import type { GlossaryTerm, TranscriptCorrection, TranscriptEvent } from "../types.js";
import { isContextAmbiguousSpokenAlias, isKnownSpokenAlias } from "./spoken-aliases.js";

type NormalizedText = {
  value: string;
  sourceStarts: number[];
  sourceEnds: number[];
};

type MatchKind = "canonical" | "english" | "spokenAlias";

export type TranscriptTermMatch = {
  term: GlossaryTerm;
  kind: MatchKind;
  sourceStart: number;
  sourceEnd: number;
  matchedText: string;
};

const graphemeSegmenter = new Intl.Segmenter("ko-KR", { granularity: "grapheme" });
const KOREAN_SUFFIXES = new Set([
  "은", "는", "이", "가", "을", "를", "과", "와", "의", "에", "에서", "에게", "에게서", "께", "께서",
  "으로", "로", "부터", "까지", "보다", "처럼", "만", "도", "이나", "나", "이랑", "랑", "하고", "이라는",
  "라는", "이라고", "라고", "이면", "면", "이며", "며", "이고", "고", "입니다", "이었다", "였다"
]);

function normalizeTextWithSourceMap(value: string): NormalizedText {
  let normalizedValue = "";
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let pendingWhitespace: { start: number; end: number } | null = null;

  const append = (segment: string, sourceStart: number, sourceEnd: number): void => {
    normalizedValue += segment;
    for (let index = 0; index < segment.length; index += 1) {
      sourceStarts.push(sourceStart);
      sourceEnds.push(sourceEnd);
    }
  };

  for (const grapheme of graphemeSegmenter.segment(value)) {
    const sourceStart = grapheme.index;
    const sourceEnd = sourceStart + grapheme.segment.length;
    const segment = grapheme.segment.normalize("NFKC").toLocaleLowerCase("ko-KR");
    if (!segment) continue;
    if (/^\s+$/u.test(segment)) {
      if (normalizedValue.length > 0) {
        pendingWhitespace = pendingWhitespace
          ? { start: pendingWhitespace.start, end: sourceEnd }
          : { start: sourceStart, end: sourceEnd };
      }
      continue;
    }
    if (pendingWhitespace) {
      append(" ", pendingWhitespace.start, pendingWhitespace.end);
      pendingWhitespace = null;
    }
    append(segment, sourceStart, sourceEnd);
  }
  return { value: normalizedValue, sourceStarts, sourceEnds };
}

function isAsciiWordCharacter(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z0-9_]/u.test(value));
}

function hasValidAsciiBoundaries(text: string, start: number, candidate: string): boolean {
  const end = start + candidate.length;
  if (isAsciiWordCharacter(candidate[0]) && isAsciiWordCharacter(text[start - 1])) return false;
  if (isAsciiWordCharacter(candidate[candidate.length - 1]) && isAsciiWordCharacter(text[end])) return false;
  return true;
}

function hasSafeAliasBoundaries(text: string, start: number, candidate: string): boolean {
  if (!hasValidAsciiBoundaries(text, start, candidate)) return false;
  const previous = text[start - 1];
  if (previous && /[가-힣A-Za-z0-9_]/u.test(previous)) return false;

  const remainder = text.slice(start + candidate.length);
  const trailing = remainder.match(/^[가-힣]+/u)?.[0] ?? "";
  if (trailing.length === 0 && isContextAmbiguousSpokenAlias(candidate) && /^\s+[가-힣]/u.test(remainder)) {
    return false;
  }
  return trailing.length === 0 || KOREAN_SUFFIXES.has(trailing);
}

export function findTranscriptTermMatches(text: string, terms: GlossaryTerm[]): TranscriptTermMatch[] {
  const normalizedText = normalizeTextWithSourceMap(text);
  const candidates = terms.flatMap((term, sourceIndex) => {
    const forms: Array<{ value: string; kind: MatchKind; formIndex: number }> = [
      { value: term.term, kind: "canonical", formIndex: 0 },
      ...(term.english ? [{ value: term.english, kind: "english" as const, formIndex: 1 }] : []),
      ...term.spokenAliases.filter((value) => isKnownSpokenAlias(term.term, term.english, value)).map((value, aliasIndex) => ({
        value,
        kind: "spokenAlias" as const,
        formIndex: aliasIndex + 2
      }))
    ];
    return forms.map((form) => ({
      term,
      sourceIndex,
      ...form,
      normalized: normalizeTextWithSourceMap(form.value).value
    }));
  }).filter((candidate) => candidate.normalized.length > 0);

  const matches: TranscriptTermMatch[] = [];
  let cursor = 0;
  while (cursor < normalizedText.value.length) {
    const selected = candidates
      .filter((candidate) => normalizedText.value.startsWith(candidate.normalized, cursor))
      .filter((candidate) => candidate.kind !== "spokenAlias" || hasSafeAliasBoundaries(normalizedText.value, cursor, candidate.normalized))
      .filter((candidate) => hasValidAsciiBoundaries(normalizedText.value, cursor, candidate.normalized))
      .sort((left, right) =>
        right.normalized.length - left.normalized.length ||
        (left.kind === "spokenAlias" ? 1 : 0) - (right.kind === "spokenAlias" ? 1 : 0) ||
        left.sourceIndex - right.sourceIndex ||
        left.formIndex - right.formIndex
      )[0];
    if (!selected) {
      cursor += 1;
      continue;
    }

    const normalizedEnd = cursor + selected.normalized.length;
    const sourceStart = normalizedText.sourceStarts[cursor];
    const sourceEnd = normalizedText.sourceEnds[normalizedEnd - 1];
    if (sourceStart !== undefined && sourceEnd !== undefined && sourceStart < sourceEnd) {
      matches.push({
        term: selected.term,
        kind: selected.kind,
        sourceStart,
        sourceEnd,
        matchedText: text.slice(sourceStart, sourceEnd)
      });
    }
    cursor = Math.max(normalizedEnd, cursor + 1);
  }
  return matches;
}

export function createTranscriptEvent(text: string, isFinal: boolean, terms: GlossaryTerm[]): TranscriptEvent {
  if (!isFinal) return { type: "interim", text };

  const matches = findTranscriptTermMatches(text, terms);
  const corrections: TranscriptCorrection[] = [];
  let displayText = "";
  let sourceCursor = 0;
  for (const match of matches) {
    if (match.sourceStart < sourceCursor) continue;
    displayText += text.slice(sourceCursor, match.sourceStart);
    if (match.kind === "spokenAlias") {
      const displayStart = displayText.length;
      displayText += match.term.term;
      corrections.push({
        originalText: match.matchedText,
        correctedText: match.term.term,
        termId: match.term.id,
        displayStart,
        displayEnd: displayText.length,
        reason: "spokenAlias"
      });
    } else {
      displayText += match.matchedText;
    }
    sourceCursor = match.sourceEnd;
  }
  displayText += text.slice(sourceCursor);

  return {
    type: "final",
    text: displayText,
    rawText: text,
    detectedTerms: matches.map((match) => match.term.id),
    relatedPage: matches[0]?.term.pageNumber,
    corrections
  };
}

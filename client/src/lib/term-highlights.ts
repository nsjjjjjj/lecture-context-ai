export type HighlightTerm = {
  id: string;
  term: string;
};

export type HighlightedTextPart = {
  text: string;
  highlighted: boolean;
  termId?: string;
};

type NormalizedText = {
  value: string;
  sourceStarts: number[];
  sourceEnds: number[];
};

type HighlightRange = {
  start: number;
  end: number;
  termId: string;
};

const graphemeSegmenter = new Intl.Segmenter("ko-KR", { granularity: "grapheme" });

function normalizeTextWithSourceMap(value: string): NormalizedText {
  let normalizedValue = "";
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let pendingWhitespace: { start: number; end: number } | null = null;

  const append = (normalizedSegment: string, sourceStart: number, sourceEnd: number) => {
    normalizedValue += normalizedSegment;
    for (let index = 0; index < normalizedSegment.length; index += 1) {
      sourceStarts.push(sourceStart);
      sourceEnds.push(sourceEnd);
    }
  };

  for (const grapheme of graphemeSegmenter.segment(value)) {
    const sourceStart = grapheme.index;
    const sourceEnd = sourceStart + grapheme.segment.length;
    const normalizedSegment = grapheme.segment.normalize("NFKC").toLocaleLowerCase("ko-KR");
    if (!normalizedSegment) continue;

    if (/^\s+$/u.test(normalizedSegment)) {
      if (normalizedValue.length === 0) continue;
      pendingWhitespace = pendingWhitespace
        ? { start: pendingWhitespace.start, end: sourceEnd }
        : { start: sourceStart, end: sourceEnd };
      continue;
    }

    if (pendingWhitespace) {
      append(" ", pendingWhitespace.start, pendingWhitespace.end);
      pendingWhitespace = null;
    }
    append(normalizedSegment, sourceStart, sourceEnd);
  }

  return { value: normalizedValue, sourceStarts, sourceEnds };
}

function isAsciiWordCharacter(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z0-9_]/.test(value));
}

function hasValidAsciiBoundaries(text: string, start: number, term: string): boolean {
  const end = start + term.length;
  if (isAsciiWordCharacter(term[0]) && isAsciiWordCharacter(text[start - 1])) return false;
  if (isAsciiWordCharacter(term[term.length - 1]) && isAsciiWordCharacter(text[end])) return false;
  return true;
}

function mergeOverlappingRanges(ranges: HighlightRange[]): HighlightRange[] {
  const merged: HighlightRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function findHighlightRanges(text: string, terms: HighlightTerm[]): HighlightRange[] {
  const normalizedText = normalizeTextWithSourceMap(text);
  const candidates = terms
    .map((term, sourceIndex) => ({
      term,
      sourceIndex,
      normalizedTerm: normalizeTextWithSourceMap(term.term).value
    }))
    .filter((candidate) => candidate.normalizedTerm.length > 0);
  const ranges: HighlightRange[] = [];
  let cursor = 0;

  while (cursor < normalizedText.value.length) {
    const selected = candidates
      .filter((candidate) => normalizedText.value.startsWith(candidate.normalizedTerm, cursor))
      .filter((candidate) => hasValidAsciiBoundaries(normalizedText.value, cursor, candidate.normalizedTerm))
      .sort((a, b) => b.normalizedTerm.length - a.normalizedTerm.length || a.sourceIndex - b.sourceIndex)[0];

    if (!selected) {
      cursor += 1;
      continue;
    }

    const normalizedEnd = cursor + selected.normalizedTerm.length;
    const sourceStart = normalizedText.sourceStarts[cursor];
    const sourceEnd = normalizedText.sourceEnds[normalizedEnd - 1];
    if (sourceStart !== undefined && sourceEnd !== undefined && sourceStart < sourceEnd) {
      ranges.push({ start: sourceStart, end: sourceEnd, termId: selected.term.id });
    }
    cursor = Math.max(normalizedEnd, cursor + 1);
  }

  return mergeOverlappingRanges(ranges);
}

export function buildHighlightedTextParts(text: string, terms: HighlightTerm[]): HighlightedTextPart[] {
  const ranges = findHighlightRanges(text, terms);
  if (ranges.length === 0) return [{ text, highlighted: false }];

  const parts: HighlightedTextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), highlighted: false });
    parts.push({ text: text.slice(range.start, range.end), highlighted: true, termId: range.termId });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts;
}

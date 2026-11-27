import type { TranscriptLine } from "../../types";

export const LIVE_CAPTION_MAX_COMPOSED_CHARACTERS = 72;

const CAPTION_SENTENCE_END = /[.!?…。！？][\]})〉》」』”’"']*\s*$/u;
const CAPTION_NO_LEADING_SPACE = /^[,.:;!?%…。！？、)\]}>〉》」』”’]/u;

export function endsCaptionSentence(text: string): boolean {
  return CAPTION_SENTENCE_END.test(text.trimEnd());
}

export function captionJoinSeparator(left: string, right: string): string {
  if (!left || !right || /\s$/u.test(left) || /^\s/u.test(right) || CAPTION_NO_LEADING_SPACE.test(right)) {
    return "";
  }
  return " ";
}

export function mergeTranscriptLines(left: TranscriptLine, right: TranscriptLine): TranscriptLine {
  const displaySeparator = captionJoinSeparator(left.text, right.text);
  const rawSeparator = captionJoinSeparator(left.rawText, right.rawText);
  const correctionOffset = left.text.length + displaySeparator.length;
  return {
    id: left.id,
    text: `${left.text}${displaySeparator}${right.text}`,
    rawText: `${left.rawText}${rawSeparator}${right.rawText}`,
    termIds: [...new Set([...left.termIds, ...right.termIds])],
    relatedPage: left.relatedPage ?? right.relatedPage,
    corrections: [
      ...left.corrections,
      ...right.corrections.map((correction) => ({
        ...correction,
        displayStart: correction.displayStart + correctionOffset,
        displayEnd: correction.displayEnd + correctionOffset
      }))
    ]
  };
}

export function appendContextualCaptionLine(
  composedLines: TranscriptLine[],
  line: TranscriptLine,
  retainedLineLimit: number
): TranscriptLine[] {
  const previous = composedLines.at(-1);
  const mergedLength = previous
    ? previous.text.length + captionJoinSeparator(previous.text, line.text).length + line.text.length
    : 0;

  const nextLines = !previous || endsCaptionSentence(previous.text) ||
      mergedLength > LIVE_CAPTION_MAX_COMPOSED_CHARACTERS
    ? [...composedLines, line]
    : [...composedLines.slice(0, -1), mergeTranscriptLines(previous, line)];
  const limit = Math.max(0, Math.trunc(retainedLineLimit));
  return limit === 0 ? [] : nextLines.slice(-limit);
}

export function composeContextualCaptionLines(lines: TranscriptLine[]): TranscriptLine[] {
  const composed: TranscriptLine[] = [];
  for (const line of lines) {
    const previous = composed.at(-1);
    const mergedLength = previous
      ? previous.text.length + captionJoinSeparator(previous.text, line.text).length + line.text.length
      : 0;
    if (!previous || endsCaptionSentence(previous.text) || mergedLength > LIVE_CAPTION_MAX_COMPOSED_CHARACTERS) {
      composed.push(line);
    } else {
      composed[composed.length - 1] = mergeTranscriptLines(previous, line);
    }
  }
  return composed;
}

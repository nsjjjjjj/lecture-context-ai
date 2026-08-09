import { Fragment } from "react";
import { buildHighlightedTextParts } from "../lib/term-highlights";
import type { GlossaryTerm, TranscriptCorrection, TranscriptLine } from "../types";

export type CaptionDisplayPart =
  | { kind: "text"; text: string }
  | { kind: "correction"; text: string; correction: TranscriptCorrection };

const TERM_HIGHLIGHT_CLASS_NAME = "rounded-md bg-cyan-300 px-1.5 py-0.5 text-slate-950";

export function buildCaptionDisplayParts(text: string, corrections: TranscriptCorrection[]): CaptionDisplayPart[] {
  const parts: CaptionDisplayPart[] = [];
  let cursor = 0;
  for (const correction of [...corrections].sort((left, right) => left.displayStart - right.displayStart)) {
    const valid =
      correction.reason === "spokenAlias" &&
      correction.displayStart >= cursor &&
      correction.displayEnd > correction.displayStart &&
      correction.displayEnd <= text.length &&
      text.slice(correction.displayStart, correction.displayEnd) === correction.correctedText;
    if (!valid) continue;
    if (correction.displayStart > cursor) {
      parts.push({ kind: "text", text: text.slice(cursor, correction.displayStart) });
    }
    parts.push({ kind: "correction", text: correction.correctedText, correction });
    cursor = correction.displayEnd;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}

function HighlightedPart({ text, terms }: { text: string; terms: GlossaryTerm[] }) {
  return buildHighlightedTextParts(text, terms).map((part, index) => part.highlighted
    ? <mark key={`${part.termId}-${index}`} className={TERM_HIGHLIGHT_CLASS_NAME}>{part.text}</mark>
    : <Fragment key={`text-${index}`}>{part.text}</Fragment>);
}

export function TransparentCaption({
  line,
  terms,
  className
}: {
  line: TranscriptLine;
  terms: GlossaryTerm[];
  className: string;
}) {
  const relevantTerms = terms.filter((term) => line.termIds.includes(term.id));
  const parts = buildCaptionDisplayParts(line.text, line.corrections);

  return (
    <p className={className}>
      {parts.map((part, index) => {
        if (part.kind === "text") {
          return <HighlightedPart key={`text-${index}`} text={part.text} terms={relevantTerms} />;
        }
        const explanation = `정정 표기: ${part.correction.correctedText}, 원래 음성 인식: ${part.correction.originalText}`;
        return (
          <span
            key={`${part.correction.termId}-${part.correction.displayStart}`}
            className="caption-correction"
            aria-label={explanation}
          >
            <mark className={TERM_HIGHLIGHT_CLASS_NAME} aria-hidden="true">{part.text}</mark>
            <span className="caption-correction-original" aria-hidden="true">({part.correction.originalText})</span>
          </span>
        );
      })}
    </p>
  );
}

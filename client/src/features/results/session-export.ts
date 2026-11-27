import type { LectureMode, LectureSessionOutcome } from "../../hooks/lecture-stream-state";
import type { GlossaryTerm, TranscriptLine } from "../../types";

export const MAX_SESSION_GLOSSARY_TERMS = 50;
export type SessionExportStatus = "not-exported" | "download-requested" | "confirmed";

export type LectureSessionExportInput = {
  title: string;
  exportedAt: string;
  mode: LectureMode;
  outcome: LectureSessionOutcome | null;
  lines: TranscriptLine[];
  glossaryTerms: GlossaryTerm[];
};

export type LectureSessionExportV2 = {
  version: 2;
  title: string;
  exportedAt: string;
  mode: LectureMode;
  outcome: LectureSessionOutcome | null;
  glossary: {
    totalTermCount: number;
    snapshotTruncated: boolean;
    terms: GlossaryTerm[];
  };
  transcript: TranscriptLine[];
};

function validatedExportTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("결과 내보내기 시각이 올바르지 않습니다.");
  return timestamp.toISOString();
}

function glossarySnapshot(input: LectureSessionExportInput): LectureSessionExportV2["glossary"] {
  const termById = new Map(input.glossaryTerms.map((term) => [term.id, term]));
  const referencedIds: string[] = [];
  const seen = new Set<string>();
  for (const line of input.lines) {
    for (const id of [...line.termIds, ...line.corrections.map((correction) => correction.termId)]) {
      if (seen.has(id)) continue;
      seen.add(id);
      referencedIds.push(id);
    }
  }

  const unresolvedIds = referencedIds.filter((id) => !termById.has(id));
  if (unresolvedIds.length > 0) {
    throw new Error(`결과 용어집에서 자막 용어 ID를 찾지 못했습니다: ${unresolvedIds.join(", ")}`);
  }
  if (referencedIds.length > MAX_SESSION_GLOSSARY_TERMS) {
    throw new Error(`한 결과에서 해석할 수 있는 전문용어는 최대 ${MAX_SESSION_GLOSSARY_TERMS}개입니다.`);
  }

  const orderedTerms = [
    ...referencedIds.map((id) => termById.get(id)!),
    ...input.glossaryTerms.filter((term) => !seen.has(term.id))
  ].slice(0, MAX_SESSION_GLOSSARY_TERMS);
  return {
    totalTermCount: input.glossaryTerms.length,
    snapshotTruncated: input.glossaryTerms.length > orderedTerms.length,
    terms: orderedTerms.map((term) => ({
      ...term,
      spokenAliases: [...term.spokenAliases]
    }))
  };
}

export function createLectureSessionExport(input: LectureSessionExportInput): LectureSessionExportV2 {
  return {
    version: 2,
    title: input.title.trim() || "강연 자막 결과",
    exportedAt: validatedExportTimestamp(input.exportedAt),
    mode: input.mode,
    outcome: input.outcome,
    glossary: glossarySnapshot(input),
    transcript: input.lines.map((line) => ({
      ...line,
      termIds: [...line.termIds],
      corrections: line.corrections.map((correction) => ({ ...correction }))
    }))
  };
}

export function serializeLectureSessionJson(input: LectureSessionExportInput): string {
  return JSON.stringify(createLectureSessionExport(input), null, 2);
}

export function serializeLectureTranscriptText(input: LectureSessionExportInput): string {
  const session = createLectureSessionExport(input);
  const termById = new Map(session.glossary.terms.map((term) => [term.id, term.term]));
  const header = [
    session.title,
    `내보낸 시각: ${session.exportedAt}`,
    `자막 방식: ${session.mode === "live" ? "AWS 실시간" : "데모"}`,
    `종료 상태: ${session.outcome?.status ?? "unknown"}`,
    ""
  ];
  const transcript = session.transcript.flatMap((line, index) => {
    const details = [
      line.rawText !== line.text ? `  원문: ${line.rawText}` : "",
      line.termIds.length > 0
        ? `  용어: ${line.termIds.map((id) => `${termById.get(id)} (${id})`).join(", ")}`
        : "",
      line.corrections.length > 0 ? `  교정: ${JSON.stringify(line.corrections)}` : ""
    ].filter(Boolean);
    return [`${index + 1}. ${line.text}`, ...details];
  });
  return [...header, ...(transcript.length > 0 ? transcript : ["확정된 자막이 없습니다."]), ""].join("\n");
}

export function safeSessionExportBaseName(title: string): string {
  const normalized = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return normalized && /[\p{L}\p{N}]/u.test(normalized) ? normalized : "lecture-caption-session";
}

export function shouldConfirmSessionDiscard(
  stage: string,
  transcriptLineCount: number,
  exportStatus: SessionExportStatus
): boolean {
  return stage === "results" && transcriptLineCount > 0 && exportStatus !== "confirmed";
}

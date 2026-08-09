import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ComparisonOccurrenceOutcome,
  ComparisonReportV3,
  ComparisonRunLabel,
  ComparisonRunResult,
  ComparisonUnexpectedObservation
} from "../lib/api";
import {
  aggregateComparisonReport,
  comparisonReportToTsv,
  isPaperReadyComparison,
  SttComparisonResultsView
} from "./SttComparisonResults";

const targetTerms = [
  {
    id: "rag",
    canonicalTerm: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["레그"],
    expectedOccurrences: [1, 2]
  }
];

function createRun(
  label: ComparisonRunLabel,
  outcomes: ComparisonOccurrenceOutcome[],
  unexpectedObservations: ComparisonUnexpectedObservation[] = []
): ComparisonRunResult {
  const directRecognitions = outcomes.filter((outcome) => outcome === "direct-recognition").length;
  const aliasCorrectionSuccesses = outcomes.filter((outcome) => outcome === "alias-correction").length;
  const misses = outcomes.filter((outcome) => outcome === "miss").length;
  return {
    label,
    status: "completed",
    phraseSet: [],
    terms: [{
      id: "rag",
      term: "RAG",
      english: "Retrieval-Augmented Generation",
      spokenAliases: label === "spoken-alias-phrase-set" ? ["레그"] : [],
      easyExplanation: "검색 증강 생성",
      pageNumber: 1,
      occurrences: 2,
      source: "demo"
    }],
    startedAt: "2026-08-09T01:00:00.000Z",
    readyAfterMs: 100,
    audioDurationMs: 1_000,
    wallClockMs: 1_200,
    interimCount: 1,
    finalTranscripts: [],
    transcript: label === "spoken-alias-phrase-set" ? "RAG(레그)와 RAG" : "RAG와 레그",
    rawTranscript: "레그와 RAG",
    metrics: {
      evaluationMode: "accuracy",
      accuracyValid: true,
      directRecognitions,
      aliasCorrectionSuccesses,
      misses,
      falseCorrections: unexpectedObservations.filter((item) => item.kind === "false-correction").length,
      falseInsertions: unexpectedObservations.filter((item) => item.kind === "false-insertion").length,
      expectedOccurrenceCount: outcomes.length,
      productLinkRate: outcomes.length === 0 ? 0 : (directRecognitions + aliasCorrectionSuccesses) / outcomes.length
    },
    occurrenceResults: outcomes.map((outcome, index) => ({
      sequence: index + 1,
      targetTermId: "rag",
      canonicalTerm: "RAG",
      outcome,
      finalTranscriptIndex: outcome === "miss" ? null : 0,
      rawText: outcome === "miss" ? null : outcome === "alias-correction" ? "레그" : "RAG"
    })),
    unexpectedObservations,
    errors: []
  };
}

function createReport(): ComparisonReportV3 {
  return {
    version: 3,
    createdAt: "2026-08-09T01:00:00.000Z",
    recording: {
      id: "11111111-1111-4111-8111-111111111111",
      scriptId: "baseline-v2",
      speakerReadReferenceScriptVerbatim: true,
      evaluationMode: "accuracy"
    },
    script: {
      id: "baseline-v2",
      title: "기준 문장",
      languageCode: "ko-KR",
      text: "RAG를 두 번 읽습니다.",
      targetTerms
    },
    websocketUrl: "ws://127.0.0.1:8787/ws",
    measurementNote: "accuracy fixture",
    runs: [
      createRun("without-phrase-set", ["direct-recognition", "miss"], [
        { kind: "false-insertion", reason: "unexpected-direct-match", targetTermId: "rag", finalTranscriptIndex: 0, rawText: "RAG" },
        { kind: "false-correction", reason: "invalid-correction", targetTermId: null, finalTranscriptIndex: 0, rawText: "알 수 없음" }
      ]),
      createRun("canonical-phrase-set", ["direct-recognition", "direct-recognition"]),
      createRun("spoken-alias-phrase-set", ["alias-correction", "direct-recognition"])
    ]
  };
}

describe("STT comparison aggregation", () => {
  it("counts outcomes per term and keeps null-target observations as unassigned errors", () => {
    const aggregation = aggregateComparisonReport(createReport());

    expect(aggregation.terms).toHaveLength(1);
    expect(aggregation.terms[0]).toMatchObject({ targetTermId: "rag", expectedCount: 2 });
    expect(aggregation.terms[0]?.byRun["without-phrase-set"]).toEqual({
      directRecognitions: 1,
      aliasCorrections: 0,
      misses: 1,
      falseCorrections: 0,
      falseInsertions: 1
    });
    expect(aggregation.terms[0]?.byRun["spoken-alias-phrase-set"]).toMatchObject({
      directRecognitions: 1,
      aliasCorrections: 1,
      misses: 0
    });
    expect(aggregation.unassignedByRun["without-phrase-set"]).toEqual({ falseCorrections: 1, falseInsertions: 0 });
  });

  it("creates a paper-ready TSV only from reported run metrics", () => {
    const report = createReport();
    const tsv = comparisonReportToTsv(report);

    expect(isPaperReadyComparison(report)).toBe(true);
    expect(tsv.split("\n")[0]).toBe("조건\tPhraseSet\t직접 인식\t별칭 정정\t누락\t오정정\t오삽입\t기대 출현\t제품 연결률");
    expect(tsv).toContain("C\t발음 별칭 포함 PhraseSet\t1\t1\t0\t0\t0\t2\t100.0%");

    report.runs[1]!.errors.push("stream failed");
    expect(isPaperReadyComparison(report)).toBe(false);
  });
});

describe("STT comparison result rendering", () => {
  it("shows the compare command when no saved report exists", () => {
    const html = renderToStaticMarkup(<SttComparisonResultsView latest={null} reportCount={0} loading={false} error="" onRefresh={() => undefined} />);
    expect(html).toContain("pnpm stt:compare");
    expect(html).toContain("이 화면에서 유료 STT API를 실행하지 않습니다");
  });

  it("labels v1/v2 as legacy smoke data without rendering invented metrics", () => {
    const html = renderToStaticMarkup(<SttComparisonResultsView latest={{ version: 2, metrics: { accuracy: 99 } }} reportCount={1} loading={false} error="" onRefresh={() => undefined} />);
    expect(html).toContain("레거시 스모크 결과");
    expect(html).not.toContain("제품 연결률");
  });

  it("renders raw/display transcripts and disables publication copy for smoke mode", () => {
    const report = createReport();
    report.recording = {
      ...report.recording,
      speakerReadReferenceScriptVerbatim: false,
      evaluationMode: "smoke"
    };
    report.runs = report.runs.map((run) => ({
      ...run,
      metrics: { ...run.metrics, evaluationMode: "smoke", accuracyValid: false }
    }));

    const html = renderToStaticMarkup(<SttComparisonResultsView latest={report} reportCount={1} loading={false} error="" onRefresh={() => undefined} />);
    expect(html).toContain("스모크 모드 결과는 출판용 정확도 수치가 아닙니다");
    expect(html).toContain("STT 원문");
    expect(html).toContain("정정·표시 문장");
    expect(html).toContain("전역·미할당 예외");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*TSV로 복사/s);
  });
});

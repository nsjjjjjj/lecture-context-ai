import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentSttComparisonJob,
  getSttComparison,
  getSttComparisons,
  PAID_STT_CALL_CONSENT,
  startSttComparisonJob,
  type AudioFixtureRecording,
  type ComparisonOccurrenceOutcome,
  type ComparisonReportV3,
  type ComparisonRunLabel,
  type ComparisonRunResult,
  type ComparisonUnexpectedObservation,
  type ExternalSttComparisonJob,
  type SttComparisonJobStatus
} from "../lib/api";
import {
  aggregateComparisonReport,
  comparisonReportToTsv,
  defaultRecordingId,
  handleLocalTerminalResultOnce,
  historyBadgeLabels,
  isPaperReadyComparison,
  registerDiscoveredLocalJob,
  startSttComparisonAttempt,
  SttComparisonJobPanel,
  SttComparisonResults,
  SttComparisonResultsView
} from "./SttComparisonResults";

afterEach(() => {
  vi.unstubAllGlobals();
});

const targetTerms = [
  {
    id: "rag",
    canonicalTerm: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["레그"],
    expectedOccurrences: [1, 2]
  }
];

const recordings: AudioFixtureRecording[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    fileName: "older.wav",
    relativePath: "audio/older.wav",
    scriptId: "baseline-v2",
    speakerLabel: "speaker-a",
    environment: "quiet",
    createdAt: "2026-08-09T00:00:00.000Z",
    durationMs: 1_000,
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    dataBytes: 32_000,
    speakerReadReferenceScriptVerbatim: true
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    fileName: "latest.wav",
    relativePath: "audio/latest.wav",
    scriptId: "baseline-v2",
    speakerLabel: "speaker-b",
    environment: "noisy",
    createdAt: "2026-08-09T01:00:00.000Z",
    durationMs: 2_000,
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    dataBytes: 64_000,
    speakerReadReferenceScriptVerbatim: true
  }
];

function createJob(overrides: Partial<SttComparisonJobStatus> = {}): SttComparisonJobStatus {
  const state = overrides.state ?? overrides.status ?? "starting";
  return {
    id: "job-1",
    recordingId: recordings[1]!.id,
    status: state,
    state,
    createdAt: "2026-08-09T01:00:00.000Z",
    startedAt: null,
    updatedAt: "2026-08-09T01:00:00.000Z",
    finishedAt: null,
    completedAt: null,
    progress: { completed: 0, total: 3, percent: 0 },
    activeRunLabel: null,
    runs: [
      { label: "without-phrase-set", state: "pending", message: null, error: null },
      { label: "canonical-phrase-set", state: "pending", message: null, error: null },
      { label: "spoken-alias-phrase-set", state: "pending", message: null, error: null }
    ],
    message: "STT 비교 작업을 시작합니다.",
    fatalError: null,
    resultFileName: null,
    ...overrides
  };
}

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

describe("STT comparison API request safety", () => {
  it("limits external job owners to the implemented CLI and UI values", () => {
    const owners: ExternalSttComparisonJob["owner"][] = ["cli", "ui"];
    expect(owners).toEqual(["cli", "ui"]);
  });

  it("sends the exact paid-call consent only to a mocked start endpoint", async () => {
    const job = createJob();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job }), {
      status: 202,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await startSttComparisonJob(recordings[1]!.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/dev/stt-comparison-jobs");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      recordingId: recordings[1]!.id,
      paidCallConsent: PAID_STT_CALL_CONSENT
    });
    expect(PAID_STT_CALL_CONSENT).toBe("I_UNDERSTAND_3_PAID_GOOGLE_STT_CALLS");
  });

  it("uses GET-only requests for current job, history paging, and detail selection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ active: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ latest: null, latestFileName: null, reportCount: 0, history: [], page: { offset: 5, limit: 5, hasMore: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fileName: "comparison-safe.json", modifiedAt: "2026-08-09T01:00:00.000Z", report: { version: 2 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getCurrentSttComparisonJob();
    await getSttComparisons({ offset: 5, limit: 5 });
    await getSttComparison("comparison-safe.json");

    expect(fetchMock.mock.calls.map(([url, options]) => ({
      url,
      method: (options as RequestInit | undefined)?.method ?? "GET"
    }))).toEqual([
      { url: "/api/dev/stt-comparison-jobs/current", method: "GET" },
      { url: "/api/dev/stt-comparisons?offset=5&limit=5", method: "GET" },
      { url: "/api/dev/stt-comparisons/comparison-safe.json", method: "GET" }
    ]);
  });

  it("reloads the current job after a failed start and resets consent after every attempt", async () => {
    const conflict = new Error("이미 다른 STT 비교가 실행 중입니다.");
    const failedLoadCurrent = vi.fn().mockResolvedValue(undefined);
    const failedResetConsent = vi.fn();
    const failedRequest = vi.fn().mockRejectedValue(conflict);

    await expect(startSttComparisonAttempt({
      recordingId: recordings[1]!.id,
      loadCurrent: failedLoadCurrent,
      resetConsent: failedResetConsent,
      requestStart: failedRequest
    })).rejects.toBe(conflict);

    expect(failedRequest).toHaveBeenCalledOnce();
    expect(failedLoadCurrent).toHaveBeenCalledOnce();
    expect(failedResetConsent).toHaveBeenCalledOnce();

    const completedJob = createJob({ state: "completed", status: "completed" });
    const successfulLoadCurrent = vi.fn().mockResolvedValue(undefined);
    const successfulResetConsent = vi.fn();
    await expect(startSttComparisonAttempt({
      recordingId: recordings[1]!.id,
      loadCurrent: successfulLoadCurrent,
      resetConsent: successfulResetConsent,
      requestStart: vi.fn().mockResolvedValue({ job: completedJob })
    })).resolves.toBe(completedJob);

    expect(successfulLoadCurrent).not.toHaveBeenCalled();
    expect(successfulResetConsent).toHaveBeenCalledOnce();
  });

  it("restores a remounted local job and handles its terminal result exactly once", () => {
    const runningJob = createJob({
      id: "job-remounted",
      state: "running",
      status: "running"
    });
    const terminalJob = createJob({
      id: runningJob.id,
      state: "completed",
      status: "completed",
      resultFileName: "comparison-job-remounted.json"
    });
    const locallyStartedJobIds = new Set<string>();
    const handledJobIds = new Set<string>();
    const calls: string[] = [];
    const selectResult = vi.fn(() => calls.push("select"));
    const refreshHistory = vi.fn(() => calls.push("refresh"));
    const onResultReady = vi.fn(() => calls.push("ready"));

    expect(registerDiscoveredLocalJob({ kind: "local", job: runningJob }, locallyStartedJobIds)).toBe(true);
    expect(locallyStartedJobIds).toEqual(new Set([runningJob.id]));
    expect(handleLocalTerminalResultOnce({ job: terminalJob, locallyStartedJobIds, handledJobIds, selectResult, refreshHistory, onResultReady })).toBe(true);
    expect(handleLocalTerminalResultOnce({ job: terminalJob, locallyStartedJobIds, handledJobIds, selectResult, refreshHistory, onResultReady })).toBe(false);
    expect(calls).toEqual(["select", "refresh", "ready"]);
    expect(selectResult).toHaveBeenCalledOnce();
    expect(selectResult).toHaveBeenCalledWith("comparison-job-remounted.json");
    expect(refreshHistory).toHaveBeenCalledOnce();
    expect(refreshHistory).toHaveBeenCalledWith("comparison-job-remounted.json");
    expect(onResultReady).toHaveBeenCalledOnce();
    expect(onResultReady).toHaveBeenCalledWith("comparison-job-remounted.json");
  });

  it("does not register null or externally owned current jobs", () => {
    const locallyStartedJobIds = new Set<string>();

    expect(registerDiscoveredLocalJob(null, locallyStartedJobIds)).toBe(false);
    expect(registerDiscoveredLocalJob({
      kind: "external",
      job: {
        id: "external-job",
        owner: "cli",
        recordingId: recordings[0]!.id,
        startedAt: "2026-08-09T01:00:00.000Z",
        state: "running"
      }
    }, locallyStartedJobIds)).toBe(false);
    expect(locallyStartedJobIds).toEqual(new Set());
  });
});

describe("STT comparison view separation", () => {
  it("renders only paid run controls in run view and only result controls in results view", () => {
    const runHtml = renderToStaticMarkup(<SttComparisonResults recordings={recordings} view="run" onResultReady={() => undefined} />);
    const resultsHtml = renderToStaticMarkup(<SttComparisonResults recordings={recordings} view="results" onResultReady={() => undefined} />);

    expect(runHtml).toContain("A/B/C STT 비교 실행");
    expect(runHtml).toContain("정확히 3개의 유료 Google STT 스트림");
    expect(runHtml).not.toContain("저장된 STT 비교 결과");
    expect(resultsHtml).toContain("저장된 STT 비교 결과");
    expect(resultsHtml).not.toContain("A/B/C STT 비교 실행");
    expect(resultsHtml).not.toContain("유료 비교 시작");
  });
});

describe("STT comparison job rendering", () => {
  it("defaults to the latest recording and disables start until explicit three-stream consent", () => {
    expect(defaultRecordingId(recordings)).toBe(recordings[1]!.id);
    expect(defaultRecordingId([...recordings].reverse())).toBe(recordings[1]!.id);
    const html = renderToStaticMarkup(
      <SttComparisonJobPanel
        recordings={recordings}
        selectedRecordingId={recordings[1]!.id}
        onSelectRecording={() => undefined}
        consent={false}
        onConsentChange={() => undefined}
        active={null}
        checkingActive={false}
        starting={false}
        startError=""
        currentError=""
        pollingError=""
        onStart={() => undefined}
      />
    );

    expect(html).toContain("정확히 3개의 유료 Google STT 스트림");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*유료 비교 시작/s);
    expect(html).not.toContain("취소");
  });

  it("blocks a paid start when the current-job check failed", () => {
    const html = renderToStaticMarkup(
      <SttComparisonJobPanel
        recordings={recordings}
        selectedRecordingId={recordings[1]!.id}
        onSelectRecording={() => undefined}
        consent
        onConsentChange={() => undefined}
        active={null}
        checkingActive={false}
        starting={false}
        startError=""
        currentError="current job unavailable"
        pollingError=""
        onStart={() => undefined}
      />
    );

    expect(html).toContain("실행 상태 확인 오류: current job unavailable");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*유료 비교 시작/s);
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
  });

  it("exposes per-condition state, condition error, fatal error, and polling failure", () => {
    const job = createJob({
      id: "job-visible",
      state: "running",
      status: "running",
      progress: { completed: 1, total: 3, percent: 33.333 },
      activeRunLabel: "canonical-phrase-set",
      runs: [
        { label: "without-phrase-set", state: "completed", message: "실행 완료", error: null },
        { label: "canonical-phrase-set", state: "error", message: "오류", error: "B stream failed" },
        { label: "spoken-alias-phrase-set", state: "pending", message: null, error: null }
      ],
      fatalError: "writer unavailable",
      resultFileName: null
    });
    const html = renderToStaticMarkup(
      <SttComparisonJobPanel
        recordings={recordings}
        selectedRecordingId={recordings[1]!.id}
        onSelectRecording={() => undefined}
        consent={false}
        onConsentChange={() => undefined}
        active={{ kind: "local", job }}
        checkingActive={false}
        starting={false}
        startError=""
        currentError=""
        pollingError="temporary poll failure"
        onStart={() => undefined}
      />
    );

    expect(html).toContain("aria-label=\"STT 비교 작업 진행률 33%\"");
    expect(html).toContain("A/B/C 조건별 진행 상태");
    expect(html).toContain("B stream failed");
    expect(html).toContain("치명적 오류: writer unavailable");
    expect(html).toContain("temporary poll failure");
    expect(html).toContain("자동으로 다시 확인합니다");
  });

  it("shows independent progress for all three concurrent conditions", () => {
    const job = createJob({
      state: "running",
      status: "running",
      progress: { completed: 0, total: 3, percent: 50 },
      activeRunLabel: null,
      message: "A/B/C 3개 조건을 병렬로 실행하고 있습니다.",
      runs: [
        { label: "without-phrase-set", state: "running", progress: 48, message: "고정 음원 재생 중 · 48%", error: null },
        { label: "canonical-phrase-set", state: "running", progress: 50, message: "고정 음원 재생 중 · 50%", error: null },
        { label: "spoken-alias-phrase-set", state: "running", progress: 52, message: "고정 음원 재생 중 · 52%", error: null }
      ]
    });
    const html = renderToStaticMarkup(
      <SttComparisonJobPanel
        recordings={recordings}
        selectedRecordingId={recordings[1]!.id}
        onSelectRecording={() => undefined}
        consent={true}
        onConsentChange={() => undefined}
        active={{ kind: "local", job }}
        checkingActive={false}
        starting={false}
        startError=""
        currentError=""
        pollingError=""
        onStart={() => undefined}
      />
    );

    expect(html).toContain("A/B/C 3개 조건을 병렬로 실행하고 있습니다.");
    expect(html).toContain('aria-label="A 조건 진행률 48%"');
    expect(html).toContain('aria-label="B 조건 진행률 50%"');
    expect(html).toContain('aria-label="C 조건 진행률 52%"');
  });
});

describe("STT comparison result rendering", () => {
  it("shows a GET-safe empty state when no saved report exists", () => {
    const html = renderToStaticMarkup(<SttComparisonResultsView latest={null} reportCount={0} loading={false} error="" onRefresh={() => undefined} />);
    expect(html).toContain("저장된 비교 결과가 없습니다");
    expect(html).toContain("새로고침과 결과 선택은 유료 호출을 만들지 않습니다");
  });

  it("labels v1/v2 as legacy smoke data without rendering invented metrics", () => {
    const html = renderToStaticMarkup(<SttComparisonResultsView latest={{ version: 2, metrics: { accuracy: 99 } }} reportCount={1} loading={false} error="" onRefresh={() => undefined} />);
    expect(html).toContain("레거시 스모크 결과");
    expect(html).not.toContain("제품 연결률");
  });

  it("renders paged history and marks the selected detail without starting a job", () => {
    const history = [
      {
        fileName: "comparison-new.json",
        modifiedAt: "2026-08-09T02:00:00.000Z",
        version: 3 as const,
        createdAt: "2026-08-09T02:00:00.000Z",
        recordingId: recordings[1]!.id,
        scriptTitle: "기준 문장",
        evaluationMode: "accuracy" as const,
        runOutcome: "complete" as const
      },
      {
        fileName: "comparison-old.json",
        modifiedAt: "2026-08-09T01:00:00.000Z",
        version: 2 as const,
        createdAt: null,
        recordingId: null,
        scriptTitle: null,
        evaluationMode: null,
        runOutcome: "legacy" as const
      }
    ];
    const html = renderToStaticMarkup(
      <SttComparisonResultsView
        latest={{ version: 2 }}
        reportCount={3}
        loading={false}
        error=""
        onRefresh={() => undefined}
        history={history}
        selectedFileName="comparison-old.json"
        page={{ offset: 0, limit: 2, hasMore: true }}
      />
    );

    expect(html).toContain("comparison-new.json");
    expect(html).toMatch(/aria-current="true"[^>]*>.*comparison-old\.json/s);
    expect(html).toContain("1–2 / 3");
  });

  it("uses mutually exclusive narrow list/detail panes and exposes a focused-detail target", () => {
    const history = [{
      fileName: "comparison-mobile.json",
      modifiedAt: "2026-08-09T02:00:00.000Z",
      version: 3 as const,
      createdAt: "2026-08-09T02:00:00.000Z",
      recordingId: recordings[1]!.id,
      scriptTitle: "기준 문장",
      evaluationMode: "accuracy" as const,
      runOutcome: "complete" as const
    }];
    const listHtml = renderToStaticMarkup(
      <SttComparisonResultsView
        latest={createReport()}
        reportCount={1}
        loading={false}
        error=""
        onRefresh={() => undefined}
        history={history}
        selectedFileName={history[0]!.fileName}
        mobileDetailOpen={false}
      />
    );
    const detailHtml = renderToStaticMarkup(
      <SttComparisonResultsView
        latest={createReport()}
        reportCount={1}
        loading={false}
        error=""
        onRefresh={() => undefined}
        history={history}
        selectedFileName={history[0]!.fileName}
        mobileDetailOpen
        detailFocusRequest={1}
      />
    );

    expect(listHtml).toContain('data-testid="stt-results-list-pane" class="block min-w-0 lg:block"');
    expect(listHtml).toContain('data-testid="stt-results-detail-pane" aria-labelledby="stt-comparison-detail-heading" class="hidden min-w-0 lg:block"');
    expect(detailHtml).toContain('data-testid="stt-results-list-pane" class="hidden min-w-0 lg:block"');
    expect(detailHtml).toContain('data-testid="stt-results-detail-pane" aria-labelledby="stt-comparison-detail-heading" class="block min-w-0 lg:block"');
    expect(detailHtml).toMatch(/data-testid="stt-results-mobile-back" class="mb-3 lg:hidden"><button type="button" class="secondary-button !min-h-10 text-xs">.*결과 목록으로/s);
    expect(detailHtml).not.toContain('secondary-button !min-h-10 text-xs lg:hidden');
    expect(detailHtml).toContain('id="stt-comparison-detail-heading" tabindex="-1"');
    expect(detailHtml).toContain("lg:grid-cols-[minmax(16rem,0.75fr)_minmax(0,1.75fr)]");
  });

  it("renders accuracy, smoke, outcome, and legacy badges only from history metadata", () => {
    const accuracy = {
      fileName: "comparison-accuracy.json",
      modifiedAt: "2026-08-09T03:00:00.000Z",
      version: 3 as const,
      createdAt: "2026-08-09T03:00:00.000Z",
      recordingId: recordings[1]!.id,
      scriptTitle: "기준 문장",
      evaluationMode: "accuracy" as const,
      runOutcome: "complete" as const
    };
    const smokeWithErrors = {
      ...accuracy,
      fileName: "comparison-smoke.json",
      evaluationMode: "smoke" as const,
      runOutcome: "has-errors" as const
    };
    const legacy = {
      fileName: "comparison-legacy.json",
      modifiedAt: "2026-08-09T01:00:00.000Z",
      version: 2 as const,
      createdAt: null,
      recordingId: null,
      scriptTitle: null,
      evaluationMode: null,
      runOutcome: "legacy" as const
    };
    const html = renderToStaticMarkup(
      <SttComparisonResultsView
        latest={{ version: 2, metrics: { accuracy: 99 } }}
        reportCount={3}
        loading={false}
        error=""
        onRefresh={() => undefined}
        history={[accuracy, smokeWithErrors, legacy]}
        page={{ offset: 0, limit: 3, hasMore: false }}
      />
    );

    expect(historyBadgeLabels(accuracy)).toEqual(["정확도", "완료"]);
    expect(historyBadgeLabels(smokeWithErrors)).toEqual(["스모크", "오류 있음"]);
    expect(historyBadgeLabels(legacy)).toEqual(["레거시 스모크"]);
    expect(html).toContain(">정확도<");
    expect(html).toContain(">스모크<");
    expect(html).toContain(">완료<");
    expect(html).toContain(">오류 있음<");
    expect(html).toContain(">레거시 스모크<");
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
    expect(html).toContain("완료된 리포트 1개만으로는 출판 수준의 반복 실험이 아닙니다");
    expect(html).not.toContain("PUBLICATION READY");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*TSV로 복사/s);
  });
});

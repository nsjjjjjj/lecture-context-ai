import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clipboard, LoaderCircle, Play, RefreshCw } from "lucide-react";
import {
  comparisonRunLabels,
  getCurrentSttComparisonJob,
  getSttComparison,
  getSttComparisonJob,
  getSttComparisons,
  startSttComparisonJob,
  type AudioFixtureRecording,
  type ComparisonReportFile,
  type ComparisonReportV3,
  type ComparisonRunLabel,
  type ComparisonRunResult,
  type CurrentSttComparisonJob,
  type SttComparisonHistoryItem,
  type SttComparisonJobRunState,
  type SttComparisonJobStatus,
  type SttComparisonPage
} from "../lib/api";

const HISTORY_PAGE_SIZE = 5;
const JOB_POLL_INTERVAL_MS = 1_000;

export type SttComparisonView = "run" | "results";
export type SttComparisonResultsProps = {
  recordings: AudioFixtureRecording[];
  view: SttComparisonView;
  onResultReady: (fileName: string) => void;
};

const RUN_DETAILS: Record<ComparisonRunLabel, { shortLabel: "A" | "B" | "C"; title: string }> = {
  "without-phrase-set": { shortLabel: "A", title: "PhraseSet 없음" },
  "canonical-phrase-set": { shortLabel: "B", title: "기준 표기 PhraseSet" },
  "spoken-alias-phrase-set": { shortLabel: "C", title: "발음 별칭 포함 PhraseSet" }
};

export type UnexpectedCounts = {
  falseCorrections: number;
  falseInsertions: number;
};

export type TermConditionAggregate = UnexpectedCounts & {
  directRecognitions: number;
  aliasCorrections: number;
  misses: number;
};

export type ComparisonTermAggregate = {
  targetTermId: string;
  canonicalTerm: string;
  expectedCount: number;
  byRun: Record<ComparisonRunLabel, TermConditionAggregate>;
};

export type ComparisonAggregation = {
  terms: ComparisonTermAggregate[];
  unassignedByRun: Record<ComparisonRunLabel, UnexpectedCounts>;
};

function createUnexpectedCounts(): UnexpectedCounts {
  return { falseCorrections: 0, falseInsertions: 0 };
}

function createTermConditionAggregate(): TermConditionAggregate {
  return {
    directRecognitions: 0,
    aliasCorrections: 0,
    misses: 0,
    ...createUnexpectedCounts()
  };
}

function createRunRecord<T>(factory: () => T): Record<ComparisonRunLabel, T> {
  return {
    "without-phrase-set": factory(),
    "canonical-phrase-set": factory(),
    "spoken-alias-phrase-set": factory()
  };
}

export function aggregateComparisonReport(report: ComparisonReportV3): ComparisonAggregation {
  const terms = report.script.targetTerms.map((term): ComparisonTermAggregate => ({
    targetTermId: term.id,
    canonicalTerm: term.canonicalTerm,
    expectedCount: term.expectedOccurrences.length,
    byRun: createRunRecord(createTermConditionAggregate)
  }));
  const termById = new Map(terms.map((term) => [term.targetTermId, term]));
  const unassignedByRun = createRunRecord(createUnexpectedCounts);

  for (const run of report.runs) {
    for (const occurrence of run.occurrenceResults) {
      const condition = termById.get(occurrence.targetTermId)?.byRun[run.label];
      if (!condition) continue;
      if (occurrence.outcome === "direct-recognition") condition.directRecognitions += 1;
      else if (occurrence.outcome === "alias-correction") condition.aliasCorrections += 1;
      else condition.misses += 1;
    }

    for (const observation of run.unexpectedObservations) {
      const counts = observation.targetTermId
        ? termById.get(observation.targetTermId)?.byRun[run.label] ?? unassignedByRun[run.label]
        : unassignedByRun[run.label];
      if (observation.kind === "false-correction") counts.falseCorrections += 1;
      else counts.falseInsertions += 1;
    }
  }

  return { terms, unassignedByRun };
}

export function isPaperReadyComparison(report: ComparisonReportV3): boolean {
  return report.recording.evaluationMode === "accuracy"
    && report.runs.length === comparisonRunLabels.length
    && report.runs.every((run) => run.status === "completed" && run.errors.length === 0);
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeTsvCell(value: string | number): string {
  const text = String(value);
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function comparisonReportToTsv(report: ComparisonReportV3): string {
  const rows: Array<Array<string | number>> = [
    ["조건", "PhraseSet", "직접 인식", "별칭 정정", "누락", "오정정", "오삽입", "기대 출현", "제품 연결률"]
  ];
  for (const run of report.runs) {
    const detail = RUN_DETAILS[run.label];
    rows.push([
      detail.shortLabel,
      detail.title,
      run.metrics.directRecognitions,
      run.metrics.aliasCorrectionSuccesses,
      run.metrics.misses,
      run.metrics.falseCorrections,
      run.metrics.falseInsertions,
      run.metrics.expectedOccurrenceCount,
      percentage(run.metrics.productLinkRate)
    ]);
  }
  return rows.map((row) => row.map(escapeTsvCell).join("\t")).join("\n");
}

function isV3ComparisonReport(report: ComparisonReportFile): report is ComparisonReportV3 {
  return report.version === 3;
}

const TERMINAL_JOB_STATES = new Set<SttComparisonJobStatus["state"]>(["completed", "completed-with-errors", "failed"]);

export function isTerminalSttComparisonJob(job: SttComparisonJobStatus): boolean {
  return TERMINAL_JOB_STATES.has(job.state);
}

export function registerDiscoveredLocalJob(
  active: CurrentSttComparisonJob | null,
  locallyStartedJobIds: Set<string>
): boolean {
  if (active?.kind !== "local") return false;
  const sizeBefore = locallyStartedJobIds.size;
  locallyStartedJobIds.add(active.job.id);
  return locallyStartedJobIds.size > sizeBefore;
}

export function handleLocalTerminalResultOnce({
  job,
  locallyStartedJobIds,
  handledJobIds,
  selectResult,
  refreshHistory,
  onResultReady
}: {
  job: SttComparisonJobStatus | null;
  locallyStartedJobIds: Set<string>;
  handledJobIds: Set<string>;
  selectResult: (fileName: string) => void;
  refreshHistory: (fileName: string) => void;
  onResultReady: (fileName: string) => void;
}): boolean {
  if (!job
    || !isTerminalSttComparisonJob(job)
    || !job.resultFileName
    || !locallyStartedJobIds.has(job.id)
    || handledJobIds.has(job.id)) return false;

  handledJobIds.add(job.id);
  selectResult(job.resultFileName);
  refreshHistory(job.resultFileName);
  onResultReady(job.resultFileName);
  return true;
}

export function defaultRecordingId(recordings: AudioFixtureRecording[]): string {
  let latest: AudioFixtureRecording | null = null;
  for (const recording of recordings) {
    if (!latest || recording.createdAt >= latest.createdAt) latest = recording;
  }
  return latest?.id ?? "";
}

export async function startSttComparisonAttempt({
  recordingId,
  loadCurrent,
  resetConsent,
  requestStart = startSttComparisonJob
}: {
  recordingId: string;
  loadCurrent: () => Promise<void>;
  resetConsent: () => void;
  requestStart?: (recordingId: string) => Promise<{ job: SttComparisonJobStatus }>;
}): Promise<SttComparisonJobStatus> {
  resetConsent();
  try {
    return (await requestStart(recordingId)).job;
  } catch (error) {
    try {
      await loadCurrent();
    } catch {
      // Preserve the start failure; loadCurrent reports its own failure in the UI.
    }
    throw error;
  }
}

function jobProgressPercent(job: SttComparisonJobStatus): number {
  return Math.min(100, Math.max(0, job.progress.percent));
}

type NormalizedJobRun = {
  label: ComparisonRunLabel;
  state: SttComparisonJobRunState;
  message: string;
  error: string;
};

function normalizedJobRuns(job: SttComparisonJobStatus): NormalizedJobRun[] {
  return job.runs.map((run) => ({
    label: run.label,
    state: run.state,
    message: run.message ?? "",
    error: run.error ?? ""
  }));
}

function formatStoredAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function historyBadgeLabels(item: SttComparisonHistoryItem): string[] {
  if (item.runOutcome === "legacy") return ["레거시 스모크"];

  const labels: string[] = [];
  if (item.evaluationMode === "accuracy") labels.push("정확도");
  if (item.evaluationMode === "smoke") labels.push("스모크");
  if (item.runOutcome === "complete") labels.push("완료");
  if (item.runOutcome === "has-errors") labels.push("오류 있음");
  return labels;
}

function jobStateLabel(state: SttComparisonJobStatus["state"]): string {
  return {
    starting: "시작 중",
    running: "실행 중",
    "writing-result": "결과 저장 중",
    completed: "완료",
    "completed-with-errors": "일부 오류로 완료",
    failed: "실패"
  }[state];
}

function runStateLabel(state: SttComparisonJobRunState): string {
  return {
    pending: "대기",
    running: "실행 중",
    completed: "완료",
    error: "오류"
  }[state];
}

function publicationStatusMessage(report: ComparisonReportV3): string {
  if (report.recording.evaluationMode !== "accuracy") {
    return "스모크 모드 결과는 출판용 정확도 수치가 아닙니다. 기준 문장을 그대로 읽은 녹음으로 다시 비교해 주세요.";
  }
  if (report.runs.some((run) => run.status !== "completed")) {
    return "완료되지 않은 비교 조건이 있어 논문용 표를 확정할 수 없습니다.";
  }
  if (report.runs.some((run) => run.errors.length > 0)) {
    return "실행 오류가 남아 있어 논문용 표를 확정할 수 없습니다.";
  }
  return "세 조건이 모두 정상 완료된 정확도 평가이므로 TSV를 복사할 수 있습니다. 단, 완료된 리포트 1개만으로는 출판 수준의 반복 실험이 아닙니다.";
}

function SummaryBar({ run }: { run: ComparisonRunResult }) {
  const { metrics } = run;
  const denominator = metrics.expectedOccurrenceCount;
  const directWidth = denominator > 0 ? (metrics.directRecognitions / denominator) * 100 : 0;
  const aliasWidth = denominator > 0 ? (metrics.aliasCorrectionSuccesses / denominator) * 100 : 0;
  const missWidth = denominator > 0 ? (metrics.misses / denominator) * 100 : 0;

  return (
    <article className="rounded-2xl border border-white/[0.07] bg-[#07111f]/65 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h5 className="text-sm font-black text-white">{RUN_DETAILS[run.label].shortLabel}. {RUN_DETAILS[run.label].title}</h5>
          <p className="mt-1 text-[11px] text-slate-500">연결률 {percentage(metrics.productLinkRate)} · 기대 출현 {metrics.expectedOccurrenceCount}회</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-black ${run.status === "completed" ? "bg-emerald-300/10 text-emerald-200" : "bg-rose-400/10 text-rose-200"}`}>
          {run.status === "completed" ? "완료" : "오류"}
        </span>
      </div>

      <div
        className="mt-4 flex h-3 overflow-hidden rounded-full bg-white/[0.06]"
        role="img"
        aria-label={`직접 인식 ${metrics.directRecognitions}회, 별칭 정정 ${metrics.aliasCorrectionSuccesses}회, 누락 ${metrics.misses}회`}
      >
        <span className="h-full bg-cyan-300" style={{ width: `${directWidth}%` }} />
        <span className="h-full bg-violet-400" style={{ width: `${aliasWidth}%` }} />
        <span className="h-full bg-rose-400/70" style={{ width: `${missWidth}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded-xl bg-cyan-300/[0.07] p-2 text-cyan-100"><span className="block text-[10px] text-cyan-300/70">직접 인식</span><strong className="text-sm">{metrics.directRecognitions}</strong></div>
        <div className="rounded-xl bg-violet-400/[0.08] p-2 text-violet-100"><span className="block text-[10px] text-violet-300/70">별칭 정정</span><strong className="text-sm">{metrics.aliasCorrectionSuccesses}</strong></div>
        <div className="rounded-xl bg-rose-400/[0.07] p-2 text-rose-100"><span className="block text-[10px] text-rose-300/70">누락</span><strong className="text-sm">{metrics.misses}</strong></div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-bold text-slate-400">
        <span className="rounded-full border border-amber-300/15 bg-amber-300/[0.06] px-2.5 py-1">오정정 {metrics.falseCorrections}</span>
        <span className="rounded-full border border-amber-300/15 bg-amber-300/[0.06] px-2.5 py-1">오삽입 {metrics.falseInsertions}</span>
      </div>
    </article>
  );
}

function TranscriptComparison({ run }: { run: ComparisonRunResult }) {
  const detail = RUN_DETAILS[run.label];
  return (
    <article className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
      <h5 className="text-xs font-black text-slate-200">{detail.shortLabel}. {detail.title}</h5>
      <dl className="mt-3 space-y-3 text-xs leading-5">
        <div>
          <dt className="font-bold text-slate-500">STT 원문</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-slate-300">{run.rawTranscript || "(빈 원문)"}</dd>
        </div>
        <div>
          <dt className="font-bold text-violet-300/80">정정·표시 문장</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-slate-100">{run.transcript || "(빈 표시 문장)"}</dd>
        </div>
      </dl>
      {run.errors.length > 0 ? (
        <ul className="mt-3 space-y-1 rounded-xl border border-rose-400/20 bg-rose-400/[0.07] p-3 text-[11px] text-rose-100">
          {run.errors.map((error, index) => <li key={`${error}-${index}`}>오류: {error}</li>)}
        </ul>
      ) : null}
    </article>
  );
}

function TermResultCell({ aggregate }: { aggregate: TermConditionAggregate }) {
  const unexpected = aggregate.falseCorrections + aggregate.falseInsertions;
  return (
    <div className="min-w-36 space-y-1 text-[11px] leading-4">
      <div>직접 <strong className="text-cyan-200">{aggregate.directRecognitions}</strong> · 별칭 <strong className="text-violet-200">{aggregate.aliasCorrections}</strong> · 누락 <strong className="text-rose-200">{aggregate.misses}</strong></div>
      <div className="text-slate-500">예외 {unexpected} (정정 {aggregate.falseCorrections} / 삽입 {aggregate.falseInsertions})</div>
    </div>
  );
}

function V3ComparisonReport({ report }: { report: ComparisonReportV3 }) {
  const aggregation = aggregateComparisonReport(report);
  const paperReady = isPaperReadyComparison(report);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  const copyTsv = async () => {
    if (!paperReady) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(comparisonReportToTsv(report));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  };

  return (
    <div className="mt-4 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
        <div>
          <h4 className="text-sm font-black text-white">{report.script.title}</h4>
          <p className="mt-1 text-[11px] text-slate-500">
            <time dateTime={report.createdAt}>{new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(report.createdAt))}</time>
            {` · ${report.recording.evaluationMode === "accuracy" ? "정확도 평가" : "스모크 점검"}`}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1.5 text-[10px] font-black ${paperReady ? "bg-emerald-300/10 text-emerald-200" : "bg-amber-300/10 text-amber-200"}`}>
          {paperReady ? "TSV READY" : "TSV LOCKED"}
        </span>
      </div>

      <div role={paperReady ? "status" : "alert"} className={`rounded-xl border p-3 text-xs leading-5 ${paperReady ? "border-emerald-300/15 bg-emerald-300/[0.06] text-emerald-100" : "border-amber-300/20 bg-amber-300/[0.08] text-amber-100"}`}>
        {publicationStatusMessage(report)}
      </div>
      {!paperReady ? <p className="text-[11px] leading-5 text-slate-500">완료된 리포트 1개만으로는 출판 수준의 반복 실험이 아닙니다. 동일 조건 반복과 분산 보고가 필요합니다.</p> : null}

      <section aria-labelledby="comparison-summary-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h4 id="comparison-summary-heading" className="text-xs font-black text-slate-200">A/B/C 인식 결과</h4>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">청록은 직접 인식, 보라는 발음 별칭 정정, 빨강은 누락입니다.</p>
          </div>
        </div>
        <div className="mt-3 grid gap-3 xl:grid-cols-3">
          {report.runs.map((run) => <SummaryBar key={run.label} run={run} />)}
        </div>
      </section>

      <section aria-labelledby="comparison-transcripts-heading">
        <h4 id="comparison-transcripts-heading" className="text-xs font-black text-slate-200">조건별 원문과 표시 문장</h4>
        <div className="mt-3 grid gap-3 xl:grid-cols-3">
          {report.runs.map((run) => <TranscriptComparison key={run.label} run={run} />)}
        </div>
      </section>

      <section aria-labelledby="comparison-terms-heading">
        <h4 id="comparison-terms-heading" className="text-xs font-black text-slate-200">용어별 출현 결과</h4>
        <div className="mt-3 overflow-x-auto rounded-2xl border border-white/[0.07]">
          <table className="w-full min-w-[780px] border-collapse text-left">
            <caption className="sr-only">기대 출현 수와 A, B, C 조건별 직접 인식, 별칭 정정, 누락, 예외 수</caption>
            <thead className="bg-white/[0.045] text-[10px] font-black text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-3">기준 용어</th>
                <th scope="col" className="px-3 py-3 text-center">기대</th>
                {comparisonRunLabels.map((label) => <th key={label} scope="col" className="px-3 py-3">{RUN_DETAILS[label].shortLabel}. {RUN_DETAILS[label].title}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-slate-300">
              {aggregation.terms.map((term) => (
                <tr key={term.targetTermId}>
                  <th scope="row" className="px-3 py-3 text-xs font-bold text-white">{term.canonicalTerm}</th>
                  <td className="px-3 py-3 text-center text-xs font-black">{term.expectedCount}</td>
                  {comparisonRunLabels.map((label) => <td key={label} className="px-3 py-3"><TermResultCell aggregate={term.byRun[label]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="comparison-unassigned-heading">
        <h4 id="comparison-unassigned-heading" className="text-xs font-black text-slate-200">전역·미할당 예외</h4>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">targetTermId가 없거나 기준 용어와 연결되지 않은 오정정·오삽입입니다.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {comparisonRunLabels.map((label) => {
            const counts = aggregation.unassignedByRun[label];
            return (
              <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-[11px] text-slate-400">
                <strong className="text-slate-200">{RUN_DETAILS[label].shortLabel}</strong> · 오정정 {counts.falseCorrections} / 오삽입 {counts.falseInsertions}
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="paper-summary-heading" aria-disabled={!paperReady}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 id="paper-summary-heading" className="text-xs font-black text-slate-200">논문용 요약 표</h4>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">정확도 평가이며 모든 조건이 오류 없이 완료된 경우에만 TSV 복사를 사용할 수 있습니다.</p>
          </div>
          <button type="button" onClick={() => void copyTsv()} disabled={!paperReady} className="secondary-button !min-h-10 text-xs disabled:cursor-not-allowed disabled:opacity-40">
            {copyStatus === "copied" ? <Check className="size-4" /> : <Clipboard className="size-4" />}
            {copyStatus === "copied" ? "TSV 복사됨" : "TSV로 복사"}
          </button>
        </div>
        <div className={`mt-3 overflow-x-auto rounded-2xl border border-white/[0.07] ${paperReady ? "" : "opacity-60"}`}>
          <table className="w-full min-w-[760px] border-collapse text-right text-xs">
            <caption className="sr-only">논문에 옮길 A, B, C 조건별 인식 지표 요약</caption>
            <thead className="bg-white/[0.045] text-[10px] font-black text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-3 text-left">조건</th>
                <th scope="col" className="px-3 py-3">직접 인식</th>
                <th scope="col" className="px-3 py-3">별칭 정정</th>
                <th scope="col" className="px-3 py-3">누락</th>
                <th scope="col" className="px-3 py-3">오정정</th>
                <th scope="col" className="px-3 py-3">오삽입</th>
                <th scope="col" className="px-3 py-3">기대 출현</th>
                <th scope="col" className="px-3 py-3">제품 연결률</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-slate-300">
              {report.runs.map((run) => (
                <tr key={run.label}>
                  <th scope="row" className="px-3 py-3 text-left font-bold text-white">{RUN_DETAILS[run.label].shortLabel}. {RUN_DETAILS[run.label].title}</th>
                  <td className="px-3 py-3">{run.metrics.directRecognitions}</td>
                  <td className="px-3 py-3">{run.metrics.aliasCorrectionSuccesses}</td>
                  <td className="px-3 py-3">{run.metrics.misses}</td>
                  <td className="px-3 py-3">{run.metrics.falseCorrections}</td>
                  <td className="px-3 py-3">{run.metrics.falseInsertions}</td>
                  <td className="px-3 py-3">{run.metrics.expectedOccurrenceCount}</td>
                  <td className="px-3 py-3 font-black text-cyan-200">{percentage(run.metrics.productLinkRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p aria-live="polite" className={`mt-2 min-h-4 text-[11px] ${copyStatus === "error" ? "text-rose-200" : "text-emerald-200"}`}>
          {copyStatus === "error" ? "클립보드에 복사하지 못했습니다. 브라우저 권한을 확인해 주세요." : copyStatus === "copied" ? "논문용 요약을 TSV 형식으로 복사했습니다." : ""}
        </p>
      </section>
    </div>
  );
}

export function SttComparisonJobPanel({
  recordings,
  selectedRecordingId,
  onSelectRecording,
  consent,
  onConsentChange,
  active,
  checkingActive,
  starting,
  startError,
  currentError,
  pollingError,
  onStart
}: {
  recordings: AudioFixtureRecording[];
  selectedRecordingId: string;
  onSelectRecording: (recordingId: string) => void;
  consent: boolean;
  onConsentChange: (consent: boolean) => void;
  active: CurrentSttComparisonJob | null;
  checkingActive: boolean;
  starting: boolean;
  startError: string;
  currentError: string;
  pollingError: string;
  onStart: () => void;
}) {
  const localJob = active?.kind === "local" ? active.job : null;
  const localJobIsTerminal = localJob ? isTerminalSttComparisonJob(localJob) : false;
  const blocksStart = checkingActive || starting || Boolean(currentError) || active?.kind === "external" || Boolean(localJob && !localJobIsTerminal);
  const selectedRecording = recordings.find((recording) => recording.id === selectedRecordingId) ?? null;
  const runs = localJob ? normalizedJobRuns(localJob) : [];
  const progress = localJob ? jobProgressPercent(localJob) : 0;

  return (
    <section aria-labelledby="stt-comparison-run-heading" className="mt-6 border-t border-white/[0.07] pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="stt-comparison-run-heading" className="text-sm font-extrabold text-white">A/B/C STT 비교 실행</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">저장된 WAV 하나를 세 조건으로 실행합니다. 조회·선택·새로고침은 실행을 시작하지 않습니다.</p>
        </div>
        <span className="rounded-full bg-rose-400/10 px-2.5 py-1 text-[10px] font-black text-rose-200">3 PAID STREAMS</span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="text-[11px] font-bold text-slate-500">
          비교할 저장 녹음
          <select
            aria-label="비교할 저장 녹음"
            value={selectedRecordingId}
            onChange={(event) => onSelectRecording(event.target.value)}
            disabled={recordings.length === 0 || blocksStart}
            className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-[#07111f] px-3 text-xs text-slate-200 outline-none focus:border-cyan-300 disabled:opacity-50"
          >
            {recordings.length === 0 ? <option value="">저장된 녹음 없음</option> : recordings.map((recording) => (
              <option key={recording.id} value={recording.id}>{recording.fileName} · {recording.speakerLabel}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onStart}
          disabled={!selectedRecording || !consent || blocksStart}
          className="danger-button !min-h-11 text-xs disabled:cursor-not-allowed disabled:opacity-40"
        >
          {starting ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
          {starting ? "비교 시작 요청 중" : "유료 비교 시작"}
        </button>
      </div>

      {selectedRecording ? <p className="mt-2 truncate text-[10px] text-slate-600">{selectedRecording.fileName} · {selectedRecording.environment} · {(selectedRecording.durationMs / 1_000).toFixed(1)}초</p> : null}

      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-rose-300/15 bg-rose-300/[0.05] p-3 text-xs leading-5 text-rose-100">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => onConsentChange(event.target.checked)}
          disabled={blocksStart}
          className="mt-0.5 size-4 shrink-0 accent-rose-300"
        />
        <span><strong className="block">명시적 유료 호출 동의</strong>이 실행은 정확히 3개의 유료 Google STT 스트림을 호출합니다.</span>
      </label>

      {active?.kind === "external" ? (
        <div role="status" className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] p-3 text-xs leading-5 text-amber-100">
          다른 실행 주체({active.job.owner})가 녹음 {active.job.recordingId} 비교를 실행 중입니다. 완료된 뒤 새로고침하세요.
        </div>
      ) : null}

      {localJob ? (
        <div className="mt-4 rounded-2xl border border-white/[0.07] bg-[#07111f]/65 p-4" aria-labelledby={`job-${localJob.id}-heading`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 id={`job-${localJob.id}-heading`} className="text-xs font-black text-slate-200">비교 작업 · {jobStateLabel(localJob.state)}</h4>
            <span className="text-[10px] font-black text-cyan-200">{Math.round(progress)}%</span>
          </div>
          <progress className="mt-3 h-2 w-full accent-cyan-300" value={progress} max={100} aria-label={`STT 비교 작업 진행률 ${Math.round(progress)}%`} />
          <p aria-live="polite" className="mt-2 min-h-4 text-[11px] leading-5 text-slate-400">
            {localJob.message || (localJob.activeRunLabel ? `${RUN_DETAILS[localJob.activeRunLabel].shortLabel} 조건 실행 중` : jobStateLabel(localJob.state))}
          </p>
          <ol className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="A/B/C 조건별 진행 상태">
            {runs.map((run) => {
              const failed = run.state === "error";
              return (
                <li key={run.label} className={`rounded-xl border p-3 text-[11px] leading-4 ${failed ? "border-rose-400/20 bg-rose-400/[0.07] text-rose-100" : "border-white/[0.06] bg-white/[0.025] text-slate-400"}`}>
                  <div className="flex items-center justify-between gap-2"><strong className="text-slate-200">{RUN_DETAILS[run.label].shortLabel}. {RUN_DETAILS[run.label].title}</strong><span>{runStateLabel(run.state)}</span></div>
                  {run.message ? <p className="mt-1">{run.message}</p> : null}
                  {run.error ? <p role="alert" className="mt-1 text-rose-200">오류: {run.error}</p> : null}
                </li>
              );
            })}
          </ol>
          {localJob.fatalError ? <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> 치명적 오류: {localJob.fatalError}</div> : null}
        </div>
      ) : null}

      {checkingActive ? <p role="status" className="mt-3 inline-flex items-center gap-2 text-xs text-slate-500"><LoaderCircle className="size-4 animate-spin" /> 실행 중인 작업 확인 중</p> : null}
      {currentError ? <div role="alert" className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] p-3 text-xs leading-5 text-amber-100">실행 상태 확인 오류: {currentError}</div> : null}
      {pollingError ? <div role="alert" className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100">작업 상태 갱신 오류: {pollingError} 자동으로 다시 확인합니다.</div> : null}
      {startError ? <div role="alert" className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100">비교 시작 오류: {startError}</div> : null}
    </section>
  );
}

export function SttComparisonResultsView({
  latest,
  reportCount,
  loading,
  error,
  onRefresh,
  history = [],
  selectedFileName = null,
  page,
  detailLoading = false,
  detailError = "",
  onSelectReport = () => undefined,
  onPreviousPage = () => undefined,
  onNextPage = () => undefined,
  mobileDetailOpen = false,
  detailFocusRequest = 0,
  onBackToList = () => undefined
}: {
  latest: ComparisonReportFile | null;
  reportCount: number;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  history?: SttComparisonHistoryItem[];
  selectedFileName?: string | null;
  page?: SttComparisonPage;
  detailLoading?: boolean;
  detailError?: string;
  onSelectReport?: (fileName: string) => void;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
  mobileDetailOpen?: boolean;
  detailFocusRequest?: number;
  onBackToList?: () => void;
}) {
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const offset = page?.offset ?? 0;
  const limit = page?.limit ?? HISTORY_PAGE_SIZE;
  const hasPrevious = offset > 0;
  const hasNext = page?.hasMore ?? offset + history.length < reportCount;

  useEffect(() => {
    if (detailFocusRequest > 0) detailHeadingRef.current?.focus();
  }, [detailFocusRequest]);

  return (
    <section aria-labelledby="stt-comparison-heading" className="mt-6 border-t border-white/[0.07] pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="stt-comparison-heading" className="text-sm font-extrabold text-white">저장된 STT 비교 결과</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">로컬 결과 기록을 페이지별로 읽고 선택합니다. 새로고침과 결과 선택은 유료 호출을 만들지 않습니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-white/[0.05] px-2.5 py-1 text-[10px] font-black text-slate-500">{reportCount}개</span>
          <button type="button" onClick={onRefresh} disabled={loading} className="secondary-button !min-h-10 text-xs disabled:opacity-40" aria-label="STT 비교 결과 새로고침">
            {loading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 새로고침
          </button>
        </div>
      </div>

      {error ? <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}</div> : null}

      <div className="mt-4 gap-4 lg:grid lg:grid-cols-[minmax(16rem,0.75fr)_minmax(0,1.75fr)] lg:items-start">
        <div
          data-testid="stt-results-list-pane"
          className={`${mobileDetailOpen ? "hidden" : "block"} min-w-0 lg:block`}
        >
          {history.length > 0 ? (
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
              <div className="space-y-1.5" aria-label="저장된 STT 비교 결과 기록">
                {history.map((item) => (
                  <button
                    key={item.fileName}
                    type="button"
                    onClick={() => onSelectReport(item.fileName)}
                    aria-current={selectedFileName === item.fileName ? "true" : undefined}
                    className={`flex min-h-10 w-full flex-col items-start gap-2 rounded-xl px-3 py-2 text-left text-[11px] transition ${selectedFileName === item.fileName ? "bg-cyan-300/10 text-cyan-100" : "bg-white/[0.025] text-slate-400 hover:bg-white/[0.05]"}`}
                  >
                    <span className="w-full truncate font-bold">{item.fileName}</span>
                    <span className="flex w-full flex-wrap items-center gap-1" aria-label="결과 메타데이터">
                      {historyBadgeLabels(item).map((label) => (
                        <span key={label} className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[9px] font-black text-slate-300">{label}</span>
                      ))}
                      <span className="ml-auto text-[10px] text-slate-500">{formatStoredAt(item.modifiedAt)}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <button type="button" onClick={onPreviousPage} disabled={!hasPrevious || loading} className="secondary-button !min-h-9 text-[11px] disabled:opacity-35"><ChevronLeft className="size-4" /> 이전</button>
                <span className="text-[10px] text-slate-500">{reportCount === 0 ? 0 : offset + 1}–{Math.min(offset + history.length, reportCount)} / {reportCount}</span>
                <button type="button" onClick={onNextPage} disabled={!hasNext || loading} className="secondary-button !min-h-9 text-[11px] disabled:opacity-35">다음 <ChevronRight className="size-4" /></button>
              </div>
            </div>
          ) : loading ? (
            <div role="status" className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4 text-xs text-slate-500"><LoaderCircle className="size-4 animate-spin" /> 결과 목록을 불러오는 중입니다.</div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/[0.09] px-4 py-6 text-center text-xs leading-6 text-slate-500">저장된 비교 결과가 없습니다.</div>
          )}
        </div>

        <section
          data-testid="stt-results-detail-pane"
          aria-labelledby="stt-comparison-detail-heading"
          className={`${mobileDetailOpen ? "block" : "hidden"} min-w-0 lg:block`}
        >
          <div data-testid="stt-results-mobile-back" className="mb-3 lg:hidden">
            <button type="button" onClick={onBackToList} className="secondary-button !min-h-10 text-xs"><ChevronLeft className="size-4" /> 결과 목록으로</button>
          </div>
          <h4 ref={detailHeadingRef} id="stt-comparison-detail-heading" tabIndex={-1} className="text-xs font-black text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">선택한 STT 비교 결과</h4>
          {detailError ? <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100">선택한 결과를 불러오지 못했습니다: {detailError}</div> : null}
          {(loading || detailLoading) && !latest ? (
            <div role="status" className="mt-4 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4 text-xs text-slate-500"><LoaderCircle className="size-4 animate-spin" /> 비교 결과를 불러오는 중입니다.</div>
          ) : !latest ? (
            <div className="mt-4 rounded-2xl border border-dashed border-white/[0.09] px-4 py-6 text-center text-xs leading-6 text-slate-500">
              {history.length > 0 ? "목록에서 확인할 결과를 선택해 주세요." : "저장된 비교 결과가 없습니다. 실행 화면에서 저장 녹음과 유료 호출 동의를 확인한 뒤 비교를 시작할 수 있습니다."}
            </div>
          ) : !isV3ComparisonReport(latest) ? (
            <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/[0.06] p-4">
              <h5 className="text-sm font-black text-amber-100">레거시 스모크 결과</h5>
              <p className="mt-1 text-xs leading-5 text-amber-100/70">버전 {latest.version} 결과에는 정확도 평가 계약이 없습니다. 지표를 추정하거나 TSV를 만들지 않습니다.</p>
            </div>
          ) : (
            <V3ComparisonReport report={latest} />
          )}
        </section>
      </div>
    </section>
  );
}

export function SttComparisonResults({ recordings, view, onResultReady }: SttComparisonResultsProps) {
  const mountedRef = useRef(true);
  const historyRequestRef = useRef(0);
  const currentRequestRef = useRef(0);
  const selectedFileNameRef = useRef<string | null>(null);
  const locallyStartedJobIdsRef = useRef(new Set<string>());
  const handledTerminalJobsRef = useRef(new Set<string>());

  const [selectedRecordingId, setSelectedRecordingId] = useState(() => defaultRecordingId(recordings));
  const [consent, setConsent] = useState(false);
  const [active, setActive] = useState<CurrentSttComparisonJob | null>(null);
  const [checkingActive, setCheckingActive] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [currentError, setCurrentError] = useState("");
  const [pollingError, setPollingError] = useState("");

  const [report, setReport] = useState<ComparisonReportFile | null>(null);
  const [reportCount, setReportCount] = useState(0);
  const [history, setHistory] = useState<SttComparisonHistoryItem[]>([]);
  const [page, setPage] = useState<SttComparisonPage>({ offset: 0, limit: HISTORY_PAGE_SIZE, hasMore: false });
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [detailFocusRequest, setDetailFocusRequest] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      historyRequestRef.current += 1;
      currentRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setSelectedRecordingId((current) => recordings.some((recording) => recording.id === current) ? current : defaultRecordingId(recordings));
  }, [recordings]);

  const selectReport = useCallback((fileName: string) => {
    const changed = selectedFileNameRef.current !== fileName;
    selectedFileNameRef.current = fileName;
    setSelectedFileName(fileName);
    if (changed) setReport(null);
  }, []);

  const openReport = useCallback((fileName: string) => {
    selectReport(fileName);
    setMobileDetailOpen(true);
    setDetailFocusRequest((current) => current + 1);
  }, [selectReport]);

  const loadHistory = useCallback(async (offset: number, preferredFileName?: string | null) => {
    const requestId = historyRequestRef.current + 1;
    historyRequestRef.current = requestId;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const next = await getSttComparisons({ offset, limit: HISTORY_PAGE_SIZE });
      if (!mountedRef.current || requestId !== historyRequestRef.current) return;
      const nextHistory = next.history ?? [];
      const nextPage = next.page ?? { offset, limit: HISTORY_PAGE_SIZE, hasMore: offset + nextHistory.length < next.reportCount };
      setReportCount(next.reportCount);
      setHistory(nextHistory);
      setPage(nextPage);

      const targetFileName = preferredFileName ?? selectedFileNameRef.current ?? next.latestFileName ?? nextHistory[0]?.fileName ?? null;
      if (targetFileName) {
        selectReport(targetFileName);
        if (targetFileName === next.latestFileName && next.latest) setReport(next.latest);
      } else {
        setReport(next.latest);
      }
    } catch (caught) {
      if (mountedRef.current && requestId === historyRequestRef.current) {
        setHistoryError(caught instanceof Error ? caught.message : "STT 비교 결과 기록을 불러오지 못했습니다.");
      }
    } finally {
      if (mountedRef.current && requestId === historyRequestRef.current) setHistoryLoading(false);
    }
  }, [selectReport]);

  const loadCurrent = useCallback(async () => {
    const requestId = currentRequestRef.current + 1;
    currentRequestRef.current = requestId;
    setCheckingActive(true);
    setCurrentError("");
    try {
      const next = await getCurrentSttComparisonJob();
      if (mountedRef.current && requestId === currentRequestRef.current) {
        registerDiscoveredLocalJob(next.active, locallyStartedJobIdsRef.current);
        setActive(next.active);
      }
    } catch (caught) {
      if (mountedRef.current && requestId === currentRequestRef.current) {
        setCurrentError(caught instanceof Error ? caught.message : "실행 중인 비교 작업을 확인하지 못했습니다.");
      }
    } finally {
      if (mountedRef.current && requestId === currentRequestRef.current) setCheckingActive(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory(0);
    void loadCurrent();
  }, [loadCurrent, loadHistory]);

  useEffect(() => {
    if (!selectedFileName) return;
    let live = true;
    setDetailLoading(true);
    setDetailError("");
    void getSttComparison(selectedFileName)
      .then((detail) => {
        if (live && mountedRef.current && selectedFileNameRef.current === detail.fileName) setReport(detail.report);
      })
      .catch((caught) => {
        if (live && mountedRef.current) setDetailError(caught instanceof Error ? caught.message : "선택한 STT 비교 결과를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (live && mountedRef.current) setDetailLoading(false);
      });
    return () => {
      live = false;
    };
  }, [selectedFileName]);

  const localJob = active?.kind === "local" ? active.job : null;
  const localJobId = localJob?.id ?? null;
  const localJobIsTerminal = localJob ? isTerminalSttComparisonJob(localJob) : false;

  useEffect(() => {
    if (!localJobId || localJobIsTerminal) return;
    let stopped = false;
    let timer: number | null = null;

    const poll = async () => {
      try {
        const next = await getSttComparisonJob(localJobId);
        if (stopped || !mountedRef.current) return;
        setActive({ kind: "local", job: next.job });
        setPollingError("");
        if (!isTerminalSttComparisonJob(next.job)) timer = window.setTimeout(() => void poll(), JOB_POLL_INTERVAL_MS);
      } catch (caught) {
        if (stopped || !mountedRef.current) return;
        setPollingError(caught instanceof Error ? caught.message : "작업 상태를 갱신하지 못했습니다.");
        timer = window.setTimeout(() => void poll(), JOB_POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(() => void poll(), JOB_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [localJobId, localJobIsTerminal]);

  useEffect(() => {
    handleLocalTerminalResultOnce({
      job: localJob,
      locallyStartedJobIds: locallyStartedJobIdsRef.current,
      handledJobIds: handledTerminalJobsRef.current,
      selectResult: (fileName) => {
        selectedFileNameRef.current = fileName;
        setSelectedFileName(fileName);
        setReport(null);
        setMobileDetailOpen(true);
        setDetailFocusRequest((current) => current + 1);
      },
      refreshHistory: (fileName) => {
        void loadHistory(0, fileName);
      },
      onResultReady
    });
  }, [loadHistory, localJob, onResultReady]);

  const startComparison = async () => {
    if (!selectedRecordingId || !consent || starting) return;
    setStarting(true);
    setStartError("");
    setPollingError("");
    try {
      const job = await startSttComparisonAttempt({
        recordingId: selectedRecordingId,
        loadCurrent,
        resetConsent: () => {
          if (mountedRef.current) setConsent(false);
        }
      });
      if (mountedRef.current) {
        locallyStartedJobIdsRef.current.add(job.id);
        setActive({ kind: "local", job });
      }
    } catch (caught) {
      if (mountedRef.current) {
        setStartError(caught instanceof Error ? caught.message : "STT 비교 작업을 시작하지 못했습니다.");
      }
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  const refresh = () => {
    void loadCurrent();
    void loadHistory(page.offset);
  };

  return view === "run" ? (
    <SttComparisonJobPanel
      recordings={recordings}
      selectedRecordingId={selectedRecordingId}
      onSelectRecording={setSelectedRecordingId}
      consent={consent}
      onConsentChange={setConsent}
      active={active}
      checkingActive={checkingActive}
      starting={starting}
      startError={startError}
      currentError={currentError}
      pollingError={pollingError}
      onStart={() => void startComparison()}
    />
  ) : (
    <SttComparisonResultsView
      latest={report}
      reportCount={reportCount}
      loading={historyLoading}
      error={historyError}
      onRefresh={refresh}
      history={history}
      selectedFileName={selectedFileName}
      page={page}
      detailLoading={detailLoading}
      detailError={detailError}
      onSelectReport={openReport}
      onPreviousPage={() => void loadHistory(Math.max(0, page.offset - page.limit))}
      onNextPage={() => void loadHistory(page.offset + page.limit)}
      mobileDetailOpen={mobileDetailOpen}
      detailFocusRequest={detailFocusRequest}
      onBackToList={() => setMobileDetailOpen(false)}
    />
  );
}

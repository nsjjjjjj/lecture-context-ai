import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clipboard, LoaderCircle, RefreshCw } from "lucide-react";
import {
  comparisonRunLabels,
  getSttComparisons,
  type ComparisonReportFile,
  type ComparisonReportV3,
  type ComparisonRunLabel,
  type ComparisonRunResult
} from "../lib/api";

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
  return "세 조건이 모두 정상 완료된 정확도 평가입니다. 논문용 TSV를 복사할 수 있습니다.";
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
          {paperReady ? "PUBLICATION READY" : "NOT FOR PUBLICATION"}
        </span>
      </div>

      <div role={paperReady ? "status" : "alert"} className={`rounded-xl border p-3 text-xs leading-5 ${paperReady ? "border-emerald-300/15 bg-emerald-300/[0.06] text-emerald-100" : "border-amber-300/20 bg-amber-300/[0.08] text-amber-100"}`}>
        {publicationStatusMessage(report)}
      </div>

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

export function SttComparisonResultsView({
  latest,
  reportCount,
  loading,
  error,
  onRefresh
}: {
  latest: ComparisonReportFile | null;
  reportCount: number;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  return (
    <section aria-labelledby="stt-comparison-heading" className="mt-6 border-t border-white/[0.07] pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="stt-comparison-heading" className="text-sm font-extrabold text-white">저장된 STT 비교 결과</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">로컬 결과 파일만 읽습니다. 이 화면에서 유료 STT API를 실행하지 않습니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-white/[0.05] px-2.5 py-1 text-[10px] font-black text-slate-500">{reportCount}개</span>
          <button type="button" onClick={onRefresh} disabled={loading} className="secondary-button !min-h-10 text-xs disabled:opacity-40" aria-label="최신 STT 비교 결과 새로고침">
            {loading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} 새로고침
          </button>
        </div>
      </div>

      {error ? <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}</div> : null}
      {loading && !latest ? (
        <div role="status" className="mt-4 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4 text-xs text-slate-500"><LoaderCircle className="size-4 animate-spin" /> 최신 비교 결과를 불러오는 중입니다.</div>
      ) : !latest ? (
        <div className="mt-4 rounded-2xl border border-dashed border-white/[0.09] px-4 py-6 text-center text-xs leading-6 text-slate-500">
          저장된 비교 결과가 없습니다.<br />터미널에서 <code className="rounded bg-white/[0.06] px-1.5 py-1 text-slate-200">pnpm stt:compare</code>를 실행한 뒤 새로고침하세요.
        </div>
      ) : !isV3ComparisonReport(latest) ? (
        <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/[0.06] p-4">
          <h4 className="text-sm font-black text-amber-100">레거시 스모크 결과</h4>
          <p className="mt-1 text-xs leading-5 text-amber-100/70">버전 {latest.version} 결과에는 정확도 평가 계약이 없습니다. 지표를 추정하지 않으며, 최신 비교는 <code>pnpm stt:compare</code>로 생성할 수 있습니다.</p>
        </div>
      ) : (
        <V3ComparisonReport report={latest} />
      )}
    </section>
  );
}

export function SttComparisonResults() {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [result, setResult] = useState<{ latest: ComparisonReportFile | null; reportCount: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void getSttComparisons()
      .then((nextResult) => {
        if (active) setResult(nextResult);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "STT 비교 결과를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshVersion]);

  return (
    <SttComparisonResultsView
      latest={result?.latest ?? null}
      reportCount={result?.reportCount ?? 0}
      loading={loading}
      error={error}
      onRefresh={() => setRefreshVersion((version) => version + 1)}
    />
  );
}

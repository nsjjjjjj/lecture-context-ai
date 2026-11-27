import { useMemo } from "react";
import {
  ArrowLeft,
  Download,
  Gauge,
  MonitorUp,
  RotateCcw
} from "lucide-react";
import { TranscriptResultsList } from "../../components/TranscriptResultsList";
import type { LectureSessionOutcome } from "../../hooks/lecture-stream-state";
import {
  forEachTranscriptLine,
  type TranscriptStore
} from "../../hooks/transcript-store";
import type { AnalysisResult } from "../../types";
import type { SessionExportStatus } from "../results/session-export";
import { APP_MAIN_CONTENT_ID } from "./lecture-screen-contract";

export function ResultsScreen({
  analysis,
  transcript,
  outcome,
  lastMode,
  exportState,
  exportActions,
  onRestart,
  onReady,
  onHome
}: {
  analysis: AnalysisResult;
  transcript: TranscriptStore;
  outcome: LectureSessionOutcome | null;
  lastMode: "live" | "demo";
  exportState: { status: SessionExportStatus; busy: boolean; error: string };
  exportActions: { json: () => void; text: () => void; confirm: () => void };
  onRestart: () => void;
  onReady: () => void;
  onHome: () => void;
}) {
  const { detectedTerms, contextRate } = useMemo(() => {
    const detectedIds = new Set<string>();
    forEachTranscriptLine(transcript, (line) => {
      for (const termId of line.termIds) detectedIds.add(termId);
    });
    const terms = analysis.terms.filter((term) => detectedIds.has(term.id));
    return {
      detectedTerms: terms,
      contextRate: analysis.terms.length ? Math.round((terms.length / analysis.terms.length) * 100) : 0
    };
  }, [analysis.terms, transcript]);

  return (
    <main id={APP_MAIN_CONTENT_ID} className="mx-auto max-w-[1180px] px-5 py-12 outline-none sm:px-8 sm:py-16" data-app-stage="results" tabIndex={-1}>
      <div className="eyebrow"><Gauge className="size-3.5" /> SESSION REPORT</div>
      <div className="mt-5 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-4xl font-black tracking-[-0.055em] text-white sm:text-5xl">강연 자막 결과</h2>
          <p className="mt-3 text-sm text-slate-500">실제 정확도 비교는 기준 자막이 있는 평가 음원을 사용해 측정합니다.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={exportState.busy} onClick={exportActions.json} className="secondary-button">
            <Download className="size-4" /> 결과 JSON 저장
          </button>
          <button type="button" disabled={exportState.busy} onClick={exportActions.text} className="secondary-button">
            <Download className="size-4" /> 자막 TXT 저장
          </button>
          <button type="button" onClick={onHome} className="secondary-button"><ArrowLeft className="size-4" /> 처음으로</button>
          <button type="button" onClick={onReady} className="secondary-button"><MonitorUp className="size-4" /> 준비 화면</button>
          <button type="button" onClick={onRestart} className="primary-button"><RotateCcw className="size-4" /> {lastMode === "live" ? "실시간 다시 시작" : "데모 다시 보기"}</button>
        </div>
      </div>

      <div
        className={`mt-5 rounded-2xl border p-4 text-sm leading-6 ${exportState.status === "confirmed" ? "border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-100" : "border-amber-300/20 bg-amber-300/[0.07] text-amber-100"}`}
        role="status"
        aria-busy={exportState.busy}
      >
        {exportState.status === "confirmed" ? (
          "파일 생성을 확인했습니다. PDF와 음성은 결과 파일에 포함되지 않습니다."
        ) : exportState.status === "download-requested" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>브라우저에 다운로드를 요청했습니다. 다운로드 목록에서 파일이 생성됐는지 확인하기 전까지 나가기 경고를 유지합니다.</span>
            <button type="button" onClick={exportActions.confirm} className="secondary-button !min-h-10 !px-3 !py-2 text-xs">
              다운로드 파일 생성 확인
            </button>
          </div>
        ) : exportState.busy ? (
          "결과 파일을 쓰고 있습니다."
        ) : (
          "자막 결과는 브라우저에 영구 저장되지 않습니다. 파일 생성을 확인하지 않고 나가면 확인 창이 표시됩니다."
        )}
      </div>
      {exportState.error ? <p className="mt-3 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-100" role="alert">{exportState.error}</p> : null}

      {outcome?.status === "flush-timeout" ? (
        <div className="mt-6 rounded-2xl border border-amber-300/25 bg-amber-300/[0.08] p-4 text-sm leading-6 text-amber-100" role="alert">
          <strong className="block">마지막 자막이 완전히 확정되지 않았습니다.</strong>
          <span>{outcome.message} 아래 결과에는 서버가 확정해 보낸 구간만 표시됩니다.</span>
        </div>
      ) : outcome?.status === "transport-error" ? (
        <div className="mt-6 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4 text-sm leading-6 text-rose-100" role="alert">
          <strong className="block">자막 연결이 정상적으로 끝나지 않았습니다.</strong>
          <span>{outcome.message} 아래 결과에는 오류 전까지 확정된 구간만 표시됩니다.</span>
        </div>
      ) : outcome?.status === "completed" && outcome.reason === "server-ended" ? (
        <div className="mt-6 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.07] p-4 text-sm text-emerald-100" role="status">
          {lastMode === "demo"
            ? "데모 자막 스트림이 끝났고 마지막 확정 자막까지 수신했습니다."
            : "AWS 자막 스트림이 끝났고 마지막 확정 자막까지 수신했습니다."}
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] p-4 text-sm text-amber-100" role="status">
          종료 상태를 확인하지 못했습니다. 아래에는 수신된 확정 자막만 표시됩니다.
        </div>
      )}

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {[
          [transcript.lineCount, "확정 자막", "구간"],
          [detectedTerms.length, "등장한 전문용어", `전체 ${analysis.terms.length}개`],
          [analysis.phraseSet.length, "자료에서 검증된 표기", lastMode === "demo" ? "데모 자막 매칭에 사용" : analysis.vocabularyName ? "AWS 사용자 지정 용어집 사용" : "AWS 기본 자막 사용"]
        ].map(([value, label, unit]) => (
          <div key={String(label)} className="rounded-[1.6rem] border border-white/[0.08] bg-white/[0.035] p-6">
            <div className="text-4xl font-black tracking-[-0.04em] text-white">{value}</div>
            <div className="mt-5 text-sm font-extrabold text-slate-300">{label}</div>
            <div className="mt-1 text-xs text-slate-600">{unit}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[.65fr_1.35fr]">
        <section className="rounded-[1.6rem] border border-cyan-300/15 bg-cyan-300/[0.055] p-6">
          <div className="text-xs font-extrabold tracking-[0.15em] text-cyan-300">용어집 등장률</div>
          <div className="mt-6 flex items-end gap-2"><span className="text-6xl font-black tracking-[-0.07em] text-white">{Math.min(contextRate, 100)}</span><span className="pb-2 text-xl font-black text-slate-500">%</span></div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-cyan-300" style={{ width: `${Math.min(contextRate, 100)}%` }} /></div>
          <p className="mt-5 text-xs leading-5 text-slate-500">분석된 전체 전문용어 가운데 이번 자막에 등장한 용어의 비율입니다.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {detectedTerms.map((term) => <span key={term.id} className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-bold text-slate-300">{term.term}</span>)}
          </div>
        </section>

        <section className="rounded-[1.6rem] border border-white/[0.08] bg-white/[0.035] p-6">
          <div className="flex items-center justify-between"><div className="text-sm font-extrabold text-white">확정 자막 목록</div><div className="text-xs text-slate-600">실시간 강연 음성은 저장하지 않음</div></div>
          <TranscriptResultsList transcript={transcript} terms={analysis.terms} />
        </section>
      </div>
    </main>
  );
}



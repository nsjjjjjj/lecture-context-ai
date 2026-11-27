import { Check, LoaderCircle, WandSparkles, X } from "lucide-react";
import {
  ANALYSIS_STEP_ORDER,
  analysisProgressPercent,
  completedAnalysisStepCount,
  type AnalysisStep,
  type AnalysisStepState
} from "../analysis/analysis-workflow";
import { APP_MAIN_CONTENT_ID } from "./lecture-screen-contract";

export function AnalyzingScreen({
  fileName,
  stepState,
  source = "pdf"
}: {
  fileName: string;
  stepState: AnalysisStepState;
  source?: "pdf" | "demo";
}) {
  const steps: Array<{ step: AnalysisStep; label: string }> = [
    { step: "extract", label: source === "demo" ? "샘플 데이터 불러오기" : "PDF 텍스트 추출" },
    { step: "analyze", label: source === "demo" ? "샘플 용어집 검증" : "전문용어 자동 선별" },
    { step: "store", label: "브라우저 용어집 검증·저장" }
  ];
  const completedCount = completedAnalysisStepCount(stepState);
  const progress = analysisProgressPercent(stepState);
  const activeStep = steps.find(({ step }) => stepState[step] === "active");
  const failedStep = steps.find(({ step }) => stepState[step] === "failed");
  const liveMessage = failedStep
    ? `${failedStep.label} 단계에 실패했습니다. ${completedCount}단계 완료.`
    : activeStep
      ? `${completedCount}단계 완료. ${activeStep.label} 진행 중.`
      : `${completedCount}단계 모두 완료.`;
  return (
    <main id={APP_MAIN_CONTENT_ID} className="mx-auto grid min-h-[calc(100vh-80px)] max-w-[900px] place-items-center px-5 py-16 outline-none" data-app-stage="analyzing" tabIndex={-1}>
      <div className="w-full rounded-[2rem] border border-white/[0.08] bg-white/[0.035] p-8 text-center sm:p-12">
        <div className="relative mx-auto size-28">
          <div className="absolute inset-0 animate-pulse rounded-full bg-cyan-300/20 blur-2xl motion-reduce:animate-none" />
          <div className="relative grid size-28 place-items-center rounded-full border border-cyan-300/20 bg-[#0b1727]">
            <WandSparkles className="size-10 text-cyan-300" />
          </div>
        </div>
        <div className="mt-8 text-xs font-extrabold tracking-[0.2em] text-cyan-300">{source === "demo" ? "DEMO PREPARATION" : "PDF ANALYSIS"}</div>
        <h2 className="mt-3 text-3xl font-black tracking-[-0.045em] text-white sm:text-4xl">{source === "demo" ? "샘플 강연을 준비하고 있어요" : "강연 자료에서 전문용어를 찾고 있어요"}</h2>
        <p className="mx-auto mt-3 max-w-[560px] truncate text-sm text-slate-500">{fileName}</p>
        <div
          className="mx-auto mt-10 h-2 max-w-[580px] overflow-hidden rounded-full bg-white/[0.06]"
          role="progressbar"
          aria-label="PDF 분석 진행률"
          aria-valuemin={0}
          aria-valuemax={ANALYSIS_STEP_ORDER.length}
          aria-valuenow={completedCount}
          aria-valuetext={`${ANALYSIS_STEP_ORDER.length}단계 중 ${completedCount}단계 완료`}
        >
          <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-blue-400 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</p>
        <div className="mx-auto mt-8 grid max-w-[650px] gap-3 text-left sm:grid-cols-3" aria-label="PDF 분석 단계">
          {steps.map(({ step, label }, index) => {
            const status = stepState[step];
            const complete = status === "complete";
            const active = status === "active";
            const failed = status === "failed";
            const statusLabel = complete ? "완료" : active ? "진행 중" : failed ? "실패" : "대기";
            return (
            <div
              key={step}
              data-analysis-step={step}
              data-analysis-step-status={status}
              className={`flex items-center gap-3 rounded-2xl border p-4 transition motion-reduce:transition-none ${complete ? "border-emerald-300/20 bg-emerald-300/[0.06]" : failed ? "border-rose-400/20 bg-rose-400/[0.07]" : active ? "border-cyan-300/20 bg-cyan-300/[0.05]" : "border-white/[0.06] bg-white/[0.025]"}`}
            >
              <div className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-black ${complete ? "bg-emerald-300 text-slate-950" : failed ? "bg-rose-300 text-slate-950" : active ? "bg-cyan-300 text-slate-950" : "bg-white/[0.07] text-slate-500"}`}>
                {complete ? <Check className="size-4" aria-hidden="true" /> : failed ? <X className="size-4" aria-hidden="true" /> : active ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : index + 1}
              </div>
              <span className={`text-xs font-bold ${complete ? "text-emerald-100" : failed ? "text-rose-100" : active ? "text-cyan-100" : "text-slate-500"}`}>
                {label}<span className="sr-only"> — {statusLabel}</span>
              </span>
            </div>
          );})}
        </div>
      </div>
    </main>
  );
}



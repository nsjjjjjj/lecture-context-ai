import { createAbortError, isAbortError, throwIfAborted } from "../../lib/abort";

export const ANALYSIS_STEP_ORDER = ["extract", "analyze", "store"] as const;
export type AnalysisStep = typeof ANALYSIS_STEP_ORDER[number];
export type AnalysisStepStatus = "pending" | "active" | "complete" | "failed";
export type AnalysisStepState = Record<AnalysisStep, AnalysisStepStatus>;

export function createAnalysisStepState(activeStep: AnalysisStep = "extract"): AnalysisStepState {
  const activeIndex = ANALYSIS_STEP_ORDER.indexOf(activeStep);
  return Object.fromEntries(ANALYSIS_STEP_ORDER.map((step, index) => [
    step,
    index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending"
  ])) as AnalysisStepState;
}

export function completedAnalysisStepCount(state: AnalysisStepState): number {
  return ANALYSIS_STEP_ORDER.filter((step) => state[step] === "complete").length;
}

export function analysisProgressPercent(state: AnalysisStepState): number {
  return Math.round((completedAnalysisStepCount(state) / ANALYSIS_STEP_ORDER.length) * 100);
}

export type AnalysisStorageOutcome<TReady> = {
  readyValue: TReady;
  completed: boolean;
};

export type RunAnalysisStepsOptions<TPages, TAnalysis, TReady> = {
  extract: () => Promise<TPages>;
  analyze: (pages: TPages) => Promise<TAnalysis>;
  store: (analysis: TAnalysis) => Promise<AnalysisStorageOutcome<TReady>> | AnalysisStorageOutcome<TReady>;
  onStateChange: (state: AnalysisStepState) => void;
  signal?: AbortSignal;
  waitForPresentation?: () => Promise<void>;
};

/** Gives React one rendering opportunity without adding artificial latency. */
export function waitForAnalysisStepPresentation(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let frame = 0;
    const onAbort = () => {
      window.cancelAnimationFrame(frame);
      reject(signal?.reason instanceof Error ? signal.reason : createAbortError());
    };
    frame = window.requestAnimationFrame(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runPdfAnalysisSteps<TPages, TAnalysis, TReady>({
  extract,
  analyze,
  store,
  onStateChange,
  signal,
  waitForPresentation = () => waitForAnalysisStepPresentation(signal)
}: RunAnalysisStepsOptions<TPages, TAnalysis, TReady>): Promise<TReady> {
  let state = createAnalysisStepState();
  const publish = (nextState: AnalysisStepState) => {
    throwIfAborted(signal);
    state = nextState;
    onStateChange({ ...state });
  };
  const wait = async () => {
    await waitForPresentation();
    throwIfAborted(signal);
  };
  const fail = (step: AnalysisStep) => publish({ ...state, [step]: "failed" });
  const handleFailure = async (step: AnalysisStep, caught: unknown): Promise<never> => {
    if (signal?.aborted || isAbortError(caught)) throw caught;
    fail(step);
    await wait();
    throw caught;
  };

  publish(state);

  let pages: TPages;
  try {
    pages = await extract();
    throwIfAborted(signal);
  } catch (caught) {
    return handleFailure("extract", caught);
  }
  publish({ extract: "complete", analyze: "active", store: "pending" });
  await wait();

  let analysis: TAnalysis;
  try {
    analysis = await analyze(pages);
    throwIfAborted(signal);
  } catch (caught) {
    return handleFailure("analyze", caught);
  }
  publish({ extract: "complete", analyze: "complete", store: "active" });
  await wait();

  let storageOutcome: AnalysisStorageOutcome<TReady>;
  try {
    storageOutcome = await store(analysis);
    throwIfAborted(signal);
  } catch (caught) {
    return handleFailure("store", caught);
  }
  publish({
    extract: "complete",
    analyze: "complete",
    store: storageOutcome.completed ? "complete" : "failed"
  });
  await wait();
  return storageOutcome.readyValue;
}

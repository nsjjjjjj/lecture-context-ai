import type { AnalysisResult } from "../../types";
import {
  runPdfAnalysisSteps,
  type AnalysisStepState
} from "./analysis-workflow";

export type AnalysisEntrySource<Extracted> = {
  kind: "pdf" | "demo";
  fileName: string;
  sourceFile: File | null;
  fallbackGlossaryName: string;
  extract: (signal: AbortSignal) => Promise<Extracted>;
  analyze: (extracted: Extracted, signal: AbortSignal) => Promise<AnalysisResult>;
};

export type AnalysisEntryStoreResult = {
  readyValue: AnalysisResult;
  completed: boolean;
};

export async function runAnalysisEntryWorkflow<Extracted>({
  source,
  store,
  onStateChange,
  signal
}: {
  source: AnalysisEntrySource<Extracted>;
  store: (result: AnalysisResult, fallbackName: string, signal: AbortSignal) => Promise<AnalysisEntryStoreResult>;
  onStateChange: (state: AnalysisStepState) => void;
  signal: AbortSignal;
}): Promise<AnalysisResult> {
  return runPdfAnalysisSteps({
    extract: () => source.extract(signal),
    analyze: (extracted) => source.analyze(extracted, signal),
    store: (result) => store(result, source.fallbackGlossaryName, signal),
    onStateChange,
    signal
  });
}

import {
  GLOSSARY_STORAGE_KEY,
  GLOSSARY_STORAGE_RECOVERY_KEY,
  loadStoredGlossaryForLecture,
  type GlossaryStorageAdapter
} from "./lib/glossary-storage";
import type { AnalysisResult } from "./types";

export type AppStage = "upload" | "analyzing" | "ready" | "live" | "results";

export type StoredGlossaryReadyState = {
  stage: "ready";
  fileName: string;
  analysis: AnalysisResult;
};

export function loadStoredGlossaryReadyState(storage: GlossaryStorageAdapter, id: string): StoredGlossaryReadyState {
  const analysis = loadStoredGlossaryForLecture(storage, id);
  return {
    stage: "ready",
    fileName: analysis.title,
    analysis
  };
}

export function requireNonEmptyGlossary(analysis: AnalysisResult): AnalysisResult {
  if (analysis.terms.length === 0) {
    throw new Error("PDF에서 저장할 전문용어를 찾지 못했습니다. 전문용어가 포함된 자료를 사용해 주세요.");
  }
  return analysis;
}

export function shouldSyncGlossaryStorageEvent(key: string | null): boolean {
  return key === null || key === GLOSSARY_STORAGE_KEY || key === GLOSSARY_STORAGE_RECOVERY_KEY;
}

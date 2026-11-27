import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { analyzePdf, getDemo, getHealth, prepareAwsVocabulary } from "./lib/api";
import {
  loadStoredGlossaryReadyState,
  requireNonEmptyGlossary,
  shouldSyncGlossaryStorageEvent,
  type AppStage as Stage
} from "./app-state";
import {
  clearGlossaryStorageBackups,
  deleteStoredGlossary,
  exportGlossaryStorageRecoveryBundle,
  glossaryStorageIssue,
  listGlossaryStorageBackups,
  listStoredGlossaries,
  recoverStoredGlossaryData,
  renameStoredGlossary,
  saveAnalyzedGlossary,
  type GlossaryStorageBackup,
  type GlossaryStorageIssue,
  type StoredGlossary
} from "./lib/glossary-storage";
import { withGlossaryStorageLock } from "./lib/glossary-storage-lock";
import { useLectureStream } from "./hooks/useLectureStream";
import { useExclusiveActionGate } from "./hooks/useExclusiveActionGate";
import { shouldTransitionToResults } from "./hooks/lecture-stream-state";
import { materializeTranscriptLines } from "./hooks/transcript-store";
import { extractPdfPages } from "./lib/pdf";
import { isAbortError, throwIfAborted } from "./lib/abort";
import {
  createAnalysisStepState,
  type AnalysisStepState
} from "./features/analysis/analysis-workflow";
import {
  runAnalysisEntryWorkflow,
  type AnalysisEntrySource
} from "./features/analysis/analysis-entry-workflow";
import {
  createPresentationAsset,
  disposePresentationAsset,
  type PresentationAsset
} from "./lib/presentation";
import type {
  AnalysisResult,
  GlossaryTerm,
  ServiceConfigurationStatus,
  ServiceStatus
} from "./types";
import { appRouteHash, LECTURE_ROUTE, resolveAppRoute, type AppRoute } from "./app-route";
import type { FontScale } from "./features/captions/live-caption-model";
import { presentationUploadFailureMessage } from "./features/upload/upload-card-model";
import {
  safeSessionExportBaseName,
  serializeLectureSessionJson,
  serializeLectureTranscriptText,
  shouldConfirmSessionDiscard,
  type SessionExportStatus
} from "./features/results/session-export";
import { requestTextDownload, saveTextFile } from "./features/results/file-export";
import { AnalyzingScreen } from "./features/lecture/lecture-analyzing-screen";
import { Header } from "./features/lecture/lecture-header";
import {
  ReadyScreen,
  type LectureStartState
} from "./features/lecture/lecture-ready-screen";
import { UploadScreen } from "./features/lecture/lecture-upload-screen";
import { LiveScreen } from "./features/lecture/lecture-live-screen";
import { ResultsScreen } from "./features/lecture/lecture-results-screen";
import { APP_MAIN_CONTENT_ID } from "./features/lecture/lecture-screen-contract";

export {
  AnalyzingScreen
} from "./features/lecture/lecture-analyzing-screen";
export { Header } from "./features/lecture/lecture-header";
export {
  PresentationUploadCard,
  ReadyScreen
} from "./features/lecture/lecture-ready-screen";
export type {
  LectureStartState,
  ReadyScreenActions,
  ReadyScreenState
} from "./features/lecture/lecture-ready-screen";
export {
  LiveCaptionRows,
  LiveCaptionSlot,
  LiveScreen
} from "./features/lecture/lecture-live-screen";
export type { FinalCaptionAnnouncement } from "./features/lecture/lecture-live-screen";
export { ResultsScreen } from "./features/lecture/lecture-results-screen";

const LazyExperimentWorkspace = import.meta.env.DEV
  ? lazy(async () => {
      const module = await import("./components/ExperimentWorkspace");
      return { default: module.ExperimentWorkspace };
    })
  : null;

const EMPTY_GLOSSARY_TERMS: GlossaryTerm[] = [];
const EMPTY_PHRASE_SET: string[] = [];
const UNCONFIGURED_SERVICE_STATUS: ServiceConfigurationStatus = {
  configured: false,
  verification: "unverified"
};
export function App({ initialHash }: { initialHash?: string } = {}) {
  const development = import.meta.env.DEV;
  const [route, setRoute] = useState<AppRoute>(() => resolveAppRoute(
    initialHash ?? (typeof window === "undefined" ? "#/lecture" : window.location.hash),
    development
  ));
  const [routeFocusRequest, setRouteFocusRequest] = useState(0);
  const [stage, setStage] = useState<Stage>("upload");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [sessionAnalysis, setSessionAnalysis] = useState<AnalysisResult | null>(null);
  const [excludedTermIds, setExcludedTermIds] = useState<string[]>([]);
  const [analysisSourceFile, setAnalysisSourceFile] = useState<File | null>(null);
  const [presentation, setPresentation] = useState<PresentationAsset | null>(null);
  const [presentationBusy, setPresentationBusy] = useState(false);
  const [presentationError, setPresentationError] = useState("");
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [serviceCheckState, setServiceCheckState] = useState<"checking" | "ready" | "error">("checking");
  const [error, setError] = useState("");
  const [analysisStepState, setAnalysisStepState] = useState<AnalysisStepState>(() => createAnalysisStepState());
  const [analysisWorkflowSource, setAnalysisWorkflowSource] = useState<"pdf" | "demo">("pdf");
  const [fileName, setFileName] = useState("");
  const [storedGlossaries, setStoredGlossaries] = useState<StoredGlossary[]>([]);
  const [activeGlossaryId, setActiveGlossaryId] = useState<string | null>(null);
  const [libraryIssue, setLibraryIssue] = useState<GlossaryStorageIssue | null>(null);
  const [analysisStorageIssue, setAnalysisStorageIssue] = useState<GlossaryStorageIssue | null>(null);
  const [storageRecoveryBackups, setStorageRecoveryBackups] = useState<GlossaryStorageBackup[]>([]);
  const [storageRecoveryIssue, setStorageRecoveryIssue] = useState<GlossaryStorageIssue | null>(null);
  const [storageRecoveryNotice, setStorageRecoveryNotice] = useState("");
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const [loadingGlossaryId, setLoadingGlossaryId] = useState<string | null>(null);
  const [lectureStartState, setLectureStartState] = useState<LectureStartState>({ status: "idle" });
  const [lastLectureConfig, setLastLectureConfig] = useState<{ mode: "live" | "demo"; withoutVocabulary: boolean }>({
    mode: "demo",
    withoutVocabulary: false
  });
  const [fontScale, setFontScale] = useState<FontScale>("normal");
  const [highContrast, setHighContrast] = useState(false);
  const [resultExportStatus, setResultExportStatus] = useState<SessionExportStatus>("not-exported");
  const [resultExportError, setResultExportError] = useState("");
  const storageMutation = useExclusiveActionGate();
  const resultExport = useExclusiveActionGate();
  const effectiveAnalysis = useMemo(() => {
    if (!analysis) return null;
    const excluded = new Set(excludedTermIds);
    const terms = analysis.terms.filter((term) => !excluded.has(term.id));
    const allowedForms = new Set(terms.flatMap((term) => [term.term, term.english, ...term.spokenAliases])
      .map((form) => form.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ko-KR"))
      .filter(Boolean));
    return {
      ...analysis,
      terms,
      phraseSet: analysis.phraseSet.filter((phrase) => allowedForms.has(
        phrase.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ko-KR")
      ))
    };
  }, [analysis, excludedTermIds]);
  const stream = useLectureStream(
    effectiveAnalysis?.terms ?? EMPTY_GLOSSARY_TERMS,
    effectiveAnalysis?.phraseSet ?? EMPTY_PHRASE_SET
  );
  const resultDiscardConfirmationRequired = shouldConfirmSessionDiscard(
    stage,
    stream.transcript.lineCount,
    resultExportStatus
  );
  const previousStreamStatusRef = useRef(stream.status);
  const previousFocusSignatureRef = useRef(`${route.page}:${stage}`);
  const analysisOperationRef = useRef<AbortController | null>(null);
  const lectureStartOperationRef = useRef<AbortController | null>(null);
  const healthAbortRef = useRef<AbortController | null>(null);
  const presentationRef = useRef<PresentationAsset | null>(null);
  const presentationRequestRef = useRef(0);
  const presentationAbortRef = useRef<AbortController | null>(null);
  const experimentNavigationBlocked = stage === "analyzing" || stage === "live" || lectureStartState.status === "preparing";
  const experimentNavigationBlockedRef = useRef(experimentNavigationBlocked);
  experimentNavigationBlockedRef.current = experimentNavigationBlocked;

  const refreshStorageRecovery = useCallback(() => {
    try {
      setStorageRecoveryBackups(listGlossaryStorageBackups(window.localStorage));
      setStorageRecoveryIssue(null);
    } catch (caught) {
      setStorageRecoveryIssue(glossaryStorageIssue(caught));
    }
  }, []);

  useEffect(() => {
    if (!experimentNavigationBlocked && !resultDiscardConfirmationRequired) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [experimentNavigationBlocked, resultDiscardConfirmationRequired]);

  const navigateToRoute = useCallback((nextRoute: AppRoute) => {
    if (nextRoute.page === "experiment" && (experimentNavigationBlocked || lectureStartOperationRef.current)) return;

    const nextHash = appRouteHash(nextRoute);
    if (initialHash !== undefined || typeof window === "undefined") {
      setRoute(nextRoute);
      setRouteFocusRequest((current) => current + 1);
      return;
    }
    if (window.location.hash === nextHash) {
      setRoute(nextRoute);
      setRouteFocusRequest((current) => current + 1);
      return;
    }
    window.location.hash = nextHash;
  }, [experimentNavigationBlocked, initialHash]);

  useEffect(() => {
    if (initialHash !== undefined || typeof window === "undefined") return;

    const initialRoute = resolveAppRoute(window.location.hash, development);
    const canonicalHash = appRouteHash(initialRoute);
    if (window.location.hash !== canonicalHash) window.history.replaceState(null, "", canonicalHash);

    const syncRoute = () => {
      const nextRoute = resolveAppRoute(window.location.hash, development);
      if (nextRoute.page === "experiment" && (experimentNavigationBlockedRef.current || lectureStartOperationRef.current)) {
        window.history.replaceState(null, "", "#/lecture");
        setRoute(LECTURE_ROUTE);
        return;
      }

      const nextHash = appRouteHash(nextRoute);
      if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
      setRoute(nextRoute);
      setRouteFocusRequest((current) => current + 1);
    };

    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, [development, initialHash]);

  const checkServiceStatus = useCallback(() => {
    healthAbortRef.current?.abort();
    const controller = new AbortController();
    healthAbortRef.current = controller;
    setServiceCheckState("checking");
    void getHealth(controller.signal).then((status) => {
      if (healthAbortRef.current !== controller) return;
      setServiceStatus(status);
      setServiceCheckState("ready");
    }).catch((caught) => {
      if (healthAbortRef.current !== controller || isAbortError(caught)) return;
      setServiceStatus(null);
      setServiceCheckState("error");
    });
  }, []);

  useEffect(() => {
    checkServiceStatus();
    return () => healthAbortRef.current?.abort();
  }, [checkServiceStatus]);

  useEffect(() => {
    let cancelled = false;
    void withGlossaryStorageLock(() => listStoredGlossaries(window.localStorage))
      .then((glossaries) => {
        if (cancelled) return;
        setStoredGlossaries(glossaries);
        setLibraryIssue(null);
        refreshStorageRecovery();
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setLibraryIssue(glossaryStorageIssue(caught));
        refreshStorageRecovery();
      });
    return () => {
      cancelled = true;
    };
  }, [refreshStorageRecovery]);

  useEffect(() => {
    const syncGlossaries = (event: StorageEvent) => {
      if (!shouldSyncGlossaryStorageEvent(event.key)) return;
      void withGlossaryStorageLock(() => listStoredGlossaries(window.localStorage)).then((glossaries) => {
        setStoredGlossaries(glossaries);
        setLibraryIssue(null);
        refreshStorageRecovery();
        if (activeGlossaryId) {
          const activeGlossary = glossaries.find((glossary) => glossary.id === activeGlossaryId);
          if (!activeGlossary) {
            setAnalysisSaved(false);
            setActiveGlossaryId(null);
            setAnalysisStorageIssue({
              code: "not-found",
              message: "현재 용어집이 다른 탭에서 삭제되었습니다. 현재 분석은 화면에 남아 있지만 브라우저에는 저장되어 있지 않습니다."
            });
          } else {
            setAnalysisSaved(true);
            setAnalysisStorageIssue(null);
            setAnalysis((current) => current ? {
              ...current,
              title: activeGlossary.name,
              terms: activeGlossary.terms,
              phraseSet: activeGlossary.phraseSet
            } : current);
            const activeTermIds = new Set(activeGlossary.terms.map((term) => term.id));
            setExcludedTermIds((current) => current.filter((id) => activeTermIds.has(id)));
            setStorageRecoveryNotice("다른 탭에서 변경한 현재 용어집을 이 화면에도 반영했습니다.");
          }
        }
      }).catch((caught: unknown) => {
        setStoredGlossaries([]);
        const issue = glossaryStorageIssue(caught);
        setLibraryIssue(issue);
        refreshStorageRecovery();
        if (activeGlossaryId) {
          setAnalysisSaved(false);
          setAnalysisStorageIssue(issue);
        }
      });
    };
    window.addEventListener("storage", syncGlossaries);
    return () => window.removeEventListener("storage", syncGlossaries);
  }, [activeGlossaryId, refreshStorageRecovery]);

  useEffect(() => {
    const previousStatus = previousStreamStatusRef.current;
    previousStreamStatusRef.current = stream.status;
    if (shouldTransitionToResults(stage, previousStatus, stream.status)) {
      setResultExportStatus("not-exported");
      setResultExportError("");
      setStage("results");
    }
  }, [stage, stream.status]);

  useEffect(() => {
    const signature = `${route.page}:${stage}`;
    if (previousFocusSignatureRef.current === signature) return;
    previousFocusSignatureRef.current = signature;
    if (route.page !== "lecture") return;

    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-app-stage="${stage}"]`)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route.page, stage]);

  const clearPresentation = useCallback(() => {
    presentationAbortRef.current?.abort();
    presentationAbortRef.current = null;
    presentationRequestRef.current += 1;
    const current = presentationRef.current;
    presentationRef.current = null;
    disposePresentationAsset(current);
    setPresentation(null);
    setPresentationBusy(false);
    setPresentationError("");
  }, []);

  const handlePresentationFile = useCallback(async (file: File) => {
    presentationAbortRef.current?.abort();
    const controller = new AbortController();
    presentationAbortRef.current = controller;
    const requestId = presentationRequestRef.current + 1;
    presentationRequestRef.current = requestId;
    setPresentationBusy(true);
    setPresentationError("");
    try {
      const nextPresentation = await createPresentationAsset(file, {}, controller.signal);
      if (requestId !== presentationRequestRef.current) {
        disposePresentationAsset(nextPresentation);
        return;
      }
      const previous = presentationRef.current;
      presentationRef.current = nextPresentation;
      setPresentation(nextPresentation);
      disposePresentationAsset(previous);
    } catch (caught) {
      if (requestId !== presentationRequestRef.current) return;
      if (isAbortError(caught)) return;
      setPresentationError(presentationUploadFailureMessage(
        caught,
        file.name,
        presentationRef.current?.name
      ));
    } finally {
      if (requestId === presentationRequestRef.current) {
        if (presentationAbortRef.current === controller) presentationAbortRef.current = null;
        setPresentationBusy(false);
      }
    }
  }, []);

  useEffect(() => () => {
    presentationAbortRef.current?.abort();
    presentationAbortRef.current = null;
    presentationRequestRef.current += 1;
    disposePresentationAsset(presentationRef.current);
    presentationRef.current = null;
  }, []);

  const cancelAnalysisOperation = () => {
    analysisOperationRef.current?.abort();
    analysisOperationRef.current = null;
    setLoadingGlossaryId(null);
  };

  const cancelLectureStartOperation = () => {
    lectureStartOperationRef.current?.abort();
    lectureStartOperationRef.current = null;
  };

  useEffect(() => () => {
    analysisOperationRef.current?.abort();
    lectureStartOperationRef.current?.abort();
  }, []);

  const confirmSessionDiscard = (): boolean => {
    if (!resultDiscardConfirmationRequired) return true;
    const confirmed = window.confirm("아직 파일로 저장하지 않은 자막 결과가 있습니다. 이 화면을 나가면 결과를 다시 복구할 수 없습니다. 그래도 계속할까요?");
    return confirmed;
  };

  const reset = () => {
    if (!confirmSessionDiscard()) return;
    cancelAnalysisOperation();
    cancelLectureStartOperation();
    clearPresentation();
    stream.discardSession();
    setAnalysis(null);
    setSessionAnalysis(null);
    setExcludedTermIds([]);
    setActiveGlossaryId(null);
    setAnalysisSourceFile(null);
    setError("");
    setAnalysisStepState(createAnalysisStepState());
    setFileName("");
    setAnalysisSaved(false);
    setLoadingGlossaryId(null);
    setAnalysisStorageIssue(null);
    setLectureStartState({ status: "idle" });
    setResultExportStatus("not-exported");
    setResultExportError("");
    setStage("upload");
    navigateToRoute(LECTURE_ROUTE);
  };

  const persistAnalysis = async (
    result: AnalysisResult,
    fallbackName: string,
    id: string | null,
    signal?: AbortSignal
  ): Promise<StoredGlossary | null> => {
    try {
      throwIfAborted(signal);
      const { saved, glossaries } = await withGlossaryStorageLock(() => {
        throwIfAborted(signal);
        const savedGlossary = saveAnalyzedGlossary(
          window.localStorage,
          result,
          result.title.trim() || fallbackName,
          id ? { id } : undefined
        );
        return {
          saved: savedGlossary,
          glossaries: listStoredGlossaries(window.localStorage)
        };
      });
      throwIfAborted(signal);
      setStoredGlossaries(glossaries);
      refreshStorageRecovery();
      setLibraryIssue(null);
      setAnalysisStorageIssue(null);
      setAnalysisSaved(true);
      setActiveGlossaryId(saved.id);
      return saved;
    } catch (caught) {
      if (isAbortError(caught)) throw caught;
      setAnalysisStorageIssue(glossaryStorageIssue(caught));
      setAnalysisSaved(false);
      return null;
    }
  };

  const runAnalysisEntry = <Extracted,>(
    source: AnalysisEntrySource<Extracted>,
    failureMessage: string
  ): void => {
    cancelAnalysisOperation();
    cancelLectureStartOperation();
    const controller = new AbortController();
    analysisOperationRef.current = controller;
    setLoadingGlossaryId(null);
    clearPresentation();
    setAnalysisSourceFile(null);
    setSessionAnalysis(null);
    setExcludedTermIds([]);
    setActiveGlossaryId(null);
    setAnalysisStorageIssue(null);
    setError("");
    setFileName(source.fileName);
    setAnalysisWorkflowSource(source.kind);
    setLectureStartState({ status: "idle" });
    setAnalysisStepState(createAnalysisStepState());
    setStage("analyzing");
    void (async () => {
      try {
        const readyAnalysis = await runAnalysisEntryWorkflow({
          source,
          store: async (result, fallbackName, signal) => {
            const saved = await persistAnalysis(result, fallbackName, null, signal);
            return {
              readyValue: saved ? { ...result, terms: saved.terms, phraseSet: saved.phraseSet } : result,
              completed: saved !== null
            };
          },
          onStateChange: setAnalysisStepState,
          signal: controller.signal
        });
        throwIfAborted(controller.signal);
        setAnalysisSourceFile(source.sourceFile);
        setAnalysis(readyAnalysis);
        setStage("ready");
      } catch (caught) {
        if (isAbortError(caught) || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : failureMessage);
        setStage("upload");
      } finally {
        if (analysisOperationRef.current === controller) analysisOperationRef.current = null;
      }
    })();
  };

  const handleFile = (file: File): void => {
    runAnalysisEntry({
      kind: "pdf",
      fileName: file.name,
      sourceFile: file,
      fallbackGlossaryName: "강연 용어집",
      extract: (signal) => extractPdfPages(file, undefined, signal),
      analyze: async (pages, signal) => requireNonEmptyGlossary(
        await analyzePdf(file.name.replace(/\.pdf$/i, ""), pages, signal)
      )
    }, "PDF를 분석하지 못했습니다.");
  };

  const handleDemo = (): void => {
    runAnalysisEntry({
      kind: "demo",
      fileName: "생성형_AI_입문_샘플.pdf",
      sourceFile: null,
      fallbackGlossaryName: "샘플 강연 용어집",
      extract: (signal) => getDemo(signal),
      analyze: async (result) => requireNonEmptyGlossary(result)
    }, "데모를 불러오지 못했습니다.");
  };

  const handleLoadGlossary = (id: string): void => {
    void storageMutation.run(async () => {
    cancelAnalysisOperation();
    cancelLectureStartOperation();
    const controller = new AbortController();
    analysisOperationRef.current = controller;
    setLoadingGlossaryId(id);
    setError("");
    try {
      await stream.stop();
      throwIfAborted(controller.signal);
      const readyState = await withGlossaryStorageLock(() => {
        throwIfAborted(controller.signal);
        return loadStoredGlossaryReadyState(window.localStorage, id);
      });
      throwIfAborted(controller.signal);
      clearPresentation();
      setAnalysisSourceFile(null);
      setSessionAnalysis(null);
      setExcludedTermIds([]);
      setAnalysis(readyState.analysis);
      setActiveGlossaryId(id);
      setFileName(readyState.fileName);
      setLibraryIssue(null);
      setAnalysisStorageIssue(null);
      setAnalysisSaved(true);
      setLectureStartState({ status: "idle" });
      setStage(readyState.stage);
    } catch (caught) {
      if (isAbortError(caught) || controller.signal.aborted) return;
      setLibraryIssue(glossaryStorageIssue(caught));
    } finally {
      if (analysisOperationRef.current === controller) {
        analysisOperationRef.current = null;
        setLoadingGlossaryId(null);
      }
    }
    });
  };

  const handleRenameGlossary = (id: string, name: string): void => {
    void storageMutation.run(async () => {
    try {
      const { renamed, glossaries } = await withGlossaryStorageLock(() => {
        const renamedGlossary = renameStoredGlossary(window.localStorage, id, name);
        return {
          renamed: renamedGlossary,
          glossaries: listStoredGlossaries(window.localStorage)
        };
      });
      setStoredGlossaries(glossaries);
      refreshStorageRecovery();
      setLibraryIssue(null);
      if (activeGlossaryId === id) {
        setAnalysis((current) => current ? { ...current, title: renamed.name } : current);
      }
    } catch (caught) {
      setLibraryIssue(glossaryStorageIssue(caught));
    }
    });
  };

  const handleDeleteGlossary = (id: string): void => {
    void storageMutation.run(async () => {
    try {
      const glossaries = await withGlossaryStorageLock(() => {
        deleteStoredGlossary(window.localStorage, id);
        return listStoredGlossaries(window.localStorage);
      });
      setStoredGlossaries(glossaries);
      refreshStorageRecovery();
      setLibraryIssue(null);
      if (activeGlossaryId === id) {
        setActiveGlossaryId(null);
        setAnalysisSaved(false);
        setAnalysisStorageIssue({
          code: "not-found",
          message: "현재 용어집을 브라우저에서 삭제했습니다. 화면의 분석은 유지되지만 다시 사용하려면 저장해야 합니다."
        });
      }
    } catch (caught) {
      setLibraryIssue(glossaryStorageIssue(caught));
    }
    });
  };

  const retryAnalysisStorage = (): void => {
    void storageMutation.run(async () => {
      if (!analysis) return;
      const saved = await persistAnalysis(analysis, "강연 용어집", activeGlossaryId);
      if (saved) setAnalysis({ ...analysis, terms: saved.terms, phraseSet: saved.phraseSet });
    });
  };

  const handleRecoverGlossaries = (): void => {
    void storageMutation.run(async () => {
    try {
      const recoveryOutcome = await withGlossaryStorageLock(() => {
        const recovered = recoverStoredGlossaryData(window.localStorage);
        const retainedActiveId = activeGlossaryId && recovered.glossaries.some((glossary) => glossary.id === activeGlossaryId)
          ? activeGlossaryId
          : null;
        let saved: StoredGlossary | null = null;
        let saveIssue: GlossaryStorageIssue | null = null;
        if (analysis && stage === "ready") {
          try {
            saved = saveAnalyzedGlossary(
              window.localStorage,
              analysis,
              analysis.title.trim() || "강연 용어집",
              retainedActiveId ? { id: retainedActiveId } : undefined
            );
          } catch (caught) {
            saveIssue = glossaryStorageIssue(caught);
          }
        }
        return {
          recovered,
          retainedActiveId,
          saved,
          saveIssue,
          glossaries: listStoredGlossaries(window.localStorage)
        };
      });
      const { recovered, retainedActiveId, saved, saveIssue, glossaries } = recoveryOutcome;
      setStoredGlossaries(glossaries);
      setLibraryIssue(null);
      setStorageRecoveryIssue(null);
      refreshStorageRecovery();
      setActiveGlossaryId(saved?.id ?? retainedActiveId);

      if (analysis && stage === "ready") {
        if (saved) {
          setAnalysis({ ...analysis, terms: saved.terms, phraseSet: saved.phraseSet });
          setAnalysisStorageIssue(null);
          setAnalysisSaved(true);
        } else {
          setAnalysisStorageIssue(saveIssue ?? {
            code: "unavailable",
            message: "복구는 완료했지만 현재 분석을 다시 저장하지 못했습니다."
          });
          setAnalysisSaved(false);
        }
      } else {
        setAnalysisStorageIssue(null);
        setAnalysisSaved(Boolean(retainedActiveId));
      }

      const rejectedMessage = recovered.rejectedCount > 0
        ? `읽을 수 없거나 한도를 넘은 항목 ${recovered.rejectedCount}개는 원본에만 남겼습니다.`
        : "읽을 수 있는 항목을 모두 복구했습니다.";
      const currentAnalysisMessage = analysis && stage === "ready"
        ? saved
          ? " 현재 분석도 다시 저장했습니다."
          : " 현재 분석 저장은 아직 완료되지 않았습니다."
        : "";
      setStorageRecoveryNotice(`원본 전체를 복구 데이터로 보존했습니다. ${recovered.glossaries.length}개 용어집을 복구했습니다. ${rejectedMessage}${currentAnalysisMessage}`);
    } catch (caught) {
      const issue = glossaryStorageIssue(caught);
      setLibraryIssue(issue);
      if (analysis && stage === "ready") setAnalysisStorageIssue(issue);
    }
    });
  };

  const handleExportGlossaryRecovery = (): void => {
    void storageMutation.run(async () => {
    try {
      const bundle = await withGlossaryStorageLock(() =>
        exportGlossaryStorageRecoveryBundle(window.localStorage)
      );
      const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
      requestTextDownload(bundle, `lecture-context-glossary-recovery-${timestamp}.json`);
      setStorageRecoveryIssue(null);
      setStorageRecoveryNotice("JSON 다운로드를 요청했습니다. 브라우저 다운로드 목록에서 파일이 생성됐는지 확인해 주세요.");
      refreshStorageRecovery();
    } catch (caught) {
      setStorageRecoveryIssue(glossaryStorageIssue(caught));
    }
    });
  };

  const handleClearGlossaryRecovery = (): void => {
    void storageMutation.run(async () => {
    try {
      await withGlossaryStorageLock(() => clearGlossaryStorageBackups(window.localStorage));
      setStorageRecoveryBackups([]);
      setStorageRecoveryIssue(null);
      setStorageRecoveryNotice("브라우저에 보관한 원본 복구 데이터를 정리했습니다. 다운로드 목록에서 확인한 JSON 파일은 영향을 받지 않습니다.");
    } catch (caught) {
      setStorageRecoveryIssue(glossaryStorageIssue(caught));
    }
    });
  };

  const handleToggleTerm = (id: string) => {
    setExcludedTermIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : [...current, id]);
    setSessionAnalysis(null);
    setLectureStartState({ status: "idle" });
  };

  const persistReviewedGlossary = (): void => {
    void storageMutation.run(async () => {
      if (
        stage !== "ready" ||
        lectureStartOperationRef.current ||
        !analysis ||
        !effectiveAnalysis ||
        excludedTermIds.length === 0 ||
        effectiveAnalysis.terms.length === 0
      ) return;

      const saved = await persistAnalysis(effectiveAnalysis, "강연 용어집", activeGlossaryId);
      if (!saved) return;

      setAnalysis({
        ...analysis,
        terms: saved.terms,
        phraseSet: saved.phraseSet
      });
      setExcludedTermIds([]);
      setSessionAnalysis(null);
      setLectureStartState({ status: "idle" });
    });
  };

  const beginLecture = async (mode: "live" | "demo", options: { withoutVocabulary?: boolean } = {}) => {
    if (!effectiveAnalysis || effectiveAnalysis.terms.length === 0 || lectureStartOperationRef.current) {
      if (effectiveAnalysis?.terms.length === 0) {
        setLectureStartState({
          status: "error",
          message: "강연에 사용할 전문용어를 하나 이상 포함해 주세요.",
          canStartWithoutVocabulary: false
        });
      }
      return;
    }
    const lectureAnalysis = effectiveAnalysis;
    setResultExportStatus("not-exported");
    setResultExportError("");
    const controller = new AbortController();
    lectureStartOperationRef.current = controller;
    let vocabularyName: string | undefined;
    let preparingVocabulary = false;
    try {
      setLectureStartState({
        status: "preparing",
        message: mode === "demo" ? "데모 자막을 준비하고 있습니다." : "AWS 자막 연결을 준비하고 있습니다."
      });
      if (mode === "live" && !options.withoutVocabulary) {
        preparingVocabulary = true;
        setLectureStartState({
          status: "preparing",
          message: "검증된 전문용어를 AWS 사용자 지정 용어집으로 준비하고 있습니다."
        });
        const prepared = await prepareAwsVocabulary(lectureAnalysis.terms, controller.signal);
        throwIfAborted(controller.signal);
        if (!/^lecture-ko-[a-f0-9]{16}$/u.test(prepared.vocabularyName)) {
          throw new Error("서버가 올바르지 않은 AWS 용어집 식별자를 반환했습니다.");
        }
        vocabularyName = prepared.vocabularyName;
        preparingVocabulary = false;
      }

      throwIfAborted(controller.signal);
      const sessionSnapshot = { ...lectureAnalysis };
      delete sessionSnapshot.vocabularyName;
      setSessionAnalysis(vocabularyName ? { ...sessionSnapshot, vocabularyName } : sessionSnapshot);
      setLectureStartState({
        status: "preparing",
        message: mode === "demo" ? "데모 자막 화면을 여는 중입니다." : "마이크와 AWS 자막 연결을 여는 중입니다."
      });
      const startOutcome = await stream.start(mode, vocabularyName);
      throwIfAborted(controller.signal);
      if (startOutcome.status === "cancelled") return;
      if (startOutcome.status === "failed") throw new Error(startOutcome.outcome.message);
      setLastLectureConfig({ mode, withoutVocabulary: Boolean(options.withoutVocabulary) });
      setLectureStartState({ status: "idle" });
      setStage("live");
    } catch (caught) {
      if (isAbortError(caught) || controller.signal.aborted) return;
      if (preparingVocabulary) {
        setLectureStartState({
          status: "error",
          message: `${caught instanceof Error ? caught.message : "AWS 사용자 지정 용어집을 준비하지 못했습니다."} 용어 카드는 유지한 채 기본 AWS 자막으로 계속할 수 있습니다.`,
          canStartWithoutVocabulary: true
        });
        setStage("ready");
        return;
      }
      setLectureStartState({
        status: "error",
        message: caught instanceof Error ? caught.message : "강연 자막 연결을 시작하지 못했습니다.",
        canStartWithoutVocabulary: false
      });
      setSessionAnalysis(null);
      setStage("ready");
    } finally {
      if (lectureStartOperationRef.current === controller) lectureStartOperationRef.current = null;
    }
  };

  const finishLecture = async () => {
    const outcome = await stream.stop();
    if (
      outcome.status === "cancelled" ||
      outcome.status === "cancelled-before-streaming" ||
      outcome.status === "no-active-session"
    ) return;
    setResultExportStatus("not-exported");
    setResultExportError("");
    setStage("results");
  };

  const exportLectureResult = (format: "json" | "text"): void => {
    void resultExport.run(async () => {
      const resultAnalysis = sessionAnalysis ?? effectiveAnalysis;
      if (!resultAnalysis) return;
      setResultExportError("");
      try {
        const exportedAt = new Date().toISOString();
        const lines = materializeTranscriptLines(stream.transcript);
        const input = {
          title: resultAnalysis.title,
          exportedAt,
          mode: lastLectureConfig.mode,
          outcome: stream.sessionOutcome,
          lines,
          glossaryTerms: resultAnalysis.terms
        } as const;
        const baseName = `${safeSessionExportBaseName(resultAnalysis.title)}-${exportedAt.replace(/[:.]/gu, "-")}`;
        const saveOutcome = format === "json"
          ? await saveTextFile(serializeLectureSessionJson(input), `${baseName}.json`)
          : await saveTextFile(
              serializeLectureTranscriptText(input),
              `${baseName}.txt`,
              "text/plain;charset=utf-8"
            );
        if (saveOutcome === "confirmed") setResultExportStatus("confirmed");
        if (saveOutcome === "download-requested") setResultExportStatus("download-requested");
      } catch (caught) {
        setResultExportError(caught instanceof Error ? caught.message : "결과 파일을 준비하지 못했습니다.");
      }
    });
  };

  const cycleFontScale = () => {
    setFontScale((current) => (current === "normal" ? "large" : current === "large" ? "xlarge" : "normal"));
  };

  const handleExperimentResultReady = useCallback((_fileName: string) => {
    navigateToRoute({ page: "experiment", panel: "results" });
  }, [navigateToRoute]);

  return (
    <div className="min-h-screen bg-[#09090D] text-slate-100">
      <a
        href={appRouteHash(route)}
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById(APP_MAIN_CONTENT_ID);
          main?.scrollIntoView?.({ block: "start" });
          main?.focus({ preventScroll: true });
        }}
        className="fixed left-4 top-4 z-[100] -translate-y-24 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-extrabold text-slate-950 shadow-xl transition-transform focus:translate-y-0 motion-reduce:transition-none"
      >
        본문으로 건너뛰기
      </a>
      {route.page !== "lecture" || stage !== "live" ? (
        <Header
          stage={stage}
          route={route}
          development={development}
          experimentNavigationBlocked={experimentNavigationBlocked}
          onHome={reset}
          onNavigate={navigateToRoute}
        />
      ) : null}
      {route.page === "lecture" && stage === "upload" && (
        <UploadScreen
          onFile={handleFile}
          onDemo={handleDemo}
          busy={loadingGlossaryId !== null || storageMutation.busy}
          error={error}
          serviceStatus={serviceStatus}
          serviceCheckState={serviceCheckState}
          onRetryService={checkServiceStatus}
          storedGlossaries={storedGlossaries}
          storageIssue={libraryIssue}
          onLoadGlossary={(id) => void handleLoadGlossary(id)}
          onRenameGlossary={handleRenameGlossary}
          onDeleteGlossary={handleDeleteGlossary}
          storageRecoveryBackups={storageRecoveryBackups}
          storageRecoveryIssue={storageRecoveryIssue}
          storageRecoveryNotice={storageRecoveryNotice}
          onRecoverGlossaries={handleRecoverGlossaries}
          onExportGlossaryRecovery={handleExportGlossaryRecovery}
          onClearGlossaryRecovery={handleClearGlossaryRecovery}
        />
      )}
      {route.page === "lecture" && stage === "analyzing" && <AnalyzingScreen fileName={fileName} stepState={analysisStepState} source={analysisWorkflowSource} />}
      {route.page === "lecture" && stage === "ready" && analysis && (
        <ReadyScreen
          state={{
            analysis,
            presentation: {
              asset: presentation,
              status: presentationBusy ? "loading" : "idle",
              error: presentationError,
              analysisFileAvailable: Boolean(analysisSourceFile)
            },
            speech: {
              transcription: serviceStatus?.sttProvider === "aws"
                ? serviceStatus.services.speech
                : UNCONFIGURED_SERVICE_STATUS,
              customVocabulary: serviceStatus?.sttProvider === "aws"
                ? serviceStatus.services.customVocabulary ?? UNCONFIGURED_SERVICE_STATUS
                : UNCONFIGURED_SERVICE_STATUS,
              checkState: serviceCheckState
            },
            storage: {
              saved: analysisSaved,
              busy: storageMutation.busy,
              issue: analysisStorageIssue,
              glossaries: storedGlossaries,
              recoveryBackups: storageRecoveryBackups,
              recoveryIssue: storageRecoveryIssue,
              recoveryNotice: storageRecoveryNotice
            },
            review: {
              excludedTermIds,
              activePhraseCount: effectiveAnalysis?.phraseSet.length ?? 0
            },
            lectureStart: lectureStartState
          }}
          actions={{
            navigation: { back: reset },
            presentation: {
              select: (file) => void handlePresentationFile(file),
              useAnalysisFile: () => {
                if (analysisSourceFile) void handlePresentationFile(analysisSourceFile);
              },
              clear: clearPresentation
            },
            speech: { retryCheck: checkServiceStatus },
            storage: {
              retry: retryAnalysisStorage,
              deleteGlossary: handleDeleteGlossary,
              recoverGlossaries: handleRecoverGlossaries,
              exportRecovery: handleExportGlossaryRecovery,
              clearRecovery: handleClearGlossaryRecovery
            },
            review: {
              toggleTerm: handleToggleTerm,
              includeAllTerms: () => {
                setExcludedTermIds([]);
                setSessionAnalysis(null);
                setLectureStartState({ status: "idle" });
              },
              persistExclusions: persistReviewedGlossary
            },
            lecture: {
              start: beginLecture,
              startWithoutVocabulary: () => void beginLecture("live", { withoutVocabulary: true })
            }
          }}
        />
      )}
      {route.page === "lecture" && stage === "live" && (sessionAnalysis ?? effectiveAnalysis) && <LiveScreen analysis={(sessionAnalysis ?? effectiveAnalysis)!} presentation={presentation} stream={stream} fontScale={fontScale} onFontScale={cycleFontScale} highContrast={highContrast} onHighContrast={() => setHighContrast((value) => !value)} onFinish={finishLecture} />}
      {route.page === "lecture" && stage === "results" && (sessionAnalysis ?? effectiveAnalysis) && (
        <ResultsScreen
          analysis={(sessionAnalysis ?? effectiveAnalysis)!}
          transcript={stream.transcript}
          outcome={stream.sessionOutcome}
          lastMode={lastLectureConfig.mode}
          exportState={{ status: resultExportStatus, busy: resultExport.busy, error: resultExportError }}
          exportActions={{
            json: () => exportLectureResult("json"),
            text: () => exportLectureResult("text"),
            confirm: () => {
              setResultExportStatus("confirmed");
              setResultExportError("");
            }
          }}
          onRestart={() => {
            if (!confirmSessionDiscard()) return;
            setStage("ready");
            void beginLecture(lastLectureConfig.mode, { withoutVocabulary: lastLectureConfig.withoutVocabulary });
          }}
          onReady={() => {
            if (!confirmSessionDiscard()) return;
            setLectureStartState({ status: "idle" });
            setStage("ready");
          }}
          onHome={reset}
        />
      )}
      {route.page === "experiment" && development && LazyExperimentWorkspace ? (
        <Suspense fallback={<main id={APP_MAIN_CONTENT_ID} className="grid min-h-[calc(100vh-80px)] place-items-center" role="status" tabIndex={-1}><LoaderCircle className="size-7 animate-spin motion-reduce:animate-none" aria-hidden="true" /><span className="sr-only">STT 실험실 불러오는 중</span></main>}>
          <LazyExperimentWorkspace
            panel={route.panel}
            glossaries={storedGlossaries}
            focusRequest={routeFocusRequest}
            onPanelChange={(panel) => navigateToRoute({ page: "experiment", panel })}
            onResultReady={handleExperimentResultReady}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

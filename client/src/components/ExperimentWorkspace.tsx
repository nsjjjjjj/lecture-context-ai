import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, FileSliders, FlaskConical, LoaderCircle, Mic2, Play } from "lucide-react";
import {
  getAudioFixtures,
  getExperimentStudies,
  type AudioFixtureCatalog,
  type AudioFixtureRecording,
  type ExperimentStudy
} from "../lib/api";
import type { StoredGlossary } from "../lib/glossary-storage";
import { AudioFixtureRecorder } from "./AudioFixtureRecorder";
import { ExperimentSetup } from "./ExperimentSetup";
import { SttComparisonResults } from "./SttComparisonResults";

export type ExperimentPanel = "setup" | "record" | "run" | "results";

type AsyncResource<T> = {
  data: T;
  loading: boolean;
  error: string;
};

export type ExperimentWorkspaceResources = {
  fixtures: AsyncResource<AudioFixtureCatalog | null>;
  studies: AsyncResource<ExperimentStudy[]>;
};

export type ExperimentWorkspaceActions = {
  changePanel: (panel: ExperimentPanel) => void;
  recordingSaved: (recording: AudioFixtureRecording) => void;
  resultReady: (fileName: string) => void;
  studiesChanged: () => Promise<void>;
};

type LatestResourceLoader<T> = {
  load: () => Promise<boolean>;
  invalidate: () => void;
};

/**
 * Owns one resource's request generation. A late response can never replace a
 * newer response, and each resource publishes as soon as its own request ends.
 */
export function createLatestResourceLoader<T>({
  request,
  onStart,
  onSuccess,
  onError,
  onSettled
}: {
  request: () => Promise<T>;
  onStart: () => void;
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
}): LatestResourceLoader<T> {
  let generation = 0;

  return {
    async load() {
      const requestGeneration = ++generation;
      onStart();
      try {
        const value = await request();
        if (requestGeneration !== generation) return false;
        onSuccess(value);
        return true;
      } catch (error) {
        if (requestGeneration !== generation) return false;
        onError(error);
        return false;
      } finally {
        if (requestGeneration === generation) onSettled();
      }
    },
    invalidate() {
      generation += 1;
    }
  };
}

const PANEL_DETAILS: Record<ExperimentPanel, {
  number: number;
  label: string;
  title: string;
  description: string;
  icon: typeof Mic2;
}> = {
  setup: {
    number: 1,
    label: "설정",
    title: "실험 세트 설정",
    description: "저장된 PDF 용어집과 정확한 대본을 재현 가능한 케이스 스냅샷으로 묶습니다.",
    icon: FileSliders
  },
  record: {
    number: 2,
    label: "녹음",
    title: "고정음원 녹음",
    description: "기준 문장을 읽어 반복 가능한 로컬 WAV 실험 음원을 준비합니다.",
    icon: Mic2
  },
  run: {
    number: 3,
    label: "실행",
    title: "A/B/C 비교 실행",
    description: "저장 음원 하나를 동일한 조건에서 세 가지 STT 설정으로 비교합니다.",
    icon: Play
  },
  results: {
    number: 4,
    label: "결과",
    title: "비교 결과 확인",
    description: "저장된 실행 기록과 조건별 인식 결과를 확인합니다.",
    icon: BarChart3
  }
};

const PANELS = Object.keys(PANEL_DETAILS) as ExperimentPanel[];

export function appendRecordingToCatalog(
  catalog: AudioFixtureCatalog | null,
  recording: AudioFixtureRecording
): AudioFixtureCatalog | null {
  if (!catalog || catalog.recordings.some((item) => item.id === recording.id)) return catalog;
  return { ...catalog, recordings: [...catalog.recordings, recording] };
}

export function ExperimentWorkspaceView({
  panel,
  glossaries = [],
  resources,
  actions,
  focusRequest = 0,
}: {
  panel: ExperimentPanel;
  glossaries?: StoredGlossary[];
  resources: ExperimentWorkspaceResources;
  actions: ExperimentWorkspaceActions;
  focusRequest?: number;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previousPanelRef = useRef(panel);
  const details = PANEL_DETAILS[panel];
  const PanelIcon = details.icon;
  const activeResource = panel === "record" || panel === "run" ? resources.fixtures : resources.studies;
  const activeResourceLabel = panel === "record" || panel === "run"
    ? `로컬 녹음 ${resources.fixtures.data?.recordings.length ?? 0}개 준비됨`
    : `실험 세트 ${resources.studies.data.length}개 준비됨`;

  useEffect(() => {
    const panelChanged = previousPanelRef.current !== panel;
    previousPanelRef.current = panel;
    if (focusRequest > 0 || panelChanged) headingRef.current?.focus();
  }, [focusRequest, panel]);

  return (
    <main id="app-main-content" className="mx-auto max-w-[1240px] px-5 py-10 sm:px-8 sm:py-14" tabIndex={-1}>
      <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div className="max-w-[720px]">
          <div className="eyebrow border-amber-300/20 bg-amber-300/[0.07] text-amber-200">
            <FlaskConical className="size-3.5" /> LOCAL DEV WORKSPACE
          </div>
          <div className="mt-5 flex items-start gap-4">
            <div className="mt-1 grid size-12 shrink-0 place-items-center rounded-2xl border border-amber-200/15 bg-amber-200/[0.08] text-amber-200">
              <PanelIcon className="size-5" />
            </div>
            <div>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-3xl font-black tracking-[-0.05em] text-white outline-none sm:text-4xl"
              >
                {details.title}
              </h1>
              <p className="mt-2 text-sm leading-6 text-slate-400">{details.description}</p>
            </div>
          </div>
        </div>

        <div className="shrink-0">
          {activeResource.loading ? (
            <div role="status" className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-2 text-xs font-bold text-slate-400">
              <LoaderCircle className="size-4 animate-spin" /> {panel === "record" || panel === "run" ? "녹음 목록 불러오는 중" : "실험 세트 불러오는 중"}
            </div>
          ) : activeResource.error ? (
            <div role="alert" className="max-w-[420px] rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs leading-5 text-rose-100">
              필요한 데이터를 불러오지 못했습니다: {activeResource.error}
            </div>
          ) : (
            <div role="status" className="inline-flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-300/[0.06] px-3 py-2 text-xs font-bold text-emerald-100">
              {activeResourceLabel}
            </div>
          )}
        </div>
      </div>

      <nav aria-label="STT 실험 단계" className="mt-8">
        <ol className="grid gap-2 rounded-[1.4rem] border border-white/[0.07] bg-white/[0.025] p-2 sm:grid-cols-4">
          {PANELS.map((item) => {
            const itemDetails = PANEL_DETAILS[item];
            const active = item === panel;
            return (
              <li key={item}>
                <a
                  href={`#/experiment/${item}`}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    actions.changePanel(item);
                  }}
                  className={`flex min-h-14 items-center gap-3 rounded-2xl px-4 outline-none ring-cyan-300 transition focus-visible:ring-2 ${active ? "bg-white text-slate-950 shadow-lg shadow-black/15" : "text-slate-400 hover:bg-white/[0.045] hover:text-white"}`}
                >
                  <span className={`grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-black ${active ? "bg-slate-950 text-white" : "bg-white/[0.07] text-slate-500"}`}>
                    {itemDetails.number}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[10px] font-bold tracking-[0.14em] opacity-60">STEP {itemDetails.number}</span>
                    <span className="block text-sm font-extrabold">{itemDetails.label}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </nav>

      <section data-testid={`experiment-task-${panel}`} aria-label={`${details.label} 작업`} className="mt-6">
        {panel === "setup" ? (
          <ExperimentSetup
            glossaries={glossaries}
            studies={resources.studies.data}
            loading={resources.studies.loading}
            error={resources.studies.error}
            onChanged={actions.studiesChanged}
            onContinue={() => actions.changePanel("record")}
          />
        ) : panel === "record" ? (
          <AudioFixtureRecorder
            catalog={resources.fixtures.data}
            catalogLoading={resources.fixtures.loading}
            catalogError={resources.fixtures.error}
            onRecordingSaved={actions.recordingSaved}
          />
        ) : (
          <SttComparisonResults
            recordings={resources.fixtures.data?.recordings ?? []}
            studies={resources.studies.data}
            view={panel}
            onResultReady={actions.resultReady}
          />
        )}
      </section>
    </main>
  );
}

export function ExperimentWorkspace({
  panel,
  glossaries,
  focusRequest = 0,
  onPanelChange,
  onResultReady
}: {
  panel: ExperimentPanel;
  glossaries: StoredGlossary[];
  focusRequest?: number;
  onPanelChange: (panel: ExperimentPanel) => void;
  onResultReady: (fileName: string) => void;
}) {
  const [catalog, setCatalog] = useState<AudioFixtureCatalog | null>(null);
  const [studies, setStudies] = useState<ExperimentStudy[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [studiesLoading, setStudiesLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [studiesError, setStudiesError] = useState("");

  const fixtureLoaderRef = useRef<LatestResourceLoader<AudioFixtureCatalog> | null>(null);
  if (!fixtureLoaderRef.current) {
    fixtureLoaderRef.current = createLatestResourceLoader({
      request: getAudioFixtures,
      onStart: () => {
        setCatalogLoading(true);
        setCatalogError("");
      },
      onSuccess: setCatalog,
      onError: (error) => setCatalogError(error instanceof Error ? error.message : "개발용 녹음 설정을 불러오지 못했습니다."),
      onSettled: () => setCatalogLoading(false)
    });
  }

  const studyLoaderRef = useRef<LatestResourceLoader<{ studies: ExperimentStudy[] }> | null>(null);
  if (!studyLoaderRef.current) {
    studyLoaderRef.current = createLatestResourceLoader({
      request: getExperimentStudies,
      onStart: () => {
        setStudiesLoading(true);
        setStudiesError("");
      },
      onSuccess: (value) => setStudies(value.studies),
      onError: (error) => setStudiesError(error instanceof Error ? error.message : "실험 세트를 불러오지 못했습니다."),
      onSettled: () => setStudiesLoading(false)
    });
  }

  const loadFixtures = useCallback(() => fixtureLoaderRef.current!.load().then(() => undefined), []);
  const loadStudies = useCallback(() => studyLoaderRef.current!.load().then(() => undefined), []);

  useEffect(() => {
    void loadFixtures();
    void loadStudies();
    return () => {
      fixtureLoaderRef.current?.invalidate();
      studyLoaderRef.current?.invalidate();
    };
  }, [loadFixtures, loadStudies]);

  return (
    <ExperimentWorkspaceView
      panel={panel}
      glossaries={glossaries}
      resources={{
        fixtures: { data: catalog, loading: catalogLoading, error: catalogError },
        studies: { data: studies, loading: studiesLoading, error: studiesError }
      }}
      actions={{
        changePanel: onPanelChange,
        recordingSaved: (recording) => setCatalog((current) => appendRecordingToCatalog(current, recording)),
        resultReady: onResultReady,
        studiesChanged: loadStudies
      }}
      focusRequest={focusRequest}
    />
  );
}

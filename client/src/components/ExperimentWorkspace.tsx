import { useEffect, useRef, useState } from "react";
import { BarChart3, FlaskConical, LoaderCircle, Mic2, Play } from "lucide-react";
import {
  getAudioFixtures,
  type AudioFixtureCatalog,
  type AudioFixtureRecording
} from "../lib/api";
import { AudioFixtureRecorder } from "./AudioFixtureRecorder";
import { SttComparisonResults } from "./SttComparisonResults";

export type ExperimentPanel = "record" | "run" | "results";

const PANEL_DETAILS: Record<ExperimentPanel, {
  number: number;
  label: string;
  title: string;
  description: string;
  icon: typeof Mic2;
}> = {
  record: {
    number: 1,
    label: "녹음",
    title: "고정음원 녹음",
    description: "기준 문장을 읽어 반복 가능한 로컬 WAV 실험 음원을 준비합니다.",
    icon: Mic2
  },
  run: {
    number: 2,
    label: "실행",
    title: "A/B/C 비교 실행",
    description: "저장 음원 하나를 동일한 조건에서 세 가지 STT 설정으로 비교합니다.",
    icon: Play
  },
  results: {
    number: 3,
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
  catalog,
  catalogLoading,
  catalogError,
  focusRequest = 0,
  onPanelChange,
  onRecordingSaved,
  onResultReady
}: {
  panel: ExperimentPanel;
  catalog: AudioFixtureCatalog | null;
  catalogLoading: boolean;
  catalogError: string;
  focusRequest?: number;
  onPanelChange: (panel: ExperimentPanel) => void;
  onRecordingSaved: (recording: AudioFixtureRecording) => void;
  onResultReady: (fileName: string) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previousPanelRef = useRef(panel);
  const details = PANEL_DETAILS[panel];
  const PanelIcon = details.icon;

  useEffect(() => {
    const panelChanged = previousPanelRef.current !== panel;
    previousPanelRef.current = panel;
    if (focusRequest > 0 || panelChanged) headingRef.current?.focus();
  }, [focusRequest, panel]);

  return (
    <main className="mx-auto max-w-[1240px] px-5 py-10 sm:px-8 sm:py-14">
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
          {catalogLoading ? (
            <div role="status" className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-2 text-xs font-bold text-slate-400">
              <LoaderCircle className="size-4 animate-spin" /> 실험 카탈로그 불러오는 중
            </div>
          ) : catalogError ? (
            <div role="alert" className="max-w-[420px] rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs leading-5 text-rose-100">
              실험 카탈로그를 불러오지 못했습니다: {catalogError}
            </div>
          ) : (
            <div role="status" className="inline-flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-300/[0.06] px-3 py-2 text-xs font-bold text-emerald-100">
              로컬 녹음 {catalog?.recordings.length ?? 0}개 준비됨
            </div>
          )}
        </div>
      </div>

      <nav aria-label="STT 실험 단계" className="mt-8">
        <ol className="grid gap-2 rounded-[1.4rem] border border-white/[0.07] bg-white/[0.025] p-2 sm:grid-cols-3">
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
                    onPanelChange(item);
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
        {panel === "record" ? (
          <AudioFixtureRecorder
            catalog={catalog}
            catalogLoading={catalogLoading}
            catalogError={catalogError}
            onRecordingSaved={onRecordingSaved}
          />
        ) : (
          <SttComparisonResults
            recordings={catalog?.recordings ?? []}
            view={panel}
            onResultReady={onResultReady}
          />
        )}
      </section>
    </main>
  );
}

export function ExperimentWorkspace({
  panel,
  focusRequest = 0,
  onPanelChange,
  onResultReady
}: {
  panel: ExperimentPanel;
  focusRequest?: number;
  onPanelChange: (panel: ExperimentPanel) => void;
  onResultReady: (fileName: string) => void;
}) {
  const catalogRequestRef = useRef<Promise<AudioFixtureCatalog> | null>(null);
  const [catalog, setCatalog] = useState<AudioFixtureCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");

  useEffect(() => {
    let active = true;
    const request = catalogRequestRef.current ?? getAudioFixtures();
    catalogRequestRef.current = request;
    void request
      .then((nextCatalog) => {
        if (!active) return;
        setCatalog(nextCatalog);
        setCatalogError("");
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setCatalogError(caught instanceof Error ? caught.message : "개발용 녹음 설정을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <ExperimentWorkspaceView
      panel={panel}
      catalog={catalog}
      catalogLoading={catalogLoading}
      catalogError={catalogError}
      focusRequest={focusRequest}
      onPanelChange={onPanelChange}
      onRecordingSaved={(recording) => setCatalog((current) => appendRecordingToCatalog(current, recording))}
      onResultReady={onResultReady}
    />
  );
}

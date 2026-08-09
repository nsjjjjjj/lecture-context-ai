import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Accessibility,
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  FileText,
  Gauge,
  Highlighter,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Mic,
  MonitorUp,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  ScanText,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  WandSparkles,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { analyzePdf, getDemo, getHealth } from "./lib/api";
import { ExperimentWorkspace, type ExperimentPanel } from "./components/ExperimentWorkspace";
import { TransparentCaption } from "./components/TransparentCaption";
import {
  loadStoredGlossaryReadyState,
  requireNonEmptyGlossary,
  shouldSyncGlossaryStorageEvent,
  type AppStage as Stage
} from "./app-state";
import {
  clearStoredGlossaries,
  deleteStoredGlossary,
  glossaryStorageIssue,
  listStoredGlossaries,
  renameStoredGlossary,
  saveAnalyzedGlossary,
  type GlossaryStorageIssue,
  type StoredGlossary
} from "./lib/glossary-storage";
import { useLectureStream } from "./hooks/useLectureStream";
import { shouldTransitionToResults } from "./hooks/lecture-stream-state";
import type { AnalysisResult, GlossaryTerm, ServiceStatus, TranscriptLine } from "./types";

type FontScale = "normal" | "large" | "xlarge";

export type AppRoute =
  | { page: "lecture" }
  | { page: "experiment"; panel: ExperimentPanel };

const LECTURE_ROUTE: AppRoute = { page: "lecture" };

export function parseAppHash(hash: string): AppRoute {
  switch (hash) {
    case "#/experiment/record":
      return { page: "experiment", panel: "record" };
    case "#/experiment/run":
      return { page: "experiment", panel: "run" };
    case "#/experiment/results":
      return { page: "experiment", panel: "results" };
    case "#/lecture":
    default:
      return LECTURE_ROUTE;
  }
}

export function appRouteHash(route: AppRoute): string {
  return route.page === "lecture" ? "#/lecture" : `#/experiment/${route.panel}`;
}

export function resolveAppRoute(hash: string, development: boolean): AppRoute {
  const route = parseAppHash(hash);
  return development || route.page === "lecture" ? route : LECTURE_ROUTE;
}

export const UPLOAD_CARD_GLOW_PROPS = {
  "aria-hidden": true,
  className: "pointer-events-none absolute -inset-3 rounded-[2.4rem] bg-gradient-to-br from-cyan-300/15 via-transparent to-blue-500/10 blur-2xl"
} as const;

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-10 place-items-center rounded-2xl bg-cyan-300 text-slate-950 shadow-[0_10px_30px_rgba(103,232,249,.18)]">
        <Volume2 className="size-5" strokeWidth={2.4} />
      </div>
      <div>
        <div className="text-[15px] font-extrabold tracking-[-0.03em] text-white">강연맥락 AI</div>
        <div className="text-[11px] font-medium tracking-[0.12em] text-slate-500">CONTEXT CAPTION</div>
      </div>
    </div>
  );
}

export function Header({
  stage,
  route,
  development,
  experimentNavigationBlocked,
  onHome,
  onNavigate
}: {
  stage: Stage;
  route: AppRoute;
  development: boolean;
  experimentNavigationBlocked: boolean;
  onHome: () => void;
  onNavigate: (route: AppRoute) => void;
}) {
  const compact = stage === "live";
  const lectureActive = route.page === "lecture";
  const experimentActive = route.page === "experiment";
  const experimentRoute: AppRoute = experimentActive ? route : { page: "experiment", panel: "record" };
  const primaryLinkClass = "inline-flex min-h-10 items-center justify-center rounded-xl px-4 text-xs font-extrabold outline-none ring-cyan-300 transition focus-visible:ring-2";

  return (
    <header className="relative z-20 border-b border-white/[0.06] bg-[#07111f]/85 backdrop-blur-xl">
      <div className={`mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-4 px-5 py-3 sm:px-8 ${compact ? "min-h-16" : "min-h-20"}`}>
        <button onClick={onHome} aria-label="처음 화면으로 이동" className="rounded-2xl text-left outline-none ring-cyan-300 focus-visible:ring-2">
          <Logo />
        </button>
        <nav aria-label="주요 메뉴" className="order-3 mt-3 w-full sm:order-none sm:mt-0 sm:w-auto">
          <ul className="flex items-center gap-1 rounded-2xl border border-white/[0.07] bg-white/[0.035] p-1">
            <li className="min-w-0 flex-1 sm:flex-none">
              <a
                href="#/lecture"
                aria-current={lectureActive ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(LECTURE_ROUTE);
                }}
                className={`${primaryLinkClass} w-full ${lectureActive ? "bg-white text-slate-950" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}
              >
                강연
              </a>
            </li>
            {development && !experimentNavigationBlocked ? (
              <li className="min-w-0 flex-1 sm:flex-none">
                <a
                  href={appRouteHash(experimentRoute)}
                  aria-current={experimentActive ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(experimentRoute);
                  }}
                  className={`${primaryLinkClass} w-full ${experimentActive ? "bg-amber-200 text-slate-950" : "text-slate-400 hover:bg-amber-200/10 hover:text-amber-100"}`}
                >
                  STT 실험실
                </a>
              </li>
            ) : null}
          </ul>
        </nav>
        {lectureActive ? <div className="hidden items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.035] p-1 xl:flex">
          {["자료 분석", "맥락 자막", "결과 확인"].map((label, index) => {
            const activeIndex = stage === "upload" || stage === "analyzing" || stage === "ready" ? 0 : stage === "live" ? 1 : 2;
            return (
              <div
                key={label}
                className={`rounded-full px-4 py-2 text-xs font-bold transition ${index === activeIndex ? "bg-white text-slate-950" : "text-slate-500"}`}
              >
                {index + 1}. {label}
              </div>
            );
          })}
        </div> : null}
        <div className="hidden items-center gap-2 text-xs font-semibold text-slate-400 lg:flex">
          <ShieldCheck className="size-4 text-emerald-300" />
          실시간 강연 음성 미저장
        </div>
      </div>
    </header>
  );
}

function ServicePill({ status }: { status: ServiceStatus | null }) {
  const live = Boolean(status?.services.speech);
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.045] px-3 py-2 text-xs font-bold text-slate-300">
      <span className={`size-2 rounded-full ${live ? "bg-emerald-300 shadow-[0_0_12px_#6ee7b7]" : "bg-amber-300"}`} />
      {live ? "Google STT 연결 가능" : "데모 모드 사용 가능"}
    </div>
  );
}

function StoredGlossaryLibrary({
  glossaries,
  issue,
  onLoad,
  onRename,
  onDelete,
  onReset
}: {
  glossaries: StoredGlossary[];
  issue: GlossaryStorageIssue | null;
  onLoad: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onReset: () => void;
}) {
  const canReset = issue?.code === "invalid" || issue?.code === "version";
  return (
    <section className="mt-4 rounded-[1.6rem] border border-white/[0.08] bg-[#0b1727]/95 p-5 shadow-xl shadow-black/20 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-extrabold text-white"><Database className="size-4 text-cyan-300" /> 이 브라우저의 용어집</div>
          <p className="mt-1 text-xs leading-5 text-slate-500">분석 결과만 이 브라우저에 저장됩니다. PDF와 실시간 강연 음성은 저장하지 않습니다.</p>
        </div>
        <span className="shrink-0 rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-black text-slate-400">{glossaries.length}개</span>
      </div>

      {issue && (
        <div role="alert" className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-xs leading-5 text-rose-100">
          <div className="flex items-start gap-3"><X className="mt-0.5 size-4 shrink-0" /> {issue.message}</div>
          {canReset && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm("호환되지 않거나 손상된 저장 데이터를 이 브라우저에서 초기화할까요? 저장된 용어집이 모두 삭제됩니다.")) onReset();
              }}
              className="danger-button mt-3"
            >
              <RotateCcw className="size-3.5" /> 저장 데이터 초기화
            </button>
          )}
        </div>
      )}

      <div className="mt-4 max-h-[260px] space-y-2 overflow-y-auto pr-1">
        {glossaries.length ? glossaries.map((glossary) => (
          <div key={glossary.id} className="flex items-center gap-2 rounded-2xl border border-white/[0.065] bg-[#07111f]/65 p-2 transition hover:border-cyan-300/20">
            <button type="button" onClick={() => onLoad(glossary.id)} className="min-w-0 flex-1 rounded-xl px-2 py-2 text-left outline-none ring-cyan-300 focus-visible:ring-2">
              <div className="truncate text-sm font-extrabold text-white">{glossary.name}</div>
              <div className="mt-1 text-[11px] font-semibold text-slate-500">전문용어 {glossary.terms.length}개 · {new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(glossary.updatedAt))}</div>
            </button>
            <button
              type="button"
              onClick={() => {
                const name = window.prompt("새 용어집 이름을 입력해 주세요.", glossary.name);
                if (name !== null) onRename(glossary.id, name);
              }}
              className="control-button !size-9 !min-h-0 !min-w-0 shrink-0"
              aria-label={`${glossary.name} 이름 바꾸기`}
              title="이름 바꾸기"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`“${glossary.name}” 용어집을 이 브라우저에서 삭제할까요?`)) onDelete(glossary.id);
              }}
              className="danger-button !size-9 !min-h-0 !p-0 shrink-0"
              aria-label={`${glossary.name} 삭제`}
              title="삭제"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )) : (
          <div className="rounded-2xl border border-dashed border-white/[0.08] px-4 py-6 text-center text-xs leading-5 text-slate-600">
            PDF 분석을 마치면 용어집이 여기에 자동 저장됩니다.
          </div>
        )}
      </div>
    </section>
  );
}

function UploadScreen({
  onFile,
  onDemo,
  busy,
  error,
  serviceStatus,
  storedGlossaries,
  storageIssue,
  onLoadGlossary,
  onRenameGlossary,
  onDeleteGlossary,
  onResetGlossaries
}: {
  onFile: (file: File) => void;
  onDemo: () => void;
  busy: boolean;
  error: string;
  serviceStatus: ServiceStatus | null;
  storedGlossaries: StoredGlossary[];
  storageIssue: GlossaryStorageIssue | null;
  onLoadGlossary: (id: string) => void;
  onRenameGlossary: (id: string, name: string) => void;
  onDeleteGlossary: (id: string) => void;
  onResetGlossaries: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const acceptFile = (file?: File) => {
    if (file) onFile(file);
  };

  return (
    <main className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-[-280px] mx-auto h-[660px] max-w-[1000px] rounded-full bg-cyan-400/[0.07] blur-[130px]" />
      <section className="relative mx-auto grid min-h-[calc(100vh-80px)] max-w-[1440px] items-center gap-16 px-5 py-16 sm:px-8 lg:grid-cols-[1.03fr_.97fr] lg:py-20">
        <div className="max-w-[700px]">
          <div className="mb-7 flex flex-wrap items-center gap-3">
            <span className="eyebrow"><Sparkles className="size-3.5" /> 2026 한신 ABC 해커톤</span>
            <ServicePill status={serviceStatus} />
          </div>
          <h1 className="text-balance text-[clamp(3.4rem,7vw,7rem)] font-black leading-[0.94] tracking-[-0.075em] text-white">
            자막을 넘어,
            <br />
            <span className="text-cyan-300">맥락</span>까지.
          </h1>
          <p className="mt-8 max-w-[590px] text-pretty text-lg font-medium leading-8 text-slate-400 sm:text-xl">
            강연 PDF에서 전문용어를 자동으로 찾아 Google STT에 전달하고, 용어가 등장할 때마다 쉬운 설명을 최신순으로 기록합니다.
          </p>
          <div className="mt-9 grid max-w-[610px] gap-3 sm:grid-cols-3">
            {[
              [ScanText, "PDF 자동 분석", "페이지별 용어 추출"],
              [Mic, "맥락 기반 자막", "Chirp 3 + PhraseSet"],
              [Accessibility, "이해 접근성", "쉬운 풀이와 큰 글씨"]
            ].map(([Icon, title, body]) => {
              const ItemIcon = Icon as typeof ScanText;
              return (
                <div key={String(title)} className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
                  <ItemIcon className="mb-5 size-5 text-cyan-300" />
                  <div className="text-sm font-extrabold text-white">{String(title)}</div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">{String(body)}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[590px]">
          <div {...UPLOAD_CARD_GLOW_PROPS} />
          <div className="relative rounded-[2rem] border border-white/10 bg-[#0b1727]/95 p-5 shadow-2xl shadow-black/30 sm:p-7">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <div className="text-sm font-extrabold text-white">강연 자료 준비</div>
                <div className="mt-1 text-xs text-slate-500">텍스트가 포함된 PDF · 최대 10MB</div>
              </div>
              <FileText className="size-6 text-slate-600" />
            </div>

            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                acceptFile(event.dataTransfer.files[0]);
              }}
              className={`group grid min-h-[265px] w-full place-items-center rounded-[1.4rem] border border-dashed p-8 text-center outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-300 ${dragging ? "border-cyan-300 bg-cyan-300/10" : "border-slate-600 bg-[#07111f]/70 hover:border-cyan-300/70 hover:bg-cyan-300/[0.045]"}`}
            >
              <div>
                <div className="mx-auto grid size-16 place-items-center rounded-3xl border border-white/10 bg-white/[0.06] text-cyan-300 transition group-hover:-translate-y-1 group-hover:bg-cyan-300 group-hover:text-slate-950">
                  {busy ? <LoaderCircle className="size-7 animate-spin" /> : <Upload className="size-7" />}
                </div>
                <div className="mt-6 text-lg font-extrabold text-white">PDF를 여기에 놓아주세요</div>
                <div className="mt-2 text-sm text-slate-500">또는 클릭해서 파일 선택</div>
              </div>
            </button>
            <input ref={inputRef} hidden type="file" accept="application/pdf,.pdf" onChange={(event) => acceptFile(event.target.files?.[0])} />

            {error && (
              <div role="alert" className="mt-4 flex items-start gap-3 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-100">
                <X className="mt-0.5 size-4 shrink-0" /> {error}
              </div>
            )}

            <div className="my-5 flex items-center gap-3 text-[11px] font-bold tracking-[0.15em] text-slate-600">
              <div className="h-px flex-1 bg-white/[0.07]" /> OR <div className="h-px flex-1 bg-white/[0.07]" />
            </div>
            <button onClick={onDemo} disabled={busy} className="secondary-button w-full">
              <Play className="size-4 fill-current" /> 샘플 강연 바로 체험하기
            </button>
          </div>
          <StoredGlossaryLibrary
            glossaries={storedGlossaries}
            issue={storageIssue}
            onLoad={onLoadGlossary}
            onRename={onRenameGlossary}
            onDelete={onDeleteGlossary}
            onReset={onResetGlossaries}
          />
        </div>
      </section>
    </main>
  );
}

function AnalyzingScreen({ fileName, progress }: { fileName: string; progress: number }) {
  const steps = [
    ["PDF 텍스트 추출", progress >= 35],
    ["전문용어 자동 선별", progress >= 72],
    ["PhraseSet 안전 검증", progress >= 96]
  ];
  return (
    <main className="mx-auto grid min-h-[calc(100vh-80px)] max-w-[900px] place-items-center px-5 py-16">
      <div className="w-full rounded-[2rem] border border-white/[0.08] bg-white/[0.035] p-8 text-center sm:p-12">
        <div className="relative mx-auto size-28">
          <div className="absolute inset-0 animate-pulse rounded-full bg-cyan-300/20 blur-2xl" />
          <div className="relative grid size-28 place-items-center rounded-full border border-cyan-300/20 bg-[#0b1727]">
            <WandSparkles className="size-10 text-cyan-300" />
          </div>
        </div>
        <div className="mt-8 text-xs font-extrabold tracking-[0.2em] text-cyan-300">PDF ANALYSIS</div>
        <h2 className="mt-3 text-3xl font-black tracking-[-0.045em] text-white sm:text-4xl">강연의 맥락을 준비하고 있어요</h2>
        <p className="mx-auto mt-3 max-w-[560px] truncate text-sm text-slate-500">{fileName}</p>
        <div className="mx-auto mt-10 h-2 max-w-[580px] overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-blue-400 transition-all duration-700" style={{ width: `${Math.max(8, progress)}%` }} />
        </div>
        <div className="mx-auto mt-8 grid max-w-[650px] gap-3 text-left sm:grid-cols-3">
          {steps.map(([label, done], index) => (
            <div key={String(label)} className={`flex items-center gap-3 rounded-2xl border p-4 transition ${done ? "border-emerald-300/20 bg-emerald-300/[0.06]" : "border-white/[0.06] bg-white/[0.025]"}`}>
              <div className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-black ${done ? "bg-emerald-300 text-slate-950" : "bg-white/[0.07] text-slate-500"}`}>
                {done ? <Check className="size-4" /> : index + 1}
              </div>
              <span className={`text-xs font-bold ${done ? "text-emerald-100" : "text-slate-500"}`}>{String(label)}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function ReadyScreen({
  analysis,
  speechReady,
  analysisSaved,
  storageIssue,
  storedGlossaries,
  onStart,
  onBack,
  onRetryStorage,
  onDeleteGlossary,
  onResetGlossaries
}: {
  analysis: AnalysisResult;
  speechReady: boolean;
  analysisSaved: boolean;
  storageIssue: GlossaryStorageIssue | null;
  storedGlossaries: StoredGlossary[];
  onStart: (mode: "live" | "demo") => void;
  onBack: () => void;
  onRetryStorage: () => void;
  onDeleteGlossary: (id: string) => void;
  onResetGlossaries: () => void;
}) {
  const visibleTerms = analysis.terms.slice(0, 12);
  const glossaryOnly = analysis.mode === "saved";
  const modeLabel = analysis.mode === "gemini" ? "GEMINI" : analysis.mode === "saved" ? "저장됨" : analysis.mode.toUpperCase();
  const canReset = storageIssue?.code === "invalid" || storageIssue?.code === "version";
  const needsSpace = storageIssue?.code === "quota" || storageIssue?.code === "limit";
  return (
    <main className="mx-auto max-w-[1240px] px-5 py-12 sm:px-8 sm:py-16">
      <button onClick={onBack} className="text-button"><ArrowLeft className="size-4" /> 처음 화면으로</button>
      <div className="mt-8 grid gap-8 lg:grid-cols-[.82fr_1.18fr]">
        <section>
          <div className="eyebrow"><Check className="size-3.5" /> {glossaryOnly ? "저장된 용어집 불러옴" : analysisSaved ? "자동 분석·저장 완료" : "자동 분석 완료 · 저장 필요"}</div>
          <h2 className="mt-5 text-4xl font-black leading-tight tracking-[-0.055em] text-white sm:text-5xl">강연을 시작할<br />준비가 됐어요.</h2>
          <p className="mt-5 max-w-[460px] text-base leading-7 text-slate-400">
            {glossaryOnly
              ? `저장된 전문용어와 ${analysis.phraseSet.length}개의 PhraseSet을 바로 Google STT에 전달합니다.`
              : `PDF에 실제로 존재하는 표기만 검증해 ${analysis.phraseSet.length}개의 Google STT 힌트를 만들었습니다.`}
          </p>

          <div className="mt-8 grid grid-cols-3 gap-3">
            {[
              [analysis.pages.length || "—", glossaryOnly ? "PDF 미저장" : "PDF 페이지"],
              [analysis.terms.length, "전문용어"],
              [analysis.phraseSet.length, "PhraseSet"]
            ].map(([value, label]) => (
              <div key={label} className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
                <div className="text-2xl font-black text-white">{value}</div>
                <div className="mt-1 text-[11px] font-bold text-slate-500">{label}</div>
              </div>
            ))}
          </div>

          {analysis.warning && <div className="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] p-4 text-xs leading-5 text-amber-100">{analysis.warning}</div>}
          {!analysisSaved ? (
            <div role="alert" className="mt-5 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-xs leading-5 text-rose-100">
              <div className="flex items-start gap-3"><X className="mt-0.5 size-4 shrink-0" /> {storageIssue?.message || "이 분석 결과는 아직 브라우저에 저장되지 않았습니다."}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {canReset ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm("호환되지 않거나 손상된 저장 데이터를 초기화하고 현재 분석 결과를 다시 저장할까요? 기존 저장 용어집이 모두 삭제됩니다.")) onResetGlossaries();
                    }}
                    className="danger-button"
                  >
                    <RotateCcw className="size-3.5" /> 초기화 후 현재 분석 저장
                  </button>
                ) : (
                  <button type="button" onClick={onRetryStorage} className="secondary-button !min-h-10 !px-3 !py-2 text-xs">
                    <RotateCcw className="size-3.5" /> 저장 다시 시도
                  </button>
                )}
              </div>
              {needsSpace && storedGlossaries.length > 0 && (
                <div className="mt-4 border-t border-rose-200/10 pt-3">
                  <p className="mb-2 text-rose-100/75">기존 용어집을 삭제한 뒤 현재 분석을 다시 저장할 수 있습니다.</p>
                  <div className="max-h-36 space-y-1.5 overflow-y-auto pr-1">
                    {storedGlossaries.map((glossary) => (
                      <div key={glossary.id} className="flex items-center justify-between gap-3 rounded-xl bg-black/15 px-3 py-2">
                        <span className="min-w-0 truncate text-slate-200">{glossary.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`“${glossary.name}” 용어집을 삭제할까요? 삭제 후 위의 저장 다시 시도를 눌러 주세요.`)) onDeleteGlossary(glossary.id);
                          }}
                          className="danger-button !min-h-8 shrink-0 !px-2 !py-1"
                        >
                          <Trash2 className="size-3" /> 삭제
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-5 flex items-start gap-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.055] p-4 text-xs leading-5 text-slate-300">
              <Database className="mt-0.5 size-4 shrink-0 text-cyan-300" />
              <span>{glossaryOnly ? "이 브라우저에 저장된 용어집입니다." : "용어집을 이 브라우저에 자동 저장했습니다."} PDF, 추출한 페이지 텍스트, 실시간 강연 음성은 저장하지 않습니다.</span>
            </div>
          )}

          <div className="mt-8 space-y-3">
            <button disabled={!speechReady} onClick={() => onStart("live")} className="primary-button w-full disabled:cursor-not-allowed disabled:opacity-40">
              <Mic className="size-5" /> 실시간 강연 시작 <ArrowRight className="ml-auto size-5" />
            </button>
            <button onClick={() => onStart("demo")} className="secondary-button w-full">
              <Play className="size-4 fill-current" /> 데모 자막으로 미리보기
            </button>
            {!speechReady && <p className="text-center text-xs text-slate-600">Google STT 자격증명 연결 전에는 데모 모드를 사용할 수 있습니다.</p>}
          </div>
        </section>

        <section className="rounded-[2rem] border border-white/[0.08] bg-white/[0.035] p-5 sm:p-7">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-extrabold text-white">자동 추출된 전문용어</div>
              <div className="mt-1 text-xs text-slate-500">검수 없이 PDF 원문과 자동 대조된 항목</div>
            </div>
            <div className="rounded-full bg-cyan-300/10 px-3 py-1.5 text-xs font-extrabold text-cyan-300">{modeLabel}</div>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {visibleTerms.map((term) => (
              <div key={term.id} className="group rounded-2xl border border-white/[0.065] bg-[#07111f]/60 p-4 transition hover:border-cyan-300/25 hover:bg-cyan-300/[0.035]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-extrabold text-white">{term.term}</div>
                    <div className="mt-1 line-clamp-1 text-xs text-cyan-300/70">{term.english || "PDF 전문용어"}</div>
                  </div>
                  <div className="shrink-0 rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-bold text-slate-400">p.{term.pageNumber}</div>
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">{term.easyExplanation}</p>
                {term.spokenAliases.length > 0 && (
                  <p className="mt-2 line-clamp-1 text-[11px] font-semibold text-amber-200/70">인식 발음: {term.spokenAliases.join(" · ")}</p>
                )}
              </div>
            ))}
          </div>
          {analysis.terms.length > visibleTerms.length && <div className="mt-5 text-center text-xs font-bold text-slate-600">외 {analysis.terms.length - visibleTerms.length}개 용어</div>}
        </section>
      </div>
    </main>
  );
}

function LiveScreen({
  analysis,
  stream,
  fontScale,
  onFontScale,
  highContrast,
  onHighContrast,
  onFinish
}: {
  analysis: AnalysisResult;
  stream: ReturnType<typeof useLectureStream>;
  fontScale: FontScale;
  onFontScale: () => void;
  highContrast: boolean;
  onHighContrast: () => void;
  onFinish: () => void;
}) {
  const termById = useMemo(() => new Map(analysis.terms.map((term) => [term.id, term])), [analysis.terms]);
  const currentLine = stream.lines.at(-1);
  const previousLines = stream.lines.slice(-4, -1);
  const sizeClass = fontScale === "xlarge" ? "caption-xlarge" : fontScale === "large" ? "caption-large" : "caption-normal";
  const fontScaleLabel = fontScale === "xlarge" ? "매우 크게" : fontScale === "large" ? "크게" : "보통";

  return (
    <main className={`min-h-[calc(100dvh-65px)] lg:h-[calc(100dvh-65px)] lg:overflow-hidden ${highContrast ? "bg-black" : ""}`}>
      <div className="mx-auto h-full max-w-[1440px] px-3 py-3 sm:px-5 lg:flex lg:flex-col">
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold ${stream.status === "ready" ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200" : stream.status === "error" ? "border-rose-300/20 bg-rose-300/10 text-rose-100" : "border-white/10 bg-white/[0.04] text-slate-400"}`}>
              {stream.status === "ready" ? <Wifi className="size-4" /> : stream.status === "error" ? <WifiOff className="size-4" /> : <LoaderCircle className="size-4 animate-spin" />}
              {stream.statusMessage}
            </div>
            <div className="hidden text-xs text-slate-600 sm:block">{analysis.title}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onFontScale}
              className="control-button"
              aria-label={`자막 글자 크기 변경, 현재 ${fontScaleLabel}`}
              title={`자막 크기: ${fontScaleLabel}`}
            >
              <span className="text-xs font-black">가</span><span className="text-base font-black">가</span>
            </button>
            <button
              onClick={onHighContrast}
              className={`control-button ${highContrast ? "!border-cyan-300 !text-cyan-300" : ""}`}
              aria-label="고대비 화면 전환"
              aria-pressed={highContrast}
            >
              <Highlighter className="size-4" />
            </button>
            <button onClick={() => document.documentElement.requestFullscreen?.()} className="control-button" aria-label="전체 화면"><Maximize2 className="size-4" /></button>
            <button onClick={onFinish} className="danger-button"><Pause className="size-4 fill-current" /> 종료</button>
          </div>
        </div>

        <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(360px,.48fr)]">
          <section className={`flex min-h-[340px] min-w-0 flex-col rounded-[1.6rem] border p-5 sm:min-h-[460px] sm:p-6 lg:min-h-0 lg:p-7 ${highContrast ? "border-white bg-black" : "border-white/[0.08] bg-[#0a1625]"}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-extrabold tracking-[0.15em] text-slate-500"><Volume2 className="size-4 text-cyan-300" /> LIVE CAPTION</div>
              <div className="rounded-full bg-white/[0.05] px-3 py-1.5 text-[11px] font-bold text-slate-500">{stream.lines.length}개 문장</div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto py-5 sm:py-6">
              <div className="space-y-3 opacity-35">
                {previousLines.map((line) => <TransparentCaption key={line.id} line={line} terms={analysis.terms} className="text-sm font-bold leading-relaxed text-slate-300 sm:text-base xl:text-lg" />)}
              </div>
              <div className="mt-5 min-h-[120px] border-t border-white/[0.07] pt-5 sm:min-h-[140px]">
                <div aria-live="polite" aria-atomic="true">
                  {currentLine ? (
                    <TransparentCaption line={currentLine} terms={analysis.terms} className={sizeClass} />
                  ) : (
                    <p className={`${sizeClass} text-slate-600`}>마이크에 대고 강연을 시작해 주세요.</p>
                  )}
                </div>
                {stream.interim && <p aria-hidden="true" className="mt-3 text-base font-semibold leading-relaxed text-slate-500 sm:text-lg xl:text-xl">{stream.interim}</p>}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] pt-4 text-[11px] text-slate-600 sm:text-xs">
              <div className="flex items-center gap-2"><Mic className="size-4 text-rose-300" /> 실시간 강연 음성을 서버에 저장하지 않습니다</div>
              <div className="flex items-center gap-2"><Keyboard className="size-4" /> 고대비·큰 글씨 지원</div>
            </div>
          </section>

          <aside className="min-w-0 lg:min-h-0" aria-label="실시간 용어 설명">
            <section className={`flex h-[min(65dvh,560px)] min-h-[360px] min-w-0 flex-col overflow-hidden rounded-[1.6rem] border lg:h-full lg:min-h-0 ${highContrast ? "border-white bg-black" : "border-cyan-300/15 bg-gradient-to-br from-cyan-300/[0.09] to-blue-400/[0.03]"}`}>
              <div className="shrink-0 border-b border-white/[0.07] px-5 py-4 sm:px-6 sm:py-5">
                <div className="flex items-center gap-2 text-xs font-extrabold tracking-[0.15em] text-cyan-300"><Sparkles className="size-4" /> TERM FLOW</div>
                <p className="mt-2 text-xs leading-5 text-slate-500">새로 언급된 용어가 위에 추가되고, 지난 설명은 아래에 남습니다.</p>
              </div>

              <div
                role="log"
                aria-label="확정 자막에서 언급된 용어 기록"
                aria-relevant="additions"
                tabIndex={0}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 outline-none ring-inset ring-cyan-300 focus-visible:ring-2 sm:p-4"
              >
                {stream.termOccurrences.length > 0 ? stream.termOccurrences.map((occurrence, index) => {
                  const term = termById.get(occurrence.termId);
                  if (!term) return null;
                  return (
                    <article
                      key={occurrence.id}
                      data-term-occurrence-id={occurrence.id}
                      className={`min-w-0 rounded-2xl border p-4 sm:p-5 ${index === 0 ? "border-cyan-300/25 bg-cyan-300/[0.09]" : "border-white/[0.075] bg-[#07111f]/60"}`}
                    >
                      <h2 className="break-words text-xl font-black leading-tight tracking-[-0.04em] text-white [overflow-wrap:anywhere] sm:text-2xl">{term.term}</h2>
                      {term.english && <p className="mt-1.5 break-words text-xs font-bold leading-5 text-cyan-300/80 [overflow-wrap:anywhere]">{term.english}</p>}
                      <p className="mt-3 break-words text-sm font-medium leading-6 text-slate-200 [overflow-wrap:anywhere]">{term.easyExplanation}</p>
                    </article>
                  );
                }) : (
                  <div className="flex min-h-[240px] flex-col items-center justify-center px-5 text-center">
                    <div className="grid size-12 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.045] text-cyan-300"><Sparkles className="size-5" /></div>
                    <div className="mt-4 text-sm font-extrabold text-slate-300">아직 언급된 용어가 없습니다</div>
                    <p className="mt-2 max-w-[280px] text-xs leading-5 text-slate-600">확정 자막에 전문용어가 등장하면 쉬운 설명이 이곳에 차례로 쌓입니다.</p>
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

function ResultsScreen({ analysis, lines, onRestart, onHome }: { analysis: AnalysisResult; lines: TranscriptLine[]; onRestart: () => void; onHome: () => void }) {
  const detectedIds = new Set(lines.flatMap((line) => line.termIds));
  const detectedTerms = analysis.terms.filter((term) => detectedIds.has(term.id));
  const contextRate = analysis.terms.length ? Math.round((detectedTerms.length / analysis.terms.length) * 100) : 0;

  return (
    <main className="mx-auto max-w-[1180px] px-5 py-12 sm:px-8 sm:py-16">
      <div className="eyebrow"><Gauge className="size-3.5" /> SESSION REPORT</div>
      <div className="mt-5 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-4xl font-black tracking-[-0.055em] text-white sm:text-5xl">강연 맥락 연결 결과</h2>
          <p className="mt-3 text-sm text-slate-500">실제 정확도 비교는 기준 자막이 있는 평가 음원을 사용해 측정합니다.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onHome} className="secondary-button"><ArrowLeft className="size-4" /> 처음으로</button>
          <button onClick={onRestart} className="primary-button"><RotateCcw className="size-4" /> 다시 시연</button>
        </div>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {[
          [lines.length, "확정 자막", "문장"],
          [detectedTerms.length, "연결된 전문용어", `전체 ${analysis.terms.length}개`],
          [analysis.phraseSet.length, "준비된 PhraseSet 힌트", "분석 단계 생성"]
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
          <div className="text-xs font-extrabold tracking-[0.15em] text-cyan-300">CONTEXT COVERAGE</div>
          <div className="mt-6 flex items-end gap-2"><span className="text-6xl font-black tracking-[-0.07em] text-white">{Math.min(contextRate, 100)}</span><span className="pb-2 text-xl font-black text-slate-500">%</span></div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-cyan-300" style={{ width: `${Math.min(contextRate, 100)}%` }} /></div>
          <p className="mt-5 text-xs leading-5 text-slate-500">분석된 전체 전문용어 가운데 이번 자막에 등장해 설명 카드와 연결된 비율입니다.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {detectedTerms.map((term) => <span key={term.id} className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-bold text-slate-300">{term.term}</span>)}
          </div>
        </section>

        <section className="rounded-[1.6rem] border border-white/[0.08] bg-white/[0.035] p-6">
          <div className="flex items-center justify-between"><div className="text-sm font-extrabold text-white">확정 자막 기록</div><div className="text-xs text-slate-600">실시간 강연 음성은 저장하지 않음</div></div>
          <div className="mt-5 max-h-[330px] space-y-3 overflow-y-auto pr-2">
            {lines.length ? lines.map((line, index) => (
              <div key={line.id} className="flex gap-4 rounded-2xl border border-white/[0.055] bg-[#07111f]/55 p-4">
                <div className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[10px] font-black text-slate-500">{index + 1}</div>
                <div>
                  <TransparentCaption line={line} terms={analysis.terms} className="text-sm font-semibold leading-6 text-slate-300" />
                  {line.termIds.length > 0 && <div className="mt-2 text-[11px] font-bold text-cyan-300">{line.termIds.map((id) => analysis.terms.find((term) => term.id === id)?.term).filter(Boolean).join(" · ")}</div>}
                </div>
              </div>
            )) : <div className="py-16 text-center text-sm text-slate-600">확정된 자막이 없습니다.</div>}
          </div>
        </section>
      </div>
    </main>
  );
}

export function App({ initialHash }: { initialHash?: string } = {}) {
  const development = import.meta.env.DEV;
  const [route, setRoute] = useState<AppRoute>(() => resolveAppRoute(
    initialHash ?? (typeof window === "undefined" ? "#/lecture" : window.location.hash),
    development
  ));
  const [routeFocusRequest, setRouteFocusRequest] = useState(0);
  const [stage, setStage] = useState<Stage>("upload");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("");
  const [storedGlossaries, setStoredGlossaries] = useState<StoredGlossary[]>([]);
  const [storageIssue, setStorageIssue] = useState<GlossaryStorageIssue | null>(null);
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const [fontScale, setFontScale] = useState<FontScale>("normal");
  const [highContrast, setHighContrast] = useState(false);
  const stream = useLectureStream(analysis?.terms || [], analysis?.phraseSet || []);
  const previousStreamStatusRef = useRef(stream.status);
  const experimentNavigationBlocked = stage === "analyzing" || stage === "live";
  const experimentNavigationBlockedRef = useRef(experimentNavigationBlocked);
  experimentNavigationBlockedRef.current = experimentNavigationBlocked;

  const navigateToRoute = useCallback((nextRoute: AppRoute) => {
    if (nextRoute.page === "experiment" && experimentNavigationBlocked) return;

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
      if (nextRoute.page === "experiment" && experimentNavigationBlockedRef.current) {
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

  useEffect(() => {
    void getHealth().then(setServiceStatus).catch(() => setServiceStatus(null));
  }, []);

  useEffect(() => {
    try {
      setStoredGlossaries(listStoredGlossaries(window.localStorage));
    } catch (caught) {
      setStorageIssue(glossaryStorageIssue(caught));
    }
  }, []);

  useEffect(() => {
    const syncGlossaries = (event: StorageEvent) => {
      if (!shouldSyncGlossaryStorageEvent(event.key)) return;
      try {
        setStoredGlossaries(listStoredGlossaries(window.localStorage));
        setStorageIssue(null);
      } catch (caught) {
        setStoredGlossaries([]);
        setStorageIssue(glossaryStorageIssue(caught));
      }
    };
    window.addEventListener("storage", syncGlossaries);
    return () => window.removeEventListener("storage", syncGlossaries);
  }, []);

  useEffect(() => {
    const previousStatus = previousStreamStatusRef.current;
    previousStreamStatusRef.current = stream.status;
    if (shouldTransitionToResults(stage, previousStatus, stream.status)) setStage("results");
  }, [stage, stream.status]);

  const reset = () => {
    if (analysis?.pdfUrl) URL.revokeObjectURL(analysis.pdfUrl);
    void stream.stop();
    setAnalysis(null);
    setError("");
    setProgress(0);
    setFileName("");
    setAnalysisSaved(false);
    setStage("upload");
    navigateToRoute(LECTURE_ROUTE);
  };

  const persistAnalysis = (result: AnalysisResult, fallbackName: string): StoredGlossary | null => {
    try {
      const saved = saveAnalyzedGlossary(window.localStorage, result, result.title.trim() || fallbackName);
      setStoredGlossaries(listStoredGlossaries(window.localStorage));
      setStorageIssue(null);
      setAnalysisSaved(true);
      return saved;
    } catch (caught) {
      setStorageIssue(glossaryStorageIssue(caught));
      setAnalysisSaved(false);
      return null;
    }
  };

  const handleFile = async (file: File) => {
    setError("");
    setFileName(file.name);
    setProgress(10);
    setStage("analyzing");
    try {
      const { extractPdfPages } = await import("./lib/pdf");
      const pages = await extractPdfPages(file, (current, total) => setProgress(10 + Math.round((current / total) * 32)));
      setProgress(56);
      const result = requireNonEmptyGlossary(await analyzePdf(file.name.replace(/\.pdf$/i, ""), pages));
      setProgress(100);
      const nextAnalysis = { ...result, pdfUrl: URL.createObjectURL(file) };
      const saved = persistAnalysis(nextAnalysis, "강연 용어집");
      setAnalysis(saved ? { ...nextAnalysis, terms: saved.terms, phraseSet: saved.phraseSet } : nextAnalysis);
      window.setTimeout(() => setStage("ready"), 420);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "PDF를 분석하지 못했습니다.");
      setStage("upload");
    }
  };

  const handleDemo = async () => {
    setError("");
    setFileName("생성형_AI_입문_샘플.pdf");
    setStage("analyzing");
    setProgress(26);
    try {
      const result = requireNonEmptyGlossary(await getDemo());
      setProgress(100);
      const saved = persistAnalysis(result, "샘플 강연 용어집");
      setAnalysis(saved ? { ...result, terms: saved.terms, phraseSet: saved.phraseSet } : result);
      window.setTimeout(() => setStage("ready"), 500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "데모를 불러오지 못했습니다.");
      setStage("upload");
    }
  };

  const handleLoadGlossary = async (id: string) => {
    setError("");
    try {
      const readyState = loadStoredGlossaryReadyState(window.localStorage, id);
      if (analysis?.pdfUrl) URL.revokeObjectURL(analysis.pdfUrl);
      await stream.stop();
      setAnalysis(readyState.analysis);
      setFileName(readyState.fileName);
      setStorageIssue(null);
      setAnalysisSaved(true);
      setStage(readyState.stage);
    } catch (caught) {
      setStorageIssue(glossaryStorageIssue(caught));
    }
  };

  const handleRenameGlossary = (id: string, name: string) => {
    try {
      renameStoredGlossary(window.localStorage, id, name);
      setStoredGlossaries(listStoredGlossaries(window.localStorage));
      setStorageIssue(null);
    } catch (caught) {
      setStorageIssue(glossaryStorageIssue(caught));
    }
  };

  const handleDeleteGlossary = (id: string) => {
    try {
      deleteStoredGlossary(window.localStorage, id);
      setStoredGlossaries(listStoredGlossaries(window.localStorage));
      setStorageIssue(null);
    } catch (caught) {
      setStorageIssue(glossaryStorageIssue(caught));
    }
  };

  const retryAnalysisStorage = () => {
    if (!analysis) return;
    const saved = persistAnalysis(analysis, "강연 용어집");
    if (saved) setAnalysis({ ...analysis, terms: saved.terms, phraseSet: saved.phraseSet });
  };

  const handleResetGlossaries = () => {
    try {
      clearStoredGlossaries(window.localStorage);
      setStoredGlossaries([]);
      setStorageIssue(null);
      if (analysis && stage === "ready" && !analysisSaved) retryAnalysisStorage();
    } catch (caught) {
      setStorageIssue(glossaryStorageIssue(caught));
    }
  };

  const beginLecture = async (mode: "live" | "demo") => {
    setStage("live");
    await stream.start(mode);
  };

  const finishLecture = async () => {
    await stream.stop();
    setStage("results");
  };

  const cycleFontScale = () => {
    setFontScale((current) => (current === "normal" ? "large" : current === "large" ? "xlarge" : "normal"));
  };

  const handleExperimentResultReady = useCallback((_fileName: string) => {
    navigateToRoute({ page: "experiment", panel: "results" });
  }, [navigateToRoute]);

  return (
    <div className={`min-h-screen bg-[#07111f] text-slate-100 ${highContrast ? "contrast-more" : ""}`}>
      <Header
        stage={stage}
        route={route}
        development={development}
        experimentNavigationBlocked={experimentNavigationBlocked}
        onHome={reset}
        onNavigate={navigateToRoute}
      />
      {route.page === "lecture" && stage === "upload" && (
        <UploadScreen
          onFile={handleFile}
          onDemo={handleDemo}
          busy={false}
          error={error}
          serviceStatus={serviceStatus}
          storedGlossaries={storedGlossaries}
          storageIssue={storageIssue}
          onLoadGlossary={(id) => void handleLoadGlossary(id)}
          onRenameGlossary={handleRenameGlossary}
          onDeleteGlossary={handleDeleteGlossary}
          onResetGlossaries={handleResetGlossaries}
        />
      )}
      {route.page === "lecture" && stage === "analyzing" && <AnalyzingScreen fileName={fileName} progress={progress} />}
      {route.page === "lecture" && stage === "ready" && analysis && (
        <ReadyScreen
          analysis={analysis}
          speechReady={Boolean(serviceStatus?.services.speech)}
          analysisSaved={analysisSaved}
          storageIssue={storageIssue}
          storedGlossaries={storedGlossaries}
          onStart={beginLecture}
          onBack={reset}
          onRetryStorage={retryAnalysisStorage}
          onDeleteGlossary={handleDeleteGlossary}
          onResetGlossaries={handleResetGlossaries}
        />
      )}
      {route.page === "lecture" && stage === "live" && analysis && <LiveScreen analysis={analysis} stream={stream} fontScale={fontScale} onFontScale={cycleFontScale} highContrast={highContrast} onHighContrast={() => setHighContrast((value) => !value)} onFinish={finishLecture} />}
      {route.page === "lecture" && stage === "results" && analysis && <ResultsScreen analysis={analysis} lines={stream.lines} onRestart={() => beginLecture("demo")} onHome={reset} />}
      {route.page === "experiment" && development ? (
        <ExperimentWorkspace
          panel={route.panel}
          focusRequest={routeFocusRequest}
          onPanelChange={(panel) => navigateToRoute({ page: "experiment", panel })}
          onResultReady={handleExperimentResultReady}
        />
      ) : null}
    </div>
  );
}

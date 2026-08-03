import { useEffect, useMemo, useRef, useState } from "react";
import {
  Accessibility,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  FileText,
  Gauge,
  Highlighter,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Mic,
  MonitorUp,
  Pause,
  Play,
  RotateCcw,
  ScanText,
  ShieldCheck,
  Sparkles,
  Upload,
  Volume2,
  WandSparkles,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { analyzePdf, getDemo, getHealth } from "./lib/api";
import { useLectureStream } from "./hooks/useLectureStream";
import type { AnalysisResult, GlossaryTerm, ServiceStatus, TranscriptLine } from "./types";

type Stage = "upload" | "analyzing" | "ready" | "live" | "results";
type FontScale = "normal" | "large" | "xlarge";

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

function Header({ stage, onHome }: { stage: Stage; onHome: () => void }) {
  return (
    <header className="relative z-20 border-b border-white/[0.06] bg-[#07111f]/85 backdrop-blur-xl">
      <div className="mx-auto flex h-20 max-w-[1440px] items-center justify-between px-5 sm:px-8">
        <button onClick={onHome} aria-label="처음 화면으로 이동" className="rounded-2xl text-left outline-none ring-cyan-300 focus-visible:ring-2">
          <Logo />
        </button>
        <div className="hidden items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.035] p-1 sm:flex">
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
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-400">
          <ShieldCheck className="size-4 text-emerald-300" />
          음성 저장 안 함
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

function UploadScreen({
  onFile,
  onDemo,
  busy,
  error,
  serviceStatus
}: {
  onFile: (file: File) => void;
  onDemo: () => void;
  busy: boolean;
  error: string;
  serviceStatus: ServiceStatus | null;
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
            강연 PDF에서 전문용어를 자동으로 찾아 Google STT에 전달하고, 용어가 등장하는 순간 쉬운 설명과 자료 페이지를 연결합니다.
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
          <div className="absolute -inset-3 rounded-[2.4rem] bg-gradient-to-br from-cyan-300/15 via-transparent to-blue-500/10 blur-2xl" />
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

function ReadyScreen({ analysis, speechReady, onStart, onBack }: { analysis: AnalysisResult; speechReady: boolean; onStart: (mode: "live" | "demo") => void; onBack: () => void }) {
  const visibleTerms = analysis.terms.slice(0, 12);
  return (
    <main className="mx-auto max-w-[1240px] px-5 py-12 sm:px-8 sm:py-16">
      <button onClick={onBack} className="text-button"><ArrowLeft className="size-4" /> 다른 PDF 선택</button>
      <div className="mt-8 grid gap-8 lg:grid-cols-[.82fr_1.18fr]">
        <section>
          <div className="eyebrow"><Check className="size-3.5" /> 자동 분석 완료</div>
          <h2 className="mt-5 text-4xl font-black leading-tight tracking-[-0.055em] text-white sm:text-5xl">강연을 시작할<br />준비가 됐어요.</h2>
          <p className="mt-5 max-w-[460px] text-base leading-7 text-slate-400">
            PDF에 실제로 존재하는 표기만 검증해 {analysis.phraseSet.length}개의 Google STT 힌트를 만들었습니다.
          </p>

          <div className="mt-8 grid grid-cols-3 gap-3">
            {[
              [analysis.pages.length, "PDF 페이지"],
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
            <div className="rounded-full bg-cyan-300/10 px-3 py-1.5 text-xs font-extrabold text-cyan-300">{analysis.mode === "gemini" ? "GEMINI" : analysis.mode.toUpperCase()}</div>
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
              </div>
            ))}
          </div>
          {analysis.terms.length > visibleTerms.length && <div className="mt-5 text-center text-xs font-bold text-slate-600">외 {analysis.terms.length - visibleTerms.length}개 용어</div>}
        </section>
      </div>
    </main>
  );
}

function HighlightedText({ text, terms, sizeClass }: { text: string; terms: GlossaryTerm[]; sizeClass: string }) {
  const matching = terms.filter((term) => text.toLocaleLowerCase("ko-KR").includes(term.term.toLocaleLowerCase("ko-KR"))).sort((a, b) => b.term.length - a.term.length);
  if (!matching.length) return <p className={sizeClass}>{text}</p>;
  const escaped = matching.map((term) => term.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(regex);
  return (
    <p className={sizeClass}>
      {parts.map((part, index) => {
        const matched = matching.some((term) => term.term.toLocaleLowerCase("ko-KR") === part.toLocaleLowerCase("ko-KR"));
        return matched ? <mark key={`${part}-${index}`} className="rounded-md bg-cyan-300 px-1.5 py-0.5 text-slate-950">{part}</mark> : <span key={`${part}-${index}`}>{part}</span>;
      })}
    </p>
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
  const activeTerm = analysis.terms.find((term) => term.id === stream.activeTermId) ?? analysis.terms[0];
  const currentLine = stream.lines.at(-1);
  const previousLines = stream.lines.slice(-4, -1);
  const currentPage = activeTerm ? analysis.pages.find((page) => page.pageNumber === activeTerm.pageNumber) : analysis.pages[0];
  const sizeClass = fontScale === "xlarge" ? "caption-xlarge" : fontScale === "large" ? "caption-large" : "caption-normal";

  return (
    <main className={`min-h-[calc(100vh-80px)] ${highContrast ? "bg-black" : ""}`}>
      <div className="mx-auto max-w-[1540px] px-4 py-4 sm:px-6 sm:py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold ${stream.status === "ready" ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200" : stream.status === "error" ? "border-rose-300/20 bg-rose-300/10 text-rose-100" : "border-white/10 bg-white/[0.04] text-slate-400"}`}>
              {stream.status === "ready" ? <Wifi className="size-4" /> : stream.status === "error" ? <WifiOff className="size-4" /> : <LoaderCircle className="size-4 animate-spin" />}
              {stream.statusMessage}
            </div>
            <div className="hidden text-xs text-slate-600 sm:block">{analysis.title}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onFontScale} className="control-button" aria-label="자막 글자 크기 변경"><span className="font-black">가</span><span className="text-base font-black">가</span></button>
            <button onClick={onHighContrast} className={`control-button ${highContrast ? "!border-cyan-300 !text-cyan-300" : ""}`} aria-label="고대비 화면 전환"><Highlighter className="size-4" /></button>
            <button onClick={() => document.documentElement.requestFullscreen?.()} className="control-button" aria-label="전체 화면"><Maximize2 className="size-4" /></button>
            <button onClick={onFinish} className="danger-button"><Pause className="size-4 fill-current" /> 종료</button>
          </div>
        </div>

        <div className="grid min-h-[calc(100vh-168px)] gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(340px,.5fr)]">
          <section className={`flex min-h-[560px] flex-col rounded-[1.8rem] border p-6 sm:p-9 ${highContrast ? "border-white bg-black" : "border-white/[0.08] bg-[#0a1625]"}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-extrabold tracking-[0.15em] text-slate-500"><Volume2 className="size-4 text-cyan-300" /> LIVE CAPTION</div>
              <div className="rounded-full bg-white/[0.05] px-3 py-1.5 text-[11px] font-bold text-slate-500">{stream.lines.length}개 문장</div>
            </div>

            <div className="flex flex-1 flex-col justify-end py-8" aria-live="polite" aria-atomic="true">
              <div className="space-y-5 opacity-35">
                {previousLines.map((line) => <p key={line.id} className="text-xl font-bold leading-relaxed text-slate-300 sm:text-2xl">{line.text}</p>)}
              </div>
              <div className="mt-7 min-h-[170px] border-t border-white/[0.07] pt-7">
                {currentLine ? (
                  <HighlightedText text={currentLine.text} terms={analysis.terms.filter((term) => currentLine.termIds.includes(term.id))} sizeClass={sizeClass} />
                ) : (
                  <p className={`${sizeClass} text-slate-600`}>마이크에 대고 강연을 시작해 주세요.</p>
                )}
                {stream.interim && <p className="mt-5 text-2xl font-semibold leading-relaxed text-slate-500 sm:text-3xl">{stream.interim}</p>}
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-white/[0.07] pt-5 text-xs text-slate-600">
              <div className="flex items-center gap-2"><Mic className="size-4 text-rose-300" /> 음성을 서버에 저장하지 않습니다</div>
              <div className="flex items-center gap-2"><Keyboard className="size-4" /> 고대비·큰 글씨 지원</div>
            </div>
          </section>

          <aside className="grid min-h-[560px] gap-4 sm:grid-cols-2 lg:grid-cols-1 lg:grid-rows-[auto_1fr]">
            <section className="rounded-[1.8rem] border border-cyan-300/15 bg-gradient-to-br from-cyan-300/[0.09] to-blue-400/[0.03] p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-extrabold tracking-[0.15em] text-cyan-300"><BookOpen className="size-4" /> CONTEXT</div>
                {activeTerm && <span className="rounded-full bg-cyan-300 px-2.5 py-1 text-[10px] font-black text-slate-950">PDF {activeTerm.pageNumber}</span>}
              </div>
              {activeTerm ? (
                <div className="mt-7">
                  <h2 className="text-3xl font-black tracking-[-0.045em] text-white">{activeTerm.term}</h2>
                  <p className="mt-2 text-xs font-bold text-cyan-300/70">{activeTerm.english}</p>
                  <p className="mt-5 text-[15px] font-medium leading-7 text-slate-300">{activeTerm.easyExplanation}</p>
                  <div className="mt-6 flex items-center gap-2 text-[11px] font-bold text-slate-500"><Sparkles className="size-3.5" /> PDF 기반 AI 쉬운 풀이</div>
                </div>
              ) : <p className="mt-7 text-sm text-slate-500">전문용어가 등장하면 쉬운 설명을 보여드립니다.</p>}
            </section>

            <section className="overflow-hidden rounded-[1.8rem] border border-white/[0.08] bg-white/[0.035]">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
                <div className="flex items-center gap-2 text-xs font-extrabold text-slate-300"><FileText className="size-4 text-cyan-300" /> 관련 자료</div>
                <span className="text-[11px] font-bold text-slate-600">PAGE {currentPage?.pageNumber || 1}</span>
              </div>
              {analysis.pdfUrl ? (
                <iframe title={`PDF ${currentPage?.pageNumber || 1}페이지`} src={`${analysis.pdfUrl}#page=${currentPage?.pageNumber || 1}&view=FitH&toolbar=0`} className="h-[310px] w-full bg-white lg:h-full" />
              ) : (
                <div className="relative flex min-h-[300px] flex-col justify-center overflow-hidden bg-[#f3f5f7] p-7 text-slate-900 lg:h-full">
                  <div className="absolute right-[-60px] top-[-60px] size-44 rounded-full bg-cyan-300/40 blur-2xl" />
                  <div className="relative text-[10px] font-black tracking-[0.2em] text-cyan-700">LECTURE SLIDE</div>
                  <div className="relative mt-3 text-2xl font-black tracking-[-0.04em]">{activeTerm?.term || "생성형 AI"}</div>
                  <div className="relative mt-5 h-1 w-12 bg-cyan-500" />
                  <p className="relative mt-5 line-clamp-5 text-xs font-medium leading-6 text-slate-600">{currentPage?.text}</p>
                  <div className="relative mt-auto pt-5 text-[10px] font-bold text-slate-400">강연맥락 AI · {currentPage?.pageNumber || 1}</div>
                </div>
              )}
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
  const averageLatency = lines.length ? Math.round(lines.reduce((sum, line) => sum + line.latencyMs, 0) / lines.length) : 0;
  const contextRate = analysis.terms.length ? Math.round((detectedTerms.length / Math.min(analysis.terms.length, 5)) * 100) : 0;

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
          [averageLatency ? `${(averageLatency / 1000).toFixed(1)}초` : "-", "평균 표시 지연", "목표 3초 이내"]
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
          <p className="mt-5 text-xs leading-5 text-slate-500">데모에 포함된 핵심 용어 가운데 자막과 설명 카드가 연결된 비율입니다.</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {detectedTerms.map((term) => <span key={term.id} className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-bold text-slate-300">{term.term}</span>)}
          </div>
        </section>

        <section className="rounded-[1.6rem] border border-white/[0.08] bg-white/[0.035] p-6">
          <div className="flex items-center justify-between"><div className="text-sm font-extrabold text-white">확정 자막 기록</div><div className="text-xs text-slate-600">음성 원본은 저장하지 않음</div></div>
          <div className="mt-5 max-h-[330px] space-y-3 overflow-y-auto pr-2">
            {lines.length ? lines.map((line, index) => (
              <div key={line.id} className="flex gap-4 rounded-2xl border border-white/[0.055] bg-[#07111f]/55 p-4">
                <div className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[10px] font-black text-slate-500">{index + 1}</div>
                <div>
                  <p className="text-sm font-semibold leading-6 text-slate-300">{line.text}</p>
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

export function App() {
  const [stage, setStage] = useState<Stage>("upload");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("");
  const [fontScale, setFontScale] = useState<FontScale>("normal");
  const [highContrast, setHighContrast] = useState(false);
  const stream = useLectureStream(analysis?.terms || []);

  useEffect(() => {
    void getHealth().then(setServiceStatus).catch(() => setServiceStatus(null));
  }, []);

  const reset = () => {
    if (analysis?.pdfUrl) URL.revokeObjectURL(analysis.pdfUrl);
    void stream.stop();
    setAnalysis(null);
    setError("");
    setProgress(0);
    setFileName("");
    setStage("upload");
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
      const result = await analyzePdf(file.name.replace(/\.pdf$/i, ""), pages);
      setProgress(100);
      setAnalysis({ ...result, pdfUrl: URL.createObjectURL(file) });
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
      const result = await getDemo();
      setProgress(100);
      setAnalysis(result);
      window.setTimeout(() => setStage("ready"), 500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "데모를 불러오지 못했습니다.");
      setStage("upload");
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

  return (
    <div className={`min-h-screen bg-[#07111f] text-slate-100 ${highContrast ? "contrast-more" : ""}`}>
      <Header stage={stage} onHome={reset} />
      {stage === "upload" && <UploadScreen onFile={handleFile} onDemo={handleDemo} busy={false} error={error} serviceStatus={serviceStatus} />}
      {stage === "analyzing" && <AnalyzingScreen fileName={fileName} progress={progress} />}
      {stage === "ready" && analysis && <ReadyScreen analysis={analysis} speechReady={Boolean(serviceStatus?.services.speech)} onStart={beginLecture} onBack={reset} />}
      {stage === "live" && analysis && <LiveScreen analysis={analysis} stream={stream} fontScale={fontScale} onFontScale={cycleFontScale} highContrast={highContrast} onHighContrast={() => setHighContrast((value) => !value)} onFinish={finishLecture} />}
      {stage === "results" && analysis && <ResultsScreen analysis={analysis} lines={stream.lines} onRestart={() => beginLecture("demo")} onHome={reset} />}
    </div>
  );
}

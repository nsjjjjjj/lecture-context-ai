import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CircleStop, FlaskConical, LoaderCircle, Mic, RotateCcw, Save } from "lucide-react";
import {
  saveAudioFixture,
  type AudioFixtureCatalog,
  type AudioFixtureRecording
} from "../lib/api";
import { AudioFixtureCapture } from "../lib/audio-fixture-capture";

const MAX_RECORDING_MS = 120_000;

type RecorderPhase = "idle" | "requesting" | "recording" | "stopping" | "ready" | "saving" | "saved";
export type AudioFixtureRecorderProps = {
  catalog: AudioFixtureCatalog | null;
  catalogLoading: boolean;
  catalogError: string;
  onRecordingSaved: (recording: AudioFixtureRecording) => void;
};
export type FixtureCaptureMetadata = {
  scriptId: string;
  speakerLabel: "speaker-a" | "speaker-b";
  environment: "quiet" | "noisy";
  speakerReadReferenceScriptVerbatim: boolean;
};
type PreparedRecording = FixtureCaptureMetadata & { blob: Blob; url: string; durationMs: number };

export function snapshotFixtureMetadata(metadata: FixtureCaptureMetadata): Readonly<FixtureCaptureMetadata> {
  return Object.freeze({ ...metadata });
}

export function createRecordingSavedNotifier(
  onRecordingSaved: (recording: AudioFixtureRecording) => void
): (recording: AudioFixtureRecording) => boolean {
  let notified = false;
  return (recording) => {
    if (notified) return false;
    notified = true;
    onRecordingSaved(recording);
    return true;
  };
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}초`;
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "마이크 권한이 거부되었습니다. 브라우저 주소창의 마이크 권한을 허용한 뒤 다시 시도해 주세요.";
  }
  return error instanceof Error ? error.message : "마이크 녹음을 시작하지 못했습니다.";
}

export function AudioFixtureRecorder({ catalog, catalogLoading, catalogError, onRecordingSaved }: AudioFixtureRecorderProps) {
  const controllerRef = useRef<AudioFixtureCapture | null>(null);
  if (!controllerRef.current) controllerRef.current = new AudioFixtureCapture();

  const mountedRef = useRef(true);
  const sessionIdRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);
  const finalizeRef = useRef<Promise<void> | null>(null);
  const saveRef = useRef<Promise<void> | null>(null);
  const preparedRef = useRef<PreparedRecording | null>(null);
  const captureMetadataRef = useRef<Readonly<FixtureCaptureMetadata> | null>(null);

  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [scriptId, setScriptId] = useState("");
  const [speakerLabel, setSpeakerLabel] = useState<"speaker-a" | "speaker-b">("speaker-a");
  const [environment, setEnvironment] = useState<"quiet" | "noisy">("quiet");
  const [speakerReadReferenceScriptVerbatim, setSpeakerReadReferenceScriptVerbatim] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [prepared, setPrepared] = useState<PreparedRecording | null>(null);
  const [saved, setSaved] = useState<AudioFixtureRecording | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedScript = useMemo(
    () => catalog?.scripts.find((script) => script.id === scriptId) ?? catalog?.scripts.at(-1) ?? null,
    [catalog, scriptId]
  );

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    intervalRef.current = null;
    autoStopRef.current = null;
  }, []);

  const releasePrepared = useCallback(() => {
    const current = preparedRef.current;
    if (current) URL.revokeObjectURL(current.url);
    preparedRef.current = null;
    setPrepared(null);
  }, []);

  useEffect(() => {
    setScriptId((current) => catalog?.scripts.some((script) => script.id === current)
      ? current
      : catalog?.scripts.at(-1)?.id ?? "");
  }, [catalog]);

  const stopCapture = useCallback((reason: "manual" | "timer" | "limit", requestedSessionId?: number): Promise<void> => {
    if (finalizeRef.current) return finalizeRef.current;
    const sessionId = requestedSessionId ?? sessionIdRef.current;
    if (sessionId === null || sessionIdRef.current !== sessionId) return Promise.resolve();

    setPhase("stopping");
    clearTimers();
    const operation = (async () => {
      try {
        const captured = await controllerRef.current?.stop(sessionId);
        if (!mountedRef.current || !captured) return;
        const metadata = captureMetadataRef.current;
        if (!metadata) throw new Error("녹음 시작 시점의 fixture 메타데이터가 없습니다.");
        releasePrepared();
        const blob = new Blob([captured.wav], { type: "audio/wav" });
        const nextPrepared = { ...metadata, blob, url: URL.createObjectURL(blob), durationMs: captured.durationMs };
        preparedRef.current = nextPrepared;
        captureMetadataRef.current = null;
        setPrepared(nextPrepared);
        setElapsedMs(captured.durationMs);
        setNotice(reason === "manual" ? "녹음을 종료했습니다. 미리 들은 뒤 로컬에 저장하세요." : "최대 120초에 도달해 녹음을 자동 종료했습니다.");
        setPhase("ready");
      } catch (caught) {
        if (mountedRef.current) {
          setError(caught instanceof Error ? caught.message : "녹음을 WAV로 만들지 못했습니다.");
          setPhase("idle");
        }
      } finally {
        sessionIdRef.current = null;
        if (!preparedRef.current) captureMetadataRef.current = null;
        finalizeRef.current = null;
      }
    })();
    finalizeRef.current = operation;
    return operation;
  }, [clearTimers, releasePrepared]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      const current = preparedRef.current;
      if (current) URL.revokeObjectURL(current.url);
      preparedRef.current = null;
      captureMetadataRef.current = null;
      void controllerRef.current?.dispose();
    };
  }, [clearTimers]);

  const startCapture = async () => {
    if (!selectedScript || sessionIdRef.current !== null || finalizeRef.current || saveRef.current) return;
    releasePrepared();
    setSaved(null);
    setError("");
    setNotice("");
    setElapsedMs(0);
    setPhase("requesting");
    captureMetadataRef.current = snapshotFixtureMetadata({
      scriptId: selectedScript.id,
      speakerLabel,
      environment,
      speakerReadReferenceScriptVerbatim
    });
    try {
      const session = await controllerRef.current?.start();
      if (!mountedRef.current || session == null) return;
      sessionIdRef.current = session.id;
      void session.limitReached.then((reached) => {
        if (reached && mountedRef.current) void stopCapture("limit", session.id);
      });
      startedAtRef.current = performance.now();
      setPhase("recording");
      intervalRef.current = window.setInterval(() => {
        setElapsedMs(Math.min(MAX_RECORDING_MS, performance.now() - startedAtRef.current));
      }, 200);
      autoStopRef.current = window.setTimeout(() => void stopCapture("timer", session.id), MAX_RECORDING_MS);
    } catch (caught) {
      if (!mountedRef.current) return;
      captureMetadataRef.current = null;
      setError(microphoneErrorMessage(caught));
      setPhase("idle");
    }
  };

  const discardAndRetry = () => {
    if (phase === "saving" || sessionIdRef.current !== null) return;
    releasePrepared();
    setSaved(null);
    setError("");
    setNotice("");
    setElapsedMs(0);
    setSpeakerReadReferenceScriptVerbatim(false);
    captureMetadataRef.current = null;
    setPhase("idle");
  };

  const savePrepared = (): Promise<void> => {
    if (saveRef.current) return saveRef.current;
    const current = preparedRef.current;
    if (!current) return Promise.resolve();
    const notifyRecordingSaved = createRecordingSavedNotifier(onRecordingSaved);
    setError("");
    setPhase("saving");
    const operation = saveAudioFixture({
      wav: current.blob,
      scriptId: current.scriptId,
      speakerLabel: current.speakerLabel,
      environment: current.environment,
      speakerReadReferenceScriptVerbatim: current.speakerReadReferenceScriptVerbatim
    })
      .then(
        ({ recording }) => {
          if (!mountedRef.current) return;
          setSaved(recording);
          setNotice(`저장 완료: test-fixtures/stt/${recording.relativePath}`);
          setPhase("saved");
          notifyRecordingSaved(recording);
        },
        (caught: unknown) => {
          if (!mountedRef.current) return;
          setError(caught instanceof Error ? caught.message : "로컬에 녹음을 저장하지 못했습니다.");
          setPhase("ready");
        }
      )
      .finally(() => {
        saveRef.current = null;
      });
    saveRef.current = operation;
    return operation;
  };

  const busy = catalogLoading || phase === "requesting" || phase === "stopping" || phase === "saving";
  const latestRecordings = catalog?.recordings.slice(-3).reverse() ?? [];
  const displayedError = error || catalogError;

  return (
    <section data-testid="audio-fixture-recorder" className="mt-4 rounded-[1.6rem] border border-amber-300/15 bg-[#0b1727]/95 p-5 shadow-xl shadow-black/20 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-extrabold text-white"><FlaskConical className="size-4 text-amber-300" /> 개발용 고정음원 녹음</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">실제 Google API를 호출하지 않고, 같은 음원을 반복 실험할 수 있도록 로컬 WAV를 만듭니다.</p>
        </div>
        <span className="shrink-0 rounded-full bg-amber-300/10 px-2.5 py-1 text-[10px] font-black text-amber-200">DEV ONLY</span>
      </div>

      {selectedScript ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] font-bold text-slate-500">
              가명 화자
              <select value={speakerLabel} onChange={(event) => setSpeakerLabel(event.target.value as "speaker-a" | "speaker-b")} disabled={busy || phase === "recording" || Boolean(prepared)} className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-[#07111f] px-3 text-xs text-slate-200 outline-none focus:border-cyan-300">
                <option value="speaker-a">speaker-a</option>
                <option value="speaker-b">speaker-b</option>
              </select>
            </label>
            <label className="text-[11px] font-bold text-slate-500">
              녹음 환경
              <select value={environment} onChange={(event) => setEnvironment(event.target.value as "quiet" | "noisy")} disabled={busy || phase === "recording" || Boolean(prepared)} className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-[#07111f] px-3 text-xs text-slate-200 outline-none focus:border-cyan-300">
                <option value="quiet">조용한 환경</option>
                <option value="noisy">소음 환경</option>
              </select>
            </label>
          </div>

          <label className="mt-3 block text-[11px] font-bold text-slate-500">
            고정 실험 문장
            <select value={selectedScript.id} onChange={(event) => {
              setScriptId(event.target.value);
              setSpeakerReadReferenceScriptVerbatim(false);
            }} disabled={busy || phase === "recording" || Boolean(prepared)} className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-[#07111f] px-3 text-xs text-slate-200 outline-none focus:border-cyan-300">
              {catalog?.scripts.map((script) => <option key={script.id} value={script.id}>{script.experimentIdentity ? "[실험 케이스] " : "[고정] "}{script.title}</option>)}
            </select>
          </label>
          {selectedScript.experimentIdentity ? <div className="mt-3 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.06] p-3 text-[11px] leading-5 text-cyan-100">
            <strong className="block">PDF 케이스 스냅샷</strong>
            {selectedScript.experimentIdentity.glossaryName} · 채점 {selectedScript.targetTerms.length}개 · PDF 적응 {selectedScript.adaptationTerms?.length ?? 0}개
            <span className="mt-1 block font-mono text-[10px] text-cyan-300/60">{selectedScript.experimentIdentity.caseSnapshotId}</span>
          </div> : null}
          <div className="mt-3 max-h-44 overflow-y-auto rounded-2xl border border-white/[0.07] bg-[#07111f]/70 p-4 text-xs leading-6 text-slate-300">
            {selectedScript.text}
          </div>

          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3 text-xs leading-5 text-slate-300">
            <input
              type="checkbox"
              checked={speakerReadReferenceScriptVerbatim}
              onChange={(event) => setSpeakerReadReferenceScriptVerbatim(event.target.checked)}
              disabled={busy || phase === "recording" || Boolean(prepared)}
              className="mt-0.5 size-4 shrink-0 accent-cyan-300"
            />
            <span>
              <strong className="block text-slate-100">기준 문장을 그대로 읽었습니다</strong>
              <span className="text-[11px] text-slate-500">체크한 상태로 녹음을 시작한 경우에만 비교 결과를 정확도 평가로 사용할 수 있습니다.</span>
            </span>
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {phase === "recording" ? (
              <button type="button" onClick={() => void stopCapture("manual")} className="danger-button"><CircleStop className="size-4" /> 녹음 종료 · {formatDuration(elapsedMs)}</button>
            ) : phase === "ready" || phase === "saving" || phase === "saved" ? (
              <>
                <button type="button" onClick={() => void savePrepared()} disabled={phase === "saving" || phase === "saved"} className="primary-button !min-h-10 text-xs disabled:opacity-40">
                  {phase === "saving" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />} {phase === "saved" ? "저장됨" : "로컬에 저장"}
                </button>
                <button type="button" onClick={discardAndRetry} disabled={phase === "saving"} className="secondary-button !min-h-10 text-xs disabled:opacity-40"><RotateCcw className="size-4" /> 다시 녹음</button>
              </>
            ) : (
              <button type="button" onClick={() => void startCapture()} disabled={busy || !catalog} className="primary-button !min-h-10 text-xs disabled:opacity-40">
                {phase === "requesting" ? <LoaderCircle className="size-4 animate-spin" /> : <Mic className="size-4" />} {phase === "requesting" ? "마이크 권한 확인 중" : "녹음 시작"}
              </button>
            )}
            {phase === "stopping" && <span className="inline-flex items-center gap-2 text-xs text-slate-400"><LoaderCircle className="size-4 animate-spin" /> WAV 만드는 중</span>}
            {(phase === "recording" || prepared) && <span className="text-xs font-bold text-slate-500">{formatDuration(phase === "recording" ? elapsedMs : prepared?.durationMs ?? 0)} / 최대 120초</span>}
          </div>

          {prepared && <audio className="mt-4 w-full" controls preload="metadata" src={prepared.url}>녹음 미리 듣기를 지원하지 않는 브라우저입니다.</audio>}
          {displayedError && <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {displayedError}</div>}
          {notice && <div className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.06] p-3 text-xs leading-5 text-emerald-100"><Check className="mt-0.5 size-4 shrink-0" /> {notice}</div>}

          <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-[11px] leading-5 text-slate-500">
            처리된 음성은 <code className="text-slate-300">test-fixtures/stt/audio/</code>에 저장되고 직접 삭제할 때까지 남습니다. 화자 label은 실제 이름이 아닌 가명입니다. WAV와 로컬 manifest는 Git·Docker에 포함되지 않습니다.
          </div>

          {latestRecordings.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-black text-slate-500">최근 로컬 저장</div>
              <div className="mt-2 space-y-1.5">
                {latestRecordings.map((recording) => (
                  <div key={recording.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.025] px-3 py-2 text-[11px] text-slate-500">
                    <span className="truncate">{recording.fileName}</span>
                    <span className="shrink-0">{recording.speakerLabel} · {formatDuration(recording.durationMs)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        catalogLoading ? (
          <div role="status" className="mt-4 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 text-xs text-slate-500"><LoaderCircle className="size-4 animate-spin" /> 개발용 녹음 설정을 불러오는 중입니다.</div>
        ) : (
          <div role="alert" className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/10 p-3 text-xs text-amber-100">{displayedError || "고정 실험 문장을 불러오지 못했습니다."}</div>
        )
      )}
    </section>
  );
}

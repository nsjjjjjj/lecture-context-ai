import { useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  Download,
  FileText,
  LoaderCircle,
  Mic,
  MonitorUp,
  Play,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { PresentationPdfCanvas } from "../../components/PresentationPdfCanvas";
import { GlossaryRecoveryPanel } from "../glossary/GlossaryRecoveryPanel";
import type {
  GlossaryStorageBackup,
  GlossaryStorageIssue,
  StoredGlossary
} from "../../lib/glossary-storage";
import type {
  AnalysisResult,
  ServiceConfigurationStatus
} from "../../types";
import type { PresentationAsset } from "../../lib/presentation";
import { APP_MAIN_CONTENT_ID } from "./lecture-screen-contract";

export function PresentationUploadCard({
  presentation,
  busy,
  disabled,
  error,
  analysisFileAvailable,
  onSelect,
  onUseAnalysisFile,
  onClear
}: {
  presentation: PresentationAsset | null;
  busy: boolean;
  disabled: boolean;
  error: string;
  analysisFileAvailable: boolean;
  onSelect: (file: File) => void;
  onUseAnalysisFile: () => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const interactionLocked = busy || disabled;

  const acceptFile = (file?: File) => {
    if (file && !interactionLocked) onSelect(file);
  };

  return (
    <section
      className="presentation-upload"
      data-state={error ? "error" : presentation ? "selected" : busy ? "loading" : "empty"}
      data-disabled={disabled || undefined}
      aria-busy={busy}
    >
      <div className="presentation-upload-heading">
        <div>
          <h3>발표 PDF</h3>
          <p>분석 자료와 별도로 선택합니다. 최대 10MB · 100페이지</p>
        </div>
        <MonitorUp aria-hidden="true" />
      </div>

      {presentation ? (
        <>
          <div className="presentation-file-summary" role="status">
            <FileText aria-hidden="true" />
            <div>
              <strong>{presentation.name}</strong>
              <span>{busy ? "새 발표 PDF 확인 중" : `${presentation.pageCount}페이지 · 첫 페이지 미리보기 확인 가능`}</span>
            </div>
            <div className="presentation-file-actions">
              <button type="button" disabled={interactionLocked} onClick={() => inputRef.current?.click()} className="presentation-clear-button">교체</button>
              <button type="button" disabled={interactionLocked} onClick={onClear} className="presentation-clear-button">제거</button>
            </div>
          </div>
          <div className="presentation-upload-preview" aria-label="발표 PDF 첫 페이지 미리보기">
            <PresentationPdfCanvas asset={presentation} pageNumber={1} />
          </div>
        </>
      ) : (
        <button
          type="button"
          disabled={interactionLocked}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            if (!interactionLocked) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            acceptFile(event.dataTransfer.files[0]);
          }}
          className="presentation-file-picker"
          data-dragging={(!interactionLocked && dragging) || undefined}
        >
          {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Upload aria-hidden="true" />}
          <span>{busy ? "발표 PDF 확인 중" : "발표 PDF 선택"}</span>
        </button>
      )}
      <input
        ref={inputRef}
        hidden
        type="file"
        name="presentation-pdf"
        disabled={interactionLocked}
        accept="application/pdf,.pdf"
        aria-label="발표 PDF 파일 선택"
        onChange={(event) => {
          acceptFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />

      <div className="presentation-upload-actions">
        {analysisFileAvailable && !presentation ? (
          <button type="button" onClick={onUseAnalysisFile} disabled={interactionLocked} className="presentation-use-analysis-button">
            분석한 PDF를 발표에 사용
          </button>
        ) : null}
        <span>{disabled ? "자막 연결을 준비하는 동안 발표 PDF를 변경할 수 없습니다." : "발표 PDF가 없어도 자막 모드로 시작할 수 있습니다."}</span>
      </div>
      {error ? <p className="presentation-upload-error" role="alert">{error}</p> : null}
    </section>
  );
}

export type LectureStartState =
  | { status: "idle" }
  | { status: "preparing"; message: string }
  | { status: "error"; message: string; canStartWithoutVocabulary: boolean };

export type ReadyScreenState = {
  analysis: AnalysisResult;
  presentation: {
    asset: PresentationAsset | null;
    status: "idle" | "loading";
    error: string;
    analysisFileAvailable: boolean;
  };
  speech: {
    transcription: ServiceConfigurationStatus;
    customVocabulary: ServiceConfigurationStatus;
    checkState: "checking" | "ready" | "error";
  };
  storage: {
    saved: boolean;
    busy: boolean;
    issue: GlossaryStorageIssue | null;
    glossaries: StoredGlossary[];
    recoveryBackups: GlossaryStorageBackup[];
    recoveryIssue: GlossaryStorageIssue | null;
    recoveryNotice: string;
  };
  review: {
    excludedTermIds: string[];
    activePhraseCount: number;
  };
  lectureStart: LectureStartState;
};

export type ReadyScreenActions = {
  navigation: {
    back: () => void;
  };
  presentation: {
    select: (file: File) => void;
    useAnalysisFile: () => void;
    clear: () => void;
  };
  speech: {
    retryCheck: () => void;
  };
  storage: {
    retry: () => void;
    deleteGlossary: (id: string) => void;
    recoverGlossaries: () => void;
    exportRecovery: () => void;
    clearRecovery: () => void;
  };
  review: {
    toggleTerm: (id: string) => void;
    includeAllTerms: () => void;
    persistExclusions: () => void;
  };
  lecture: {
    start: (mode: "live" | "demo") => void;
    startWithoutVocabulary: () => void;
  };
};

export function ReadyScreen({ state, actions }: {
  state: ReadyScreenState;
  actions: ReadyScreenActions;
}) {
  const { analysis, presentation, speech, storage, review, lectureStart } = state;
  const visibleTerms = analysis.terms;
  const excludedTerms = new Set(review.excludedTermIds);
  const activeTermCount = analysis.terms.length - excludedTerms.size;
  const glossaryOnly = analysis.mode === "saved";
  const modeLabel = analysis.mode === "gemini" ? "GEMINI" : analysis.mode === "saved" ? "저장됨" : analysis.mode.toUpperCase();
  const canRecover = storage.issue?.code === "invalid" || storage.issue?.code === "version" || storage.issue?.code === "limit";
  const needsSpace = storage.issue?.code === "quota" || storage.issue?.code === "limit";
  const startBusy = lectureStart.status === "preparing";
  const interactionBusy = startBusy || storage.busy;
  const speechReady = speech.transcription.configured && speech.transcription.verification !== "failed";
  const customVocabularyReady = speech.customVocabulary.configured
    && speech.customVocabulary.verification !== "failed";
  return (
    <main id={APP_MAIN_CONTENT_ID} className="mx-auto max-w-[1240px] px-5 py-12 outline-none sm:px-8 sm:py-16" data-app-stage="ready" tabIndex={-1}>
      <button type="button" disabled={interactionBusy} onClick={actions.navigation.back} className="text-button"><ArrowLeft className="size-4" /> 처음 화면으로</button>
      <div className="mt-8 grid gap-8 lg:grid-cols-[.82fr_1.18fr]">
        <section>
          <div className="eyebrow"><Check className="size-3.5" /> {glossaryOnly ? "저장된 용어집 불러옴" : storage.saved ? "자동 분석·저장 완료" : "자동 분석 완료 · 저장 필요"}</div>
          <h2 className="mt-5 text-4xl font-black leading-tight tracking-[-0.055em] text-white sm:text-5xl">강연을 시작할<br />준비가 됐어요.</h2>
          <p className="mt-5 max-w-[460px] text-base leading-7 text-slate-400">
            {glossaryOnly
              ? `저장된 전문용어를 검토한 뒤 AWS 사용자 지정 용어집을 준비합니다. 저장된 자료 근거 표기는 ${analysis.phraseSet.length}개입니다.`
              : `PDF에서 전문용어와 자료 근거 표기 ${analysis.phraseSet.length}개를 찾았습니다. AWS 입력은 포함한 용어와 발음 별칭으로 서버에서 별도 검증합니다.`}
          </p>

          <div className="mt-8 grid grid-cols-3 gap-3">
            {[
              [analysis.pages.length || "—", glossaryOnly ? "PDF 미저장" : "PDF 페이지"],
              [activeTermCount, "포함한 전문용어"],
              [review.activePhraseCount, "자료 근거 표기"]
            ].map(([value, label]) => (
              <div key={label} className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
                <div className="text-2xl font-black text-white">{value}</div>
                <div className="mt-1 text-[11px] font-bold text-slate-500">{label}</div>
              </div>
            ))}
          </div>

          {analysis.warning && <div className="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] p-4 text-xs leading-5 text-amber-100">{analysis.warning}</div>}
          {!storage.saved ? (
            <div role="alert" className="mt-5 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-xs leading-5 text-rose-100">
              <div className="flex items-start gap-3"><X className="mt-0.5 size-4 shrink-0" /> {storage.issue?.message || "이 분석 결과는 아직 브라우저에 저장되지 않았습니다."}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {canRecover ? (
                  <button
                    type="button"
                    disabled={interactionBusy}
                    onClick={() => {
                      if (window.confirm("현재 저장 데이터의 원본 전체를 별도 복구 데이터로 보존하고, 읽을 수 있는 용어집을 복구한 뒤 현재 분석을 다시 저장할까요? 보존한 원본은 JSON 파일로 내보낼 수 있습니다.")) actions.storage.recoverGlossaries();
                    }}
                    className="secondary-button !min-h-10 !px-3 !py-2 text-xs"
                  >
                    <RotateCcw className="size-3.5" aria-hidden="true" /> 원본 보존 후 복구·저장
                  </button>
                ) : (
                  <button type="button" disabled={interactionBusy} onClick={actions.storage.retry} className="secondary-button !min-h-10 !px-3 !py-2 text-xs">
                    <RotateCcw className="size-3.5" /> 저장 다시 시도
                  </button>
                )}
                {canRecover ? (
                  <button type="button" disabled={interactionBusy} onClick={actions.storage.exportRecovery} className="text-button !min-h-10 !px-3 !py-2 text-xs">
                    <Download className="size-3.5" aria-hidden="true" /> 현재 원본 JSON 다운로드 요청
                  </button>
                ) : null}
              </div>
              {needsSpace && storage.glossaries.length > 0 && (
                <div className="mt-4 border-t border-rose-200/10 pt-3">
                  <p className="mb-2 text-rose-100/75">기존 용어집을 삭제한 뒤 현재 분석을 다시 저장할 수 있습니다.</p>
                  <div className="max-h-36 space-y-1.5 overflow-y-auto pr-1">
                    {storage.glossaries.map((glossary) => (
                      <div key={glossary.id} className="flex items-center justify-between gap-3 rounded-xl bg-black/15 px-3 py-2">
                        <span className="min-w-0 truncate text-slate-200">{glossary.name}</span>
                        <button
                          type="button"
                          disabled={interactionBusy}
                          onClick={() => {
                            if (window.confirm(`“${glossary.name}” 용어집을 삭제할까요? 삭제 후 위의 저장 다시 시도를 눌러 주세요.`)) actions.storage.deleteGlossary(glossary.id);
                          }}
                          className="danger-button !min-h-11 shrink-0 !px-3 !py-2"
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

          <GlossaryRecoveryPanel
            backups={storage.recoveryBackups}
            issue={storage.recoveryIssue}
            notice={storage.recoveryNotice}
            busy={interactionBusy}
            onExport={actions.storage.exportRecovery}
            onClear={actions.storage.clearRecovery}
          />

          <div className="mt-3 flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 text-xs leading-5 text-slate-400">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-slate-300" />
            <span>
              분석할 때 PDF 텍스트는 서버의 분석 서비스로 전송됩니다. 실시간 시작 시 음성과 선택한 용어는 AWS로 전송되며,
              생성된 AWS 사용자 지정 용어집은 운영자가 별도로 정리할 때까지 AWS 계정에 남을 수 있습니다. 브라우저 용어집 삭제와 AWS 용어집 정리는 서로 다릅니다.
            </span>
          </div>

          <div className="mt-5">
            <PresentationUploadCard
              presentation={presentation.asset}
              busy={presentation.status === "loading"}
              disabled={interactionBusy}
              error={presentation.error}
              analysisFileAvailable={presentation.analysisFileAvailable}
              onSelect={actions.presentation.select}
              onUseAnalysisFile={actions.presentation.useAnalysisFile}
              onClear={actions.presentation.clear}
            />
          </div>

          <div className="mt-8 space-y-3">
            <button type="button" disabled={!speechReady || presentation.status === "loading" || interactionBusy || activeTermCount === 0} onClick={() => customVocabularyReady ? actions.lecture.start("live") : actions.lecture.startWithoutVocabulary()} className="primary-button w-full disabled:cursor-not-allowed disabled:opacity-40">
              {startBusy ? <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" /> : <Mic className="size-5" />}
              {startBusy ? "AWS 자막 준비 중" : customVocabularyReady ? "용어집 적용해 실시간 시작" : "기본 AWS 자막으로 시작"}
              {!startBusy ? <ArrowRight className="ml-auto size-5" /> : null}
            </button>
            <button type="button" disabled={presentation.status === "loading" || interactionBusy || activeTermCount === 0} onClick={() => actions.lecture.start("demo")} className="secondary-button w-full disabled:cursor-not-allowed disabled:opacity-40">
              <Play className="size-4 fill-current" /> 데모 자막으로 미리보기
            </button>
            {!speechReady ? (
              <div className="text-center text-xs leading-5 text-slate-500">
                <p>{speech.checkState === "checking"
                  ? "AWS 설정을 확인하고 있습니다. 그동안 데모를 사용할 수 있습니다."
                  : speech.checkState === "error"
                    ? "서버 상태를 확인하지 못했습니다. 데모를 사용하거나 다시 확인해 주세요."
                    : speech.transcription.verification === "failed"
                      ? "AWS 동작 확인에 실패했습니다. 운영 설정을 점검하는 동안 데모를 사용할 수 있습니다."
                      : "AWS 연결 설정이 없어 데모 모드만 사용할 수 있습니다."}</p>
                {speech.checkState === "error" ? (
                  <button type="button" onClick={actions.speech.retryCheck} className="text-button mt-2">서버 상태 다시 확인</button>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2 text-center text-xs leading-5 text-amber-100/80">
                {speech.transcription.verification === "unverified" || (
                  speech.customVocabulary.configured && speech.customVocabulary.verification === "unverified"
                ) ? (
                  <p>AWS 설정값만 감지했습니다. 실제 권한과 연결은 시작할 때 확인됩니다. 운영자는 <code>pnpm aws:doctor</code>로 먼저 점검할 수 있습니다.</p>
                ) : null}
                {!customVocabularyReady ? (
                  <p>AWS 실시간 자막 연결은 시도할 수 있지만 사용자 지정 용어집 저장소는 준비되지 않았습니다. 용어 카드는 유지되고 자막 인식은 기본 AWS 설정으로 시작합니다.</p>
                ) : null}
              </div>
            )}
            {lectureStart.status === "preparing" ? (
              <p className="text-center text-xs text-slate-400" role="status">{lectureStart.message}</p>
            ) : null}
            {lectureStart.status === "error" ? (
              <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-xs leading-5 text-rose-100" role="alert">
                <p>{lectureStart.message}</p>
                {lectureStart.canStartWithoutVocabulary ? (
                  <button type="button" disabled={interactionBusy} onClick={actions.lecture.startWithoutVocabulary} className="secondary-button mt-3 !min-h-10 !px-3 !py-2 text-xs">
                    기본 AWS 자막으로 시작
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-[2rem] border border-white/[0.08] bg-white/[0.035] p-5 sm:p-7">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-extrabold text-white">강연에 사용할 전문용어</div>
              <div className="mt-1 text-xs text-slate-500">잘못 추출된 항목은 제외하세요. 기본적으로 이번 강연에만 적용됩니다.</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {excludedTerms.size > 0 ? (
                <button type="button" disabled={interactionBusy} onClick={actions.review.includeAllTerms} className="secondary-button !min-h-11 !px-3 !py-2 text-xs">
                  전체 다시 포함
                </button>
              ) : null}
              <div className="rounded-full bg-cyan-300/10 px-3 py-1.5 text-xs font-extrabold text-cyan-300">{modeLabel}</div>
            </div>
          </div>
          <div className="mt-6 grid max-h-[640px] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
            {visibleTerms.map((term) => {
              const included = !excludedTerms.has(term.id);
              return (
              <div key={term.id} className={`group rounded-2xl border p-4 transition ${included ? "border-white/[0.065] bg-[#07111f]/60 hover:border-cyan-300/25 hover:bg-cyan-300/[0.035]" : "border-white/[0.04] bg-black/15 opacity-60"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-extrabold text-white">{term.term}</div>
                    <div className="mt-1 line-clamp-1 text-xs text-cyan-300/70">{term.english || "PDF 전문용어"}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-bold text-slate-400">p.{term.pageNumber}</div>
                    <button
                      type="button"
                      aria-label={`${term.term} ${included ? "제외하기" : "다시 포함"}`}
                      disabled={interactionBusy}
                      onClick={() => actions.review.toggleTerm(term.id)}
                      className="secondary-button !min-h-11 !px-3 !py-2 text-xs"
                    >
                      {included ? "제외하기" : "다시 포함"}
                    </button>
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">{term.easyExplanation}</p>
                {term.spokenAliases.length > 0 && (
                  <p className="mt-2 line-clamp-1 text-[11px] font-semibold text-amber-200/70">인식 발음: {term.spokenAliases.join(" · ")}</p>
                )}
              </div>
            );})}
          </div>
          {excludedTerms.size > 0 ? (
            <div className="mt-4 rounded-2xl border border-white/[0.08] bg-black/15 p-4 text-xs leading-5 text-slate-400">
              <p>현재 제외 선택은 저장본을 바꾸지 않습니다. 아래 동작을 선택하면 제외한 {excludedTerms.size}개 항목을 이 브라우저의 저장본에서도 제거합니다.</p>
              <button
                type="button"
                disabled={interactionBusy || activeTermCount === 0}
                onClick={() => {
                  if (window.confirm(`제외한 ${excludedTerms.size}개 항목을 이 브라우저의 저장본에서도 제거할까요? 다시 포함하려면 PDF를 다시 분석해야 합니다.`)) {
                    actions.review.persistExclusions();
                  }
                }}
                className="secondary-button mt-3 !min-h-11 !px-3 !py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                제외 {excludedTerms.size}개를 저장본에 반영
              </button>
            </div>
          ) : null}
          {activeTermCount === 0 ? <p className="mt-4 text-center text-xs font-bold text-rose-200" role="alert">강연을 시작하려면 전문용어를 하나 이상 포함해 주세요.</p> : null}
        </section>
      </div>
    </main>
  );
}



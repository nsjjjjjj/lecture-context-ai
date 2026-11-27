import { useRef, useState } from "react";
import {
  Accessibility,
  Database,
  Download,
  FileText,
  LoaderCircle,
  Mic,
  Pencil,
  Play,
  RotateCcw,
  ScanText,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { GlossaryRecoveryPanel } from "../glossary/GlossaryRecoveryPanel";
import type {
  GlossaryStorageBackup,
  GlossaryStorageIssue,
  StoredGlossary
} from "../../lib/glossary-storage";
import type { ServiceStatus } from "../../types";
import { UPLOAD_CARD_GLOW_PROPS } from "../upload/upload-card-model";
import { APP_MAIN_CONTENT_ID } from "./lecture-screen-contract";

function ServicePill({
  status,
  checkState,
  onRetry
}: {
  status: ServiceStatus | null;
  checkState: "checking" | "ready" | "error";
  onRetry: () => void;
}) {
  const speech = status?.sttProvider === "aws" ? status.services.speech : null;
  const configured = Boolean(speech?.configured);
  const verified = configured && speech?.verification === "verified";
  const failed = configured && speech?.verification === "failed";
  if (checkState === "error") {
    return (
      <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/[0.07] px-3 py-2 text-xs font-bold text-amber-100">
        <span className="size-2 rounded-full bg-amber-300" /> 서버 상태 다시 확인
      </button>
    );
  }
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.045] px-3 py-2 text-xs font-bold text-slate-300">
      <span className={`size-2 rounded-full ${verified ? "bg-emerald-300 shadow-[0_0_12px_#6ee7b7]" : failed ? "bg-rose-300" : "bg-amber-300"}`} />
      {checkState === "checking"
        ? "AWS 설정 확인 중"
        : verified
          ? "AWS 동작 확인됨"
          : failed
            ? "AWS 동작 확인 실패 · 데모 가능"
            : configured
              ? "AWS 설정 감지 · 동작 미확인"
              : "강연용 AWS 미설정 · 데모 가능"}
    </div>
  );
}

function StoredGlossaryLibrary({
  glossaries,
  issue,
  recoveryBackups,
  recoveryIssue,
  recoveryNotice,
  busy,
  onLoad,
  onRename,
  onDelete,
  onRecover,
  onExportRecovery,
  onClearRecovery
}: {
  glossaries: StoredGlossary[];
  issue: GlossaryStorageIssue | null;
  recoveryBackups: GlossaryStorageBackup[];
  recoveryIssue: GlossaryStorageIssue | null;
  recoveryNotice: string;
  busy: boolean;
  onLoad: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRecover: () => void;
  onExportRecovery: () => void;
  onClearRecovery: () => void;
}) {
  const canRecover = issue?.code === "invalid" || issue?.code === "version" || issue?.code === "limit";
  return (
    <section className="mt-4 rounded-[1.6rem] border border-white/[0.08] bg-[#0b1727]/95 p-5 shadow-xl shadow-black/20 sm:p-6" aria-busy={busy}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-extrabold text-white"><Database className="size-4 text-cyan-300" /> 이 브라우저의 용어집</div>
          <p className="mt-1 text-xs leading-5 text-slate-500">분석 결과만 이 브라우저에 저장됩니다. PDF와 실시간 강연 음성은 저장하지 않습니다.</p>
        </div>
        <span className="shrink-0 rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-black text-slate-400">{glossaries.length}개</span>
      </div>

      {issue && (
        <div role="alert" className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-xs leading-5 text-rose-100">
          <div className="flex items-start gap-3"><X className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {issue.message}</div>
          {canRecover ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("현재 저장 데이터의 원본 전체를 별도 복구 데이터로 보존한 뒤, 읽을 수 있는 용어집만 복구할까요? 보존한 원본은 JSON 파일로 내보낼 수 있습니다.")) onRecover();
                }}
                className="secondary-button !min-h-10 !px-3 !py-2 text-xs"
              >
                <RotateCcw className="size-3.5" aria-hidden="true" /> 원본 보존 후 복구
              </button>
              <button type="button" disabled={busy} onClick={onExportRecovery} className="text-button !min-h-10 !px-3 !py-2 text-xs">
                <Download className="size-3.5" aria-hidden="true" /> 현재 원본 JSON 다운로드 요청
              </button>
            </div>
          ) : null}
        </div>
      )}

      <GlossaryRecoveryPanel
        backups={recoveryBackups}
        issue={recoveryIssue}
        notice={recoveryNotice}
        busy={busy}
        onExport={onExportRecovery}
        onClear={onClearRecovery}
      />

      <div className="mt-4 max-h-[260px] space-y-2 overflow-y-auto pr-1">
        {glossaries.length ? glossaries.map((glossary) => (
          <div key={glossary.id} className="flex items-center gap-2 rounded-2xl border border-white/[0.065] bg-[#07111f]/65 p-2 transition hover:border-cyan-300/20">
            <button type="button" disabled={busy} onClick={() => onLoad(glossary.id)} className="min-w-0 flex-1 rounded-xl px-2 py-2 text-left outline-none ring-cyan-300 disabled:cursor-wait disabled:opacity-50 focus-visible:ring-2">
              <div className="truncate text-sm font-extrabold text-white">{glossary.name}</div>
              <div className="mt-1 text-[11px] font-semibold text-slate-500">전문용어 {glossary.terms.length}개 · {new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(glossary.updatedAt))}</div>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const name = window.prompt("새 용어집 이름을 입력해 주세요.", glossary.name);
                if (name !== null) onRename(glossary.id, name);
              }}
              className="control-button !size-11 !min-h-11 !min-w-11 shrink-0"
              aria-label={`${glossary.name} 이름 바꾸기`}
              title="이름 바꾸기"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`“${glossary.name}” 용어집을 이 브라우저에서 삭제할까요?`)) onDelete(glossary.id);
              }}
              className="danger-button !size-11 !min-h-11 !min-w-11 !p-0 shrink-0"
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

export function UploadScreen({
  onFile,
  onDemo,
  busy,
  error,
  serviceStatus,
  serviceCheckState,
  onRetryService,
  storedGlossaries,
  storageIssue,
  onLoadGlossary,
  onRenameGlossary,
  onDeleteGlossary,
  storageRecoveryBackups,
  storageRecoveryIssue,
  storageRecoveryNotice,
  onRecoverGlossaries,
  onExportGlossaryRecovery,
  onClearGlossaryRecovery
}: {
  onFile: (file: File) => void;
  onDemo: () => void;
  busy: boolean;
  error: string;
  serviceStatus: ServiceStatus | null;
  serviceCheckState: "checking" | "ready" | "error";
  onRetryService: () => void;
  storedGlossaries: StoredGlossary[];
  storageIssue: GlossaryStorageIssue | null;
  onLoadGlossary: (id: string) => void;
  onRenameGlossary: (id: string, name: string) => void;
  onDeleteGlossary: (id: string) => void;
  storageRecoveryBackups: GlossaryStorageBackup[];
  storageRecoveryIssue: GlossaryStorageIssue | null;
  storageRecoveryNotice: string;
  onRecoverGlossaries: () => void;
  onExportGlossaryRecovery: () => void;
  onClearGlossaryRecovery: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const acceptFile = (file?: File) => {
    if (file && !busy) onFile(file);
  };

  return (
    <main id={APP_MAIN_CONTENT_ID} className="relative overflow-hidden outline-none" data-app-stage="upload" tabIndex={-1}>
      <div className="pointer-events-none absolute inset-x-0 top-[-280px] mx-auto h-[660px] max-w-[1000px] rounded-full bg-cyan-400/[0.07] blur-[130px]" />
      <section className="relative mx-auto grid min-h-[calc(100vh-80px)] max-w-[1440px] items-center gap-16 px-5 py-16 sm:px-8 lg:grid-cols-[1.03fr_.97fr] lg:py-20">
        <div className="max-w-[700px]">
          <div className="mb-7 flex flex-wrap items-center gap-3">
            <span className="eyebrow"><Sparkles className="size-3.5" /> 2026 한신 ABC 해커톤</span>
            <ServicePill status={serviceStatus} checkState={serviceCheckState} onRetry={onRetryService} />
          </div>
          <h1 className="text-balance text-[clamp(3.4rem,7vw,7rem)] font-black leading-[0.94] tracking-[-0.075em] text-white">
            자막 속 어려운
            <br />
            <span className="text-cyan-300">전문용어</span>까지.
          </h1>
          <p className="mt-8 max-w-[590px] text-pretty text-lg font-medium leading-8 text-slate-400 sm:text-xl">
            강연 PDF에서 전문용어를 자동으로 찾아 AWS Transcribe에 전달하고, 용어가 등장할 때마다 쉬운 설명을 최신순으로 보여줍니다.
          </p>
          <div className="mt-9 grid max-w-[610px] gap-3 sm:grid-cols-3">
            {[
              [ScanText, "PDF 자동 분석", "페이지별 용어 추출"],
              [Mic, "강연 자료 기반 자막", "AWS Streaming + Custom Vocabulary"],
              [Accessibility, "쉬운 용어 설명", "쉬운 풀이와 큰 글씨"]
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
              disabled={busy}
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
            <input
              ref={inputRef}
              hidden
              type="file"
              name="analysis-pdf"
              accept="application/pdf,.pdf"
              aria-label="분석할 강연 PDF 파일 선택"
              onChange={(event) => {
                acceptFile(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />

            {error && (
              <div role="alert" className="mt-4 flex items-start gap-3 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-100">
                <X className="mt-0.5 size-4 shrink-0" /> {error}
              </div>
            )}

            <div className="my-5 flex items-center gap-3 text-[11px] font-bold tracking-[0.15em] text-slate-600">
              <div className="h-px flex-1 bg-white/[0.07]" /> OR <div className="h-px flex-1 bg-white/[0.07]" />
            </div>
            <button type="button" onClick={onDemo} disabled={busy} className="secondary-button w-full">
              <Play className="size-4 fill-current" /> 샘플 강연 바로 체험하기
            </button>
          </div>
          <StoredGlossaryLibrary
            glossaries={storedGlossaries}
            issue={storageIssue}
            recoveryBackups={storageRecoveryBackups}
            recoveryIssue={storageRecoveryIssue}
            recoveryNotice={storageRecoveryNotice}
            busy={busy}
            onLoad={onLoadGlossary}
            onRename={onRenameGlossary}
            onDelete={onDeleteGlossary}
            onRecover={onRecoverGlossaries}
            onExportRecovery={onExportGlossaryRecovery}
            onClearRecovery={onClearGlossaryRecovery}
          />
        </div>
      </section>
    </main>
  );
}



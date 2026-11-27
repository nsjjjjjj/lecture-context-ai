import { Download } from "lucide-react";
import type {
  GlossaryStorageBackup,
  GlossaryStorageIssue
} from "../../lib/glossary-storage";

export function GlossaryRecoveryPanel({
  backups,
  issue,
  notice,
  busy,
  onExport,
  onClear
}: {
  backups: GlossaryStorageBackup[];
  issue: GlossaryStorageIssue | null;
  notice: string;
  busy: boolean;
  onExport: () => void;
  onClear: () => void;
}) {
  if (!issue && backups.length === 0 && !notice && !busy) return null;

  return (
    <div className="mt-4 space-y-3" aria-busy={busy}>
      {busy ? <p className="sr-only" role="status">용어집 저장 작업 처리 중</p> : null}
      {issue ? (
        <div role="alert" className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.08] p-4 text-xs leading-5 text-amber-100">
          <p>복구 데이터 저장소를 확인하지 못했습니다. {issue.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={onExport} className="secondary-button !min-h-10 !px-3 !py-2 text-xs">
              <Download className="size-3.5" aria-hidden="true" /> 손상 원본 JSON 다운로드 요청
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("손상된 복구 데이터 원본을 먼저 내려받아 파일이 생성됐는지 확인해 주세요. 현재 용어집은 유지하고, 읽을 수 없는 복구 데이터만 브라우저에서 정리할까요?")) onClear();
              }}
              className="text-button !min-h-10 !px-3 !py-2 text-xs"
            >
              손상 보관본 정리
            </button>
          </div>
        </div>
      ) : null}

      {backups.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/15 bg-amber-300/[0.055] p-4 text-xs leading-5 text-amber-50" role="status">
          <span>원본 복구 데이터 {backups.length}개를 이 브라우저에 보관하고 있습니다.</span>
          <span className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={onExport} className="secondary-button !min-h-10 !px-3 !py-2 text-xs">
              <Download className="size-3.5" aria-hidden="true" /> 복구 JSON 다운로드 요청
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("다운로드 목록에서 JSON 파일이 생성됐는지 확인하셨나요? 브라우저에 보관한 원본 복구 데이터만 정리하며 현재 용어집은 유지됩니다.")) onClear();
              }}
              className="text-button !min-h-10 !px-3 !py-2 text-xs"
            >
              브라우저 보관본 정리
            </button>
          </span>
        </div>
      ) : null}

      {notice ? <p className="text-xs leading-5 text-emerald-200" role="status">{notice}</p> : null}
    </div>
  );
}

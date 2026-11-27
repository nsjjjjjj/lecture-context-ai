import { useEffect, useMemo, useRef, useState } from "react";
import type { GlossaryTerm } from "../types";
import {
  sliceTranscriptLines,
  type TranscriptStore
} from "../hooks/transcript-store";
import { TransparentCaption } from "./TransparentCaption";

export const TRANSCRIPT_RESULTS_PAGE_SIZE = 100;

export function TranscriptResultsList({
  transcript,
  terms,
  pageSize = TRANSCRIPT_RESULTS_PAGE_SIZE
}: {
  transcript: TranscriptStore;
  terms: GlossaryTerm[];
  pageSize?: number;
}) {
  const normalizedPageSize = Math.trunc(pageSize);
  const safePageSize = Number.isFinite(normalizedPageSize) && normalizedPageSize > 0
    ? normalizedPageSize
    : TRANSCRIPT_RESULTS_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(transcript.lineCount / safePageSize));
  const [pageIndex, setPageIndex] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);
  const focusAfterNavigationRef = useRef(false);
  const clampedPageIndex = Math.min(pageIndex, pageCount - 1);
  const startIndex = clampedPageIndex * safePageSize;
  const endIndex = Math.min(transcript.lineCount, startIndex + safePageSize);
  const visibleLines = useMemo(
    () => sliceTranscriptLines(transcript, startIndex, endIndex),
    [endIndex, startIndex, transcript]
  );
  const termById = useMemo(() => new Map(terms.map((term) => [term.id, term.term])), [terms]);

  useEffect(() => {
    if (pageIndex !== clampedPageIndex) setPageIndex(clampedPageIndex);
  }, [clampedPageIndex, pageIndex]);

  useEffect(() => {
    if (!focusAfterNavigationRef.current) return;
    focusAfterNavigationRef.current = false;
    listRef.current?.focus();
  }, [clampedPageIndex]);

  const navigateToPage = (nextPageIndex: number): void => {
    focusAfterNavigationRef.current = true;
    setPageIndex(Math.min(pageCount - 1, Math.max(0, nextPageIndex)));
  };

  if (transcript.lineCount === 0) {
    return <div className="py-16 text-center text-sm text-slate-600">확정된 자막이 없습니다.</div>;
  }

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
        <div role="status" aria-live="polite" aria-atomic="true">
          전체 {transcript.lineCount.toLocaleString("ko-KR")}개 중 {startIndex + 1}–{endIndex}번째 자막
        </div>
        <label className="inline-flex min-h-11 items-center gap-2 font-bold text-slate-400">
          페이지
          <select
            aria-label="자막 페이지 선택"
            value={clampedPageIndex}
            onChange={(event) => navigateToPage(Number(event.target.value))}
            className="min-h-11 rounded-xl border border-white/10 bg-[#07111f] px-3 text-sm text-slate-200 outline-none ring-cyan-300 focus-visible:ring-2"
          >
            {Array.from({ length: pageCount }, (_, index) => (
              <option key={index} value={index}>{index + 1} / {pageCount}</option>
            ))}
          </select>
        </label>
      </div>

      <ol
        ref={listRef}
        start={startIndex + 1}
        aria-label={`확정 자막 ${startIndex + 1}번부터 ${endIndex}번`}
        className="mt-3 max-h-[330px] space-y-3 overflow-y-auto pr-2 outline-none ring-cyan-300 focus-visible:ring-2"
        tabIndex={-1}
      >
        {visibleLines.map((line, index) => {
          const transcriptIndex = startIndex + index;
          const detectedTerms = line.termIds.map((id) => termById.get(id)).filter(Boolean);
          return (
            <li
              key={`${line.id}:${transcriptIndex}`}
              data-testid="transcript-result-row"
              data-transcript-index={transcriptIndex}
              className="transcript-result-row flex gap-4 rounded-2xl border border-white/[0.055] bg-[#07111f]/55 p-4"
            >
              <div aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[10px] font-black text-slate-500">
                {transcriptIndex + 1}
              </div>
              <div>
                <TransparentCaption line={line} terms={terms} className="text-sm font-semibold leading-6 text-slate-300" />
                {detectedTerms.length > 0 ? (
                  <div className="mt-2 text-[11px] font-bold text-cyan-300">{detectedTerms.join(" · ")}</div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <nav aria-label="자막 목록 페이지 이동" className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          className="secondary-button min-h-11"
          disabled={clampedPageIndex === 0}
          onClick={() => navigateToPage(clampedPageIndex - 1)}
        >
          이전 {safePageSize}개
        </button>
        <span className="text-xs font-bold text-slate-500">{clampedPageIndex + 1} / {pageCount} 페이지</span>
        <button
          type="button"
          className="secondary-button min-h-11"
          disabled={clampedPageIndex === pageCount - 1}
          onClick={() => navigateToPage(clampedPageIndex + 1)}
        >
          다음 {safePageSize}개
        </button>
      </nav>
    </>
  );
}

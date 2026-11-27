import type { PageText } from "../types";
import { createAbortError, throwIfAborted } from "./abort";

export const PDF_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_PAGES = 100;

export type PdfTextFragment = {
  str: string;
  dir?: string;
  transform?: readonly number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

function finiteGeometryValue(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fragmentFontSize(fragment: PdfTextFragment): number {
  const height = finiteGeometryValue(fragment.height);
  const transform = fragment.transform;
  const transformHeight = transform && transform.length >= 4
    ? Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
    : 0;
  return Math.max(height ?? 0, Number.isFinite(transformHeight) ? transformHeight : 0, 1);
}

function visibleCharacterCount(value: string): number {
  return Math.max(1, Array.from(value.replace(/\s+/gu, "")).length);
}

function needsGeometrySeparator(previous: PdfTextFragment, current: PdfTextFragment): boolean {
  const previousTransform = previous.transform;
  const currentTransform = current.transform;
  const previousX = finiteGeometryValue(previousTransform?.[4]);
  const previousY = finiteGeometryValue(previousTransform?.[5]);
  const currentX = finiteGeometryValue(currentTransform?.[4]);
  const currentY = finiteGeometryValue(currentTransform?.[5]);
  const previousWidth = finiteGeometryValue(previous.width);
  const currentWidth = finiteGeometryValue(current.width);

  if (previousX === null || previousY === null || currentX === null || currentY === null ||
      previousWidth === null || currentWidth === null) {
    return true;
  }

  const fontSize = Math.max(fragmentFontSize(previous), fragmentFontSize(current));
  if (Math.abs(currentY - previousY) > fontSize * 0.35) return true;
  if (previous.dir && current.dir && previous.dir !== current.dir) return true;

  const isRtl = previous.dir === "rtl" && current.dir === "rtl";
  const gap = isRtl
    ? previousX - (currentX + currentWidth)
    : currentX - (previousX + previousWidth);
  const previousGlyphWidth = previousWidth / visibleCharacterCount(previous.str);
  const currentGlyphWidth = currentWidth / visibleCharacterCount(current.str);
  const glyphWidth = Math.max(0, Math.min(previousGlyphWidth, currentGlyphWidth));
  const adjacencyTolerance = Math.max(0.5, Math.min(fontSize * 0.15, glyphWidth * 0.2));

  // Small negative gaps are normal kerning. A large reset generally means a new
  // column or a distinct text run even when PDF.js reports the same baseline.
  if (gap < -fontSize) return true;
  return gap > adjacencyTolerance;
}

function isKoreanLineWrapContinuation(previous: PdfTextFragment, current: PdfTextFragment): boolean {
  const previousText = previous.str.trim();
  const currentText = current.str.trim();
  if (!/[가-힣]$/u.test(previousText) || !/^[가-힣]+$/u.test(currentText)) return false;

  // PDF generators occasionally split a Korean conjugation inside one word and
  // still mark the first run as EOL. These fragments cannot stand as a normal
  // word at the beginning of a new line, so retain the original word boundary.
  return /^(?:니다|니까|세요|십시오|지만|는데|으며|면서|므로|라고|이라고)$/u.test(currentText);
}

function shouldJoinAcrossEndOfLine(previous: PdfTextFragment, current: PdfTextFragment): boolean {
  return !needsGeometrySeparator(previous, current) || isKoreanLineWrapContinuation(previous, current);
}

/**
 * Reconstructs PDF.js text runs without inserting spaces inside a word.
 * Explicit whitespace, end-of-line markers, and measured layout gaps remain
 * separators; geometry-free runs use the conservative separator fallback.
 */
export function combinePdfTextFragments(items: readonly PdfTextFragment[]): string {
  let result = "";
  let previous: PdfTextFragment | null = null;
  let pendingSeparator = false;

  for (const item of items) {
    const normalized = item.str.replace(/\s+/gu, " ");
    const text = normalized.trim();
    const hasLeadingWhitespace = /^\s/u.test(normalized);
    const hasTrailingWhitespace = /\s$/u.test(normalized);

    if (!text) {
      pendingSeparator ||= normalized.length > 0 || item.hasEOL === true;
      continue;
    }

    const joinsAcrossEndOfLine = previous?.hasEOL === true && shouldJoinAcrossEndOfLine(previous, item);
    if (result && (pendingSeparator || hasLeadingWhitespace ||
        (previous?.hasEOL === true && !joinsAcrossEndOfLine) ||
        (previous !== null && !joinsAcrossEndOfLine && needsGeometrySeparator(previous, item)))) {
      result += " ";
    }
    result += text;
    previous = item;
    pendingSeparator = hasTrailingWhitespace;
  }

  return result.replace(/\s+/gu, " ").trim();
}

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export async function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  pdfJsPromise ??= import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  });
  return pdfJsPromise;
}

export function validatePdfFile(file: Pick<File, "name" | "type" | "size">): void {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("PDF 파일만 업로드할 수 있습니다.");
  }
  if (file.size > PDF_MAX_FILE_BYTES) throw new Error("PDF는 10MB 이하만 사용할 수 있습니다.");
}

export async function extractPdfPages(
  file: File,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<PageText[]> {
  validatePdfFile(file);
  throwIfAborted(signal);

  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  const { getDocument } = await loadPdfJs();
  throwIfAborted(signal);
  const loadingTask = getDocument({ data: bytes });
  let destroyPromise: Promise<void> | null = null;
  const destroyLoadingTask = (): Promise<void> => {
    destroyPromise ??= loadingTask.destroy();
    return destroyPromise;
  };
  const abortLoading = () => {
    void destroyLoadingTask();
  };
  signal?.addEventListener("abort", abortLoading, { once: true });
  let document: Awaited<typeof loadingTask.promise> | null = null;

  try {
    try {
      document = await loadingTask.promise;
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      throw error;
    }
    throwIfAborted(signal);
    if (document.numPages > PDF_MAX_PAGES) throw new Error("100페이지 이하 PDF만 지원합니다.");

    const pages: PageText[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        throwIfAborted(signal);
        const text = combinePdfTextFragments(content.items.filter(
          (item): item is Extract<(typeof content.items)[number], { str: string }> => "str" in item
        ));
        pages.push({ pageNumber, text });
      } finally {
        page.cleanup();
      }
      onProgress?.(pageNumber, document.numPages);
    }

    if (!pages.some((page) => page.text.length > 20)) {
      throw new Error("텍스트를 찾지 못했습니다. 스캔 PDF는 현재 지원하지 않습니다.");
    }
    return pages;
  } finally {
    signal?.removeEventListener("abort", abortLoading);
    await destroyLoadingTask();
  }
}

import { PDF_MAX_PAGES, loadPdfJs, validatePdfFile } from "./pdf";
import { createAbortError, throwIfAborted } from "./abort";
import type { PDFDocumentProxy } from "pdfjs-dist";

export type PresentationAsset = {
  id: string;
  name: string;
  file: File;
  objectUrl: string;
  pageCount: number;
  /**
   * The production upload path opens a PDF exactly once and lets every canvas
   * mounted for this asset reuse the same document. This remains optional so
   * lightweight callers and injected page-count tests can provide metadata-only
   * assets; the canvas keeps a backwards-compatible URL loading path for them.
   */
  pdfDocument?: PDFDocumentProxy;
  /** Idempotent owner cleanup. Call through disposePresentationAsset. */
  dispose?: () => Promise<void>;
};

export type PresentationPdfResource = {
  document: PDFDocumentProxy;
  /** Owns the PDF.js loading task and worker; must be idempotent. */
  destroy: () => Promise<void>;
};

type PresentationAssetDependencies = {
  readPageCount?: (file: File, signal?: AbortSignal) => Promise<number>;
  openPdfDocument?: (file: File, signal?: AbortSignal) => Promise<PresentationPdfResource>;
  createObjectUrl?: (file: File) => string;
  revokeObjectUrl?: (url: string) => void;
  createId?: () => string;
};

const fallbackDisposals = new WeakMap<PresentationAsset, Promise<void>>();

function runCleanup(cleanup: () => void | Promise<unknown>): Promise<void> {
  try {
    return Promise.resolve(cleanup()).then(() => undefined, () => undefined);
  } catch {
    return Promise.resolve();
  }
}

async function openPdfDocument(file: File, signal?: AbortSignal): Promise<PresentationPdfResource> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  const { getDocument } = await loadPdfJs();
  throwIfAborted(signal);

  const loadingTask = getDocument({ data: bytes });
  let destroyLoadingPromise: Promise<void> | null = null;
  const destroyLoadingTask = () => {
    destroyLoadingPromise ??= runCleanup(() => loadingTask.destroy());
    return destroyLoadingPromise;
  };
  const abortLoading = () => {
    void destroyLoadingTask();
  };
  signal?.addEventListener("abort", abortLoading, { once: true });

  try {
    const document = await loadingTask.promise;
    if (signal?.aborted) {
      await destroyLoadingTask();
      throw createAbortError();
    }
    return { document, destroy: destroyLoadingTask };
  } catch (error) {
    await destroyLoadingTask();
    if (signal?.aborted) throw createAbortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortLoading);
  }
}

export type PresentationPageAction = "previous" | "next" | "first" | "last" | null;

export function clampPresentationPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page) || pageCount < 1) return 1;
  return Math.min(pageCount, Math.max(1, Math.trunc(page)));
}

export function presentationPageActionFromKey(key: string): PresentationPageAction {
  if (key === "ArrowLeft" || key === "PageUp") return "previous";
  if (key === "ArrowRight" || key === "PageDown" || key === " ") return "next";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return null;
}

export function applyPresentationPageAction(
  page: number,
  pageCount: number,
  action: Exclude<PresentationPageAction, null>
): number {
  if (action === "first") return 1;
  if (action === "last") return Math.max(1, pageCount);
  return clampPresentationPage(page + (action === "next" ? 1 : -1), pageCount);
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(target.closest(
    "input, textarea, select, button, summary, a[href], [contenteditable]:not([contenteditable='false']), [role='button'], [role='link'], [role='menuitem'], [role='option'], [role='slider'], [role='switch'], [role='tab']"
  ));
}

export async function createPresentationAsset(
  file: File,
  dependencies: PresentationAssetDependencies = {},
  signal?: AbortSignal
): Promise<PresentationAsset> {
  validatePdfFile(file);
  throwIfAborted(signal);

  let pdfResource: PresentationPdfResource | undefined;
  let pdfDocument: PDFDocumentProxy | undefined;
  let destroyResourcePromise: Promise<void> | null = null;
  let objectUrl: string | null = null;
  let objectUrlRevoked = false;
  const destroyPdfResource = () => {
    if (!pdfResource) return Promise.resolve();
    destroyResourcePromise ??= runCleanup(() => pdfResource?.destroy());
    return destroyResourcePromise;
  };
  const revokeObjectUrl = () => {
    if (objectUrl === null || objectUrlRevoked) return;
    objectUrlRevoked = true;
    try {
      (dependencies.revokeObjectUrl ?? URL.revokeObjectURL)(objectUrl);
    } catch {
      // Disposal must continue to the PDF worker even if a URL shim is faulty.
    }
  };

  try {
    // readPageCount is kept as a metadata-only compatibility seam for tests and
    // custom callers. The normal product path opens and retains one document.
    let pageCount: number;
    if (dependencies.readPageCount) {
      pageCount = await dependencies.readPageCount(file, signal);
    } else {
      pdfResource = await (dependencies.openPdfDocument ?? openPdfDocument)(file, signal);
      pdfDocument = pdfResource.document;
      pageCount = pdfDocument.numPages;
    }
    throwIfAborted(signal);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      throw new Error("페이지가 없는 PDF는 사용할 수 없습니다.");
    }
    if (pageCount > PDF_MAX_PAGES) throw new Error("100페이지 이하 PDF만 지원합니다.");

    objectUrl = dependencies.createObjectUrl?.(file) ?? URL.createObjectURL(file);
    throwIfAborted(signal);
    const id = dependencies.createId?.() ?? globalThis.crypto.randomUUID();
    let disposePromise: Promise<void> | null = null;
    const dispose = () => {
      if (disposePromise) return disposePromise;
      revokeObjectUrl();
      disposePromise = destroyPdfResource();
      return disposePromise;
    };

    return {
      id,
      name: file.name,
      file,
      objectUrl,
      pageCount,
      ...(pdfDocument ? { pdfDocument } : {}),
      dispose
    };
  } catch (error) {
    revokeObjectUrl();
    await destroyPdfResource();
    if (signal?.aborted) throw createAbortError();
    throw error;
  }
}

export function disposePresentationAsset(asset: PresentationAsset | null): Promise<void> {
  if (!asset) return Promise.resolve();
  if (asset.dispose) return asset.dispose();

  const existing = fallbackDisposals.get(asset);
  if (existing) return existing;
  try {
    URL.revokeObjectURL(asset.objectUrl);
  } catch {
    // Some non-browser test hosts do not implement the object URL APIs.
  }
  // Metadata-only/fake assets have no worker ownership handle. Production
  // assets always carry the idempotent dispose closure created above.
  const cleanup = Promise.resolve();
  fallbackDisposals.set(asset, cleanup);
  return cleanup;
}

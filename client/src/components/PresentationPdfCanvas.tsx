import { memo, useEffect, useReducer, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { loadPdfJs } from "../lib/pdf";
import type { PresentationAsset } from "../lib/presentation";
import {
  createAnimationFrameCoalescer,
  INITIAL_PRESENTATION_PDF_CANVAS_STATE,
  isPdfRenderCancellation,
  reducePresentationPdfCanvasState,
  resolvePresentationCanvasBitmapSize,
  resolvePresentationPageIndicator,
  type PresentationPdfCanvasState
} from "./presentation-pdf-canvas-state";

type PdfRenderSession = {
  loadingTask: PDFDocumentLoadingTask | null;
  document: PDFDocumentProxy | null;
  renderTask: RenderTask | null;
  renderTaskRequest: number | null;
  renderWork: Promise<void>;
  requestVersion: number;
  disposed: boolean;
  disposePromise: Promise<void> | null;
};

function createPdfRenderSession(): PdfRenderSession {
  return {
    loadingTask: null,
    document: null,
    renderTask: null,
    renderTaskRequest: null,
    renderWork: Promise.resolve(),
    requestVersion: 0,
    disposed: false,
    disposePromise: null
  };
}

function cancelRenderTask(task: RenderTask | null): void {
  try {
    task?.cancel();
  } catch {
    // PDF.js can already have released a completed task. Cleanup remains best-effort.
  }
}

function disposePdfRenderSession(session: PdfRenderSession): Promise<void> {
  if (session.disposePromise) return session.disposePromise;

  session.disposed = true;
  session.requestVersion += 1;
  cancelRenderTask(session.renderTask);

  const loadingTask = session.loadingTask;
  const renderWork = session.renderWork;
  session.disposePromise = (async () => {
    try {
      await renderWork;
    } catch {
      // Render attempts handle their own user-visible errors. Disposal must always continue.
    }
    session.renderTask = null;
    session.renderTaskRequest = null;
    session.document = null;
    session.loadingTask = null;
    try {
      await loadingTask?.destroy();
    } catch {
      // The document may already have torn down after a failed or cancelled load.
    }
  })();
  return session.disposePromise;
}

function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.hidden = true;
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.removeProperty("width");
  canvas.style.removeProperty("height");
}

function releaseCanvases(canvases: ReadonlyArray<HTMLCanvasElement | null>): void {
  for (const canvas of canvases) {
    releaseCanvas(canvas);
  }
}

function cleanupPage(page: PDFPageProxy | null): void {
  try {
    page?.cleanup();
  } catch {
    // A destroyed document may already have released the page resources.
  }
}

export const PresentationPdfCanvas = memo(function PresentationPdfCanvas({
  asset,
  pageNumber,
  onViewStateChange
}: {
  asset: PresentationAsset;
  pageNumber: number;
  onViewStateChange?: (state: PresentationPdfCanvasState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const firstCanvasRef = useRef<HTMLCanvasElement>(null);
  const secondCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeCanvasRef = useRef<0 | 1>(0);
  const sessionRef = useRef<PdfRenderSession | null>(null);
  const cleanupBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const [documentVersion, setDocumentVersion] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [viewState, dispatchViewEvent] = useReducer(
    reducePresentationPdfCanvasState,
    INITIAL_PRESENTATION_PDF_CANVAS_STATE
  );
  const pageIndicator = resolvePresentationPageIndicator(pageNumber, asset.pageCount, viewState);
  const status = pageIndicator.status;

  useEffect(() => {
    onViewStateChange?.(viewState);
  }, [onViewStateChange, viewState]);

  useEffect(() => {
    const precedingCleanup = cleanupBarrierRef.current;
    const session = createPdfRenderSession();
    sessionRef.current = session;
    dispatchViewEvent({ type: "asset-changed", pageNumber });
    releaseCanvases([firstCanvasRef.current, secondCanvasRef.current]);
    activeCanvasRef.current = 0;

    const load = async () => {
      try {
        await precedingCleanup;
        if (session.disposed || sessionRef.current !== session) return;

        // Production assets already own an open document. A canvas is only a
        // borrower: unmounting it must never destroy the asset-level resource.
        if (asset.pdfDocument) {
          session.document = asset.pdfDocument;
          setDocumentVersion((version) => version + 1);
          return;
        }

        const { getDocument } = await loadPdfJs();
        if (session.disposed || sessionRef.current !== session) return;

        const loadingTask = getDocument({ url: asset.objectUrl });
        session.loadingTask = loadingTask;
        const document = await loadingTask.promise;
        if (session.disposed || sessionRef.current !== session) return;

        session.document = document;
        setDocumentVersion((version) => version + 1);
      } catch {
        if (!session.disposed && sessionRef.current === session) {
          dispatchViewEvent({ type: "failed", pageNumber });
        }
        void disposePdfRenderSession(session);
      }
    };

    void load();
    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      const sessionCleanup = disposePdfRenderSession(session);
      cleanupBarrierRef.current = Promise.allSettled([cleanupBarrierRef.current, sessionCleanup]).then(() => undefined);
      releaseCanvases([firstCanvasRef.current, secondCanvasRef.current]);
    };
  }, [asset.id, asset.objectUrl, asset.pdfDocument]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const resize = createAnimationFrameCoalescer(
      window.requestAnimationFrame.bind(window),
      window.cancelAnimationFrame.bind(window),
      () => setLayoutVersion((version) => version + 1)
    );
    const observer = new ResizeObserver(() => resize.request());
    observer.observe(container);
    return () => {
      observer.disconnect();
      resize.cancel();
    };
  }, []);

  useEffect(() => {
    const session = sessionRef.current;
    const document = session?.document;
    const firstCanvas = firstCanvasRef.current;
    const secondCanvas = secondCanvasRef.current;
    const container = containerRef.current;
    if (!session || !document || !container || !firstCanvas || !secondCanvas) return;
    const canvases = [firstCanvas, secondCanvas] as const;

    const requestVersion = ++session.requestVersion;
    const previousWork = session.renderWork;
    let localRenderTask: RenderTask | null = null;
    let renderCanvas: HTMLCanvasElement | null = null;
    let pagePainted = false;
    dispatchViewEvent({ type: "render-requested", pageNumber });

    const isCurrentRequest = () => (
      !session.disposed
      && sessionRef.current === session
      && session.document === document
      && session.requestVersion === requestVersion
    );

    const renderWork = (async () => {
      let page: PDFPageProxy | null = null;
      try {
        await previousWork;
        if (!isCurrentRequest()) return;

        page = await document.getPage(pageNumber);
        if (!isCurrentRequest()) return;

        const baseViewport = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(baseViewport.width)
          || !Number.isFinite(baseViewport.height)
          || baseViewport.width <= 0
          || baseViewport.height <= 0
        ) {
          throw new Error("PDF 페이지 크기가 올바르지 않습니다.");
        }

        const availableWidth = Math.max(1, container.clientWidth);
        const availableHeight = Math.max(1, container.clientHeight);
        const cssScale = Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height);
        const cssViewport = page.getViewport({ scale: cssScale });
        const bitmapSize = resolvePresentationCanvasBitmapSize({
          cssWidth: cssViewport.width,
          cssHeight: cssViewport.height,
          devicePixelRatio: window.devicePixelRatio || 1
        });
        const pixelRatio = bitmapSize.pixelRatio;
        const viewport = page.getViewport({ scale: cssScale * pixelRatio });
        const nextCanvasIndex = activeCanvasRef.current === 0 ? 1 : 0;
        const canvas = canvases[nextCanvasIndex];
        renderCanvas = canvas;

        canvas.width = bitmapSize.pixelWidth;
        canvas.height = bitmapSize.pixelHeight;
        canvas.style.width = `${Math.max(1, Math.round(bitmapSize.cssWidth))}px`;
        canvas.style.height = `${Math.max(1, Math.round(bitmapSize.cssHeight))}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("PDF canvas를 만들지 못했습니다.");
        if (!isCurrentRequest()) return;

        localRenderTask = page.render({ canvas, canvasContext: context, viewport });
        session.renderTask = localRenderTask;
        session.renderTaskRequest = requestVersion;
        await localRenderTask.promise;
        if (!isCurrentRequest()) return;

        const previousCanvas = canvases[activeCanvasRef.current];
        canvas.hidden = false;
        activeCanvasRef.current = nextCanvasIndex;
        releaseCanvas(previousCanvas);
        pagePainted = true;
        dispatchViewEvent({ type: "page-painted", pageNumber });
      } catch (error) {
        if (isCurrentRequest() && !isPdfRenderCancellation(error)) {
          dispatchViewEvent({ type: "failed", pageNumber });
        }
      } finally {
        if (session.renderTask === localRenderTask && session.renderTaskRequest === requestVersion) {
          session.renderTask = null;
          session.renderTaskRequest = null;
        }
        if (!pagePainted && renderCanvas?.hidden) releaseCanvas(renderCanvas);
        cleanupPage(page);
      }
    })();

    session.renderWork = renderWork;
    return () => {
      if (session.requestVersion === requestVersion) session.requestVersion += 1;
      if (session.renderTaskRequest === requestVersion) cancelRenderTask(localRenderTask);
    };
  }, [asset.id, documentVersion, layoutVersion, pageNumber]);

  return (
    <div
      ref={containerRef}
      className="presentation-pdf-canvas"
      data-status={status}
      role="group"
      aria-busy={status === "loading"}
      aria-label={`${asset.name} PDF 화면, ${pageIndicator.ariaLabel}`}
    >
      <canvas ref={firstCanvasRef} aria-hidden="true" hidden />
      <canvas ref={secondCanvasRef} aria-hidden="true" hidden />
      {status === "loading" && <div className="presentation-pdf-status" role="status">{pageIndicator.statusMessage}</div>}
      {status === "error" && (
        <div className="presentation-pdf-status" role="alert">
          {pageIndicator.statusMessage} 페이지를 이동하거나 창 크기를 바꾸면 다시 시도합니다. 자막과 용어 카드는 계속 표시됩니다.
        </div>
      )}
    </div>
  );
});

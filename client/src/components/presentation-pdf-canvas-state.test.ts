import { describe, expect, it, vi } from "vitest";
import {
  MAX_PRESENTATION_CANVAS_DIMENSION,
  MAX_PRESENTATION_CANVAS_PIXELS,
  createAnimationFrameCoalescer,
  createInitialPresentationPdfCanvasState,
  isPdfRenderCancellation,
  reducePresentationPdfCanvasState,
  resolvePresentationCanvasBitmapSize,
  resolvePresentationPageIndicator
} from "./presentation-pdf-canvas-state";

describe("presentation PDF canvas state", () => {
  it("keeps requested and actually painted pages separate until the new page is visible", () => {
    const firstPage = reducePresentationPdfCanvasState(
      createInitialPresentationPdfCanvasState(1),
      { type: "page-painted", pageNumber: 1 }
    );
    const requestingSecondPage = reducePresentationPdfCanvasState(
      firstPage,
      { type: "render-requested", pageNumber: 2 }
    );

    expect(requestingSecondPage).toEqual({
      status: "loading",
      requestedPageNumber: 2,
      paintedPageNumber: 1
    });
    expect(resolvePresentationPageIndicator(2, 12, requestingSecondPage)).toMatchObject({
      status: "loading",
      label: "1 → 2 / 12",
      ariaLabel: "2페이지 여는 중, 현재 1페이지 표시 중"
    });

    const secondPage = reducePresentationPdfCanvasState(
      requestingSecondPage,
      { type: "page-painted", pageNumber: 2 }
    );
    expect(secondPage).toEqual({
      status: "ready",
      requestedPageNumber: 2,
      paintedPageNumber: 2
    });
    expect(resolvePresentationPageIndicator(2, 12, secondPage).label).toBe("2 / 12");
  });

  it("retains the last painted page when a requested page fails", () => {
    const firstPage = {
      status: "ready",
      requestedPageNumber: 1,
      paintedPageNumber: 1
    } as const;
    const failed = reducePresentationPdfCanvasState(
      reducePresentationPdfCanvasState(firstPage, { type: "render-requested", pageNumber: 2 }),
      { type: "failed", pageNumber: 2 }
    );

    expect(failed).toEqual({
      status: "error",
      requestedPageNumber: 2,
      paintedPageNumber: 1
    });
    expect(resolvePresentationPageIndicator(2, 12, failed)).toMatchObject({
      label: "1 / 12 · 2 실패",
      statusMessage: "2페이지를 표시하지 못해 1페이지를 계속 표시하고 있습니다."
    });
  });

  it("does not show a loading transition for a resize of the already painted page", () => {
    const painted = {
      status: "ready",
      requestedPageNumber: 3,
      paintedPageNumber: 3
    } as const;

    expect(reducePresentationPdfCanvasState(
      painted,
      { type: "render-requested", pageNumber: 3 }
    )).toEqual(painted);
  });

  it("resets the painted page when the presentation asset changes", () => {
    expect(reducePresentationPdfCanvasState(
      { status: "ready", requestedPageNumber: 8, paintedPageNumber: 8 },
      { type: "asset-changed", pageNumber: 1 }
    )).toEqual(createInitialPresentationPdfCanvasState(1));
  });
});

describe("presentation PDF bitmap budget", () => {
  it("keeps ordinary Retina presentation pages sharp", () => {
    expect(resolvePresentationCanvasBitmapSize({
      cssWidth: 1_920,
      cssHeight: 1_080,
      devicePixelRatio: 2
    })).toMatchObject({
      pixelRatio: 2,
      pixelWidth: 3_840,
      pixelHeight: 2_160
    });
  });

  it("bounds 8K and high-DPR fullscreen pages by both area and axis", () => {
    const size = resolvePresentationCanvasBitmapSize({
      cssWidth: 7_680,
      cssHeight: 4_320,
      devicePixelRatio: 2
    });

    expect(size.pixelRatio).toBeLessThan(1);
    expect(size.pixelWidth).toBeLessThanOrEqual(MAX_PRESENTATION_CANVAS_DIMENSION);
    expect(size.pixelHeight).toBeLessThanOrEqual(MAX_PRESENTATION_CANVAS_DIMENSION);
    expect(size.pixelWidth * size.pixelHeight).toBeLessThanOrEqual(MAX_PRESENTATION_CANVAS_PIXELS);
  });
});

describe("presentation PDF resize coalescing", () => {
  it("runs at most one resize update per animation frame and can schedule the next frame", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    const update = vi.fn();
    const coalescer = createAnimationFrameCoalescer(
      (callback) => {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      (handle) => frames.delete(handle),
      update
    );

    coalescer.request();
    coalescer.request();
    coalescer.request();
    expect(frames.size).toBe(1);

    frames.get(1)?.(16);
    expect(update).toHaveBeenCalledTimes(1);

    coalescer.request();
    expect(frames.has(2)).toBe(true);
    frames.get(2)?.(32);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued resize update during cleanup", () => {
    const cancelFrame = vi.fn();
    const update = vi.fn();
    const coalescer = createAnimationFrameCoalescer(() => 42, cancelFrame, update);

    coalescer.request();
    coalescer.cancel();

    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("PDF.js render cancellation", () => {
  it("distinguishes expected render cancellation from real failures", () => {
    const cancellation = new Error("cancelled");
    cancellation.name = "RenderingCancelledException";

    expect(isPdfRenderCancellation(cancellation)).toBe(true);
    expect(isPdfRenderCancellation({ name: "RenderingCancelledException" })).toBe(true);
    expect(isPdfRenderCancellation(new Error("broken page"))).toBe(false);
    expect(isPdfRenderCancellation(null)).toBe(false);
  });
});

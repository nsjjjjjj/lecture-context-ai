/** @vitest-environment jsdom */

import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { PresentationAsset } from "../lib/presentation";
import { loadPdfJs } from "../lib/pdf";
import { PresentationPdfCanvas } from "./PresentationPdfCanvas";
import type { PresentationPdfCanvasState } from "./presentation-pdf-canvas-state";

vi.mock("../lib/pdf", () => ({
  loadPdfJs: vi.fn()
}));

const asset: PresentationAsset = {
  id: "presentation-1",
  name: "slides.pdf",
  file: new File(["pdf"], "slides.pdf", { type: "application/pdf" }),
  objectUrl: "blob:presentation-1",
  pageCount: 5
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("presentation PDF canvas", () => {
  beforeEach(() => {
    vi.mocked(loadPdfJs).mockReset();
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({}))
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("starts busy with both render buffers hidden until the first page is painted", () => {
    const html = renderToStaticMarkup(<PresentationPdfCanvas asset={asset} pageNumber={2} />);

    expect(html).toContain('data-status="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="slides.pdf PDF 화면, 2페이지 여는 중, 표시 중인 페이지 없음"');
    expect(html.match(/<canvas[^>]*hidden=""/g)).toHaveLength(2);
    expect(html).toContain('<div class="presentation-pdf-status" role="status">2페이지를 여는 중입니다.</div>');
  });

  it("같은 asset을 다시 마운트해도 소유 문서를 재사용하고 canvas는 문서를 파괴하지 않는다", async () => {
    const renderTask = {
      promise: Promise.resolve(),
      cancel: vi.fn()
    } as unknown as RenderTask;
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 1600 * scale, height: 900 * scale }),
      render: vi.fn(() => renderTask),
      cleanup: vi.fn()
    } as unknown as PDFPageProxy;
    const document = {
      numPages: 5,
      getPage: vi.fn(async () => page)
    } as unknown as PDFDocumentProxy;
    const dispose = vi.fn(async () => undefined);
    const sharedAsset: PresentationAsset = {
      ...asset,
      pdfDocument: document,
      dispose
    };

    const firstMount = render(<PresentationPdfCanvas asset={sharedAsset} pageNumber={1} />);
    await waitFor(() => expect(document.getPage).toHaveBeenCalledTimes(1));
    firstMount.unmount();

    const secondMount = render(<PresentationPdfCanvas asset={sharedAsset} pageNumber={2} />);
    await waitFor(() => expect(document.getPage).toHaveBeenCalledTimes(2));
    secondMount.unmount();

    expect(loadPdfJs).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(page.cleanup).toHaveBeenCalledTimes(2);
  });

  it("keeps the painted page visible and releases its backing store only after the requested page is painted", async () => {
    const secondPaint = deferred<void>();
    const renderTasks = [
      { promise: Promise.resolve(), cancel: vi.fn() },
      { promise: secondPaint.promise, cancel: vi.fn() }
    ] as unknown as RenderTask[];
    let renderIndex = 0;
    const pages = [1, 2].map(() => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 1_600 * scale, height: 900 * scale }),
      render: vi.fn(() => renderTasks[renderIndex++]!),
      cleanup: vi.fn()
    } as unknown as PDFPageProxy));
    const document = {
      numPages: 5,
      getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]!)
    } as unknown as PDFDocumentProxy;
    const sharedAsset: PresentationAsset = {
      ...asset,
      pdfDocument: document,
      dispose: vi.fn(async () => undefined)
    };
    const states: PresentationPdfCanvasState[] = [];
    const { container, rerender } = render(
      <PresentationPdfCanvas
        asset={sharedAsset}
        pageNumber={1}
        onViewStateChange={(state) => states.push(state)}
      />
    );

    await waitFor(() => expect(container.querySelector(".presentation-pdf-canvas")?.getAttribute("data-status")).toBe("ready"));
    const canvases = [...container.querySelectorAll("canvas")];
    const firstPaintedCanvas = canvases.find((canvas) => !canvas.hidden)!;
    expect(states.at(-1)).toMatchObject({ status: "ready", requestedPageNumber: 1, paintedPageNumber: 1 });

    rerender(
      <PresentationPdfCanvas
        asset={sharedAsset}
        pageNumber={2}
        onViewStateChange={(state) => states.push(state)}
      />
    );

    await waitFor(() => expect(container.querySelector(".presentation-pdf-canvas")?.getAttribute("data-status")).toBe("loading"));
    expect(container.textContent).toContain("2페이지를 여는 동안 1페이지를 계속 표시하고 있습니다.");
    expect(firstPaintedCanvas.hidden).toBe(false);
    expect(states.at(-1)).toMatchObject({ status: "loading", requestedPageNumber: 2, paintedPageNumber: 1 });

    secondPaint.resolve(undefined);
    await waitFor(() => expect(container.querySelector(".presentation-pdf-canvas")?.getAttribute("data-status")).toBe("ready"));

    expect(firstPaintedCanvas.hidden).toBe(true);
    expect(firstPaintedCanvas.width).toBe(0);
    expect(firstPaintedCanvas.height).toBe(0);
    expect(states.at(-1)).toMatchObject({ status: "ready", requestedPageNumber: 2, paintedPageNumber: 2 });
  });
});

export type PresentationPdfCanvasStatus = "loading" | "ready" | "error";

export type PresentationPdfCanvasState = {
  status: PresentationPdfCanvasStatus;
  requestedPageNumber: number;
  paintedPageNumber: number | null;
};

export type PresentationPdfCanvasEvent =
  | { type: "asset-changed"; pageNumber: number }
  | { type: "render-requested"; pageNumber: number }
  | { type: "page-painted"; pageNumber: number }
  | { type: "failed"; pageNumber: number };

export function createInitialPresentationPdfCanvasState(pageNumber = 1): PresentationPdfCanvasState {
  return {
    status: "loading",
    requestedPageNumber: pageNumber,
    paintedPageNumber: null
  };
}

export const INITIAL_PRESENTATION_PDF_CANVAS_STATE = createInitialPresentationPdfCanvasState();

export function reducePresentationPdfCanvasState(
  state: PresentationPdfCanvasState,
  event: PresentationPdfCanvasEvent
): PresentationPdfCanvasState {
  switch (event.type) {
    case "asset-changed":
      return createInitialPresentationPdfCanvasState(event.pageNumber);
    case "render-requested":
      if (state.status !== "error" && state.paintedPageNumber === event.pageNumber) {
        return {
          ...state,
          status: "ready",
          requestedPageNumber: event.pageNumber
        };
      }
      return {
        ...state,
        status: "loading",
        requestedPageNumber: event.pageNumber
      };
    case "page-painted":
      return {
        status: "ready",
        requestedPageNumber: event.pageNumber,
        paintedPageNumber: event.pageNumber
      };
    case "failed":
      return {
        ...state,
        status: "error",
        requestedPageNumber: event.pageNumber
      };
  }
}

export type PresentationPageIndicator = {
  status: PresentationPdfCanvasStatus;
  label: string;
  ariaLabel: string;
  statusMessage: string;
};

export function resolvePresentationPageIndicator(
  requestedPageNumber: number,
  pageCount: number,
  state: PresentationPdfCanvasState
): PresentationPageIndicator {
  const requestedMatchesState = state.requestedPageNumber === requestedPageNumber;
  const status = requestedMatchesState
    ? state.status
    : state.paintedPageNumber === requestedPageNumber
      ? "ready"
      : "loading";
  const paintedPageNumber = state.paintedPageNumber;

  if (status === "ready" && paintedPageNumber === requestedPageNumber) {
    return {
      status,
      label: `${paintedPageNumber} / ${pageCount}`,
      ariaLabel: `${paintedPageNumber}페이지, 전체 ${pageCount}페이지`,
      statusMessage: `${paintedPageNumber}페이지를 표시하고 있습니다.`
    };
  }

  if (status === "error") {
    return paintedPageNumber === null
      ? {
          status,
          label: `${requestedPageNumber} / ${pageCount} · 실패`,
          ariaLabel: `${requestedPageNumber}페이지 표시 실패, 표시 중인 페이지 없음`,
          statusMessage: `${requestedPageNumber}페이지를 표시하지 못했습니다.`
        }
      : {
          status,
          label: `${paintedPageNumber} / ${pageCount} · ${requestedPageNumber} 실패`,
          ariaLabel: `${requestedPageNumber}페이지 표시 실패, 현재 ${paintedPageNumber}페이지 표시 중`,
          statusMessage: `${requestedPageNumber}페이지를 표시하지 못해 ${paintedPageNumber}페이지를 계속 표시하고 있습니다.`
        };
  }

  return paintedPageNumber === null
    ? {
        status: "loading",
        label: `${requestedPageNumber} / ${pageCount} · 여는 중`,
        ariaLabel: `${requestedPageNumber}페이지 여는 중, 표시 중인 페이지 없음`,
        statusMessage: `${requestedPageNumber}페이지를 여는 중입니다.`
      }
    : {
        status: "loading",
        label: `${paintedPageNumber} → ${requestedPageNumber} / ${pageCount}`,
        ariaLabel: `${requestedPageNumber}페이지 여는 중, 현재 ${paintedPageNumber}페이지 표시 중`,
        statusMessage: `${requestedPageNumber}페이지를 여는 동안 ${paintedPageNumber}페이지를 계속 표시하고 있습니다.`
      };
}

export const MAX_PRESENTATION_CANVAS_PIXELS = 16_000_000;
export const MAX_PRESENTATION_CANVAS_DIMENSION = 8_192;
export const MAX_PRESENTATION_CANVAS_DEVICE_PIXEL_RATIO = 2;

export type PresentationCanvasBitmapSize = {
  pixelRatio: number;
  pixelWidth: number;
  pixelHeight: number;
  cssWidth: number;
  cssHeight: number;
};

export function resolvePresentationCanvasBitmapSize({
  cssWidth,
  cssHeight,
  devicePixelRatio,
  maxPixels = MAX_PRESENTATION_CANVAS_PIXELS,
  maxDimension = MAX_PRESENTATION_CANVAS_DIMENSION
}: {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  maxPixels?: number;
  maxDimension?: number;
}): PresentationCanvasBitmapSize {
  const safeCssWidth = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 1;
  const safeCssHeight = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : 1;
  const safeMaxPixels = Number.isFinite(maxPixels) && maxPixels >= 1 ? Math.floor(maxPixels) : 1;
  const safeMaxDimension = Number.isFinite(maxDimension) && maxDimension >= 1 ? Math.floor(maxDimension) : 1;
  const desiredPixelRatio = Math.min(
    Math.max(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, 1),
    MAX_PRESENTATION_CANVAS_DEVICE_PIXEL_RATIO
  );
  const boundedPixelRatio = Math.min(
    desiredPixelRatio,
    safeMaxDimension / safeCssWidth,
    safeMaxDimension / safeCssHeight,
    Math.sqrt(safeMaxPixels / (safeCssWidth * safeCssHeight))
  );
  const pixelWidth = Math.max(1, Math.floor(safeCssWidth * boundedPixelRatio));
  const pixelHeight = Math.max(1, Math.floor(safeCssHeight * boundedPixelRatio));
  const pixelRatio = Math.min(pixelWidth / safeCssWidth, pixelHeight / safeCssHeight);

  return {
    pixelRatio,
    pixelWidth,
    pixelHeight,
    cssWidth: safeCssWidth,
    cssHeight: safeCssHeight
  };
}

export type AnimationFrameCoalescer = {
  request: () => void;
  cancel: () => void;
};

export function createAnimationFrameCoalescer(
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (handle: number) => void,
  callback: () => void
): AnimationFrameCoalescer {
  let pendingFrame: number | null = null;

  return {
    request() {
      if (pendingFrame !== null) return;
      pendingFrame = requestFrame(() => {
        pendingFrame = null;
        callback();
      });
    },
    cancel() {
      if (pendingFrame === null) return;
      cancelFrame(pendingFrame);
      pendingFrame = null;
    }
  };
}

export function isPdfRenderCancellation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "RenderingCancelledException";
}

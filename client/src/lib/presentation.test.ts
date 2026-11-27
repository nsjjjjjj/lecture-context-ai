import { describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  applyPresentationPageAction,
  clampPresentationPage,
  createPresentationAsset,
  disposePresentationAsset,
  presentationPageActionFromKey
} from "./presentation";
import type { PresentationPdfResource } from "./presentation";

function createPdfDocument(numPages = 12) {
  return {
    numPages
  } as unknown as PDFDocumentProxy;
}

function createPdfResource(numPages = 12): PresentationPdfResource {
  return {
    document: createPdfDocument(numPages),
    destroy: vi.fn(async () => undefined)
  };
}

describe("presentation PDF asset", () => {
  it("PDF 메타데이터와 page count를 별도 asset으로 만든다", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "slides.pdf", { type: "application/pdf" });
    const asset = await createPresentationAsset(file, {
      readPageCount: vi.fn(async () => 12),
      createObjectUrl: () => "blob:presentation",
      createId: () => "presentation-1"
    });
    expect(asset).toMatchObject({
      id: "presentation-1",
      name: "slides.pdf",
      file,
      objectUrl: "blob:presentation",
      pageCount: 12
    });
    expect(asset.pdfDocument).toBeUndefined();
    expect(asset.dispose).toEqual(expect.any(Function));
  });

  it("실제 업로드 경로는 asset마다 PDF를 한 번만 열고 dispose를 여러 번 불러도 한 번만 정리한다", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "slides.pdf", { type: "application/pdf" });
    const resource = createPdfResource(8);
    const openPdfDocument = vi.fn(async () => resource);
    const revokeObjectUrl = vi.fn();

    const asset = await createPresentationAsset(file, {
      openPdfDocument,
      createObjectUrl: () => "blob:owned-presentation",
      revokeObjectUrl,
      createId: () => "owned-presentation"
    });

    expect(openPdfDocument).toHaveBeenCalledTimes(1);
    expect(asset.pdfDocument).toBe(resource.document);
    expect(asset.pageCount).toBe(8);

    await Promise.all([disposePresentationAsset(asset), disposePresentationAsset(asset)]);
    expect(resource.destroy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:owned-presentation");
  });

  it("PDF 형식, 10MB, 100페이지 제한을 asset 생성 전에 검증한다", async () => {
    const text = new File(["text"], "notes.txt", { type: "text/plain" });
    await expect(createPresentationAsset(text, { readPageCount: async () => 1 })).rejects.toThrow("PDF 파일만");

    const tooLarge = { name: "slides.pdf", type: "application/pdf", size: 10 * 1024 * 1024 + 1 } as File;
    await expect(createPresentationAsset(tooLarge, { readPageCount: async () => 1 })).rejects.toThrow("10MB");

    const file = new File(["pdf"], "slides.pdf", { type: "application/pdf" });
    await expect(createPresentationAsset(file, { readPageCount: async () => 101 })).rejects.toThrow("100페이지");
  });

  it("열린 PDF가 검증에 실패하거나 asset 조립에 실패하면 문서를 즉시 한 번만 정리한다", async () => {
    const file = new File(["pdf"], "slides.pdf", { type: "application/pdf" });
    const oversizedResource = createPdfResource(101);
    await expect(createPresentationAsset(file, {
      openPdfDocument: async () => oversizedResource
    })).rejects.toThrow("100페이지");
    expect(oversizedResource.destroy).toHaveBeenCalledTimes(1);

    const validResource = createPdfResource(3);
    await expect(createPresentationAsset(file, {
      openPdfDocument: async () => validResource,
      createObjectUrl: () => {
        throw new Error("URL 생성 실패");
      }
    })).rejects.toThrow("URL 생성 실패");
    expect(validResource.destroy).toHaveBeenCalledTimes(1);
  });

  it("교체 요청이 취소되면 object URL을 만들지 않는다", async () => {
    const controller = new AbortController();
    const createObjectUrl = vi.fn(() => "blob:cancelled");
    let finishRead!: (pageCount: number) => void;
    const file = new File(["pdf"], "slides.pdf", { type: "application/pdf" });
    const operation = createPresentationAsset(file, {
      readPageCount: () => new Promise<number>((resolve) => {
        finishRead = resolve;
      }),
      createObjectUrl
    }, controller.signal);

    controller.abort();
    finishRead(3);

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("PDF 문서를 여는 동안 취소되면 늦게 도착한 문서를 한 번만 정리한다", async () => {
    const controller = new AbortController();
    const resource = createPdfResource(3);
    let finishOpen!: (resource: PresentationPdfResource) => void;
    const file = new File(["pdf"], "slides.pdf", { type: "application/pdf" });
    const operation = createPresentationAsset(file, {
      openPdfDocument: () => new Promise<PresentationPdfResource>((resolve) => {
        finishOpen = resolve;
      }),
      createObjectUrl: vi.fn(() => "blob:cancelled")
    }, controller.signal);

    controller.abort();
    finishOpen(resource);

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(resource.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("presentation page controller", () => {
  it("페이지 이동을 범위 안으로 고정한다", () => {
    expect(clampPresentationPage(-10, 12)).toBe(1);
    expect(clampPresentationPage(99, 12)).toBe(12);
    expect(applyPresentationPageAction(1, 12, "previous")).toBe(1);
    expect(applyPresentationPageAction(12, 12, "next")).toBe(12);
    expect(applyPresentationPageAction(5, 12, "first")).toBe(1);
    expect(applyPresentationPageAction(5, 12, "last")).toBe(12);
  });

  it("발표용 키를 페이지 동작으로 매핑한다", () => {
    expect(presentationPageActionFromKey("ArrowLeft")).toBe("previous");
    expect(presentationPageActionFromKey("PageDown")).toBe("next");
    expect(presentationPageActionFromKey(" ")).toBe("next");
    expect(presentationPageActionFromKey("Home")).toBe("first");
    expect(presentationPageActionFromKey("End")).toBe("last");
    expect(presentationPageActionFromKey("Escape")).toBeNull();
  });
});

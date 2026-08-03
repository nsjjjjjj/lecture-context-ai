import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PageText } from "../types";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export async function extractPdfPages(file: File, onProgress?: (current: number, total: number) => void): Promise<PageText[]> {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("PDF 파일만 업로드할 수 있습니다.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("PDF는 10MB 이하만 사용할 수 있습니다.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const document = await getDocument({ data: bytes }).promise;
  if (document.numPages > 100) throw new Error("MVP에서는 100페이지 이하 PDF만 지원합니다.");

  const pages: PageText[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({ pageNumber, text });
    onProgress?.(pageNumber, document.numPages);
  }

  if (!pages.some((page) => page.text.length > 20)) {
    throw new Error("텍스트를 찾지 못했습니다. 스캔 PDF는 현재 지원하지 않습니다.");
  }
  return pages;
}

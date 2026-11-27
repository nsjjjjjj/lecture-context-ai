export type FileExportResult = "confirmed" | "download-requested" | "cancelled";

type WritableFileLike = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};

type FileHandleLike = {
  createWritable: () => Promise<WritableFileLike>;
};

type SaveFilePickerLike = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<FileHandleLike>;

function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function requestTextDownload(
  contents: string,
  fileName: string,
  mediaType = "application/json;charset=utf-8"
): FileExportResult {
  const url = URL.createObjectURL(new Blob([contents], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return "download-requested";
}

/**
 * A completed File System Access write is confirmable. An anchor click is only
 * a request: browsers can block, rename, or discard it after this function.
 */
export async function saveTextFile(
  contents: string,
  fileName: string,
  mediaType = "application/json;charset=utf-8"
): Promise<FileExportResult> {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePickerLike }).showSaveFilePicker;
  if (!picker) return requestTextDownload(contents, fileName, mediaType);

  const extensionIndex = fileName.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex) : ".txt";
  try {
    const handle = await picker.call(window, {
      suggestedName: fileName,
      types: [{
        description: mediaType.startsWith("application/json") ? "JSON 파일" : "텍스트 파일",
        accept: { [mediaType.split(";")[0]]: [extension] }
      }]
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([contents], { type: mediaType }));
    await writable.close();
    return "confirmed";
  } catch (error) {
    if (isPickerCancellation(error)) return "cancelled";
    throw error;
  }
}

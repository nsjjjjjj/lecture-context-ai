// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { saveTextFile } from "./file-export";

afterEach(() => {
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  vi.restoreAllMocks();
});

describe("saveTextFile", () => {
  it("reports a fallback anchor click only as download-requested", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:requested") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await expect(saveTextFile("result", "result.json")).resolves.toBe("download-requested");
    expect(click).toHaveBeenCalledOnce();
  });

  it("reports confirmed only after the selected file is written and closed", async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => ({ write, close })
    }));
    (window as Window & { showSaveFilePicker?: typeof showSaveFilePicker }).showSaveFilePicker = showSaveFilePicker;

    await expect(saveTextFile("result", "result.txt", "text/plain;charset=utf-8")).resolves.toBe("confirmed");
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not turn a cancelled picker into a confirmed export", async () => {
    (window as Window & { showSaveFilePicker?: () => Promise<never> }).showSaveFilePicker = async () => {
      throw new DOMException("cancelled", "AbortError");
    };
    await expect(saveTextFile("result", "result.json")).resolves.toBe("cancelled");
  });
});

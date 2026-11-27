// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GlossaryRecoveryPanel } from "./GlossaryRecoveryPanel";

describe("GlossaryRecoveryPanel", () => {
  it("disables export and destructive cleanup together while any storage action is active", () => {
    const onExport = vi.fn();
    const onClear = vi.fn();
    render(
      <GlossaryRecoveryPanel
        backups={[{
          id: "backup-1",
          capturedAt: "2026-08-29T00:00:00.000Z",
          reason: "manual-recovery",
          sourceVersion: 3,
          raw: "raw"
        }]}
        issue={null}
        notice=""
        busy
        onExport={onExport}
        onClear={onClear}
      />
    );

    const exportButton = screen.getByRole("button", { name: "복구 JSON 다운로드 요청" }) as HTMLButtonElement;
    const clearButton = screen.getByRole("button", { name: "브라우저 보관본 정리" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(clearButton.disabled).toBe(true);
    fireEvent.click(exportButton);
    fireEvent.click(clearButton);
    expect(onExport).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });
});

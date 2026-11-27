// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTranscriptLine,
  createTranscriptStore
} from "../hooks/transcript-store";
import { TranscriptResultsList, TRANSCRIPT_RESULTS_PAGE_SIZE } from "./TranscriptResultsList";

afterEach(cleanup);

describe("TranscriptResultsList", () => {
  it("10,000개 기록에서 DOM 행을 제한하고 첫 행부터 마지막 행까지 페이지로 접근한다", () => {
    let transcript = createTranscriptStore();
    for (let index = 0; index < 10_000; index += 1) {
      transcript = appendTranscriptLine(transcript, {
        id: `line-${index}`,
        text: `확정 자막 ${index + 1}`,
        rawText: `확정 자막 ${index + 1}`,
        termIds: [],
        corrections: []
      });
    }

    render(<TranscriptResultsList transcript={transcript} terms={[]} />);

    expect(screen.getAllByTestId("transcript-result-row")).toHaveLength(TRANSCRIPT_RESULTS_PAGE_SIZE);
    expect(screen.getAllByTestId("transcript-result-row")[0].getAttribute("data-transcript-index")).toBe("0");
    expect(screen.getByText("확정 자막 100")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `다음 ${TRANSCRIPT_RESULTS_PAGE_SIZE}개` }));
    expect(screen.getAllByTestId("transcript-result-row")).toHaveLength(TRANSCRIPT_RESULTS_PAGE_SIZE);
    expect(screen.getAllByTestId("transcript-result-row")[0].getAttribute("data-transcript-index")).toBe("100");

    fireEvent.change(screen.getByRole("combobox", { name: "자막 페이지 선택" }), {
      target: { value: "99" }
    });
    expect(screen.getAllByTestId("transcript-result-row")).toHaveLength(TRANSCRIPT_RESULTS_PAGE_SIZE);
    expect(screen.getByText("확정 자막 10000")).toBeTruthy();
    expect(screen.getAllByTestId("transcript-result-row").at(-1)?.getAttribute("data-transcript-index")).toBe("9999");
  });

  it("빈 기록을 명시적으로 안내한다", () => {
    render(<TranscriptResultsList transcript={createTranscriptStore()} terms={[]} />);

    expect(screen.getByText("확정된 자막이 없습니다.")).toBeTruthy();
    expect(screen.queryByTestId("transcript-result-row")).toBeNull();
  });
});

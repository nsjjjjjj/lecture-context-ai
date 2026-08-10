import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AudioFixtureCatalog, AudioFixtureRecording } from "../lib/api";
import {
  ExperimentWorkspaceView,
  appendRecordingToCatalog,
  type ExperimentPanel
} from "./ExperimentWorkspace";

const recording: AudioFixtureRecording = {
  id: "11111111-1111-4111-8111-111111111111",
  fileName: "fixture-a.wav",
  relativePath: "audio/fixture-a.wav",
  scriptId: "baseline-v1",
  speakerLabel: "speaker-a",
  environment: "quiet",
  createdAt: "2026-08-09T00:00:00.000Z",
  durationMs: 1_000,
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  dataBytes: 32_000,
  speakerReadReferenceScriptVerbatim: true
};

const catalog: AudioFixtureCatalog = {
  scripts: [{
    id: "baseline-v1",
    title: "기준 문장",
    languageCode: "ko-KR",
    text: "엘엘엠과 래그를 읽습니다.",
    targetTerms: []
  }],
  recordings: [recording],
  storageDirectory: "test-fixtures/stt/audio"
};

function renderPanel(
  panel: ExperimentPanel,
  state: Pick<Parameters<typeof ExperimentWorkspaceView>[0], "catalog" | "catalogLoading" | "catalogError"> = {
    catalog,
    catalogLoading: false,
    catalogError: ""
  }
): string {
  return renderToStaticMarkup(
    <ExperimentWorkspaceView
      panel={panel}
      {...state}
      onPanelChange={() => undefined}
      onRecordingSaved={() => undefined}
      onResultReady={() => undefined}
    />
  );
}

describe("experiment catalog ownership", () => {
  it("renders loading, error, and loaded catalog status", () => {
    const loadingHtml = renderPanel("record", { catalog: null, catalogLoading: true, catalogError: "" });
    expect(loadingHtml).toContain("실험 카탈로그 불러오는 중");
    expect(loadingHtml).toContain("개발용 녹음 설정을 불러오는 중입니다");

    const errorHtml = renderPanel("record", { catalog: null, catalogLoading: false, catalogError: "fixture API 404" });
    expect(errorHtml).toContain("실험 카탈로그를 불러오지 못했습니다: fixture API 404");

    const loadedHtml = renderPanel("record");
    expect(loadedHtml).toContain("로컬 녹음 1개 준비됨");
    expect(loadedHtml).toContain("fixture-a.wav");
  });

  it("appends a newly saved recording once without duplicating the same id", () => {
    const nextRecording = { ...recording, id: "22222222-2222-4222-8222-222222222222", fileName: "fixture-b.wav" };
    const appended = appendRecordingToCatalog(catalog, nextRecording);

    expect(appended?.recordings.map((item) => item.id)).toEqual([recording.id, nextRecording.id]);
    expect(appendRecordingToCatalog(appended, nextRecording)).toBe(appended);
  });
});

describe("experiment panel hierarchy", () => {
  it("keeps the programmatic heading focus target without interactive focus-ring styling", () => {
    const html = renderPanel("record");
    const headingTag = html.match(/<h1[^>]*>/)?.[0];

    expect(headingTag).toContain('tabindex="-1"');
    expect(headingTag).toContain("outline-none");
    expect(headingTag).not.toContain("focus-visible:ring");
    expect(headingTag).not.toContain("ring-cyan-300");
    expect(html).toMatch(/<a[^>]*ring-cyan-300[^>]*focus-visible:ring-2/);
  });

  it.each([
    ["setup", "실험 세트 설정"],
    ["record", "고정음원 녹음"],
    ["run", "A/B/C 비교 실행"],
    ["results", "비교 결과 확인"]
  ] as const)("marks and renders only the %s task", (panel, title) => {
    const html = renderPanel(panel);

    expect(html).toContain(title);
    expect(html).toContain(`data-testid="experiment-task-${panel}"`);
    expect(html.match(/data-testid="experiment-task-/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`href="#/experiment/${panel}" aria-current="page"`));

    if (panel === "setup") {
      expect(html).toContain("PDF·대본 케이스 만들기");
      expect(html).not.toContain('data-testid="audio-fixture-recorder"');
    } else if (panel === "record") {
      expect(html).toContain('data-testid="audio-fixture-recorder"');
      expect(html).not.toContain("명시적 유료 호출 동의");
      expect(html).not.toContain('data-testid="stt-results-list-pane"');
    } else if (panel === "run") {
      expect(html).toContain("명시적 유료 호출 동의");
      expect(html).not.toContain('data-testid="audio-fixture-recorder"');
      expect(html).not.toContain('data-testid="stt-results-list-pane"');
    } else {
      expect(html).toContain('data-testid="stt-results-list-pane"');
      expect(html).not.toContain('data-testid="audio-fixture-recorder"');
      expect(html).not.toContain("명시적 유료 호출 동의");
    }
  });
});

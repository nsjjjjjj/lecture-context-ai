import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAudioFixture, type AudioFixtureCatalog, type AudioFixtureRecording } from "../lib/api";
import {
  AudioFixtureRecorder,
  createRecordingSavedNotifier,
  runSingleFlight,
  snapshotFixtureMetadata,
  type FixtureCaptureMetadata
} from "./AudioFixtureRecorder";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audio fixture metadata ownership", () => {
  const recording: AudioFixtureRecording = {
    id: "11111111-1111-4111-8111-111111111111",
    fileName: "fixture.wav",
    relativePath: "audio/fixture.wav",
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
    storageDirectory: "test-fixtures/stt/audio",
    recordings: [recording]
  };

  it("renders only the injected catalog without fetching or nesting comparison results", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const html = renderToStaticMarkup(createElement(AudioFixtureRecorder, {
      catalog,
      catalogLoading: false,
      catalogError: "",
      onRecordingSaved: () => undefined
    }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("엘엘엠과 래그를 읽습니다");
    expect(html).toContain("fixture.wav");
    expect(html).toContain("유료 STT API를 호출하지 않고");
    expect(html).not.toContain("실제 Google API");
    expect(html).not.toContain("A/B/C STT 비교 실행");
    expect(html).not.toContain("저장된 STT 비교 결과");
    expect(html).toContain('for="fixture-speaker-label"');
    expect(html).toContain('name="fixtureSpeakerLabel"');
    expect(html).toContain('name="fixtureEnvironment"');
    expect(html).toContain('name="fixtureScriptId"');
    expect(html).toContain('name="fixtureVerbatimConfirmation"');
    expect(html).toContain("focus-visible:ring-2");
  });

  it("announces catalog loading as a status instead of plain decorative text", () => {
    const html = renderToStaticMarkup(createElement(AudioFixtureRecorder, {
      catalog: null,
      catalogLoading: true,
      catalogError: "",
      onRecordingSaved: () => undefined
    }));

    expect(html).toMatch(/role="status"[^>]*>.*개발용 녹음 설정을 불러오는 중입니다/s);
    expect(html).toContain('aria-hidden="true"');
  });

  it("notifies the parent exactly once for the same successful save", () => {
    const onRecordingSaved = vi.fn();
    const notifyRecordingSaved = createRecordingSavedNotifier(onRecordingSaved);

    expect(notifyRecordingSaved(recording)).toBe(true);
    expect(notifyRecordingSaved(recording)).toBe(false);
    expect(onRecordingSaved).toHaveBeenCalledOnce();
    expect(onRecordingSaved).toHaveBeenCalledWith(recording);
  });

  it("coalesces repeated start requests until microphone setup settles", async () => {
    let resolveStart!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>((resolve) => { resolveStart = resolve; }));
    const owner = { current: null as Promise<string> | null };

    const first = runSingleFlight(owner, operation);
    const second = runSingleFlight(owner, operation);

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledOnce();
    resolveStart("ready");
    await expect(first).resolves.toBe("ready");
    expect(owner.current).toBeNull();
  });

  it("keeps the recording-start snapshot when later form values change", () => {
    const form: FixtureCaptureMetadata = {
      scriptId: "baseline-v1",
      speakerLabel: "speaker-a",
      environment: "quiet",
      speakerReadReferenceScriptVerbatim: true
    };
    const captured = snapshotFixtureMetadata(form);

    form.speakerLabel = "speaker-b";
    form.environment = "noisy";
    form.speakerReadReferenceScriptVerbatim = false;

    expect(captured).toEqual({
      scriptId: "baseline-v1",
      speakerLabel: "speaker-a",
      environment: "quiet",
      speakerReadReferenceScriptVerbatim: true
    });
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("sends the recording-start verbatim declaration with the WAV save request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      recording: {
        id: "11111111-1111-4111-8111-111111111111",
        fileName: "fixture.wav",
        relativePath: "audio/fixture.wav",
        scriptId: "baseline-v1",
        speakerLabel: "speaker-a",
        environment: "quiet",
        createdAt: "2026-08-09T01:00:00.000Z",
        durationMs: 1_000,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        dataBytes: 32_000,
        speakerReadReferenceScriptVerbatim: true
      },
      storageDirectory: "test-fixtures/stt/audio"
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await saveAudioFixture({
      wav: new Blob([new Uint8Array([1, 2])], { type: "audio/wav" }),
      scriptId: "baseline-v1",
      speakerLabel: "speaker-a",
      environment: "quiet",
      speakerReadReferenceScriptVerbatim: true
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(requestUrl.searchParams.get("speakerReadReferenceScriptVerbatim")).toBe("true");
  });
});

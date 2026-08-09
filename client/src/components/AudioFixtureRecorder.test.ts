import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAudioFixture, type AudioFixtureCatalog } from "../lib/api";
import { comparisonRecordings, snapshotFixtureMetadata, type FixtureCaptureMetadata } from "./AudioFixtureRecorder";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audio fixture metadata ownership", () => {
  it("passes the complete saved recording catalog to comparison controls", () => {
    const catalog: AudioFixtureCatalog = {
      scripts: [],
      storageDirectory: "test-fixtures/stt/audio",
      recordings: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          fileName: "first.wav",
          relativePath: "audio/first.wav",
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
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          fileName: "second.wav",
          relativePath: "audio/second.wav",
          scriptId: "baseline-v1",
          speakerLabel: "speaker-b",
          environment: "noisy",
          createdAt: "2026-08-09T01:00:00.000Z",
          durationMs: 2_000,
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
          dataBytes: 64_000,
          speakerReadReferenceScriptVerbatim: false
        }
      ]
    };

    expect(comparisonRecordings(catalog)).toBe(catalog.recordings);
    expect(comparisonRecordings(catalog)).toHaveLength(2);
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

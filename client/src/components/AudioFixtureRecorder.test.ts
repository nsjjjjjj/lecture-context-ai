import { describe, expect, it } from "vitest";
import { snapshotFixtureMetadata, type FixtureCaptureMetadata } from "./AudioFixtureRecorder";

describe("audio fixture metadata ownership", () => {
  it("keeps the recording-start snapshot when later form values change", () => {
    const form: FixtureCaptureMetadata = {
      scriptId: "baseline-v1",
      speakerLabel: "speaker-a",
      environment: "quiet"
    };
    const captured = snapshotFixtureMetadata(form);

    form.speakerLabel = "speaker-b";
    form.environment = "noisy";

    expect(captured).toEqual({
      scriptId: "baseline-v1",
      speakerLabel: "speaker-a",
      environment: "quiet"
    });
    expect(Object.isFrozen(captured)).toBe(true);
  });
});

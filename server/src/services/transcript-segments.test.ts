import { describe, expect, it } from "vitest";
import { createTranscriptSegmentSequencer } from "./transcript-segments.js";

describe("transcript segment sequencing", () => {
  it("keeps partial revisions on one segment and advances after final", () => {
    let sequence = 0;
    const sequencer = createTranscriptSegmentSequencer(() => `segment-${++sequence}`);

    expect(sequencer.next({ isFinal: false })).toEqual({ segmentId: "segment-1", revision: 1 });
    expect(sequencer.next({ isFinal: false })).toEqual({ segmentId: "segment-1", revision: 2 });
    expect(sequencer.next({ isFinal: true })).toEqual({ segmentId: "segment-1", revision: 3 });
    expect(sequencer.next({ isFinal: false })).toEqual({ segmentId: "segment-2", revision: 1 });
  });

  it("tracks interleaved provider result ids independently and deduplicates repeated finals", () => {
    let sequence = 0;
    const sequencer = createTranscriptSegmentSequencer(() => `segment-${++sequence}`);

    const a1 = sequencer.next({ isFinal: false, providerResultId: "result-a" });
    const b1 = sequencer.next({ isFinal: false, providerResultId: "result-b" });
    const a2 = sequencer.next({ isFinal: true, providerResultId: "result-a", endTimeMs: 900 });
    const duplicateA = sequencer.next({ isFinal: true, providerResultId: "result-a", endTimeMs: 900 });
    const b2 = sequencer.next({ isFinal: true, providerResultId: "result-b" });

    expect(a1).toMatchObject({ segmentId: "segment-1", providerResultId: "result-a", revision: 1 });
    expect(b1).toMatchObject({ segmentId: "segment-2", providerResultId: "result-b", revision: 1 });
    expect(a2).toMatchObject({ segmentId: "segment-1", revision: 2, endTimeMs: 900 });
    expect(duplicateA).toEqual(a2);
    expect(b2).toMatchObject({ segmentId: "segment-2", revision: 2 });
  });

  it("bounds active and finalized provider histories for long lectures", () => {
    let sequence = 0;
    const sequencer = createTranscriptSegmentSequencer(
      () => `segment-${++sequence}`,
      { maxActiveProviderSegments: 2, maxFinalizedProviderSegments: 2 }
    );

    const firstActive = sequencer.next({ isFinal: false, providerResultId: "active-a" });
    sequencer.next({ isFinal: false, providerResultId: "active-b" });
    sequencer.next({ isFinal: false, providerResultId: "active-c" });
    const evictedActive = sequencer.next({ isFinal: true, providerResultId: "active-a" });
    expect(evictedActive.segmentId).not.toBe(firstActive.segmentId);

    const firstFinal = sequencer.next({ isFinal: true, providerResultId: "final-a" });
    sequencer.next({ isFinal: true, providerResultId: "final-b" });
    sequencer.next({ isFinal: true, providerResultId: "final-c" });
    const evictedFinal = sequencer.next({ isFinal: true, providerResultId: "final-a" });
    expect(evictedFinal.segmentId).not.toBe(firstFinal.segmentId);
  });
});

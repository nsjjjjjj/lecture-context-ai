import { randomUUID } from "node:crypto";
import type { TranscriptSegmentMetadata } from "../types.js";

type SegmentCursor = {
  segmentId: string;
  revision: number;
};

export type TranscriptSegmentInput = {
  isFinal: boolean;
  providerResultId?: string;
  stablePrefixLength?: number;
  startTimeMs?: number;
  endTimeMs?: number;
};

export type TranscriptSegmentSequencer = {
  next: (input: TranscriptSegmentInput) => TranscriptSegmentMetadata;
};

export const DEFAULT_ACTIVE_PROVIDER_SEGMENT_LIMIT = 128;
export const DEFAULT_FINALIZED_PROVIDER_SEGMENT_LIMIT = 1_024;

export type TranscriptSegmentSequencerOptions = {
  maxActiveProviderSegments?: number;
  maxFinalizedProviderSegments?: number;
};

export function createTranscriptSegmentSequencer(
  createSegmentId: () => string = randomUUID,
  options: TranscriptSegmentSequencerOptions = {}
): TranscriptSegmentSequencer {
  const providerSegments = new Map<string, SegmentCursor>();
  const finalizedProviderSegments = new Map<string, SegmentCursor>();
  const maxActiveProviderSegments = Math.max(
    1,
    Math.floor(options.maxActiveProviderSegments ?? DEFAULT_ACTIVE_PROVIDER_SEGMENT_LIMIT)
  );
  const maxFinalizedProviderSegments = Math.max(
    1,
    Math.floor(options.maxFinalizedProviderSegments ?? DEFAULT_FINALIZED_PROVIDER_SEGMENT_LIMIT)
  );
  let fallbackSegment: SegmentCursor | null = null;

  const createCursor = (): SegmentCursor => ({ segmentId: createSegmentId(), revision: 0 });
  const evictOldest = (segments: Map<string, SegmentCursor>, limit: number): void => {
    while (segments.size > limit) {
      const oldest = segments.keys().next().value as string | undefined;
      if (!oldest) return;
      segments.delete(oldest);
    }
  };
  const touch = (segments: Map<string, SegmentCursor>, key: string, cursor: SegmentCursor): void => {
    segments.delete(key);
    segments.set(key, cursor);
  };

  return {
    next(input) {
      const providerResultId = input.providerResultId?.trim() || undefined;
      const finalized = providerResultId ? finalizedProviderSegments.get(providerResultId) : undefined;
      if (finalized) {
        touch(finalizedProviderSegments, providerResultId!, finalized);
        return {
          segmentId: finalized.segmentId,
          providerResultId,
          revision: finalized.revision,
          ...(input.stablePrefixLength === undefined ? {} : { stablePrefixLength: input.stablePrefixLength }),
          ...(input.startTimeMs === undefined ? {} : { startTimeMs: input.startTimeMs }),
          ...(input.endTimeMs === undefined ? {} : { endTimeMs: input.endTimeMs })
        };
      }

      const cursor = providerResultId
        ? providerSegments.get(providerResultId) ?? createCursor()
        : fallbackSegment ?? createCursor();
      cursor.revision += 1;

      if (providerResultId) {
        touch(providerSegments, providerResultId, cursor);
        evictOldest(providerSegments, maxActiveProviderSegments);
      }
      else fallbackSegment = cursor;

      if (input.isFinal) {
        if (providerResultId) {
          providerSegments.delete(providerResultId);
          touch(finalizedProviderSegments, providerResultId, { ...cursor });
          evictOldest(finalizedProviderSegments, maxFinalizedProviderSegments);
        } else {
          fallbackSegment = null;
        }
      }

      return {
        segmentId: cursor.segmentId,
        ...(providerResultId ? { providerResultId } : {}),
        revision: cursor.revision,
        ...(input.stablePrefixLength === undefined ? {} : { stablePrefixLength: input.stablePrefixLength }),
        ...(input.startTimeMs === undefined ? {} : { startTimeMs: input.startTimeMs }),
        ...(input.endTimeMs === undefined ? {} : { endTimeMs: input.endTimeMs })
      };
    }
  };
}

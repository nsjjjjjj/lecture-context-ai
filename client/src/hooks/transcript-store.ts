import type { TranscriptLine } from "../types";

export const TRANSCRIPT_CHUNK_SIZE = 128;

export type TranscriptStore = {
  completedChunks: readonly (readonly TranscriptLine[])[];
  activeChunk: readonly TranscriptLine[];
  lineCount: number;
  appendOperations: number;
  structuralReferenceCopies: number;
};

export function createTranscriptStore(): TranscriptStore {
  return {
    completedChunks: [],
    activeChunk: [],
    lineCount: 0,
    appendOperations: 0,
    structuralReferenceCopies: 0
  };
}

/**
 * Persistent chunk append. It copies at most one bounded line chunk per final;
 * the outer chunk index changes only once per full chunk.
 */
export function appendTranscriptLine(store: TranscriptStore, line: TranscriptLine): TranscriptStore {
  const activeChunk = [...store.activeChunk, line];
  const activeCopies = activeChunk.length;

  if (activeChunk.length < TRANSCRIPT_CHUNK_SIZE) {
    return {
      ...store,
      activeChunk,
      lineCount: store.lineCount + 1,
      appendOperations: store.appendOperations + 1,
      structuralReferenceCopies: store.structuralReferenceCopies + activeCopies
    };
  }

  const completedChunks = [...store.completedChunks, activeChunk];
  return {
    completedChunks,
    activeChunk: [],
    lineCount: store.lineCount + 1,
    appendOperations: store.appendOperations + 1,
    structuralReferenceCopies: store.structuralReferenceCopies + activeCopies + completedChunks.length
  };
}

export function lastTranscriptLine(store: TranscriptStore): TranscriptLine | undefined {
  return store.activeChunk.at(-1) ?? store.completedChunks.at(-1)?.at(-1);
}

export function forEachTranscriptLine(
  store: TranscriptStore,
  visit: (line: TranscriptLine, index: number) => void
): void {
  let index = 0;
  for (const chunk of store.completedChunks) {
    for (const line of chunk) visit(line, index++);
  }
  for (const line of store.activeChunk) visit(line, index++);
}

export function sliceTranscriptLines(
  store: TranscriptStore,
  startIndex: number,
  endIndex: number
): TranscriptLine[] {
  const start = Math.min(store.lineCount, Math.max(0, Math.trunc(startIndex)));
  const end = Math.min(store.lineCount, Math.max(start, Math.trunc(endIndex)));
  if (start === end) return [];

  const result: TranscriptLine[] = [];
  let chunkStart = 0;
  for (const chunk of store.completedChunks) {
    const chunkEnd = chunkStart + chunk.length;
    if (chunkEnd > start && chunkStart < end) {
      result.push(...chunk.slice(Math.max(0, start - chunkStart), Math.min(chunk.length, end - chunkStart)));
    }
    if (chunkEnd >= end) return result;
    chunkStart = chunkEnd;
  }

  const activeEnd = chunkStart + store.activeChunk.length;
  if (activeEnd > start && chunkStart < end) {
    result.push(...store.activeChunk.slice(
      Math.max(0, start - chunkStart),
      Math.min(store.activeChunk.length, end - chunkStart)
    ));
  }
  return result;
}

export function materializeTranscriptLines(store: TranscriptStore): TranscriptLine[] {
  return sliceTranscriptLines(store, 0, store.lineCount);
}

import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  comparisonReportFileSchema,
  type ComparisonReportFile
} from "./stt-comparison.js";

export const MAX_COMPARISON_REPORT_BYTES = 5 * 1024 * 1024;

const comparisonReportFileNamePattern = /^comparison-[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/;

export type SttComparisonResultsResponse = {
  latest: ComparisonReportFile | null;
  reportCount: number;
};

type ValidReport = {
  fileName: string;
  modifiedAtMs: number;
  report: ComparisonReportFile;
};

async function readBoundedFile(handle: FileHandle): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(MAX_COMPARISON_REPORT_BYTES + 1);
  let offset = 0;

  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }

  if (offset > MAX_COMPARISON_REPORT_BYTES) return null;
  return buffer.subarray(0, offset);
}

async function readValidReport(resultsRoot: string, fileName: string): Promise<ValidReport | null> {
  if (!comparisonReportFileNamePattern.test(fileName)) return null;

  const filePath = path.resolve(resultsRoot, fileName);
  if (path.dirname(filePath) !== resultsRoot) return null;

  let handle: FileHandle | undefined;
  try {
    const pathStats = await lstat(filePath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > MAX_COMPARISON_REPORT_BYTES) return null;

    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openStats = await handle.stat();
    if (!openStats.isFile() || openStats.size > MAX_COMPARISON_REPORT_BYTES) return null;

    const contents = await readBoundedFile(handle);
    if (!contents) return null;

    const parsedJson = JSON.parse(contents.toString("utf8")) as unknown;
    const parsedReport = comparisonReportFileSchema.safeParse(parsedJson);
    if (!parsedReport.success) return null;

    return {
      fileName,
      modifiedAtMs: openStats.mtimeMs,
      report: parsedReport.data
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readSttComparisonResults(fixtureRoot: string): Promise<SttComparisonResultsResponse> {
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  const resultsRoot = path.resolve(resolvedFixtureRoot, "results");
  if (path.dirname(resultsRoot) !== resolvedFixtureRoot) return { latest: null, reportCount: 0 };

  try {
    const [fixtureStats, resultsStats] = await Promise.all([lstat(resolvedFixtureRoot), lstat(resultsRoot)]);
    if (
      !fixtureStats.isDirectory() || fixtureStats.isSymbolicLink() ||
      !resultsStats.isDirectory() || resultsStats.isSymbolicLink()
    ) {
      return { latest: null, reportCount: 0 };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { latest: null, reportCount: 0 };
    throw error;
  }

  const entries = await readdir(resultsRoot, { withFileTypes: true });
  const reports: ValidReport[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const report = await readValidReport(resultsRoot, entry.name);
    if (report) reports.push(report);
  }

  // Filenames are UUID-based and legacy payload timestamps are not schema-guaranteed,
  // so filesystem modification time is the stable ordering metadata for valid files.
  reports.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || right.fileName.localeCompare(left.fileName));
  return {
    latest: reports[0]?.report ?? null,
    reportCount: reports.length
  };
}

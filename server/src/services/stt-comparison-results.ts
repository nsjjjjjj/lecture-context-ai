import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  comparisonReportFileSchema,
  type ComparisonReportFile,
  type CurrentComparisonReport
} from "./stt-comparison.js";

export const MAX_COMPARISON_REPORT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_STT_COMPARISON_RESULTS_LIMIT = 25;
export const MAX_STT_COMPARISON_RESULTS_LIMIT = 100;

const comparisonReportFileNamePattern = /^comparison-[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/;

export type SttComparisonResultsPagination = {
  offset?: number;
  limit?: number;
  studyId?: string;
  caseId?: string;
};

export type SttComparisonRunOutcome = "complete" | "has-errors" | "legacy";

export type SttComparisonResultSummary = {
  fileName: string;
  modifiedAt: string;
  version: ComparisonReportFile["version"];
  createdAt: string | null;
  recordingId: string | null;
  scriptTitle: string | null;
  evaluationMode: "accuracy" | "smoke" | null;
  runOutcome: SttComparisonRunOutcome;
  studyId?: string | null;
  caseId?: string | null;
  caseSnapshotId?: string | null;
  glossaryName?: string | null;
};

export type SttComparisonCaseAggregate = {
  studyId: string;
  caseId: string;
  caseSnapshotId: string;
  caseTitle: string;
  glossaryName: string;
  reportCount: number;
  accuracyReportCount: number;
  rates: Record<"without-phrase-set" | "canonical-phrase-set" | "spoken-alias-phrase-set", number | null>;
};

export type SttComparisonResultsPage = {
  offset: number;
  limit: number;
  hasMore: boolean;
};

export type SttComparisonResultsResponse = {
  latest: ComparisonReportFile | null;
  latestFileName: string | null;
  reportCount: number;
  history: SttComparisonResultSummary[];
  page: SttComparisonResultsPage;
};

export type SttComparisonResultDetail = {
  fileName: string;
  modifiedAt: string;
  report: ComparisonReportFile;
};

type ValidReport = {
  fileName: string;
  modifiedAtMs: number;
  report: ComparisonReportFile;
};

export function isValidSttComparisonResultFileName(fileName: string): boolean {
  return comparisonReportFileNamePattern.test(fileName);
}

function normalizePagination(pagination: SttComparisonResultsPagination): { offset: number; limit: number; studyId?: string; caseId?: string } {
  const offset = Number.isSafeInteger(pagination.offset) && pagination.offset! >= 0
    ? pagination.offset!
    : 0;
  const requestedLimit = Number.isSafeInteger(pagination.limit) && pagination.limit! > 0
    ? pagination.limit!
    : DEFAULT_STT_COMPARISON_RESULTS_LIMIT;
  return {
    offset,
    limit: Math.min(requestedLimit, MAX_STT_COMPARISON_RESULTS_LIMIT),
    ...(pagination.studyId ? { studyId: pagination.studyId } : {}),
    ...(pagination.caseId ? { caseId: pagination.caseId } : {})
  };
}

function emptyResponse(offset: number, limit: number): SttComparisonResultsResponse {
  return {
    latest: null,
    latestFileName: null,
    reportCount: 0,
    history: [],
    page: { offset, limit, hasMore: false }
  };
}

async function resolveResultsRoot(fixtureRoot: string): Promise<string | null> {
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  const resultsRoot = path.resolve(resolvedFixtureRoot, "results");
  if (path.dirname(resultsRoot) !== resolvedFixtureRoot) return null;

  try {
    const [fixtureStats, resultsStats] = await Promise.all([lstat(resolvedFixtureRoot), lstat(resultsRoot)]);
    if (
      !fixtureStats.isDirectory() || fixtureStats.isSymbolicLink() ||
      !resultsStats.isDirectory() || resultsStats.isSymbolicLink()
    ) {
      return null;
    }
    return resultsRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

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
  if (!isValidSttComparisonResultFileName(fileName)) return null;

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

function runOutcome(report: CurrentComparisonReport): SttComparisonRunOutcome {
  return report.runs.every((run) => run.status === "completed" && run.errors.length === 0)
    ? "complete"
    : "has-errors";
}

function summarizeReport(report: ValidReport): SttComparisonResultSummary {
  const base = {
    fileName: report.fileName,
    modifiedAt: new Date(report.modifiedAtMs).toISOString(),
    version: report.report.version
  };

  if (report.report.version !== 3 && report.report.version !== 4) {
    return {
      ...base,
      createdAt: null,
      recordingId: null,
      scriptTitle: null,
      evaluationMode: null,
      runOutcome: "legacy"
    };
  }

  const identity = report.report.version === 4 ? report.report.recording.experimentIdentity : null;

  return {
    ...base,
    createdAt: report.report.createdAt,
    recordingId: report.report.recording.id,
    scriptTitle: report.report.script.title,
    evaluationMode: report.report.recording.evaluationMode,
    runOutcome: runOutcome(report.report),
    ...(identity ? {
      studyId: identity.studyId,
      caseId: identity.caseId,
      caseSnapshotId: identity.caseSnapshotId,
      glossaryName: identity.glossaryName
    } : {})
  };
}

async function readAllValidReports(fixtureRoot: string): Promise<ValidReport[]> {
  const resultsRoot = await resolveResultsRoot(fixtureRoot);
  if (!resultsRoot) return [];
  let entries;
  try {
    entries = await readdir(resultsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const reports: ValidReport[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const report = await readValidReport(resultsRoot, entry.name);
    if (report) reports.push(report);
  }
  reports.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || right.fileName.localeCompare(left.fileName));
  return reports;
}

export async function readSttComparisonResult(
  fixtureRoot: string,
  fileName: string
): Promise<SttComparisonResultDetail | null> {
  if (!isValidSttComparisonResultFileName(fileName)) return null;

  const resultsRoot = await resolveResultsRoot(fixtureRoot);
  if (!resultsRoot) return null;

  const result = await readValidReport(resultsRoot, fileName);
  if (!result) return null;
  return {
    fileName: result.fileName,
    modifiedAt: new Date(result.modifiedAtMs).toISOString(),
    report: result.report
  };
}

export async function readSttComparisonResults(
  fixtureRoot: string,
  pagination: SttComparisonResultsPagination = {}
): Promise<SttComparisonResultsResponse> {
  const { offset, limit, studyId, caseId } = normalizePagination(pagination);
  const allReports = await readAllValidReports(fixtureRoot);
  const reports = allReports.filter(({ report }) => {
    if (!studyId && !caseId) return true;
    if (report.version !== 4 || !report.recording.experimentIdentity) return false;
    if (studyId && report.recording.experimentIdentity.studyId !== studyId) return false;
    return !caseId || report.recording.experimentIdentity.caseId === caseId;
  });
  if (reports.length === 0) return emptyResponse(offset, limit);
  const history = reports.slice(offset, offset + limit).map(summarizeReport);
  return {
    latest: reports[0]?.report ?? null,
    latestFileName: reports[0]?.fileName ?? null,
    reportCount: reports.length,
    history,
    page: {
      offset,
      limit,
      hasMore: offset + history.length < reports.length
    }
  };
}

export async function readSttComparisonCaseAggregates(
  fixtureRoot: string,
  filters: { studyId?: string; caseId?: string } = {}
): Promise<{ cases: SttComparisonCaseAggregate[] }> {
  const reports = await readAllValidReports(fixtureRoot);
  const groups = new Map<string, {
    identity: NonNullable<Extract<ComparisonReportFile, { version: 4 }>["recording"]["experimentIdentity"]>;
    title: string;
    reportCount: number;
    accuracyReportCount: number;
    rates: Record<string, number[]>;
  }>();

  for (const { report } of reports) {
    if (report.version !== 4 || !report.recording.experimentIdentity) continue;
    const identity = report.recording.experimentIdentity;
    if (filters.studyId && identity.studyId !== filters.studyId) continue;
    if (filters.caseId && identity.caseId !== filters.caseId) continue;
    const group = groups.get(identity.caseSnapshotId) ?? {
      identity,
      title: report.script.title,
      reportCount: 0,
      accuracyReportCount: 0,
      rates: {
        "without-phrase-set": [],
        "canonical-phrase-set": [],
        "spoken-alias-phrase-set": []
      }
    };
    group.reportCount += 1;
    if (report.recording.evaluationMode === "accuracy" && report.runs.every((run) => run.status === "completed" && run.errors.length === 0)) {
      group.accuracyReportCount += 1;
      for (const run of report.runs) group.rates[run.label]!.push(run.metrics.productLinkRate);
    }
    groups.set(identity.caseSnapshotId, group);
  }

  const mean = (values: number[]): number | null => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
  return {
    cases: [...groups.values()].map((group) => ({
      studyId: group.identity.studyId,
      caseId: group.identity.caseId,
      caseSnapshotId: group.identity.caseSnapshotId,
      caseTitle: group.title,
      glossaryName: group.identity.glossaryName,
      reportCount: group.reportCount,
      accuracyReportCount: group.accuracyReportCount,
      rates: {
        "without-phrase-set": mean(group.rates["without-phrase-set"]!),
        "canonical-phrase-set": mean(group.rates["canonical-phrase-set"]!),
        "spoken-alias-phrase-set": mean(group.rates["spoken-alias-phrase-set"]!)
      }
    }))
  };
}

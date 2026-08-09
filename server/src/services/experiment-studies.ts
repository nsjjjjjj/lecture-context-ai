import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { glossaryTermSchema, type GlossaryTerm } from "../types.js";
import { findTranscriptTermMatches } from "./caption.js";
import {
  experimentIdentitySchema,
  fixtureAdaptationTermSchema,
  fixtureIdSchema,
  fixtureScriptSchema,
  fixtureTargetTermSchema,
  type FixtureAdaptationTerm,
  type FixtureScript
} from "./stt-comparison.js";

const STUDIES_FILE = "studies.local.json";
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const experimentStudyCreateSchema = z.object({
  title: z.string().trim().min(1).max(120)
}).strict();

export const experimentTargetInputSchema = z.object({
  canonicalTerm: z.string().trim().min(1).max(120),
  english: z.string().trim().max(120).optional().default(""),
  spokenAliases: z.array(z.string().trim().min(1).max(40)).max(6).optional().default([])
}).strict();

export const experimentCaseCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  scriptText: z.string().trim().min(1).max(5_000),
  glossary: z.object({
    id: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(160),
    updatedAt: z.string().datetime({ offset: true }),
    terms: z.array(glossaryTermSchema).min(1).max(50)
  }).strict(),
  targetTerms: z.array(experimentTargetInputSchema).min(1).max(50)
}).strict();

const experimentGlossarySnapshotSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  updatedAt: z.string().datetime({ offset: true }),
  hash: hashSchema,
  terms: z.array(glossaryTermSchema).min(1).max(50)
}).strict();

export const experimentCaseSchema = z.object({
  id: fixtureIdSchema,
  studyId: fixtureIdSchema,
  snapshotId: fixtureIdSchema,
  title: z.string().min(1).max(120),
  createdAt: z.string().datetime({ offset: true }),
  glossary: experimentGlossarySnapshotSchema,
  scriptHash: hashSchema,
  snapshotHash: hashSchema,
  script: fixtureScriptSchema
}).strict();

export const experimentStudySchema = z.object({
  id: fixtureIdSchema,
  title: z.string().min(1).max(120),
  createdAt: z.string().datetime({ offset: true }),
  cases: z.array(experimentCaseSchema).max(50)
}).strict();

export const experimentStudyStoreSchema = z.object({
  version: z.literal(1),
  studies: z.array(experimentStudySchema).max(20)
}).strict();

export type ExperimentStudy = z.infer<typeof experimentStudySchema>;
export type ExperimentCase = z.infer<typeof experimentCaseSchema>;
export type ExperimentStudyStore = z.infer<typeof experimentStudyStoreSchema>;
export type ExperimentCaseCreateInput = z.infer<typeof experimentCaseCreateSchema>;

export class ExperimentStudyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ExperimentStudyError";
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeGeneratedId(prefix: "study" | "case", uuid: string): string {
  return fixtureIdSchema.parse(`${prefix}-${uuid.toLowerCase()}`);
}

function adaptationTermsFromGlossary(terms: GlossaryTerm[]): FixtureAdaptationTerm[] {
  return terms.map((term, index) => fixtureAdaptationTermSchema.parse({
    id: `pdf-${String(index + 1).padStart(2, "0")}`,
    canonicalTerm: term.term,
    english: term.english,
    spokenAliases: term.spokenAliases
  }));
}

function targetGlossaryTerms(targets: FixtureAdaptationTerm[]): GlossaryTerm[] {
  return targets.map((term) => ({
    id: term.id,
    term: term.canonicalTerm,
    english: term.english,
    spokenAliases: term.spokenAliases,
    easyExplanation: "실험 채점용 정답 전문용어",
    pageNumber: 1,
    occurrences: 0,
    source: "demo"
  }));
}

function missingTargetMessage(term: FixtureAdaptationTerm, index: number): string {
  const labels = [
    `정식 표기: ${term.canonicalTerm}`,
    ...(term.english ? [`영문 표기: ${term.english}`] : []),
    ...(term.spokenAliases.length ? [`발음 별칭: ${term.spokenAliases.join(", ")}`] : [])
  ];
  return `${index + 1}. ${labels.join(" · ")}`;
}

function missingTargetsError(terms: FixtureAdaptationTerm[]): ExperimentStudyError {
  return new ExperimentStudyError([
    "대본에서 찾지 못한 채점 용어가 있습니다.",
    ...terms.map(missingTargetMessage),
    "대본에 위 표기·영문 표기·발음 별칭 중 하나를 넣거나, 해당 채점 용어 선택을 해제해 주세요."
  ].join("\n"));
}

export function buildExperimentTargetTerms(
  scriptText: string,
  requestedTargets: z.infer<typeof experimentTargetInputSchema>[]
): z.infer<typeof fixtureTargetTermSchema>[] {
  const candidates = requestedTargets.map((target, index) => fixtureAdaptationTermSchema.parse({
    id: `gold-${String(index + 1).padStart(2, "0")}`,
    canonicalTerm: target.canonicalTerm,
    english: target.english,
    spokenAliases: target.spokenAliases
  }));
  const matches = candidates.flatMap((candidate, candidateIndex) =>
    findTranscriptTermMatches(scriptText, targetGlossaryTerms([candidate]))
      .map((match) => ({ ...match, candidateIndex }))
  ).sort((left, right) =>
    left.sourceStart - right.sourceStart ||
    left.sourceEnd - right.sourceEnd ||
    left.candidateIndex - right.candidateIndex
  );
  if (matches.length === 0) {
    throw missingTargetsError(candidates);
  }

  const sequences = new Map(candidates.map((term) => [term.id, [] as number[]]));
  const sequenceBySpan = new Map<string, number>();
  matches.forEach((match) => {
    const spanKey = `${match.sourceStart}:${match.sourceEnd}`;
    let sequence = sequenceBySpan.get(spanKey);
    if (sequence === undefined) {
      sequence = sequenceBySpan.size + 1;
      sequenceBySpan.set(spanKey, sequence);
    }
    sequences.get(match.term.id)?.push(sequence);
  });
  const missing = candidates.filter((term) => sequences.get(term.id)?.length === 0);
  if (missing.length > 0) {
    throw missingTargetsError(missing);
  }

  return candidates.map((term) => fixtureTargetTermSchema.parse({
    ...term,
    expectedOccurrences: sequences.get(term.id)
  }));
}

async function assertSafeRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ExperimentStudyError("실험 세트 저장 경로가 안전한 디렉터리가 아닙니다.", 500);
  }
}

async function writeAtomically(filePath: string, store: ExperimentStudyStore): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(experimentStudyStoreSchema.parse(store), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class ExperimentStudyStoreService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
    private readonly randomId: () => string = randomUUID
  ) {}

  private get filePath(): string {
    return path.join(this.root, STUDIES_FILE);
  }

  private async readNow(): Promise<ExperimentStudyStore> {
    await assertSafeRoot(this.root);
    try {
      const stats = await lstat(this.filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new ExperimentStudyError("실험 세트 파일이 안전한 일반 파일이 아닙니다.", 500);
      }
      return experimentStudyStoreSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, studies: [] };
      if (error instanceof ExperimentStudyError) throw error;
      throw new ExperimentStudyError("로컬 실험 세트 파일이 손상되었습니다.", 500);
    }
  }

  async getCatalog(): Promise<ExperimentStudyStore> {
    await this.queue;
    return this.readNow();
  }

  getScripts = async (): Promise<FixtureScript[]> => {
    const catalog = await this.getCatalog();
    return catalog.studies.flatMap((study) => study.cases.map((experimentCase) => experimentCase.script));
  };

  createStudy(input: unknown): Promise<ExperimentStudy> {
    return this.enqueue(async () => {
      const parsed = experimentStudyCreateSchema.parse(input);
      const store = await this.readNow();
      if (store.studies.length >= 20) throw new ExperimentStudyError("실험 세트는 최대 20개까지 만들 수 있습니다.", 409);
      const study = experimentStudySchema.parse({
        id: safeGeneratedId("study", this.randomId()),
        title: parsed.title,
        createdAt: this.now().toISOString(),
        cases: []
      });
      await writeAtomically(this.filePath, { ...store, studies: [...store.studies, study] });
      return study;
    });
  }

  createCase(studyId: string, input: unknown): Promise<ExperimentCase> {
    return this.enqueue(async () => {
      const id = fixtureIdSchema.parse(studyId);
      const parsed = experimentCaseCreateSchema.parse(input);
      const store = await this.readNow();
      const studyIndex = store.studies.findIndex((study) => study.id === id);
      if (studyIndex < 0) throw new ExperimentStudyError("실험 세트를 찾을 수 없습니다.", 404);
      const study = store.studies[studyIndex]!;
      if (study.cases.length >= 50) throw new ExperimentStudyError("한 실험 세트에는 케이스를 최대 50개까지 만들 수 있습니다.", 409);

      const glossaryTerms = parsed.glossary.terms.map((term) => glossaryTermSchema.parse(term));
      const adaptationTerms = adaptationTermsFromGlossary(glossaryTerms);
      const targetTerms = buildExperimentTargetTerms(parsed.scriptText, parsed.targetTerms);
      const glossaryHash = stableHash({ id: parsed.glossary.id, updatedAt: parsed.glossary.updatedAt, terms: glossaryTerms });
      const scriptHash = stableHash(parsed.scriptText);
      const snapshotHash = stableHash({
        title: parsed.title,
        glossaryHash,
        scriptHash,
        targetTerms,
        adaptationTerms
      });
      if (study.cases.some((candidate) => candidate.snapshotHash === snapshotHash)) {
        throw new ExperimentStudyError("같은 PDF 용어집·대본·채점 용어의 케이스가 이미 이 실험 세트에 있습니다.", 409);
      }

      const caseId = safeGeneratedId("case", this.randomId());
      const snapshotId = fixtureIdSchema.parse(`snapshot-${snapshotHash.slice(0, 24)}`);
      const identity = experimentIdentitySchema.parse({
        studyId: study.id,
        caseId,
        caseSnapshotId: snapshotId,
        glossaryId: parsed.glossary.id,
        glossaryName: parsed.glossary.name,
        glossaryHash,
        scriptHash
      });
      const script = fixtureScriptSchema.parse({
        id: caseId,
        title: parsed.title,
        languageCode: "ko-KR",
        text: parsed.scriptText,
        targetTerms,
        adaptationTerms,
        experimentIdentity: identity
      });
      const experimentCase = experimentCaseSchema.parse({
        id: caseId,
        studyId: study.id,
        snapshotId,
        title: parsed.title,
        createdAt: this.now().toISOString(),
        glossary: {
          id: parsed.glossary.id,
          name: parsed.glossary.name,
          updatedAt: parsed.glossary.updatedAt,
          hash: glossaryHash,
          terms: glossaryTerms
        },
        scriptHash,
        snapshotHash,
        script
      });
      const nextStudy = { ...study, cases: [...study.cases, experimentCase] };
      const studies = [...store.studies];
      studies[studyIndex] = nextStudy;
      await writeAtomically(this.filePath, { ...store, studies });
      return experimentCase;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

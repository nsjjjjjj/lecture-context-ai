import { z } from "zod";
import { glossaryTermSchema, type GlossaryTerm } from "../types.js";
import { findTranscriptTermMatches } from "./caption.js";
import {
  canonicalizeSpokenForm,
  sanitizeSpokenAliases,
  spokenFormKey
} from "./spoken-aliases.js";

export const fixtureIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const fixtureFormSchema = z.string().min(1).max(120);

export const fixtureAdaptationTermSchema = z.object({
  id: fixtureIdSchema,
  canonicalTerm: fixtureFormSchema,
  english: z.string().max(120).optional().default(""),
  spokenAliases: z.array(z.string().min(1).max(40)).max(6).optional().default([])
}).strict().superRefine((term, context) => {
  const normalizedAliases = term.spokenAliases.map(canonicalizeSpokenForm);
  const reviewedAliases = sanitizeSpokenAliases(term.canonicalTerm, term.english, normalizedAliases);
  if (
    reviewedAliases.length !== normalizedAliases.length ||
    reviewedAliases.some((alias, index) => alias !== normalizedAliases[index])
  ) {
    context.addIssue({
      code: "custom",
      path: ["spokenAliases"],
      message: "spokenAliases에는 정규화된 검토 완료 별칭만 사용할 수 있습니다."
    });
  }
});

export const experimentIdentitySchema = z.object({
  studyId: fixtureIdSchema,
  caseId: fixtureIdSchema,
  caseSnapshotId: fixtureIdSchema,
  glossaryId: z.string().min(1).max(120),
  glossaryName: z.string().min(1).max(160),
  glossaryHash: z.string().regex(/^[0-9a-f]{64}$/),
  scriptHash: z.string().regex(/^[0-9a-f]{64}$/)
}).strict();

export const fixtureTargetTermSchema = z.object({
  id: fixtureIdSchema,
  canonicalTerm: fixtureFormSchema,
  english: z.string().max(120).optional().default(""),
  spokenAliases: z.array(z.string().min(1).max(40)).max(6).optional().default([]),
  expectedOccurrences: z.array(z.number().int().positive()).min(1).max(50)
}).strict().superRefine((term, context) => {
  const normalizedAliases = term.spokenAliases.map(canonicalizeSpokenForm);
  const reviewedAliases = sanitizeSpokenAliases(term.canonicalTerm, term.english, normalizedAliases);
  if (
    reviewedAliases.length !== normalizedAliases.length ||
    reviewedAliases.some((alias, index) => alias !== normalizedAliases[index])
  ) {
    context.addIssue({
      code: "custom",
      path: ["spokenAliases"],
      message: "spokenAliases에는 정규화된 검토 완료 별칭만 사용할 수 있습니다."
    });
  }
  if (new Set(term.expectedOccurrences).size !== term.expectedOccurrences.length) {
    context.addIssue({
      code: "custom",
      path: ["expectedOccurrences"],
      message: "expectedOccurrences의 순서 번호는 중복될 수 없습니다."
    });
  }
});

export const fixtureScriptSchema = z.object({
  id: fixtureIdSchema,
  title: z.string().min(1).max(120),
  languageCode: z.literal("ko-KR"),
  text: z.string().min(1).max(5_000),
  targetTerms: z.array(fixtureTargetTermSchema).min(1).max(50),
  adaptationTerms: z.array(fixtureAdaptationTermSchema).min(1).max(50).optional(),
  experimentIdentity: experimentIdentitySchema.optional()
}).strict().superRefine((script, context) => {
  const ids = new Set<string>();
  const expectedSequences = new Set<number>();
  const formOwners = new Map<string, Set<string>>();
  const aliasOwners = new Map<string, Set<string>>();
  let expectedCount = 0;

  const addOwner = (owners: Map<string, Set<string>>, key: string, ownerId: string): void => {
    const current = owners.get(key) ?? new Set<string>();
    current.add(ownerId);
    owners.set(key, current);
  };

  // Collect all ownership first so collision checks do not depend on targetTerms order.
  script.targetTerms.forEach((term, termIndex) => {
    if (ids.has(term.id)) {
      context.addIssue({ code: "custom", path: ["targetTerms", termIndex, "id"], message: "target term id가 중복되었습니다." });
    }
    ids.add(term.id);

    for (const form of [term.canonicalTerm, term.english]) {
      const key = spokenFormKey(form);
      if (!key) continue;
      addOwner(formOwners, key, term.id);
    }

    term.spokenAliases.forEach((alias) => addOwner(aliasOwners, spokenFormKey(alias), term.id));

    for (const sequence of term.expectedOccurrences) {
      expectedCount += 1;
      if (expectedSequences.has(sequence)) {
        context.addIssue({
          code: "custom",
          path: ["targetTerms", termIndex, "expectedOccurrences"],
          message: "expected occurrence 순서 번호가 다른 target term과 중복되었습니다."
        });
      }
      expectedSequences.add(sequence);
    }
  });

  script.targetTerms.forEach((term, termIndex) => {
    for (const form of [term.canonicalTerm, term.english]) {
      const key = spokenFormKey(form);
      if (!key) continue;
      if ((formOwners.get(key)?.size ?? 0) > 1 || [...(aliasOwners.get(key) ?? [])].some((owner) => owner !== term.id)) {
        context.addIssue({
          code: "custom",
          path: ["targetTerms", termIndex],
          message: "canonical/English 표기가 다른 target term과 충돌합니다."
        });
      }
    }

    term.spokenAliases.forEach((alias, aliasIndex) => {
      const key = spokenFormKey(alias);
      if ((aliasOwners.get(key)?.size ?? 0) > 1 || [...(formOwners.get(key) ?? [])].some((owner) => owner !== term.id)) {
        context.addIssue({
          code: "custom",
          path: ["targetTerms", termIndex, "spokenAliases", aliasIndex],
          message: "spoken alias가 다른 target term의 표기와 충돌합니다."
        });
      }
    });
  });

  for (let sequence = 1; sequence <= expectedCount; sequence += 1) {
    if (!expectedSequences.has(sequence)) {
      context.addIssue({
        code: "custom",
        path: ["targetTerms"],
        message: "expected occurrence 순서는 1부터 빠짐없이 이어져야 합니다."
      });
      break;
    }
  }

  const adaptationTerms = script.adaptationTerms ?? script.targetTerms;
  const canonicalCount = phraseSetFor(adaptationTerms, false).length;
  const aliasCount = phraseSetFor(adaptationTerms, true).length;
  if (canonicalCount > 50 || aliasCount > 50) {
    context.addIssue({
      code: "custom",
      path: ["targetTerms"],
      message: "비교용 PhraseSet은 각 조건에서 50개를 넘을 수 없습니다."
    });
  }
});

export const fixtureScriptsSchema = z.object({
  version: z.literal(2),
  scripts: z.array(fixtureScriptSchema).min(1).max(20)
}).strict();

const legacyFixtureScriptsSchema = z.object({
  version: z.literal(1),
  scripts: z.array(z.object({
    id: fixtureIdSchema,
    title: z.string().min(1).max(120),
    languageCode: z.literal("ko-KR"),
    text: z.string().min(1).max(5_000),
    targetTerms: z.array(fixtureFormSchema).min(1).max(50)
  }).passthrough()).min(1).max(20)
}).strict();

export type FixtureTargetTerm = z.infer<typeof fixtureTargetTermSchema>;
export type FixtureAdaptationTerm = z.infer<typeof fixtureAdaptationTermSchema>;
export type ExperimentIdentity = z.infer<typeof experimentIdentitySchema>;
export type FixtureScript = z.infer<typeof fixtureScriptSchema>;
export type FixtureScripts = z.infer<typeof fixtureScriptsSchema>;

export function parseFixtureScripts(value: unknown): FixtureScripts {
  const current = fixtureScriptsSchema.safeParse(value);
  if (current.success) return current.data;

  const legacy = legacyFixtureScriptsSchema.parse(value);
  return fixtureScriptsSchema.parse({
    version: 2,
    scripts: legacy.scripts.map((script) => ({
      id: script.id,
      title: script.title,
      languageCode: script.languageCode,
      text: script.text,
      targetTerms: script.targetTerms.map((canonicalTerm, index) => ({
        id: `legacy-term-${String(index + 1).padStart(2, "0")}`,
        canonicalTerm,
        english: "",
        spokenAliases: [],
        expectedOccurrences: [index + 1]
      }))
    }))
  });
}

function uniqueForms(forms: string[]): string[] {
  const seen = new Set<string>();
  return forms.filter((form) => {
    const key = spokenFormKey(form);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function phraseSetFor(targetTerms: FixtureAdaptationTerm[], includeAliases: boolean): string[] {
  return uniqueForms(targetTerms.flatMap((term) => [
    term.canonicalTerm,
    term.english,
    ...(includeAliases ? term.spokenAliases : [])
  ]));
}

export function buildExpectedOccurrences(script: FixtureScript): ExpectedTermOccurrence[] {
  return script.targetTerms
    .flatMap((term) => term.expectedOccurrences.map((sequence) => ({
      sequence,
      targetTermId: term.id,
      canonicalTerm: term.canonicalTerm
    })))
    .sort((left, right) => left.sequence - right.sequence);
}

export function buildFixtureTerms(targetTerms: FixtureAdaptationTerm[], includeAliases: boolean): GlossaryTerm[] {
  return targetTerms.map((term) => ({
    id: term.id,
    term: term.canonicalTerm,
    english: term.english,
    spokenAliases: includeAliases ? [...term.spokenAliases] : [],
    easyExplanation: "고정음원 STT 비교용 전문용어",
    pageNumber: 1,
    occurrences: "expectedOccurrences" in term && Array.isArray(term.expectedOccurrences) ? term.expectedOccurrences.length : 0,
    source: "demo"
  }));
}

export const comparisonRunLabels = [
  "without-phrase-set",
  "canonical-phrase-set",
  "spoken-alias-phrase-set"
] as const;

export const comparisonRunLabelSchema = z.enum(comparisonRunLabels);
export type ComparisonRunLabel = z.infer<typeof comparisonRunLabelSchema>;

export const comparisonRunDefinitionSchema = z.object({
  label: comparisonRunLabelSchema,
  phraseSet: z.array(z.string().min(1).max(120)).max(50),
  terms: z.array(glossaryTermSchema).min(1).max(50)
}).strict();

export type ComparisonRunDefinition = z.infer<typeof comparisonRunDefinitionSchema>;

export function buildComparisonRunDefinitions(script: FixtureScript): ComparisonRunDefinition[] {
  const adaptationTerms = script.adaptationTerms ?? script.targetTerms;
  const canonicalPhraseSet = phraseSetFor(adaptationTerms, false);
  const aliasPhraseSet = phraseSetFor(adaptationTerms, true);
  const withoutAliases = buildFixtureTerms(adaptationTerms, false);
  const withAliases = buildFixtureTerms(adaptationTerms, true);
  return [
    comparisonRunDefinitionSchema.parse({
      label: "without-phrase-set",
      phraseSet: [],
      terms: withoutAliases
    }),
    comparisonRunDefinitionSchema.parse({
      label: "canonical-phrase-set",
      phraseSet: canonicalPhraseSet,
      terms: withoutAliases
    }),
    comparisonRunDefinitionSchema.parse({
      label: "spoken-alias-phrase-set",
      phraseSet: aliasPhraseSet,
      terms: withAliases
    })
  ];
}

export const transcriptCorrectionSchema = z.object({
  originalText: z.string().min(1),
  correctedText: z.string().min(1),
  termId: z.string().min(1),
  displayStart: z.number().int().nonnegative(),
  displayEnd: z.number().int().positive(),
  reason: z.literal("spokenAlias")
}).strict().superRefine((correction, context) => {
  if (correction.displayEnd <= correction.displayStart) {
    context.addIssue({ code: "custom", path: ["displayEnd"], message: "displayEnd는 displayStart보다 커야 합니다." });
  }
});

export const comparisonFinalTranscriptSchema = z.object({
  text: z.string(),
  rawText: z.string(),
  detectedTermIds: z.array(z.string()).default([]),
  corrections: z.array(transcriptCorrectionSchema).default([])
}).strict();

export type ComparisonFinalTranscript = z.infer<typeof comparisonFinalTranscriptSchema>;

export const comparisonRunMetricsSchema = z.object({
  evaluationMode: z.enum(["accuracy", "smoke"]),
  accuracyValid: z.boolean(),
  directRecognitions: z.number().int().nonnegative(),
  aliasCorrectionSuccesses: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  falseCorrections: z.number().int().nonnegative(),
  falseInsertions: z.number().int().nonnegative(),
  expectedOccurrenceCount: z.number().int().nonnegative(),
  productLinkRate: z.number().min(0).max(1)
}).strict().superRefine((metrics, context) => {
  if (metrics.accuracyValid !== (metrics.evaluationMode === "accuracy")) {
    context.addIssue({ code: "custom", path: ["accuracyValid"], message: "accuracyValid와 evaluationMode가 일치하지 않습니다." });
  }
  if (metrics.directRecognitions + metrics.aliasCorrectionSuccesses + metrics.misses !== metrics.expectedOccurrenceCount) {
    context.addIssue({
      code: "custom",
      path: ["expectedOccurrenceCount"],
      message: "성공과 miss 합계가 expected occurrence count와 일치해야 합니다."
    });
  }
});

export type ComparisonRunMetrics = z.infer<typeof comparisonRunMetricsSchema>;

export const expectedTermOccurrenceSchema = z.object({
  sequence: z.number().int().positive(),
  targetTermId: fixtureIdSchema,
  canonicalTerm: fixtureFormSchema
}).strict();

export type ExpectedTermOccurrence = z.infer<typeof expectedTermOccurrenceSchema>;

export const comparisonOccurrenceResultSchema = expectedTermOccurrenceSchema.extend({
  outcome: z.enum(["direct-recognition", "alias-correction", "miss"]),
  finalTranscriptIndex: z.number().int().nonnegative().nullable(),
  rawText: z.string().nullable()
}).strict();

export const unexpectedObservationSchema = z.object({
  kind: z.enum(["false-correction", "false-insertion"]),
  reason: z.enum(["invalid-correction", "unexpected-alias-correction", "unexpected-direct-match"]),
  targetTermId: z.string().nullable(),
  finalTranscriptIndex: z.number().int().nonnegative(),
  rawText: z.string()
}).strict();

export type ComparisonOccurrenceResult = z.infer<typeof comparisonOccurrenceResultSchema>;
export type UnexpectedObservation = z.infer<typeof unexpectedObservationSchema>;

type ObservedOccurrence = {
  kind: "direct" | "aliasCorrection";
  targetTermId: string;
  finalTranscriptIndex: number;
  sourceStart: number;
  rawText: string;
};

function alignOccurrenceIds(expected: ExpectedTermOccurrence[], observed: ObservedOccurrence[]): Array<[number, number]> {
  const table = Array.from({ length: expected.length + 1 }, () => Array<number>(observed.length + 1).fill(0));
  for (let expectedIndex = expected.length - 1; expectedIndex >= 0; expectedIndex -= 1) {
    for (let observedIndex = observed.length - 1; observedIndex >= 0; observedIndex -= 1) {
      table[expectedIndex]![observedIndex] = expected[expectedIndex]!.targetTermId === observed[observedIndex]!.targetTermId
        ? 1 + table[expectedIndex + 1]![observedIndex + 1]!
        : Math.max(table[expectedIndex + 1]![observedIndex]!, table[expectedIndex]![observedIndex + 1]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let expectedIndex = 0;
  let observedIndex = 0;
  while (expectedIndex < expected.length && observedIndex < observed.length) {
    if (
      expected[expectedIndex]!.targetTermId === observed[observedIndex]!.targetTermId &&
      table[expectedIndex]![observedIndex] === 1 + table[expectedIndex + 1]![observedIndex + 1]!
    ) {
      pairs.push([expectedIndex, observedIndex]);
      expectedIndex += 1;
      observedIndex += 1;
    } else if (table[expectedIndex + 1]![observedIndex]! >= table[expectedIndex]![observedIndex + 1]!) {
      expectedIndex += 1;
    } else {
      observedIndex += 1;
    }
  }
  return pairs;
}

export type ComparisonScore = {
  metrics: ComparisonRunMetrics;
  occurrenceResults: ComparisonOccurrenceResult[];
  unexpectedObservations: UnexpectedObservation[];
};

export function scoreComparisonRun(options: {
  runLabel: ComparisonRunLabel;
  script: FixtureScript;
  finalTranscripts: ComparisonFinalTranscript[];
  speakerReadReferenceScriptVerbatim: boolean;
}): ComparisonScore {
  const finalTranscripts = options.finalTranscripts.map((transcript) => comparisonFinalTranscriptSchema.parse(transcript));
  const terms = buildFixtureTerms(options.script.targetTerms, true);
  const targetById = new Map(options.script.targetTerms.map((term) => [term.id, term]));
  const adaptationTargetById = new Map<string, FixtureTargetTerm>();
  for (const adaptationTerm of options.script.adaptationTerms ?? []) {
    const adaptationLabels = new Set([adaptationTerm.canonicalTerm, adaptationTerm.english].map(spokenFormKey).filter(Boolean));
    const candidates = options.script.targetTerms.filter((target) =>
      [target.canonicalTerm, target.english].map(spokenFormKey).filter(Boolean).some((label) => adaptationLabels.has(label))
    );
    if (candidates.length === 1) adaptationTargetById.set(adaptationTerm.id, candidates[0]!);
  }
  const observed: ObservedOccurrence[] = [];
  const unexpectedObservations: UnexpectedObservation[] = [];

  finalTranscripts.forEach((transcript, finalTranscriptIndex) => {
    const matches = findTranscriptTermMatches(transcript.rawText, terms);
    const aliasMatches = matches.filter((match) => match.kind === "spokenAlias");
    const usedAliasMatches = new Set<number>();

    matches.filter((match) => match.kind !== "spokenAlias").forEach((match) => {
      observed.push({
        kind: "direct",
        targetTermId: match.term.id,
        finalTranscriptIndex,
        sourceStart: match.sourceStart,
        rawText: match.matchedText
      });
    });

    transcript.corrections
      .map((correction, correctionIndex) => ({ correction, correctionIndex }))
      .sort((left, right) => left.correction.displayStart - right.correction.displayStart || left.correctionIndex - right.correctionIndex)
      .forEach(({ correction }) => {
        const target = targetById.get(correction.termId) ?? adaptationTargetById.get(correction.termId);
        const correctedCanonical = target && spokenFormKey(correction.correctedText) === spokenFormKey(target.canonicalTerm);
        const reviewedOriginal = target?.spokenAliases.some((alias) => spokenFormKey(alias) === spokenFormKey(correction.originalText)) ?? false;
        const aliasMatchIndex = target && correctedCanonical && reviewedOriginal
          ? aliasMatches.findIndex((match, index) =>
              !usedAliasMatches.has(index) &&
              match.term.id === target.id &&
              spokenFormKey(match.matchedText) === spokenFormKey(correction.originalText)
            )
          : -1;

        if (aliasMatchIndex < 0) {
          unexpectedObservations.push({
            kind: "false-correction",
            reason: "invalid-correction",
            targetTermId: target?.id ?? null,
            finalTranscriptIndex,
            rawText: correction.originalText
          });
          return;
        }

        usedAliasMatches.add(aliasMatchIndex);
        const match = aliasMatches[aliasMatchIndex]!;
        if (options.runLabel !== "spoken-alias-phrase-set") {
          unexpectedObservations.push({
            kind: "false-correction",
            reason: "unexpected-alias-correction",
            targetTermId: match.term.id,
            finalTranscriptIndex,
            rawText: match.matchedText
          });
          return;
        }
        observed.push({
          kind: "aliasCorrection",
          targetTermId: match.term.id,
          finalTranscriptIndex,
          sourceStart: match.sourceStart,
          rawText: match.matchedText
        });
      });
  });

  observed.sort((left, right) =>
    left.finalTranscriptIndex - right.finalTranscriptIndex ||
    left.sourceStart - right.sourceStart ||
    (left.kind === "direct" ? -1 : 1)
  );

  const expected = buildExpectedOccurrences(options.script);
  const alignedPairs = alignOccurrenceIds(expected, observed);
  const observedByExpected = new Map(alignedPairs);
  const matchedObserved = new Set(alignedPairs.map(([, observedIndex]) => observedIndex));
  const occurrenceResults = expected.map((occurrence, expectedIndex): ComparisonOccurrenceResult => {
    const observedIndex = observedByExpected.get(expectedIndex);
    const match = observedIndex === undefined ? undefined : observed[observedIndex];
    return comparisonOccurrenceResultSchema.parse({
      ...occurrence,
      outcome: !match ? "miss" : match.kind === "direct" ? "direct-recognition" : "alias-correction",
      finalTranscriptIndex: match?.finalTranscriptIndex ?? null,
      rawText: match?.rawText ?? null
    });
  });

  observed.forEach((observation, observedIndex) => {
    if (matchedObserved.has(observedIndex)) return;
    unexpectedObservations.push({
      kind: observation.kind === "direct" ? "false-insertion" : "false-correction",
      reason: observation.kind === "direct" ? "unexpected-direct-match" : "unexpected-alias-correction",
      targetTermId: observation.targetTermId,
      finalTranscriptIndex: observation.finalTranscriptIndex,
      rawText: observation.rawText
    });
  });

  const directRecognitions = occurrenceResults.filter((result) => result.outcome === "direct-recognition").length;
  const aliasCorrectionSuccesses = occurrenceResults.filter((result) => result.outcome === "alias-correction").length;
  const expectedOccurrenceCount = expected.length;
  const linkedOccurrences = directRecognitions + aliasCorrectionSuccesses;
  const metrics = comparisonRunMetricsSchema.parse({
    evaluationMode: options.speakerReadReferenceScriptVerbatim ? "accuracy" : "smoke",
    accuracyValid: options.speakerReadReferenceScriptVerbatim,
    directRecognitions,
    aliasCorrectionSuccesses,
    misses: expectedOccurrenceCount - linkedOccurrences,
    falseCorrections: unexpectedObservations.filter((observation) => observation.kind === "false-correction").length,
    falseInsertions: unexpectedObservations.filter((observation) => observation.kind === "false-insertion").length,
    expectedOccurrenceCount,
    productLinkRate: expectedOccurrenceCount === 0 ? 0 : linkedOccurrences / expectedOccurrenceCount
  });

  return {
    metrics,
    occurrenceResults,
    unexpectedObservations: unexpectedObservations.map((observation) => unexpectedObservationSchema.parse(observation))
  };
}

export const comparisonRunResultSchema = z.object({
  label: comparisonRunLabelSchema,
  status: z.enum(["completed", "error"]),
  phraseSet: z.array(z.string().min(1).max(120)).max(50),
  terms: z.array(glossaryTermSchema).min(1).max(50),
  startedAt: z.string().datetime({ offset: true }),
  readyAfterMs: z.number().int().nonnegative().nullable(),
  audioDurationMs: z.number().int().nonnegative(),
  wallClockMs: z.number().int().nonnegative(),
  interimCount: z.number().int().nonnegative(),
  finalTranscripts: z.array(comparisonFinalTranscriptSchema),
  transcript: z.string(),
  rawTranscript: z.string(),
  metrics: comparisonRunMetricsSchema,
  occurrenceResults: z.array(comparisonOccurrenceResultSchema),
  unexpectedObservations: z.array(unexpectedObservationSchema),
  errors: z.array(z.string())
}).strict();

export type ComparisonRunResult = z.infer<typeof comparisonRunResultSchema>;

export const comparisonReportV3Schema = z.object({
  version: z.literal(3),
  createdAt: z.string().datetime({ offset: true }),
  recording: z.object({
    id: z.string().uuid(),
    scriptId: fixtureIdSchema,
    speakerReadReferenceScriptVerbatim: z.boolean(),
    evaluationMode: z.enum(["accuracy", "smoke"])
  }).strict(),
  script: fixtureScriptSchema,
  websocketUrl: z.string().url(),
  measurementNote: z.string().min(1),
  runs: z.array(comparisonRunResultSchema).length(3)
}).strict().superRefine((report, context) => {
  if (report.recording.scriptId !== report.script.id) {
    context.addIssue({ code: "custom", path: ["recording", "scriptId"], message: "recording과 script id가 일치하지 않습니다." });
  }
  const expectedMode = report.recording.speakerReadReferenceScriptVerbatim ? "accuracy" : "smoke";
  if (report.recording.evaluationMode !== expectedMode) {
    context.addIssue({ code: "custom", path: ["recording", "evaluationMode"], message: "녹음 검증 상태와 evaluationMode가 일치하지 않습니다." });
  }

  const expectedDefinitions = buildComparisonRunDefinitions(report.script);
  report.runs.forEach((run, index) => {
    const definition = expectedDefinitions[index];
    if (!definition || run.label !== comparisonRunLabels[index]) {
      context.addIssue({ code: "custom", path: ["runs", index, "label"], message: "A/B/C run은 고정 순서로 정확히 한 번씩 있어야 합니다." });
      return;
    }
    if (JSON.stringify(run.phraseSet) !== JSON.stringify(definition.phraseSet)) {
      context.addIssue({ code: "custom", path: ["runs", index, "phraseSet"], message: "run PhraseSet이 고정 조건과 일치하지 않습니다." });
    }
    if (JSON.stringify(run.terms) !== JSON.stringify(definition.terms)) {
      context.addIssue({ code: "custom", path: ["runs", index, "terms"], message: "run term alias 구성이 고정 조건과 일치하지 않습니다." });
    }
    if (run.metrics.evaluationMode !== expectedMode || run.metrics.accuracyValid !== report.recording.speakerReadReferenceScriptVerbatim) {
      context.addIssue({ code: "custom", path: ["runs", index, "metrics"], message: "run 평가 상태가 녹음 검증 선언과 일치하지 않습니다." });
    }
  });
});

export type ComparisonReportV3 = z.infer<typeof comparisonReportV3Schema>;

export const comparisonReportV4Schema = z.object({
  version: z.literal(4),
  createdAt: z.string().datetime({ offset: true }),
  recording: z.object({
    id: z.string().uuid(),
    scriptId: fixtureIdSchema,
    speakerReadReferenceScriptVerbatim: z.boolean(),
    evaluationMode: z.enum(["accuracy", "smoke"]),
    experimentIdentity: experimentIdentitySchema.nullable()
  }).strict(),
  script: fixtureScriptSchema,
  websocketUrl: z.string().url(),
  measurementNote: z.string().min(1),
  runs: z.array(comparisonRunResultSchema).length(3)
}).strict().superRefine((report, context) => {
  if (report.recording.scriptId !== report.script.id) {
    context.addIssue({ code: "custom", path: ["recording", "scriptId"], message: "recording과 script id가 일치하지 않습니다." });
  }
  const expectedMode = report.recording.speakerReadReferenceScriptVerbatim ? "accuracy" : "smoke";
  if (report.recording.evaluationMode !== expectedMode) {
    context.addIssue({ code: "custom", path: ["recording", "evaluationMode"], message: "녹음 검증 상태와 evaluationMode가 일치하지 않습니다." });
  }
  if (JSON.stringify(report.recording.experimentIdentity) !== JSON.stringify(report.script.experimentIdentity ?? null)) {
    context.addIssue({ code: "custom", path: ["recording", "experimentIdentity"], message: "녹음과 대본의 실험 스냅샷 ID가 일치하지 않습니다." });
  }
  if (report.script.experimentIdentity && !report.script.adaptationTerms) {
    context.addIssue({ code: "custom", path: ["script", "adaptationTerms"], message: "실험 케이스에는 PDF 용어집 적응 용어가 필요합니다." });
  }

  const expectedDefinitions = buildComparisonRunDefinitions(report.script);
  report.runs.forEach((run, index) => {
    const definition = expectedDefinitions[index];
    if (!definition || run.label !== comparisonRunLabels[index]) {
      context.addIssue({ code: "custom", path: ["runs", index, "label"], message: "A/B/C run은 고정 순서로 정확히 한 번씩 있어야 합니다." });
      return;
    }
    if (JSON.stringify(run.phraseSet) !== JSON.stringify(definition.phraseSet)) {
      context.addIssue({ code: "custom", path: ["runs", index, "phraseSet"], message: "run PhraseSet이 고정 조건과 일치하지 않습니다." });
    }
    if (JSON.stringify(run.terms) !== JSON.stringify(definition.terms)) {
      context.addIssue({ code: "custom", path: ["runs", index, "terms"], message: "run term alias 구성이 고정 조건과 일치하지 않습니다." });
    }
    if (run.metrics.evaluationMode !== expectedMode || run.metrics.accuracyValid !== report.recording.speakerReadReferenceScriptVerbatim) {
      context.addIssue({ code: "custom", path: ["runs", index, "metrics"], message: "run 평가 상태가 녹음 검증 선언과 일치하지 않습니다." });
    }
  });
});

export type ComparisonReportV4 = z.infer<typeof comparisonReportV4Schema>;
export type CurrentComparisonReport = ComparisonReportV3 | ComparisonReportV4;

export const legacyComparisonReportSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)])
}).passthrough();

export const comparisonReportFileSchema = z.union([
  comparisonReportV4Schema,
  comparisonReportV3Schema,
  legacyComparisonReportSchema
]);

export type ComparisonReportFile = z.infer<typeof comparisonReportFileSchema>;
export type LegacyComparisonReport = z.infer<typeof legacyComparisonReportSchema>;

export function isLegacyComparisonReport(report: ComparisonReportFile): report is LegacyComparisonReport {
  return report.version === 1 || report.version === 2;
}

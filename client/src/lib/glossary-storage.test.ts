import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStoredGlossaryReadyState } from "../app-state";
import { createLectureStartMessage } from "../hooks/lecture-stream-state";
import type { AnalysisResult, GlossaryTerm } from "../types";
import {
  clearGlossaryStorageBackups,
  clearStoredGlossaries,
  deleteStoredGlossary,
  exportGlossaryStorageRecoveryBundle,
  GLOSSARY_STORAGE_KEY,
  GLOSSARY_STORAGE_RECOVERY_KEY,
  glossaryStorageErrorMessage,
  listGlossaryStorageBackups,
  listStoredGlossaries,
  recoverStoredGlossaryData,
  renameStoredGlossary,
  restoreGlossaryStorageBackup,
  saveAnalyzedGlossary,
  type GlossaryStorageAdapter
} from "./glossary-storage";

class MemoryStorage implements GlossaryStorageAdapter {
  protected readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function term(overrides: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    id: "term-rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["래그", "레그", "알에이지"],
    easyExplanation: "외부 자료를 찾아 답변에 활용하는 방식",
    pageNumber: 3,
    occurrences: 2,
    source: "gemini",
    ...overrides
  };
}

function analysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const result: AnalysisResult & { pdfUrl: string } = {
    title: "생성형 AI 강연",
    pages: [{ pageNumber: 3, text: "민감한 PDF 추출 페이지 텍스트" }],
    terms: [term()],
    phraseSet: ["RAG", "Retrieval-Augmented Generation"],
    mode: "gemini",
    warning: "저장하면 안 되는 분석 경고",
    pdfUrl: "blob:https://example.test/private-pdf",
    ...overrides
  };
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser glossary storage v3", () => {
  it("roundtrips complete terms and PhraseSet while excluding PDF-derived and transient data", () => {
    const storage = new MemoryStorage();
    const saved = saveAnalyzedGlossary(storage, analysis(), "생성형 AI 용어집", {
      id: "glossary-1",
      now: "2026-08-08T01:00:00.000Z"
    });

    expect(listStoredGlossaries(storage)).toEqual([saved]);
    expect(saved.terms).toEqual([term()]);
    expect(saved.phraseSet).toEqual(["RAG", "Retrieval-Augmented Generation"]);

    const raw = storage.getItem(GLOSSARY_STORAGE_KEY);
    expect(raw).not.toContain("민감한 PDF 추출 페이지 텍스트");
    expect(raw).not.toContain("private-pdf");
    expect(raw).not.toContain("저장하면 안 되는 분석 경고");
    expect(JSON.parse(raw || "{}")).toEqual({ version: 3, glossaries: [saved] });
  });

  it("원본 용어 개수만 제한하고 50개를 넘는 영문·한글 발음 표기를 저장한다", () => {
    const storage = new MemoryStorage();
    const terms = Array.from({ length: 20 }, (_, index): GlossaryTerm => ({
      ...term(),
      id: `term-${index}`,
      term: `Term ${index}`,
      english: `English ${index}`,
      spokenAliases: [`${String.fromCharCode(0xac00 + index)}음`]
    }));
    const phraseSet = terms.flatMap((candidate) => [
      candidate.term,
      candidate.english,
      ...candidate.spokenAliases
    ]);

    const saved = saveAnalyzedGlossary(storage, analysis({ terms, phraseSet }), "파생 표기 용어집", {
      id: "glossary-derived-forms",
      now: "2026-08-08T01:30:00.000Z"
    });

    expect(saved.terms).toHaveLength(20);
    expect(saved.phraseSet).toHaveLength(60);
    expect(saved.phraseSet).toContain(terms[19]!.spokenAliases[0]);
  });

  it("기존 50개에서 잘린 저장 PhraseSet의 원본·발음 표기를 API 재호출 없이 복원한다", () => {
    const storage = new MemoryStorage();
    const terms = Array.from({ length: 20 }, (_, index): GlossaryTerm => ({
      ...term(),
      id: `legacy-term-${index}`,
      term: `Legacy ${index}`,
      english: `Legacy English ${index}`,
      spokenAliases: [`${String.fromCharCode(0xac00 + index)}음`]
    }));
    const completePhraseSet = terms.flatMap((candidate) => [
      candidate.term,
      candidate.english,
      ...candidate.spokenAliases
    ]);
    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify({
      version: 3,
      glossaries: [{
        id: "legacy-capped-glossary",
        name: "기존 50개 제한 용어집",
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
        terms,
        phraseSet: completePhraseSet.slice(0, 50)
      }]
    }));

    const [loaded] = listStoredGlossaries(storage);

    expect(loaded?.phraseSet.length).toBeGreaterThan(50);
    expect(loaded?.phraseSet).toContain(terms[19]!.term);
    expect(loaded?.phraseSet).toContain(terms[19]!.spokenAliases[0]);
  });

  it("roundtrips a safe generated pronunciation outside the fallback list", () => {
    const storage = new MemoryStorage();
    const bert = term({
      id: "term-bert",
      term: "BERT",
      english: "",
      spokenAliases: ["버트"],
      easyExplanation: "문맥을 양방향으로 이해하는 언어 모델"
    });
    const saved = saveAnalyzedGlossary(storage, analysis({ terms: [bert], phraseSet: ["BERT", "버트"] }), "BERT 용어집", {
      id: "glossary-bert",
      now: "2026-08-08T01:10:00.000Z"
    });

    expect(saved.terms[0]?.spokenAliases).toEqual(["버트"]);
    expect(saved.phraseSet).toEqual(["BERT", "버트"]);
    expect(listStoredGlossaries(storage)).toEqual([saved]);
  });

  it("rejects malformed JSON and strict-shape violations", () => {
    const storage = new MemoryStorage();
    storage.setItem(GLOSSARY_STORAGE_KEY, "{");

    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "invalid" }));

    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify({ version: 3, glossaries: [], unexpected: true }));
    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "invalid" }));
  });

  it("isolates one malformed glossary, keeps valid glossaries loadable, and preserves the exact source", () => {
    const storage = new MemoryStorage();
    const saved = saveAnalyzedGlossary(storage, analysis(), "정상 용어집", {
      id: "valid-glossary",
      now: "2026-08-08T01:00:00.000Z"
    });
    const source = JSON.stringify({
      version: 3,
      glossaries: [
        saved,
        {
          ...saved,
          id: "broken-glossary",
          name: "손상된 용어집",
          terms: [{ ...saved.terms[0], pageNumber: 0 }]
        }
      ]
    });
    storage.setItem(GLOSSARY_STORAGE_KEY, source);

    expect(listStoredGlossaries(storage)).toEqual([saved]);
    expect(JSON.parse(storage.getItem(GLOSSARY_STORAGE_KEY) || "{}")).toEqual({
      version: 3,
      glossaries: [saved]
    });

    const backups = listGlossaryStorageBackups(storage);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ reason: "entry-salvage", sourceVersion: 3, raw: source });
    expect(JSON.parse(backups[0]!.raw).glossaries[1].id).toBe("broken-glossary");

    const bundle = JSON.parse(exportGlossaryStorageRecoveryBundle(
      storage,
      "2026-08-08T01:05:00.000Z"
    ));
    expect(bundle).toMatchObject({
      version: 1,
      exportedAt: "2026-08-08T01:05:00.000Z",
      backups: [{ raw: source }]
    });
  });

  it("does not rewrite a malformed envelope until explicit lossless recovery", () => {
    const storage = new MemoryStorage();
    const saved = saveAnalyzedGlossary(storage, analysis(), "정상 용어집", {
      id: "valid-in-envelope",
      now: "2026-08-08T01:00:00.000Z"
    });
    const source = JSON.stringify({ version: 3, glossaries: [saved], unexpected: "preserve me" });
    storage.setItem(GLOSSARY_STORAGE_KEY, source);

    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).toBe(source);
    expect(listGlossaryStorageBackups(storage)).toEqual([]);

    const recovered = recoverStoredGlossaryData(storage, "2026-08-08T01:10:00.000Z");
    expect(recovered).toMatchObject({ glossaries: [saved], rejectedCount: 0 });
    expect(recovered.backup).toMatchObject({ reason: "manual-recovery", raw: source });
    expect(listStoredGlossaries(storage)).toEqual([saved]);
    expect(listGlossaryStorageBackups(storage)[0]?.raw).toBe(source);
  });

  it("backs up malformed JSON and unsupported versions exactly before starting a clean store", () => {
    const malformedStorage = new MemoryStorage();
    malformedStorage.setItem(GLOSSARY_STORAGE_KEY, "{not-json");

    const malformedRecovery = recoverStoredGlossaryData(
      malformedStorage,
      "2026-08-08T01:20:00.000Z"
    );
    expect(malformedRecovery).toMatchObject({ glossaries: [], rejectedCount: 1 });
    expect(malformedRecovery.backup?.raw).toBe("{not-json");
    expect(listStoredGlossaries(malformedStorage)).toEqual([]);

    const futureStorage = new MemoryStorage();
    const futureSource = JSON.stringify({ version: 99, glossaries: [{ future: true }] });
    futureStorage.setItem(GLOSSARY_STORAGE_KEY, futureSource);

    expect(() => listStoredGlossaries(futureStorage)).toThrowError(expect.objectContaining({ code: "version" }));
    const futureRecovery = recoverStoredGlossaryData(
      futureStorage,
      "2026-08-08T01:21:00.000Z"
    );
    expect(futureRecovery).toMatchObject({ glossaries: [], rejectedCount: 1 });
    expect(futureRecovery.backup).toMatchObject({ sourceVersion: 99, raw: futureSource });
    expect(listStoredGlossaries(futureStorage)).toEqual([]);
  });

  it("restores an exact backup without deleting the active store or the backup history", () => {
    const storage = new MemoryStorage();
    const unsupportedSource = JSON.stringify({ version: 99, glossaries: [{ future: true }] });
    storage.setItem(GLOSSARY_STORAGE_KEY, unsupportedSource);
    const recovery = recoverStoredGlossaryData(storage, "2026-08-08T01:30:00.000Z");
    const cleanSource = storage.getItem(GLOSSARY_STORAGE_KEY);

    restoreGlossaryStorageBackup(storage, recovery.backup!.id);

    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).toBe(unsupportedSource);
    expect(listGlossaryStorageBackups(storage).map((candidate) => candidate.raw)).toEqual(
      expect.arrayContaining([unsupportedSource, cleanSource])
    );
    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "version" }));

    clearGlossaryStorageBackups(storage);
    expect(storage.getItem(GLOSSARY_STORAGE_RECOVERY_KEY)).toBeNull();
    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).toBe(unsupportedSource);
  });

  it("exports the exact recovery-store source even when its envelope is malformed", () => {
    const storage = new MemoryStorage();
    const activeSource = JSON.stringify({ version: 3, glossaries: [] });
    const malformedRecoverySource = "{not-valid-recovery-json";
    storage.setItem(GLOSSARY_STORAGE_KEY, activeSource);
    storage.setItem(GLOSSARY_STORAGE_RECOVERY_KEY, malformedRecoverySource);

    const bundle = JSON.parse(exportGlossaryStorageRecoveryBundle(
      storage,
      "2026-08-08T01:45:00.000Z"
    ));

    expect(bundle).toMatchObject({
      version: 1,
      exportedAt: "2026-08-08T01:45:00.000Z",
      activeStoreRaw: activeSource,
      recoveryStoreRaw: malformedRecoverySource,
      backups: null,
      recoveryStoreIssue: { code: "invalid" }
    });
    expect(storage.getItem(GLOSSARY_STORAGE_RECOVERY_KEY)).toBe(malformedRecoverySource);
  });

  it("rejects an unsupported schema version without rewriting it", () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify({ version: 4, glossaries: [] });
    storage.setItem(GLOSSARY_STORAGE_KEY, raw);

    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "version" }));
    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).toBe(raw);
  });

  it("clears corrupt or unsupported data only after an explicit recovery call", () => {
    const storage = new MemoryStorage();
    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify({ version: 4, glossaries: [] }));

    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "version" }));
    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).not.toBeNull();

    clearStoredGlossaries(storage);
    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).toBeNull();
    expect(listStoredGlossaries(storage)).toEqual([]);
  });

  it("rejects empty persisted glossaries", () => {
    const storage = new MemoryStorage();

    expect(() => saveAnalyzedGlossary(storage, analysis({ terms: [], phraseSet: [] }), "빈 용어집", {
      id: "glossary-empty",
      now: "2026-08-08T01:30:00.000Z"
    })).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(listStoredGlossaries(storage)).toEqual([]);
  });

  it("explicitly migrates valid v1 glossaries to v3 without changing IDs or invoking analysis", () => {
    const storage = new MemoryStorage();
    const legacyTerm = { ...term() } as Record<string, unknown>;
    delete legacyTerm.spokenAliases;
    const source = JSON.stringify({
      version: 1,
      glossaries: [{
        id: "legacy-glossary",
        name: "기존 용어집",
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
        terms: [legacyTerm],
        phraseSet: ["RAG", "Retrieval-Augmented Generation"]
      }]
    });
    storage.setItem(GLOSSARY_STORAGE_KEY, source);

    const migrated = listStoredGlossaries(storage);

    expect(migrated[0]).toMatchObject({
      id: "legacy-glossary",
      terms: [{ id: "term-rag", spokenAliases: [] }],
      phraseSet: ["RAG", "Retrieval-Augmented Generation"]
    });
    expect(JSON.parse(storage.getItem(GLOSSARY_STORAGE_KEY) || "{}")).toMatchObject({
      version: 3,
      glossaries: [{ id: "legacy-glossary", terms: [{ spokenAliases: [] }] }]
    });
    expect(listGlossaryStorageBackups(storage)[0]).toMatchObject({
      reason: "schema-migration",
      sourceVersion: 1,
      raw: source
    });
  });

  it("migrates v2 by retaining safe aliases and dropping unsafe aliases and their PhraseSet entries", () => {
    const storage = new MemoryStorage();
    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify({
      version: 2,
      glossaries: [{
        id: "v2-glossary",
        name: "이전 별칭 용어집",
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
        terms: [term({ spokenAliases: ["레그", "사과"] })],
        phraseSet: ["RAG", "레그", "사과"]
      }]
    }));

    const migrated = listStoredGlossaries(storage);

    expect(migrated[0]?.terms[0]?.spokenAliases).toEqual(["레그"]);
    expect(migrated[0]?.phraseSet).toEqual(["RAG", "레그"]);
    expect(JSON.parse(storage.getItem(GLOSSARY_STORAGE_KEY) || "{}").version).toBe(3);
  });

  it("validates alias limits, common-word hazards, collisions, and PhraseSet correspondence", () => {
    const storage = new MemoryStorage();
    expect(() => saveAnalyzedGlossary(storage, analysis({
      terms: [term({ spokenAliases: ["모델"] })],
      phraseSet: ["RAG", "모델"]
    }), "위험 별칭")).toThrowError(expect.objectContaining({ code: "invalid" }));

    expect(() => saveAnalyzedGlossary(storage, analysis({
      terms: [term({ term: "API", english: "Application Programming Interface", spokenAliases: ["사과"] })],
      phraseSet: ["API", "사과"]
    }), "위험 일반 단어 별칭")).toThrowError(expect.objectContaining({ code: "invalid" }));

    expect(() => saveAnalyzedGlossary(storage, analysis({
      terms: [
        term({ id: "one", term: "Alpha", english: "Alpha", spokenAliases: ["공유발음"] }),
        term({ id: "two", term: "Beta", english: "Beta", spokenAliases: ["공유발음"] })
      ],
      phraseSet: ["Alpha", "Beta", "공유발음"]
    }), "충돌 별칭")).toThrowError(expect.objectContaining({ code: "invalid" }));
  });

  it("deduplicates normalized term text, term IDs, and PhraseSet values while preserving the first term ID", () => {
    const storage = new MemoryStorage();
    const saved = saveAnalyzedGlossary(
      storage,
      analysis({
        terms: [
          term(),
          term({ id: "term-duplicate", term: " ＲＡＧ " }),
          term({ id: "term-transformer", term: "Transformer", english: "Transformer", spokenAliases: ["트랜스포머"], easyExplanation: "문맥을 처리하는 신경망 구조" })
        ],
        phraseSet: [" RAG ", "ＲＡＧ", " retrieval-augmented   generation ", "Transformer", " Transformer "]
      }),
      "중복 검증",
      { id: "glossary-dedup", now: "2026-08-08T02:00:00.000Z" }
    );

    expect(saved.terms).toHaveLength(2);
    expect(saved.terms[0]?.id).toBe("term-rag");
    expect(saved.phraseSet).toEqual(["RAG", "Retrieval-Augmented Generation", "Transformer"]);
  });

  it("canonicalizes term IDs before deduplication so the client and server keep the same terms", () => {
    const storage = new MemoryStorage();
    const saved = saveAnalyzedGlossary(storage, analysis({
      terms: [
        term({ id: "same", term: "RAG" }),
        term({ id: " same ", term: "Transformer", english: "Transformer", spokenAliases: ["트랜스포머"] })
      ],
      phraseSet: ["RAG", "Retrieval-Augmented Generation"]
    }), "ID 정규화");

    expect(saved.terms).toHaveLength(1);
    expect(saved.terms[0]?.id).toBe("same");
  });

  it("deduplicates identical content regardless of term and PhraseSet order", () => {
    const storage = new MemoryStorage();
    const transformer = term({
      id: "term-transformer",
      term: "Transformer",
      english: "Transformer",
      spokenAliases: ["트랜스포머"],
      easyExplanation: "문맥을 처리하는 신경망 구조"
    });
    const first = saveAnalyzedGlossary(storage, analysis({
      terms: [term(), transformer],
      phraseSet: ["RAG", "Retrieval-Augmented Generation", "Transformer"]
    }), "같은 강연", { now: "2026-08-08T02:10:00.000Z" });
    const second = saveAnalyzedGlossary(storage, analysis({
      terms: [transformer, term()],
      phraseSet: ["Transformer", "Retrieval-Augmented Generation", "RAG"]
    }), "같은 강연", { now: "2026-08-08T02:20:00.000Z" });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe("2026-08-08T02:20:00.000Z");
    expect(listStoredGlossaries(storage)).toEqual([second]);
  });

  it("never moves updatedAt backwards when the device clock rolls back", () => {
    const storage = new MemoryStorage();
    const original = saveAnalyzedGlossary(storage, analysis(), "강연", {
      id: "clock-safe",
      now: "2026-08-08T10:00:00.000Z"
    });
    const renamed = renameStoredGlossary(storage, original.id, "바뀐 이름", "2026-08-08T12:00:00.000Z");
    const savedAgain = saveAnalyzedGlossary(storage, analysis(), "바뀐 이름", {
      id: original.id,
      now: "2026-08-08T11:00:00.000Z"
    });
    const renamedWithOlderClock = renameStoredGlossary(storage, original.id, "다시 바뀐 이름", "2026-08-08T09:00:00.000Z");

    expect(renamed.updatedAt).toBe("2026-08-08T12:00:00.000Z");
    expect(savedAgain.updatedAt).toBe("2026-08-08T12:00:00.000Z");
    expect(renamedWithOlderClock.updatedAt).toBe("2026-08-08T12:00:00.000Z");
  });

  it("reports the 50-item limit without discarding existing glossaries", () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 50; index += 1) {
      saveAnalyzedGlossary(storage, analysis(), `강연 ${index}`, {
        id: `glossary-${index}`,
        now: new Date(Date.UTC(2026, 7, 8, 2, 30, index)).toISOString()
      });
    }

    expect(() => saveAnalyzedGlossary(storage, analysis(), "51번째 강연", {
      id: "glossary-50",
      now: "2026-08-08T02:31:00.000Z"
    })).toThrowError(expect.objectContaining({ code: "limit" }));
    expect(listStoredGlossaries(storage)).toHaveLength(50);
  });

  it("preserves an over-limit source and explicitly recovers the 50 newest glossaries", () => {
    const storage = new MemoryStorage();
    const base = saveAnalyzedGlossary(storage, analysis(), "기준", {
      id: "base",
      now: "2026-08-08T00:00:00.000Z"
    });
    const glossaries = Array.from({ length: 51 }, (_, index) => ({
      ...base,
      id: `over-limit-${index}`,
      name: `용어집 ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 8, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 7, 8, 0, 0, index)).toISOString()
    }));
    const source = JSON.stringify({ version: 3, glossaries });
    storage.setItem(GLOSSARY_STORAGE_KEY, source);

    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "limit" }));
    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).toBe(source);

    const recovered = recoverStoredGlossaryData(storage, "2026-08-08T02:40:00.000Z");
    expect(recovered.glossaries).toHaveLength(50);
    expect(recovered.rejectedCount).toBe(1);
    expect(recovered.glossaries[0]?.id).toBe("over-limit-50");
    expect(recovered.glossaries.at(-1)?.id).toBe("over-limit-1");
    expect(recovered.backup?.raw).toBe(source);
    expect(listStoredGlossaries(storage)).toHaveLength(50);
  });

  it("renames and deletes a stored glossary without changing its terms or creation time", () => {
    const storage = new MemoryStorage();
    const saved = saveAnalyzedGlossary(storage, analysis(), "이전 이름", {
      id: "glossary-edit",
      now: "2026-08-08T03:00:00.000Z"
    });

    const renamed = renameStoredGlossary(storage, saved.id, "새 이름", "2026-08-08T04:00:00.000Z");
    expect(renamed).toMatchObject({
      id: saved.id,
      name: "새 이름",
      createdAt: "2026-08-08T03:00:00.000Z",
      updatedAt: "2026-08-08T04:00:00.000Z",
      terms: saved.terms,
      phraseSet: saved.phraseSet
    });

    deleteStoredGlossary(storage, saved.id);
    expect(listStoredGlossaries(storage)).toEqual([]);
  });

  it("reports quota failures with a user-facing storage message", () => {
    class QuotaStorage extends MemoryStorage {
      override setItem(): void {
        throw { name: "QuotaExceededError" };
      }
    }

    let caught: unknown;
    try {
      saveAnalyzedGlossary(new QuotaStorage(), analysis(), "공간 부족", {
        id: "glossary-quota",
        now: "2026-08-08T05:00:00.000Z"
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "quota" });
    expect(glossaryStorageErrorMessage(caught)).toContain("저장 공간이 부족");
  });

  it("keeps a mixed source readable but blocks mutation when a lossless backup cannot fit", () => {
    class RecoveryQuotaStorage extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (key === GLOSSARY_STORAGE_RECOVERY_KEY) throw { name: "QuotaExceededError" };
        super.setItem(key, value);
      }
    }

    const storage = new RecoveryQuotaStorage();
    const seed = new MemoryStorage();
    const saved = saveAnalyzedGlossary(seed, analysis(), "정상 용어집", {
      id: "quota-valid",
      now: "2026-08-08T05:10:00.000Z"
    });
    const source = JSON.stringify({
      version: 3,
      glossaries: [saved, { ...saved, id: "quota-invalid", terms: [] }]
    });
    storage.setItem(GLOSSARY_STORAGE_KEY, source);

    expect(listStoredGlossaries(storage)).toEqual([saved]);
    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).toBe(source);
    expect(() => renameStoredGlossary(storage, saved.id, "덮어쓰면 안 됨"))
      .toThrowError(expect.objectContaining({ code: "quota" }));
    expect(storage.getItem(GLOSSARY_STORAGE_KEY)).toBe(source);
  });
});

describe("stored glossary lecture path", () => {
  it("loads terms and PhraseSet into the live WebSocket start message without calling the analyze API", () => {
    const storage = new MemoryStorage();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const saved = saveAnalyzedGlossary(storage, analysis(), "다시 쓰는 용어집", {
      id: "glossary-live",
      now: "2026-08-08T06:00:00.000Z"
    });

    const readyState = loadStoredGlossaryReadyState(storage, saved.id);
    const loaded = readyState.analysis;
    const start = createLectureStartMessage("live", loaded.terms, loaded.phraseSet);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readyState.stage).toBe("ready");
    expect(readyState.fileName).toBe(saved.name);
    expect(loaded).not.toHaveProperty("pdfUrl");
    expect(loaded.pages).toEqual([]);
    expect(start).toEqual({ type: "start", mode: "live", terms: saved.terms, phraseSet: saved.phraseSet });
  });

  it("keeps migrated v1 aliases empty in the live start message", () => {
    const storage = new MemoryStorage();
    const legacyTerm = { ...term() } as Record<string, unknown>;
    delete legacyTerm.spokenAliases;
    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify({
      version: 1,
      glossaries: [{
        id: "legacy-live",
        name: "기존 용어집",
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
        terms: [legacyTerm],
        phraseSet: ["RAG", "Retrieval-Augmented Generation"]
      }]
    }));

    const readyState = loadStoredGlossaryReadyState(storage, "legacy-live");
    const start = createLectureStartMessage("live", readyState.analysis.terms, readyState.analysis.phraseSet);

    expect(start.terms[0]?.spokenAliases).toEqual([]);
    expect(start.phraseSet).toEqual(["RAG", "Retrieval-Augmented Generation"]);
  });
});

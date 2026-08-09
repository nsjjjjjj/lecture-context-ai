import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStoredGlossaryReadyState } from "../app-state";
import { createLectureStartMessage } from "../hooks/lecture-stream-state";
import type { AnalysisResult, GlossaryTerm } from "../types";
import {
  clearStoredGlossaries,
  deleteStoredGlossary,
  GLOSSARY_STORAGE_KEY,
  glossaryStorageErrorMessage,
  listStoredGlossaries,
  renameStoredGlossary,
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
  return {
    title: "생성형 AI 강연",
    pages: [{ pageNumber: 3, text: "민감한 PDF 추출 페이지 텍스트" }],
    terms: [term()],
    phraseSet: ["RAG", "Retrieval-Augmented Generation"],
    mode: "gemini",
    warning: "저장하면 안 되는 분석 경고",
    pdfUrl: "blob:https://example.test/private-pdf",
    ...overrides
  };
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

  it("rejects malformed JSON and strict-shape violations", () => {
    const storage = new MemoryStorage();
    storage.setItem(GLOSSARY_STORAGE_KEY, "{");

    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "invalid" }));

    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify({ version: 3, glossaries: [], unexpected: true }));
    expect(() => listStoredGlossaries(storage)).toThrowError(expect.objectContaining({ code: "invalid" }));
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
    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify({
      version: 1,
      glossaries: [{
        id: "legacy-glossary",
        name: "기존 용어집",
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
        terms: [legacyTerm],
        phraseSet: ["RAG", "Retrieval-Augmented Generation"]
      }]
    }));

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
  });

  it("migrates v2 by retaining reviewed aliases and dropping unsafe aliases and their PhraseSet entries", () => {
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
    }), "미검토 별칭")).toThrowError(expect.objectContaining({ code: "invalid" }));

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

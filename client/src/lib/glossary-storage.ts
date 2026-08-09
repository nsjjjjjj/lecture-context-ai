import type { AnalysisResult, GlossaryTerm } from "../types";

export const GLOSSARY_STORAGE_KEY = "lecture-context-ai.glossaries";
export const GLOSSARY_STORAGE_VERSION = 2 as const;

const MAX_GLOSSARIES = 50;
const MAX_TERMS = 50;
const MAX_PHRASES = 50;
const MAX_RAW_ITEMS = 200;
const MAX_SPOKEN_ALIASES = 6;
const MAX_SPOKEN_ALIAS_LENGTH = 40;
const UNSAFE_ALIASES = new Set([
  "강연", "검색", "결과", "경우", "관련", "그래서", "기능", "다시", "다음", "데이터", "모델", "문서",
  "방식", "생성", "서비스", "사용자", "설명", "그리고", "이것", "입니다", "인식", "오늘", "외부", "이유",
  "이미", "이번", "자료", "정도", "자막", "저것", "하지만", "답변", "용어", "우리", "페이지", "현재"
]);

export type StoredGlossary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  terms: GlossaryTerm[];
  phraseSet: string[];
};

type GlossaryStoreV2 = {
  version: typeof GLOSSARY_STORAGE_VERSION;
  glossaries: StoredGlossary[];
};

export type GlossaryStorageAdapter = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type GlossaryStorageErrorCode = "invalid" | "version" | "unavailable" | "quota" | "limit" | "not-found";
export type GlossaryStorageIssue = { code: GlossaryStorageErrorCode; message: string };

export class GlossaryStorageError extends Error {
  constructor(
    readonly code: GlossaryStorageErrorCode,
    message: string
  ) {
    super(message);
    this.name = "GlossaryStorageError";
  }
}

function fail(code: GlossaryStorageErrorCode, message: string): never {
  throw new GlossaryStorageError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function canonicalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizedKey(value: string): string {
  return canonicalize(value).toLocaleLowerCase("ko-KR");
}

function validatedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") fail("invalid", `${label} 형식이 올바르지 않습니다.`);
  const canonical = canonicalize(value);
  if (canonical.length < minimum || canonical.length > maximum) {
    fail("invalid", `${label} 길이가 허용 범위를 벗어났습니다.`);
  }
  return canonical;
}

function validatedTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") fail("invalid", `${label} 형식이 올바르지 않습니다.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    fail("invalid", `${label} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function validateSpokenAliases(value: unknown, term: string, english: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_RAW_ITEMS) {
    fail("invalid", "저장된 발음 별칭 형식이 올바르지 않습니다.");
  }
  const protectedKeys = new Set([normalizedKey(term), normalizedKey(english)].filter(Boolean));
  if (!/[A-Za-z]/u.test(`${term}${english}`) && value.length > 0) {
    fail("invalid", "발음 별칭은 영문 표기가 있는 전문용어에만 사용할 수 있습니다.");
  }
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const alias = validatedString(candidate, "발음 별칭", 2, MAX_SPOKEN_ALIAS_LENGTH);
    const key = normalizedKey(alias);
    const hangulCount = [...alias].filter((character) => /[가-힣]/u.test(character)).length;
    if (!/^[가-힣]+(?:[ -][가-힣]+)*$/u.test(alias) || hangulCount < 2 || protectedKeys.has(key) || UNSAFE_ALIASES.has(key)) {
      fail("invalid", "안전하지 않거나 전문용어와 중복되는 발음 별칭이 있습니다.");
    }
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length > MAX_SPOKEN_ALIASES) fail("invalid", "전문용어 하나의 발음 별칭은 최대 6개입니다.");
  }
  return aliases;
}

function validateTerm(value: unknown, legacy = false): GlossaryTerm {
  const expectedKeys = legacy
    ? ["id", "term", "english", "easyExplanation", "pageNumber", "occurrences", "source"]
    : ["id", "term", "english", "spokenAliases", "easyExplanation", "pageNumber", "occurrences", "source"];
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) {
    fail("invalid", "저장된 전문용어 형식이 올바르지 않습니다.");
  }

  if (typeof value.id !== "string" || value.id.trim().length === 0 || value.id.length > 160) {
    fail("invalid", "저장된 전문용어 ID가 올바르지 않습니다.");
  }
  if (!Number.isInteger(value.pageNumber) || (value.pageNumber as number) <= 0) {
    fail("invalid", "저장된 전문용어 페이지 번호가 올바르지 않습니다.");
  }
  if (!Number.isInteger(value.occurrences) || (value.occurrences as number) < 0) {
    fail("invalid", "저장된 전문용어 출현 횟수가 올바르지 않습니다.");
  }
  if (value.source !== "gemini" && value.source !== "heuristic" && value.source !== "demo") {
    fail("invalid", "저장된 전문용어 출처가 올바르지 않습니다.");
  }

  const term = validatedString(value.term, "전문용어", 2, 80);
  const english = validatedString(value.english, "영문 표기", 0, 120);
  return {
    id: value.id,
    term,
    english,
    spokenAliases: legacy ? [] : validateSpokenAliases(value.spokenAliases, term, english),
    easyExplanation: validatedString(value.easyExplanation, "쉬운 설명", 2, 240),
    pageNumber: value.pageNumber as number,
    occurrences: value.occurrences as number,
    source: value.source
  };
}

function validateTerms(value: unknown, legacy = false): GlossaryTerm[] {
  if (!Array.isArray(value) || value.length > MAX_RAW_ITEMS) {
    fail("invalid", "저장된 전문용어 목록이 올바르지 않습니다.");
  }

  const terms: GlossaryTerm[] = [];
  const seenIds = new Set<string>();
  const seenTerms = new Set<string>();
  for (const candidate of value) {
    const term = validateTerm(candidate, legacy);
    const termKey = normalizedKey(term.term);
    if (seenIds.has(term.id) || seenTerms.has(termKey)) continue;
    seenIds.add(term.id);
    seenTerms.add(termKey);
    terms.push(term);
    if (terms.length > MAX_TERMS) fail("invalid", "저장 가능한 전문용어는 최대 50개입니다.");
  }
  if (terms.length === 0) fail("invalid", "전문용어가 하나 이상 있는 용어집만 저장할 수 있습니다.");

  const protectedOwners = new Map<string, string>();
  const aliasOwners = new Map<string, string>();
  for (const term of terms) {
    for (const label of [term.term, term.english]) {
      const key = normalizedKey(label);
      if (key) protectedOwners.set(key, term.id);
    }
  }
  for (const term of terms) {
    for (const alias of term.spokenAliases) {
      const key = normalizedKey(alias);
      const protectedOwner = protectedOwners.get(key);
      const aliasOwner = aliasOwners.get(key);
      if ((protectedOwner && protectedOwner !== term.id) || (aliasOwner && aliasOwner !== term.id)) {
        fail("invalid", "서로 다른 전문용어가 같은 발음 별칭을 사용할 수 없습니다.");
      }
      aliasOwners.set(key, term.id);
    }
  }
  return terms;
}

function validatePhraseSet(value: unknown, terms: GlossaryTerm[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_RAW_ITEMS) {
    fail("invalid", "저장된 PhraseSet 형식이 올바르지 않습니다.");
  }

  const allowed = new Map<string, string>();
  for (const term of terms) {
    allowed.set(normalizedKey(term.term), term.term);
    if (term.english) allowed.set(normalizedKey(term.english), term.english);
    for (const alias of term.spokenAliases) allowed.set(normalizedKey(alias), alias);
  }

  const phraseSet: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const phrase = validatedString(candidate, "PhraseSet 표기", 2, 120);
    const key = normalizedKey(phrase);
    const canonical = allowed.get(key);
    if (!canonical) fail("invalid", "PhraseSet에 전문용어와 일치하지 않는 표기가 있습니다.");
    if (seen.has(key)) continue;
    seen.add(key);
    phraseSet.push(canonical);
    if (phraseSet.length > MAX_PHRASES) fail("invalid", "저장 가능한 PhraseSet 표기는 최대 50개입니다.");
  }
  return phraseSet;
}

function validateStoredGlossary(value: unknown, legacy = false): StoredGlossary {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "name", "createdAt", "updatedAt", "terms", "phraseSet"])) {
    fail("invalid", "저장된 용어집 형식이 올바르지 않습니다.");
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0 || value.id.length > 160) {
    fail("invalid", "저장된 용어집 ID가 올바르지 않습니다.");
  }

  const terms = validateTerms(value.terms, legacy);
  const createdAt = validatedTimestamp(value.createdAt, "생성 시각");
  const updatedAt = validatedTimestamp(value.updatedAt, "수정 시각");
  if (updatedAt < createdAt) fail("invalid", "용어집 수정 시각이 생성 시각보다 빠릅니다.");

  return {
    id: value.id,
    name: validatedString(value.name, "용어집 이름", 1, 160),
    createdAt,
    updatedAt,
    terms,
    phraseSet: validatePhraseSet(value.phraseSet, terms)
  };
}

function collectGlossaries(value: unknown[], legacy = false): StoredGlossary[] {
  const byId = new Map<string, StoredGlossary>();
  for (const candidate of value) {
    const glossary = validateStoredGlossary(candidate, legacy);
    const existing = byId.get(glossary.id);
    if (!existing || glossary.updatedAt > existing.updatedAt) byId.set(glossary.id, glossary);
  }
  if (byId.size > MAX_GLOSSARIES) fail("limit", "이 브라우저에는 용어집을 최대 50개까지 저장할 수 있습니다. 기존 용어집을 삭제한 뒤 다시 시도해 주세요.");
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function validateStore(value: unknown): GlossaryStoreV2 {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "glossaries"])) {
    fail("invalid", "저장된 용어집 데이터가 손상되었습니다.");
  }
  if (value.version !== GLOSSARY_STORAGE_VERSION) {
    fail("version", "저장된 용어집 버전이 현재 앱과 호환되지 않습니다.");
  }
  if (!Array.isArray(value.glossaries) || value.glossaries.length > MAX_RAW_ITEMS) {
    fail("invalid", "저장된 용어집 목록이 올바르지 않습니다.");
  }

  return {
    version: GLOSSARY_STORAGE_VERSION,
    glossaries: collectGlossaries(value.glossaries)
  };
}

function migrateStoreV1(value: unknown): GlossaryStoreV2 {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "glossaries"]) || value.version !== 1) {
    fail("version", "저장된 용어집 버전이 현재 앱과 호환되지 않습니다.");
  }
  if (!Array.isArray(value.glossaries) || value.glossaries.length > MAX_RAW_ITEMS) {
    fail("invalid", "저장된 용어집 목록이 올바르지 않습니다.");
  }
  return { version: GLOSSARY_STORAGE_VERSION, glossaries: collectGlossaries(value.glossaries, true) };
}

function isQuotaError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22 || error.code === 1014;
}

function readStore(storage: GlossaryStorageAdapter): GlossaryStoreV2 {
  let raw: string | null;
  try {
    raw = storage.getItem(GLOSSARY_STORAGE_KEY);
  } catch {
    fail("unavailable", "브라우저 저장소를 사용할 수 없습니다. 사이트 저장소 설정을 확인해 주세요.");
  }
  if (raw === null) return { version: GLOSSARY_STORAGE_VERSION, glossaries: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid", "저장된 용어집 데이터가 손상되어 불러오지 못했습니다.");
  }
  if (isRecord(parsed) && parsed.version === 1) {
    const migrated = migrateStoreV1(parsed);
    try {
      storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify(migrated));
    } catch {
      // In-memory migration still keeps existing glossaries loadable when storage is read-only or full.
    }
    return migrated;
  }
  return validateStore(parsed);
}

function writeStore(storage: GlossaryStorageAdapter, glossaries: StoredGlossary[]): void {
  const store = validateStore({ version: GLOSSARY_STORAGE_VERSION, glossaries });
  try {
    storage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    if (isQuotaError(error)) {
      fail("quota", "브라우저 저장 공간이 부족합니다. 저장된 용어집을 삭제한 뒤 다시 시도해 주세요.");
    }
    fail("unavailable", "브라우저 저장소에 용어집을 저장할 수 없습니다. 사이트 저장소 설정을 확인해 주세요.");
  }
}

function createGlossaryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `glossary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function glossaryContentFingerprint(glossary: StoredGlossary): string {
  const terms = glossary.terms
    .map((term) => JSON.stringify([
      term.id,
      term.term,
      term.english,
      term.spokenAliases.map(normalizedKey).sort(),
      term.easyExplanation,
      term.pageNumber,
      term.occurrences,
      term.source
    ]))
    .sort();
  const phrases = glossary.phraseSet.map(normalizedKey).sort();
  return JSON.stringify([glossary.name, terms, phrases]);
}

function hasSameGlossaryContent(left: StoredGlossary, right: StoredGlossary): boolean {
  return glossaryContentFingerprint(left) === glossaryContentFingerprint(right);
}

export function listStoredGlossaries(storage: GlossaryStorageAdapter): StoredGlossary[] {
  return readStore(storage).glossaries;
}

export function saveAnalyzedGlossary(
  storage: GlossaryStorageAdapter,
  analysis: Pick<AnalysisResult, "terms" | "phraseSet">,
  name: string,
  options: { id?: string; now?: string } = {}
): StoredGlossary {
  const now = options.now ?? new Date().toISOString();
  const proposed = validateStoredGlossary({
    id: options.id ?? createGlossaryId(),
    name,
    createdAt: now,
    updatedAt: now,
    terms: analysis.terms,
    phraseSet: analysis.phraseSet
  });
  const stored = readStore(storage).glossaries;
  const previous = stored.find((candidate) => candidate.id === proposed.id)
    ?? (options.id === undefined ? stored.find((candidate) => hasSameGlossaryContent(candidate, proposed)) : undefined);
  const glossary = previous
    ? validateStoredGlossary({
        ...proposed,
        id: previous.id,
        createdAt: previous.createdAt,
        updatedAt: now >= previous.createdAt ? now : previous.updatedAt
      })
    : proposed;
  const existing = stored.filter((candidate) => candidate.id !== glossary.id);
  writeStore(storage, [glossary, ...existing]);
  return glossary;
}

export function renameStoredGlossary(
  storage: GlossaryStorageAdapter,
  id: string,
  name: string,
  now = new Date().toISOString()
): StoredGlossary {
  const glossaries = readStore(storage).glossaries;
  const current = glossaries.find((candidate) => candidate.id === id);
  if (!current) fail("not-found", "선택한 용어집을 찾을 수 없습니다.");
  const renamed = validateStoredGlossary({ ...current, name, updatedAt: now });
  writeStore(storage, glossaries.map((candidate) => (candidate.id === id ? renamed : candidate)));
  return renamed;
}

export function deleteStoredGlossary(storage: GlossaryStorageAdapter, id: string): void {
  const glossaries = readStore(storage).glossaries;
  writeStore(storage, glossaries.filter((candidate) => candidate.id !== id));
}

export function clearStoredGlossaries(storage: GlossaryStorageAdapter): void {
  try {
    storage.removeItem(GLOSSARY_STORAGE_KEY);
  } catch {
    fail("unavailable", "브라우저 저장 데이터를 초기화할 수 없습니다. 사이트 저장소 설정을 확인해 주세요.");
  }
}

export function loadStoredGlossaryForLecture(storage: GlossaryStorageAdapter, id: string): AnalysisResult {
  const glossary = readStore(storage).glossaries.find((candidate) => candidate.id === id);
  if (!glossary) fail("not-found", "선택한 용어집을 찾을 수 없습니다.");
  return {
    title: glossary.name,
    pages: [],
    terms: glossary.terms,
    phraseSet: glossary.phraseSet,
    mode: "saved"
  };
}

export function glossaryStorageErrorMessage(error: unknown): string {
  return error instanceof GlossaryStorageError ? error.message : "브라우저 용어집을 처리하지 못했습니다.";
}

export function glossaryStorageIssue(error: unknown): GlossaryStorageIssue {
  return error instanceof GlossaryStorageError
    ? { code: error.code, message: error.message }
    : { code: "unavailable", message: "브라우저 용어집을 처리하지 못했습니다." };
}

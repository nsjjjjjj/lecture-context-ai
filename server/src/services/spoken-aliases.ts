import type { GlossaryTerm } from "../types.js";

export const MAX_SPOKEN_ALIASES = 6;
export const MAX_SPOKEN_ALIAS_LENGTH = 40;
const MAX_INSPECTED_ALIASES = 24;

const UNSAFE_ALIASES = new Set([
  "강연",
  "검색",
  "결과",
  "경우",
  "관련",
  "그래서",
  "기능",
  "다시",
  "다음",
  "데이터",
  "모델",
  "문서",
  "방식",
  "사과",
  "생성",
  "서비스",
  "사용자",
  "설명",
  "그리고",
  "이것",
  "입니다",
  "인식",
  "오늘",
  "외부",
  "이유",
  "이미",
  "이번",
  "자료",
  "정도",
  "자막",
  "저것",
  "하지만",
  "답변",
  "용어",
  "우리",
  "페이지",
  "현재"
]);

const KNOWN_ALIAS_GROUPS: Array<{ labels: string[]; aliases: string[] }> = [
  { labels: ["RAG", "Retrieval-Augmented Generation"], aliases: ["래그", "레그", "알에이지"] },
  { labels: ["LLM", "Large Language Model"], aliases: ["엘엘엠"] },
  { labels: ["AI", "Artificial Intelligence"], aliases: ["에이아이"] },
  { labels: ["API", "Application Programming Interface"], aliases: ["에이피아이"] },
  { labels: ["Transformer"], aliases: ["트랜스포머"] },
  { labels: ["Attention"], aliases: ["어텐션"] },
  { labels: ["Prompt"], aliases: ["프롬프트"] },
  { labels: ["Token"], aliases: ["토큰"] },
  { labels: ["Vector Database"], aliases: ["벡터 데이터베이스"] },
  { labels: ["Embedding"], aliases: ["임베딩"] },
  { labels: ["Pipeline"], aliases: ["파이프라인"] },
  { labels: ["Fine-tuning", "파인튜닝"], aliases: ["파인튜닝", "파인 튜닝"] },
  { labels: ["Prompt Engineering"], aliases: ["프롬프트 엔지니어링"] },
  { labels: ["Latency"], aliases: ["레이턴시"] },
  { labels: ["Hallucination"], aliases: ["할루시네이션"] },
  { labels: ["Guardrail"], aliases: ["가드레일"] },
  { labels: ["PhraseSet"], aliases: ["프레이즈셋", "프레이즈 세트", "프레이저스 셋"] },
  { labels: ["LangChain"], aliases: ["랭체인", "랑체인"] },
  { labels: ["PDF.js"], aliases: ["피디에프 제이에스"] },
  { labels: ["WebSocket"], aliases: ["웹소켓"] }
];

export function canonicalizeSpokenForm(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function spokenFormKey(value: string): string {
  return canonicalizeSpokenForm(value).toLocaleLowerCase("ko-KR");
}

function hasAsciiSource(term: string, english: string): boolean {
  return /[A-Za-z]/u.test(term) || /[A-Za-z]/u.test(english);
}

export function knownSpokenAliases(term: string, english: string): string[] {
  const labels = new Set([spokenFormKey(term), spokenFormKey(english)].filter(Boolean));
  return KNOWN_ALIAS_GROUPS
    .filter((group) => group.labels.some((label) => labels.has(spokenFormKey(label))))
    .flatMap((group) => group.aliases);
}

export function isContextAmbiguousSpokenAlias(alias: string): boolean {
  return spokenFormKey(alias) === spokenFormKey("레그");
}

export function sanitizeSpokenAliases(term: string, english: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (!hasAsciiSource(term, english)) return [];

  const protectedKeys = new Set([spokenFormKey(term), spokenFormKey(english)].filter(Boolean));
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, MAX_INSPECTED_ALIASES)) {
    if (typeof candidate !== "string" || candidate.length > MAX_SPOKEN_ALIAS_LENGTH * 2) continue;
    const alias = canonicalizeSpokenForm(candidate);
    const key = spokenFormKey(alias);
    const hangulCount = [...alias].filter((character) => /[가-힣]/u.test(character)).length;
    if (
      alias.length < 2 ||
      alias.length > MAX_SPOKEN_ALIAS_LENGTH ||
      !/^[가-힣]+(?:[ -][가-힣]+)*$/u.test(alias) ||
      hangulCount < 2 ||
      protectedKeys.has(key) ||
      UNSAFE_ALIASES.has(key) ||
      seen.has(key)
    ) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length === MAX_SPOKEN_ALIASES) break;
  }
  return aliases;
}

export function withSanitizedSpokenAliases<T extends GlossaryTerm>(terms: T[]): T[] {
  const sanitized = terms.map((term) => ({
    ...term,
    spokenAliases: sanitizeSpokenAliases(term.term, term.english, term.spokenAliases)
  }));
  const protectedOwners = new Map<string, string>();
  const aliasOwners = new Map<string, Set<string>>();

  for (const term of sanitized) {
    for (const label of [term.term, term.english]) {
      const key = spokenFormKey(label);
      if (key) protectedOwners.set(key, term.id);
    }
    for (const alias of term.spokenAliases) {
      const key = spokenFormKey(alias);
      const owners = aliasOwners.get(key) ?? new Set<string>();
      owners.add(term.id);
      aliasOwners.set(key, owners);
    }
  }

  return sanitized.map((term) => ({
    ...term,
    spokenAliases: term.spokenAliases.filter((alias) => {
      const key = spokenFormKey(alias);
      const protectedOwner = protectedOwners.get(key);
      return aliasOwners.get(key)?.size === 1 && (!protectedOwner || protectedOwner === term.id);
    })
  }));
}

export function withValidatedSpokenAliases<T extends GlossaryTerm>(terms: T[]): T[] {
  return withSanitizedSpokenAliases(terms.map((term) => ({
    ...term,
    spokenAliases: [...term.spokenAliases, ...knownSpokenAliases(term.term, term.english)]
  })));
}

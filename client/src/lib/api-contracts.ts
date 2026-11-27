import type {
  AnalysisResult,
  GlossaryTerm,
  PageText,
  PreparedAwsVocabulary,
  ServiceConfigurationStatus,
  ServiceStatus
} from "../types";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}

function parsePage(value: unknown): PageText | null {
  const candidate = record(value);
  if (!candidate || !finiteInteger(candidate.pageNumber, 1) || typeof candidate.text !== "string" || candidate.text.length > 80_000) {
    return null;
  }
  return { pageNumber: candidate.pageNumber, text: candidate.text };
}

function parseTerm(value: unknown): GlossaryTerm | null {
  const candidate = record(value);
  if (
    !candidate
    || !boundedString(candidate.id, 1, 160)
    || !boundedString(candidate.term, 2, 80)
    || typeof candidate.english !== "string"
    || candidate.english.length > 120
    || !Array.isArray(candidate.spokenAliases)
    || candidate.spokenAliases.length > 6
    || candidate.spokenAliases.some((alias) => !boundedString(alias, 2, 40))
    || !boundedString(candidate.easyExplanation, 2, 240)
    || !finiteInteger(candidate.pageNumber, 1)
    || !finiteInteger(candidate.occurrences, 0)
    || !["gemini", "heuristic", "demo"].includes(String(candidate.source))
  ) {
    return null;
  }
  return {
    id: candidate.id,
    term: candidate.term,
    english: candidate.english,
    spokenAliases: [...candidate.spokenAliases] as string[],
    easyExplanation: candidate.easyExplanation,
    pageNumber: candidate.pageNumber,
    occurrences: candidate.occurrences,
    source: candidate.source as GlossaryTerm["source"]
  };
}

function parseServiceConfigurationStatus(value: unknown): ServiceConfigurationStatus | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.configured !== "boolean"
    || !["unverified", "verified", "failed"].includes(String(candidate.verification))
  ) {
    return null;
  }
  return {
    configured: candidate.configured,
    verification: candidate.verification as ServiceConfigurationStatus["verification"]
  };
}

export function parseAnalysisResponse(value: unknown, pagesOverride?: PageText[]): AnalysisResult {
  const candidate = record(value);
  if (!candidate || !boundedString(candidate.title, 1, 160)) {
    throw new Error("서버의 분석 결과 형식이 올바르지 않습니다.");
  }
  const rawPages = pagesOverride ?? candidate.pages;
  const pages = Array.isArray(rawPages) ? rawPages.map(parsePage) : [];
  const terms = Array.isArray(candidate.terms) ? candidate.terms.map(parseTerm) : [];
  const phraseSet = Array.isArray(candidate.phraseSet) ? candidate.phraseSet : [];
  if (
    !Array.isArray(rawPages)
    || !Array.isArray(candidate.terms)
    || !Array.isArray(candidate.phraseSet)
    || pages.some((page) => page === null)
    || terms.length > 50
    || terms.some((term) => term === null)
    || phraseSet.length > 400
    || phraseSet.some((phrase) => !boundedString(phrase, 2, 120))
    || !["gemini", "heuristic", "demo"].includes(String(candidate.mode))
    || (candidate.warning !== undefined && typeof candidate.warning !== "string")
  ) {
    throw new Error("서버의 분석 결과 형식이 올바르지 않습니다.");
  }
  return {
    title: candidate.title,
    pages: pages as PageText[],
    terms: terms as GlossaryTerm[],
    phraseSet: [...phraseSet] as string[],
    mode: candidate.mode as AnalysisResult["mode"],
    ...(candidate.warning ? { warning: candidate.warning } : {})
  };
}

export function parseServiceStatusResponse(value: unknown): ServiceStatus {
  const candidate = record(value);
  const services = record(candidate?.services);
  const speech = parseServiceConfigurationStatus(services?.speech);
  const rawCustomVocabulary = services?.customVocabulary;
  const customVocabulary = rawCustomVocabulary === undefined
    ? undefined
    : parseServiceConfigurationStatus(rawCustomVocabulary);
  if (
    !candidate
    || typeof candidate.ok !== "boolean"
    || !services
    || !speech
    || typeof services.gemini !== "boolean"
    || customVocabulary === null
    || (candidate.sttProvider !== undefined && candidate.sttProvider !== "aws" && candidate.sttProvider !== "google")
  ) {
    throw new Error("서버 상태 응답 형식이 올바르지 않습니다.");
  }
  return {
    ok: candidate.ok,
    ...(candidate.sttProvider ? { sttProvider: candidate.sttProvider } : {}),
    services: {
      speech,
      gemini: services.gemini,
      ...(customVocabulary === undefined ? {} : { customVocabulary })
    }
  };
}

export function parsePreparedVocabularyResponse(value: unknown): PreparedAwsVocabulary {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.vocabularyName !== "string"
    || !/^lecture-ko-[a-f0-9]{16}$/u.test(candidate.vocabularyName)
    || typeof candidate.hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(candidate.hash)
    || typeof candidate.reused !== "boolean"
  ) {
    throw new Error("서버의 AWS 용어집 응답 형식이 올바르지 않습니다.");
  }
  return {
    vocabularyName: candidate.vocabularyName,
    hash: candidate.hash,
    reused: candidate.reused
  };
}

import { createHash } from "node:crypto";
import type { AnalysisResult, GlossaryTerm, PageText } from "../types.js";
import { findTranscriptTermMatches } from "./caption.js";
import { MAX_GLOSSARY_TERMS, MAX_PHRASE_SET_FORMS } from "./phrase-set-limits.js";
import { withSanitizedSpokenAliases, withValidatedSpokenAliases } from "./spoken-aliases.js";

const MAX_GEMINI_CHARACTERS = 120_000;
const DEFAULT_GEMINI_TIMEOUT_MS = 30_000;
const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";
const DEFAULT_GEMINI_THINKING_LEVEL = "low";
const MAX_INSPECTED_GLOSSARY_CANDIDATES = 250;
const PAGE_OMISSION_MARKER = "\n…[페이지 가운데 일부 생략]…\n";

type GeminiThinkingLevel = "low" | "medium" | "high";

function resolveGeminiThinkingLevel(value: string | undefined): GeminiThinkingLevel {
  if (value === "medium" || value === "high") return value;
  return DEFAULT_GEMINI_THINKING_LEVEL;
}

const GEMINI_PROMPT_PREFIX = `다음은 한국어 강연 PDF에서 추출한 페이지별 텍스트다.
실시간 음성인식에 힌트로 줄 가치가 있는 전문용어, 약어, 제품명, 인명, 고유명사만 20~50개 추출하라.

규칙:
- term은 반드시 제공된 PDF에 그대로 존재하는 표기를 복사한다.
- 일상적인 단어와 너무 긴 문장은 제외한다.
- easyExplanation은 비전공자가 이해할 수 있는 60자 이내의 한국어 명사구로 작성한다.
- 반드시 '~하는 기술', '~하는 방식', '~을 위한 모델', '~하는 과정', '~인 현상'처럼 명사로 끝낸다.
- '이다', '입니다', '한다', '합니다' 같은 서술형 종결과 문장 끝 마침표를 사용하지 않는다.
- english는 PDF에 명시된 경우에만 넣고, 없으면 빈 문자열로 둔다.
- term 또는 english에 영문 알파벳이 하나라도 있으면 spokenAliases에 한국인이 실제로 읽을 때 STT가 만들 수 있는 한글 발음을 반드시 1개 이상, 최대 3개 넣는다. 예: BERT는 ["버트"], ResNet은 ["레즈넷"], RAG는 ["래그", "레그", "알에이지"].
- spokenAliases는 완성형 한글과 단어 사이 공백 또는 하이픈만 사용한다. 일반 단어, 번역어, 설명 문구는 넣지 않는다. 영문 알파벳이 전혀 없는 용어는 빈 배열로 둔다.
- 같은 용어의 중복은 제거한다.

PDF 텍스트:
`;

export type GeminiPromptBuildResult = {
  prompt: string;
  wasTruncated: boolean;
  truncatedPageNumbers: number[];
};

const DOMAIN_HINTS: Array<[string, string, string]> = [
  ["RAG", "Retrieval-Augmented Generation", "외부 자료를 검색한 뒤 답변을 만드는 AI 방식"],
  ["LLM", "Large Language Model", "많은 텍스트를 학습해 언어를 처리하는 대규모 모델"],
  ["AI", "Artificial Intelligence", "사람의 지능적 작업을 컴퓨터로 수행하는 기술"],
  ["Transformer", "Transformer", "문장 안의 관계를 효율적으로 학습하는 신경망 구조"],
  ["LangChain", "LangChain", "언어 모델 기반 애플리케이션 개발을 돕는 도구"],
  ["파인튜닝", "Fine-tuning", "기존 모델을 특정 목적의 데이터로 추가 학습하는 방법"],
  ["임베딩", "Embedding", "텍스트의 의미를 숫자 벡터로 나타낸 값"],
  ["벡터 데이터베이스", "Vector database", "의미가 비슷한 데이터를 빠르게 찾는 저장소"],
  ["생성형 AI", "Generative AI", "새로운 글·이미지·음성 등을 생성하는 인공지능"],
  ["환각", "Hallucination", "AI가 사실과 다른 내용을 그럴듯하게 만드는 현상"]
];

type GeminiTerm = {
  term?: unknown;
  english?: unknown;
  spokenAliases?: unknown;
  easyExplanation?: unknown;
};

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}

type DocumentTermLocation = { pageNumber: number; occurrences: number };

type DocumentIndex = {
  originalText: string;
  supportsKoreanHeuristic: boolean;
  locate: (term: string) => DocumentTermLocation | null;
};

function isAsciiWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/u.test(value);
}

function countIndexedOccurrences(normalizedText: string, normalizedTerm: string): number {
  if (!normalizedTerm) return 0;
  const needsLeftBoundary = isAsciiWordCharacter(normalizedTerm[0]);
  const needsRightBoundary = isAsciiWordCharacter(normalizedTerm[normalizedTerm.length - 1]);
  let count = 0;
  let offset = 0;

  while (offset <= normalizedText.length - normalizedTerm.length) {
    const matchAt = normalizedText.indexOf(normalizedTerm, offset);
    if (matchAt < 0) break;
    const before = matchAt > 0 ? normalizedText[matchAt - 1] : undefined;
    const after = normalizedText[matchAt + normalizedTerm.length];
    if ((!needsLeftBoundary || !isAsciiWordCharacter(before)) &&
        (!needsRightBoundary || !isAsciiWordCharacter(after))) {
      count += 1;
    }
    offset = matchAt + Math.max(1, normalizedTerm.length);
  }
  return count;
}

function createDocumentIndex(pages: PageText[]): DocumentIndex {
  const originalText = pages.map((page) => page.text).join("\n");
  const koreanSyllableCount = originalText.match(/[가-힣]/gu)?.length ?? 0;
  const indexedPages = pages.map((page) => ({ pageNumber: page.pageNumber, normalizedText: normalize(page.text) }));
  const locations = new Map<string, DocumentTermLocation | null>();

  return {
    originalText,
    supportsKoreanHeuristic: koreanSyllableCount >= 4 && /[가-힣]{2,}/u.test(originalText),
    locate(term) {
      const normalizedTerm = normalize(term);
      if (!normalizedTerm) return null;
      if (locations.has(normalizedTerm)) return locations.get(normalizedTerm) ?? null;

      let pageNumber = 0;
      let occurrences = 0;
      for (const page of indexedPages) {
        const pageCount = countIndexedOccurrences(page.normalizedText, normalizedTerm);
        if (pageCount > 0 && pageNumber === 0) pageNumber = page.pageNumber;
        occurrences += pageCount;
      }
      const location = pageNumber > 0 ? { pageNumber, occurrences } : null;
      locations.set(normalizedTerm, location);
      return location;
    }
  };
}

function idFor(term: string): string {
  return createHash("sha1").update(normalize(term)).digest("hex").slice(0, 12);
}

function isUsefulTerm(term: string): boolean {
  const cleaned = term.trim();
  if (cleaned.length < 2 || cleaned.length > 80) return false;
  if (/^[\d\s.,%+-]+$/.test(cleaned)) return false;
  if (/^(그리고|하지만|때문에|이번에는|서비스|사용자|페이지|강연|자료)$/i.test(cleaned)) return false;
  return true;
}

function nounPhraseExplanation(term: string, value: unknown): string {
  const fallback = `${term}와 관련된 강연 핵심 개념`;
  if (typeof value !== "string") return fallback;

  const explanation = value.trim().slice(0, 240).replace(/[.!?。！？]+$/u, "").trim();
  if (explanation.length < 2) return fallback;

  const withoutCopula = explanation.replace(/(?:입니다|이다)$/u, "").trim();
  return withoutCopula.length >= 2 ? withoutCopula : fallback;
}

function validateCandidates(
  document: DocumentIndex,
  candidates: GeminiTerm[],
  source: GlossaryTerm["source"]
): GlossaryTerm[] {
  const seen = new Set<string>();
  const terms: GlossaryTerm[] = [];

  for (const candidate of candidates.slice(0, MAX_INSPECTED_GLOSSARY_CANDIDATES)) {
    if (typeof candidate.term !== "string" || !isUsefulTerm(candidate.term)) continue;
    const term = candidate.term.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!isUsefulTerm(term)) continue;
    const key = normalize(term);
    if (seen.has(key)) continue;

    const location = document.locate(term);
    if (!location) continue;

    const proposedEnglish = typeof candidate.english === "string"
      ? candidate.english.normalize("NFKC").replace(/\s+/g, " ").trim()
      : "";
    const english = proposedEnglish.length <= 120 && /[A-Za-z]/u.test(proposedEnglish) && document.locate(proposedEnglish)
      ? proposedEnglish
      : "";
    const explanation = nounPhraseExplanation(term, candidate.easyExplanation);

    seen.add(key);
    terms.push({
      id: idFor(term),
      term,
      english,
      spokenAliases: Array.isArray(candidate.spokenAliases)
        ? candidate.spokenAliases.slice(0, 24).filter((value): value is string => typeof value === "string")
        : [],
      easyExplanation: explanation,
      pageNumber: location.pageNumber,
      occurrences: location.occurrences,
      source
    });
  }

  return withValidatedSpokenAliases(
    terms.sort((a, b) => {
      const acronymA = /^[A-Z][A-Z0-9-]{1,12}$/.test(a.term) ? 1 : 0;
      const acronymB = /^[A-Z][A-Z0-9-]{1,12}$/.test(b.term) ? 1 : 0;
      return acronymB - acronymA || b.occurrences - a.occurrences || a.pageNumber - b.pageNumber;
    })
      .slice(0, MAX_GLOSSARY_TERMS)
  );
}

function mergeValidatedTerms(primary: GlossaryTerm[], supplements: GlossaryTerm[]): GlossaryTerm[] {
  const seen = new Set<string>();
  const merged = [...primary, ...supplements].filter((term) => {
    const key = normalize(term.term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return withValidatedSpokenAliases(merged).slice(0, MAX_GLOSSARY_TERMS);
}

function extractHeuristicCandidates(document: DocumentIndex): GeminiTerm[] {
  // The known-term and acronym rules below were designed for Korean lecture
  // prose. On another language they would turn arbitrary capitalized words
  // into confident-looking glossary entries, so fail closed instead.
  if (!document.supportsKoreanHeuristic) return [];
  const fullText = document.originalText;
  const candidates: GeminiTerm[] = [];
  const seen = new Set<string>();
  const add = (candidate: GeminiTerm): void => {
    if (typeof candidate.term !== "string") return;
    const key = normalize(candidate.term);
    if (!key || seen.has(key) || candidates.length >= MAX_INSPECTED_GLOSSARY_CANDIDATES) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const [term, english, easyExplanation] of DOMAIN_HINTS) {
    if (document.locate(term)) add({ term, english, easyExplanation });
  }

  const acronyms = fullText.match(/\b[A-Z][A-Z0-9-]{1,11}\b/g) ?? [];
  for (const term of acronyms) {
    add({ term, english: "", easyExplanation: `${term}와 관련된 강연 전문용어` });
  }

  const namedTerms = fullText.match(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+\b/g) ?? [];
  for (const term of namedTerms) {
    add({ term, english: term, easyExplanation: `${term}와 관련된 강연 전문용어` });
  }

  // Recover conservative Korean compound nouns when Gemini is unavailable.
  // The suffix allowlist intentionally excludes generic verbs and short nouns;
  // a candidate must be a contiguous compound that appears verbatim in the PDF.
  const koreanTechnicalCompounds = fullText.matchAll(
    /([가-힣]{2,24}(?:학습|생성|모델|검색|인식|분석|처리|최적화|알고리즘|시스템|네트워크|데이터|지능|표현|벡터|토큰|파이프라인|아키텍처))(?=(?:입니다|이다|이며|이고|에는|에서|으로|처럼|보다|은|는|이|가|을|를|과|와|의|에|도|만)?(?:[^가-힣]|$))/gu
  );
  for (const match of koreanTechnicalCompounds) {
    const term = match[1];
    if (term) add({ term, english: "", easyExplanation: `${term}와 관련된 강연 전문용어` });
  }

  return candidates;
}

function allocateBalancedPageBudgets(lengths: number[], totalBudget: number): number[] {
  const budgets = lengths.map(() => 0);
  let remainingBudget = Math.max(0, totalBudget);
  let remainingIndexes = lengths
    .map((length, index) => ({ length, index }))
    .filter(({ length }) => length > 0);

  while (remainingIndexes.length > 0) {
    const fairShare = Math.floor(remainingBudget / remainingIndexes.length);
    const fitting = remainingIndexes.filter(({ length }) => length <= fairShare);

    if (fitting.length === 0) {
      const remainder = remainingBudget - fairShare * remainingIndexes.length;
      remainingIndexes.forEach(({ index }, position) => {
        budgets[index] = fairShare + (position < remainder ? 1 : 0);
      });
      break;
    }

    const fittingIndexes = new Set(fitting.map(({ index }) => index));
    for (const { length, index } of fitting) {
      budgets[index] = length;
      remainingBudget -= length;
    }
    remainingIndexes = remainingIndexes.filter(({ index }) => !fittingIndexes.has(index));
  }

  return budgets;
}

function abbreviatePageText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  if (budget <= PAGE_OMISSION_MARKER.length + 2) {
    const headLength = Math.ceil(budget / 2);
    return `${text.slice(0, headLength)}${text.slice(text.length - (budget - headLength))}`;
  }

  const visibleBudget = budget - PAGE_OMISSION_MARKER.length;
  const headLength = Math.ceil(visibleBudget / 2);
  const tailLength = visibleBudget - headLength;
  return `${text.slice(0, headLength)}${PAGE_OMISSION_MARKER}${text.slice(text.length - tailLength)}`;
}

/**
 * Builds one bounded Gemini request while keeping every page represented.
 * Short pages are included in full; the remaining budget is shared equally,
 * and oversized pages retain both their beginning and end.
 */
export function buildGeminiPrompt(pages: PageText[]): GeminiPromptBuildResult {
  const headers = pages.map((page) => `[PDF ${page.pageNumber}페이지]\n`);
  const separatorCharacters = Math.max(0, pages.length - 1);
  const fixedCharacters = GEMINI_PROMPT_PREFIX.length +
    headers.reduce((sum, header) => sum + header.length, 0) +
    separatorCharacters;
  const textBudget = Math.max(0, MAX_GEMINI_CHARACTERS - fixedCharacters);
  const pageBudgets = allocateBalancedPageBudgets(pages.map((page) => page.text.length), textBudget);
  const truncatedPageNumbers: number[] = [];

  const documentText = pages.map((page, index) => {
    if (page.text.length > pageBudgets[index]) truncatedPageNumbers.push(page.pageNumber);
    return `${headers[index]}${abbreviatePageText(page.text, pageBudgets[index])}`;
  }).join("\n");
  const prompt = `${GEMINI_PROMPT_PREFIX}${documentText}`;

  return {
    prompt,
    wasTruncated: truncatedPageNumbers.length > 0,
    truncatedPageNumbers
  };
}

export class GlossaryAnalysisCancelledError extends Error {
  constructor() {
    super("PDF 분석 요청이 취소되었습니다.");
    this.name = "GlossaryAnalysisCancelledError";
  }
}

class GeminiTimeoutError extends Error {
  constructor() {
    super("Gemini 분석 시간이 초과되었습니다.");
    this.name = "TimeoutError";
  }
}

async function extractWithGemini(prompt: string, callerSignal?: AbortSignal): Promise<GeminiTerm[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
  if (callerSignal?.aborted) throw new GlossaryAnalysisCancelledError();

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const thinkingLevel = resolveGeminiThinkingLevel(process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase());
  const configuredTimeoutMs = Number(process.env.GEMINI_TIMEOUT_MS);
  const timeoutMs = Number.isSafeInteger(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.min(configuredTimeoutMs, 120_000)
    : DEFAULT_GEMINI_TIMEOUT_MS;

  const requestController = new AbortController();
  let timedOut = false;
  const cancelFromCaller = (): void => requestController.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", cancelFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort(new GeminiTimeoutError());
  }, timeoutMs);
  timeout.unref();

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        signal: requestController.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            thinkingConfig: { thinkingLevel },
            maxOutputTokens: 8_192,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                terms: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      term: { type: "STRING" },
                      english: { type: "STRING" },
                      spokenAliases: { type: "ARRAY", items: { type: "STRING" } },
                      easyExplanation: { type: "STRING" }
                    },
                    required: ["term", "english", "spokenAliases", "easyExplanation"]
                  }
                }
              },
              required: ["terms"]
            }
          }
        })
      }
    );

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gemini 요청 실패 (${response.status}).`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    if (callerSignal?.aborted) throw new GlossaryAnalysisCancelledError();
    const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (!raw) throw new Error("Gemini가 용어 결과를 반환하지 않았습니다.");

    const parsed = JSON.parse(raw) as { terms?: GeminiTerm[] };
    return Array.isArray(parsed.terms) ? parsed.terms : [];
  } catch (error) {
    if (callerSignal?.aborted) throw new GlossaryAnalysisCancelledError();
    if (timedOut) throw new GeminiTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancelFromCaller);
  }
}

function buildPhraseSetFromIndex(terms: GlossaryTerm[], document: DocumentIndex): string[] {
  const phrases = new Map<string, string>();
  for (const term of withSanitizedSpokenAliases(terms).slice(0, MAX_GLOSSARY_TERMS)) {
    const hasCanonicalEvidence = Boolean(document.locate(term.term));
    const hasEnglishEvidence = Boolean(term.english && document.locate(term.english));
    if (!hasCanonicalEvidence && !hasEnglishEvidence) continue;
    if (hasCanonicalEvidence) phrases.set(normalize(term.term), term.term);
    for (const alias of term.spokenAliases) phrases.set(normalize(alias), alias);
    if (hasEnglishEvidence) phrases.set(normalize(term.english), term.english);
  }
  return [...phrases.values()].slice(0, MAX_PHRASE_SET_FORMS);
}

export function buildPhraseSet(terms: GlossaryTerm[], pages: PageText[]): string[] {
  return buildPhraseSetFromIndex(terms, createDocumentIndex(pages));
}

function publicGeminiFallbackReason(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "AI 분석 시간이 초과되었습니다.";
  }
  if (error instanceof Error && error.message === "GEMINI_API_KEY가 설정되지 않았습니다.") {
    return "AI 분석 설정이 없습니다.";
  }
  return "AI 분석 요청을 완료하지 못했습니다.";
}

function geminiCoverageWarning(result: GeminiPromptBuildResult): string | undefined {
  if (!result.wasTruncated) return undefined;
  const pages = result.truncatedPageNumbers.length <= 8
    ? result.truncatedPageNumbers.map((pageNumber) => `${pageNumber}페이지`).join(", ")
    : `${result.truncatedPageNumbers.length}개 페이지`;
  return `AI 입력 길이 제한으로 ${pages}의 가운데 일부를 줄여 전달했습니다. 반환 용어 검증에는 전체 추출 텍스트를 사용했습니다.`;
}

function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
  const message = warnings.filter((warning): warning is string => Boolean(warning)).join(" ");
  return message || undefined;
}

export async function analyzeGlossary(
  title: string,
  pages: PageText[],
  options: { signal?: AbortSignal } = {}
): Promise<AnalysisResult> {
  const totalCharacters = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (totalCharacters > 600_000) throw new Error("PDF 텍스트가 너무 큽니다. 60만 자 이하 자료를 사용해 주세요.");
  const document = createDocumentIndex(pages);
  const geminiPrompt = buildGeminiPrompt(pages);
  const coverageWarning = geminiCoverageWarning(geminiPrompt);

  try {
    const geminiCandidates = await extractWithGemini(geminiPrompt.prompt, options.signal);
    const geminiTerms = validateCandidates(document, geminiCandidates, "gemini");
    const shouldSupplementFromFullDocument = geminiPrompt.wasTruncated || geminiTerms.length < 3;
    if (!shouldSupplementFromFullDocument) {
      return {
        title,
        terms: geminiTerms,
        phraseSet: buildPhraseSetFromIndex(geminiTerms, document),
        mode: "gemini",
        ...(coverageWarning ? { warning: coverageWarning } : {})
      };
    }

    const heuristicTerms = validateCandidates(document, extractHeuristicCandidates(document), "heuristic");
    const terms = mergeValidatedTerms(geminiTerms, heuristicTerms);
    const supplementedTermCount = Math.max(0, terms.length - geminiTerms.length);
    return {
      title,
      terms,
      phraseSet: buildPhraseSetFromIndex(terms, document),
      mode: geminiTerms.length > 0 ? "gemini" : "heuristic",
      warning: combineWarnings(
        geminiTerms.length < 3
          ? document.supportsKoreanHeuristic
            ? `AI가 검증 가능한 전문용어를 ${geminiTerms.length}개만 반환해 한국어 문서 표기 기반 후보로 보완했습니다.`
            : `AI가 검증 가능한 전문용어를 ${geminiTerms.length}개만 반환했습니다. 자동 보완은 한국어 강연 자료에서만 지원합니다.`
          : undefined,
        coverageWarning,
        geminiPrompt.wasTruncated && document.supportsKoreanHeuristic
          ? `전체 문서에서 확인한 표기 기반 후보를 ${supplementedTermCount}개 추가했습니다.`
          : undefined
      )
    };
  } catch (error) {
    if (error instanceof GlossaryAnalysisCancelledError || options.signal?.aborted) {
      throw new GlossaryAnalysisCancelledError();
    }
    const terms = validateCandidates(document, extractHeuristicCandidates(document), "heuristic");
    return {
      title,
      terms,
      phraseSet: buildPhraseSetFromIndex(terms, document),
      mode: "heuristic",
      warning: combineWarnings(
        document.supportsKoreanHeuristic
          ? `AI 분석을 사용할 수 없어 한국어 문서 내 표기 기반으로 추출했습니다. ${publicGeminiFallbackReason(error)}`
          : `AI 분석을 사용할 수 없습니다. ${publicGeminiFallbackReason(error)} 자동 보완은 한국어 강연 자료에서만 지원하므로 용어를 임의 추출하지 않았습니다.`,
        coverageWarning
      )
    };
  }
}

export function matchTerms(text: string, terms: GlossaryTerm[]): GlossaryTerm[] {
  return findTranscriptTermMatches(text, terms).map((match) => match.term);
}

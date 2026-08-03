import { createHash } from "node:crypto";
import type { AnalysisResult, GlossaryTerm, PageText } from "../types.js";

const MAX_TERMS = 50;
const MAX_GEMINI_CHARACTERS = 120_000;

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
  easyExplanation?: unknown;
};

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}

function countOccurrences(text: string, term: string): number {
  const normalizedText = normalize(text);
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return 0;
  return normalizedText.split(normalizedTerm).length - 1;
}

function locateTerm(pages: PageText[], term: string): { pageNumber: number; occurrences: number } | null {
  let pageNumber = 0;
  let occurrences = 0;
  for (const page of pages) {
    const pageCount = countOccurrences(page.text, term);
    if (pageCount > 0 && pageNumber === 0) pageNumber = page.pageNumber;
    occurrences += pageCount;
  }
  return pageNumber > 0 ? { pageNumber, occurrences } : null;
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

function validateCandidates(
  pages: PageText[],
  candidates: GeminiTerm[],
  source: GlossaryTerm["source"]
): GlossaryTerm[] {
  const seen = new Set<string>();
  const terms: GlossaryTerm[] = [];

  for (const candidate of candidates) {
    if (typeof candidate.term !== "string" || !isUsefulTerm(candidate.term)) continue;
    const term = candidate.term.normalize("NFKC").replace(/\s+/g, " ").trim();
    const key = normalize(term);
    if (seen.has(key)) continue;

    const location = locateTerm(pages, term);
    if (!location) continue;

    const english = typeof candidate.english === "string" ? candidate.english.trim() : "";
    const explanation =
      typeof candidate.easyExplanation === "string" && candidate.easyExplanation.trim().length >= 2
        ? candidate.easyExplanation.trim().slice(0, 240)
        : `${term}에 관한 강연 핵심 용어입니다.`;

    seen.add(key);
    terms.push({
      id: idFor(term),
      term,
      english,
      easyExplanation: explanation,
      pageNumber: location.pageNumber,
      occurrences: location.occurrences,
      source
    });
  }

  return terms
    .sort((a, b) => {
      const acronymA = /^[A-Z][A-Z0-9-]{1,12}$/.test(a.term) ? 1 : 0;
      const acronymB = /^[A-Z][A-Z0-9-]{1,12}$/.test(b.term) ? 1 : 0;
      return acronymB - acronymA || b.occurrences - a.occurrences || a.pageNumber - b.pageNumber;
    })
    .slice(0, MAX_TERMS);
}

function extractHeuristicCandidates(pages: PageText[]): GeminiTerm[] {
  const fullText = pages.map((page) => page.text).join("\n");
  const candidates: GeminiTerm[] = [];

  for (const [term, english, easyExplanation] of DOMAIN_HINTS) {
    if (countOccurrences(fullText, term) > 0) candidates.push({ term, english, easyExplanation });
  }

  const acronyms = fullText.match(/\b[A-Z][A-Z0-9-]{1,11}\b/g) ?? [];
  for (const term of acronyms) {
    candidates.push({ term, english: "", easyExplanation: `${term}에 관한 강연 전문용어입니다.` });
  }

  const namedTerms = fullText.match(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+\b/g) ?? [];
  for (const term of namedTerms) {
    candidates.push({ term, english: term, easyExplanation: `${term}에 관한 강연 전문용어입니다.` });
  }

  return candidates;
}

async function extractWithGemini(pages: PageText[]): Promise<GeminiTerm[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const documentText = pages
    .map((page) => `\n[PDF ${page.pageNumber}페이지]\n${page.text}`)
    .join("\n")
    .slice(0, MAX_GEMINI_CHARACTERS);

  const prompt = `다음은 한국어 강연 PDF에서 추출한 페이지별 텍스트다.
실시간 음성인식에 힌트로 줄 가치가 있는 전문용어, 약어, 제품명, 인명, 고유명사만 20~50개 추출하라.

규칙:
- term은 반드시 제공된 PDF에 그대로 존재하는 표기를 복사한다.
- 일상적인 단어와 너무 긴 문장은 제외한다.
- easyExplanation은 비전공자가 이해할 수 있는 한국어 한 문장으로 60자 이내로 작성한다.
- english는 PDF에 명시된 경우에만 넣고, 없으면 빈 문자열로 둔다.
- 같은 용어의 중복은 제거한다.

PDF 텍스트:
${documentText}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
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
                    easyExplanation: { type: "STRING" }
                  },
                  required: ["term", "english", "easyExplanation"]
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
    const body = await response.text();
    throw new Error(`Gemini 요청 실패 (${response.status}): ${body.slice(0, 240)}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (!raw) throw new Error("Gemini가 용어 결과를 반환하지 않았습니다.");

  const parsed = JSON.parse(raw) as { terms?: GeminiTerm[] };
  return Array.isArray(parsed.terms) ? parsed.terms : [];
}

export function buildPhraseSet(terms: GlossaryTerm[], pages: PageText[]): string[] {
  const phrases = new Map<string, string>();
  for (const term of terms) {
    if (locateTerm(pages, term.term)) phrases.set(normalize(term.term), term.term);
    if (term.english && locateTerm(pages, term.english)) {
      phrases.set(normalize(term.english), term.english);
    }
  }
  return [...phrases.values()].slice(0, MAX_TERMS);
}

export async function analyzeGlossary(title: string, pages: PageText[]): Promise<AnalysisResult> {
  const totalCharacters = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (totalCharacters > 600_000) throw new Error("PDF 텍스트가 너무 큽니다. 60만 자 이하 자료를 사용해 주세요.");

  try {
    const geminiCandidates = await extractWithGemini(pages);
    const terms = validateCandidates(pages, geminiCandidates, "gemini");
    if (terms.length < 3) throw new Error("검증을 통과한 전문용어가 충분하지 않습니다.");
    return { title, terms, phraseSet: buildPhraseSet(terms, pages), mode: "gemini" };
  } catch (error) {
    const terms = validateCandidates(pages, extractHeuristicCandidates(pages), "heuristic");
    return {
      title,
      terms,
      phraseSet: buildPhraseSet(terms, pages),
      mode: "heuristic",
      warning: `AI 분석을 사용할 수 없어 문서 내 표기 기반으로 추출했습니다. ${error instanceof Error ? error.message : ""}`.trim()
    };
  }
}

export function matchTerms(text: string, terms: GlossaryTerm[]): GlossaryTerm[] {
  const normalizedText = normalize(text);
  return terms
    .filter((term) => normalizedText.includes(normalize(term.term)))
    .sort((a, b) => b.term.length - a.term.length);
}

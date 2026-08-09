import type { GlossaryTerm, StartMessage } from "../types.js";
import { glossaryTermSchema } from "../types.js";
import { demoTerms } from "./demo.js";
import { withSanitizedSpokenAliases } from "./spoken-aliases.js";

const MAX_TERMS = 50;
const MAX_PHRASES = 50;
const MAX_PHRASE_LENGTH = 120;
const MAX_RAW_PHRASE_LENGTH = MAX_PHRASE_LENGTH * 2;
const MAX_INSPECTED_PHRASES = MAX_PHRASES * 4;

function canonicalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalize(value: string): string {
  return canonicalize(value).toLocaleLowerCase("ko-KR");
}

export function sanitizeGlossaryTerms(value: unknown): GlossaryTerm[] {
  if (!Array.isArray(value)) return [];

  const seenIds = new Set<string>();
  const seenTerms = new Set<string>();
  const terms: GlossaryTerm[] = [];
  for (const candidate of value) {
    const parsed = glossaryTermSchema.safeParse(candidate);
    if (!parsed.success) continue;

    const term = canonicalize(parsed.data.term);
    const english = canonicalize(parsed.data.english);
    const id = parsed.data.id.trim();
    if (id.length === 0 || id.length > 160 || term.length < 2 || term.length > 80 || english.length > 120) continue;

    const key = normalize(term);
    if (seenIds.has(id) || seenTerms.has(key)) continue;
    seenIds.add(id);
    seenTerms.add(key);
    terms.push({ ...parsed.data, id, term, english });
    if (terms.length === MAX_TERMS) break;
  }
  return withSanitizedSpokenAliases(terms);
}

export function sanitizePhraseSet(value: unknown, terms: GlossaryTerm[]): string[] {
  if (!Array.isArray(value)) return [];

  const allowed = new Map<string, string>();
  for (const term of terms) {
    allowed.set(normalize(term.term), term.term);
    if (term.english) allowed.set(normalize(term.english), term.english);
    for (const alias of term.spokenAliases) allowed.set(normalize(alias), alias);
  }

  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const candidate of value.slice(0, MAX_INSPECTED_PHRASES)) {
    if (typeof candidate !== "string" || candidate.length > MAX_RAW_PHRASE_LENGTH) continue;
    const key = normalize(candidate);
    if (key.length < 2 || key.length > MAX_PHRASE_LENGTH) continue;
    const canonical = allowed.get(key);
    if (!canonical || seen.has(key)) continue;

    seen.add(key);
    phrases.push(canonical);
    if (phrases.length === MAX_PHRASES) break;
  }
  return phrases;
}

export type StartContext = Pick<StartMessage, "mode" | "terms" | "phraseSet">;

export function resolveStartContext(mode: StartMessage["mode"], rawTerms: unknown, rawPhraseSet: unknown): StartContext {
  const suppliedTerms = sanitizeGlossaryTerms(rawTerms);
  const terms = mode === "demo" && suppliedTerms.length === 0 ? demoTerms : suppliedTerms;
  return {
    mode,
    terms,
    phraseSet: sanitizePhraseSet(rawPhraseSet, terms)
  };
}

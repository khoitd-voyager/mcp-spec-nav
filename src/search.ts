/**
 * Lexical matching for `spec_nav_find_functions`.
 *
 * Words, not meaning. A query is split into words, identifiers are split on
 * camelCase and snake_case, and words match exactly, by a shared stem
 * (`fees`/`fee`), by prefix (`calc`/`calculate`), or through a short fixed
 * list of verbs code commonly uses interchangeably (`compute`/`calculate`).
 * Anything beyond that — `surcharge` for "fee" when nobody wrote "fee" — is
 * out of reach, and the tool says so rather than implying otherwise.
 */

/**
 * One copy of each word. A large repo has a few hundred thousand functions
 * but only tens of thousands of distinct words, and every function holding
 * its own copies of "return" and "const" is most of the catalog's memory.
 */
const interned = new Map<string, string>();
function intern(w: string): string {
  const hit = interned.get(w);
  if (hit !== undefined) return hit;
  interned.set(w, w);
  return w;
}

/** Distinct words of `text`, shared copies. */
export function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))].map(intern);
}

/**
 * Split identifiers and prose into lower-case words, by Unicode letter and
 * digit classes — `tínhPhíVậnChuyển` and "tính phí vận chuyển" both give
 * tính, phí, vận, chuyển. Words keep their diacritics; matching folds them.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.normalize("NFC").split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (!raw) continue;
    const parts = raw
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
      .replace(/(\p{L})(\p{N})/gu, "$1 $2")
      .split(" ");
    for (const p of parts) {
      const w = p.toLowerCase();
      if ([...w].length >= 2 && !/^\p{N}+$/u.test(w)) out.push(w);
    }
  }
  return out;
}

/** Words in a query that say nothing about which function is meant. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "by", "with", "and", "or", "from", "into",
  "that", "which", "this", "it", "its", "function", "functions", "method", "methods", "func",
  "fn", "helper", "logic", "code", "some", "any", "all", "existing",
  // Vietnamese, with diacritics only — unaccented forms collide with English.
  "hàm", "các", "của", "và", "để", "là", "một", "những", "trong", "cho", "với", "được", "này", "đó",
]);

export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const t of tokenize(query)) if (!STOPWORDS.has(t)) seen.add(t);
  return [...seen];
}

const isAscii = (w: string) => /^[\x00-\x7f]*$/.test(w);

const folded = new Map<string, string>();
/** Diacritics removed, `đ` → `d`: "phí" and "phi" fold to the same word. */
export function fold(w: string): string {
  if (isAscii(w)) return w;
  let f = folded.get(w);
  if (f === undefined) {
    f = w.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
    folded.set(w, f);
  }
  return f;
}

const stems = new Map<string, string>();
/**
 * A crude English suffix stripper — enough to match `fees`/`fee`,
 * `orders`/`order`. Words with non-ASCII letters are returned as they are:
 * English suffix rules turn Vietnamese `thuế` into `thu`, another word.
 */
export function stem(w: string): string {
  if (!isAscii(w)) return w;
  let s = stems.get(w);
  if (s === undefined) {
    s = stemAscii(w);
    stems.set(w, s);
  }
  return s;
}

function stemAscii(w: string): string {
  const rules: Array<[RegExp, string]> = [
    [/ations?$/, ""],
    [/ings?$/, ""],
    [/ies$/, "y"],
    [/(ss|sh|ch|x)es$/, "$1"],
    [/ers?$/, ""],
    [/ed$/, ""],
    [/s$/, ""],
    [/e$/, ""],
  ];
  // Twice, so `ordering` → `order` → `ord` lands where `orders` does.
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const [re, rep] of rules) {
      if (!re.test(w)) continue;
      const s = w.replace(re, rep);
      if (s.length >= 3) {
        w = s;
        changed = true;
      }
      break;
    }
    if (!changed) break;
  }
  return w;
}

/**
 * Words code uses interchangeably for the same action. Deliberately short:
 * each entry is a guess about meaning, and a long list turns every query into
 * a match for everything.
 */
const SYNONYM_GROUPS = [
  ["calculate", "calc", "compute", "computation", "calculation", "estimate"],
  ["get", "fetch", "load", "retrieve", "find", "lookup", "read", "query"],
  ["create", "make", "build", "add", "insert"],
  ["update", "modify", "edit", "patch", "change"],
  ["delete", "remove", "destroy", "del", "drop"],
  ["validate", "check", "verify", "assert", "ensure"],
  ["convert", "transform"],
  ["format", "render", "display", "print", "stringify"],
  ["send", "dispatch", "emit", "publish", "notify"],
  ["fee", "charge", "surcharge"],
  ["total", "sum", "amount"],
  ["count", "number", "num"],
];
const SYNONYMS = new Map<string, Set<string>>();
for (const g of SYNONYM_GROUPS) {
  const stems = g.map(stem);
  for (const s of stems) {
    const set = SYNONYMS.get(s) ?? new Set<string>();
    for (const o of stems) if (o !== s) set.add(o);
    SYNONYMS.set(s, set);
  }
}

export type MatchQuality = "exact" | "accent" | "stem" | "prefix" | "synonym";
const QUALITY_SCORE: Record<MatchQuality, number> = { exact: 1, accent: 0.95, stem: 0.9, prefix: 0.65, synonym: 0.55 };

/** How well a query word matches one document word, if at all. */
export function matchWord(q: string, w: string): MatchQuality | undefined {
  if (q === w) return "exact";
  if (fold(q) === fold(w)) return "accent";
  // Prefixes, stems and synonyms are English rules; they say nothing about
  // a word written with other letters.
  if (!isAscii(q) || !isAscii(w)) return undefined;
  const qs = stem(q);
  const ws = stem(w);
  if (qs === ws) return "stem";
  const [short, long] = qs.length <= ws.length ? [qs, ws] : [ws, qs];
  // Four characters is where a prefix stops being a coincidence:
  // `calc`/`calculate` yes, `fee`/`feedback` no.
  if (short.length >= 4 && long.startsWith(short)) return "prefix";
  if (SYNONYMS.get(qs)?.has(ws)) return "synonym";
  return undefined;
}

/** The fields searched, and how much a match in each one counts. */
export const FIELD_WEIGHTS = {
  name: 6,
  qualifier: 3,
  signature: 2,
  doc: 2,
  path: 1.5,
  body: 0.6,
} as const;
export type Field = keyof typeof FIELD_WEIGHTS;

export interface SearchDoc {
  name: string[];
  qualifier: string[];
  signature: string[];
  doc: string[];
  path: string[];
  body?: string[];
}

export interface ScoredMatch {
  score: number;
  matched: number;
  reasons: string[];
  /** Every word matched only inside the body: weaker evidence, ranked after the rest. */
  bodyOnly?: boolean;
}

/**
 * Syntax, not behaviour: words every body contains. A body that "matches"
 * `return` says nothing about what the function does.
 */
const BODY_NOISE = new Set([
  "return", "const", "let", "var", "function", "if", "else", "for", "while", "do", "switch", "case",
  "break", "continue", "new", "this", "self", "true", "false", "null", "nil", "none", "undefined",
  "async", "await", "def", "func", "fn", "pub", "end", "try", "catch", "finally", "throw", "raise",
  "import", "from", "export", "class", "public", "private", "protected", "static", "void", "int",
  "string", "bool", "boolean", "number", "err", "error", "ctx", "args", "arg", "val", "value",
]);

function bestIn(q: string, words: Iterable<string>): { quality: MatchQuality; word: string } | undefined {
  let best: { quality: MatchQuality; word: string } | undefined;
  for (const w of words) {
    const m = matchWord(q, w);
    if (!m) continue;
    if (!best || QUALITY_SCORE[m] > QUALITY_SCORE[best.quality]) best = { quality: m, word: w };
    if (m === "exact") break;
  }
  return best;
}

/**
 * Score one function against the query words. A function needs to match at
 * least half the words (one of two is enough).
 *
 * A function whose matches are all in its body is a weaker candidate — the
 * word may be a local variable in code doing something else — so it must
 * match every query word, exactly or by stem, none of them syntax noise, and
 * it is flagged `bodyOnly` so the caller can rank it after the rest.
 */
export function scoreDoc(qTokens: string[], doc: SearchDoc, useBody: boolean): ScoredMatch | undefined {
  let score = 0;
  let matched = 0;
  let outsideBody = false;
  let strongInBody = true;
  const reasons: string[] = [];
  for (const q of qTokens) {
    let best: { field: Field; quality: MatchQuality; word: string; value: number } | undefined;
    for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
      if (field === "body" && !useBody) continue;
      const words = doc[field];
      if (!words) continue;
      const m = bestIn(q, words);
      if (!m) continue;
      const value = FIELD_WEIGHTS[field] * QUALITY_SCORE[m.quality];
      if (!best || value > best.value) best = { field, ...m, value };
    }
    if (!best) continue;
    matched++;
    score += best.value;
    if (best.field !== "body") outsideBody = true;
    else if (!(best.quality === "exact" || best.quality === "accent" || best.quality === "stem") || BODY_NOISE.has(q)) {
      strongInBody = false;
    }
    reasons.push(
      `${q}→${best.field}${best.quality === "exact" ? "" : `(${best.quality}${best.word !== q ? `:${best.word}` : ""})`}`,
    );
  }
  const needed = Math.max(1, Math.ceil(qTokens.length / 2));
  if (matched < needed) return undefined;
  const bodyOnly = !outsideBody;
  if (bodyOnly && (matched < qTokens.length || !strongInBody)) return undefined;
  // Covering more of the query beats matching one word very well.
  const coverage = matched / qTokens.length;
  return {
    score: Math.round(score * (0.4 + 0.6 * coverage) * 100) / 100,
    matched,
    reasons,
    ...(bodyOnly ? { bodyOnly: true } : {}),
  };
}

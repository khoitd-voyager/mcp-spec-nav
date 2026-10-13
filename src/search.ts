/**
 * Matching for `spec_nav_find_functions`.
 *
 * Still words, not a model of meaning — but several kinds of evidence, each
 * labelled in the output so a reader can tell how strong a match is:
 *
 *  - the function's own words: name, export aliases, class/module, signature,
 *    doc comment, path;
 *  - what it calls: `notifyCustomer` that calls `mailer.sendMail` is a
 *    candidate for "send email" whatever it is named — behaviour by the
 *    company it keeps;
 *  - its body, weakest of all.
 *
 * Words match exactly, by diacritic folding (`phí`/`phi`), by a shared stem
 * (`fees`/`fee`), by prefix (`calc`/`calculate`), by a common abbreviation
 * (`amt`/`amount`), through short lists of words code uses interchangeably
 * (`compute`/`calculate`, `remove`/`delete`) and of domain concepts
 * (`shipping`/`delivery`), and — for Vietnamese queries written with
 * diacritics — through a small built-in dictionary (`phí` → fee).
 *
 * Words rare in the repo count for more than common ones (IDF), so "shipping
 * fee" in a billing service ranks on "shipping" rather than drowning in "fee".
 */

/**
 * One copy of each word. A large repo has a few hundred thousand functions
 * but only tens of thousands of distinct words, and every function holding
 * its own copies of "return" and "const" is most of the catalog's memory.
 */
const interned = new Map<string, string>();
export function intern(w: string): string {
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
 * Verbs code uses interchangeably for the same action. Deliberately short:
 * each entry is a guess about meaning, and a long list turns every query into
 * a match for everything.
 */
const SYNONYM_GROUPS = [
  ["calculate", "calc", "compute", "computation", "calculation", "estimate"],
  ["get", "fetch", "load", "retrieve", "find", "lookup", "read", "query"],
  ["create", "make", "build", "add", "insert"],
  ["update", "modify", "edit", "patch", "change"],
  ["delete", "remove", "destroy", "del", "drop", "purge", "erase"],
  ["validate", "check", "verify", "assert", "ensure"],
  ["convert", "transform"],
  ["format", "render", "display", "print", "stringify"],
  ["send", "dispatch", "emit", "publish", "notify"],
  ["save", "store", "persist"],
  ["parse", "decode", "deserialize", "unmarshal"],
  ["serialize", "encode", "marshal"],
  ["search", "filter"],
  ["fee", "charge", "surcharge"],
  ["total", "sum", "amount"],
  ["count", "number", "num"],
];

/**
 * Domain words that name the same thing. Weaker than a verb synonym: a
 * `delivery` function is a candidate for "shipping", not a sure match.
 */
const CONCEPT_GROUPS = [
  ["shipping", "shipment", "delivery", "freight"],
  ["email", "mail", "mailer"],
  ["message", "notification", "sms"],
  ["price", "cost", "pricing", "rate", "tariff"],
  ["discount", "coupon", "promo", "promotion", "voucher", "rebate"],
  ["refund", "reimburse", "reimbursement", "chargeback"],
  ["payment", "pay", "checkout", "billing"],
  ["invoice", "bill", "receipt"],
  ["tax", "vat", "gst"],
  ["user", "customer", "account", "member"],
  ["login", "signin", "authenticate", "auth", "logon"],
  ["logout", "signout", "logoff"],
  ["register", "signup", "enroll"],
  ["password", "passphrase", "credential", "credentials"],
  ["permission", "authorize", "authorization", "role", "acl"],
  ["image", "picture", "photo", "thumbnail"],
  ["address", "location"],
  ["quantity", "qty"],
  ["inventory", "stock", "warehouse"],
  ["cart", "basket"],
  ["cancel", "abort", "void"],
  ["approve", "accept", "confirm"],
  ["reject", "decline", "deny"],
  ["schedule", "cron", "enqueue", "job"],
  ["cache", "memoize", "memo"],
  ["retry", "backoff"],
  ["encrypt", "cipher"],
  ["hash", "digest"],
  ["export", "download"],
  ["import", "upload", "ingest"],
  ["report", "summary", "statistics", "stats"],
  ["round", "rounding"],
  ["currency", "money"],
  ["date", "time", "timestamp", "datetime"],
  ["sync", "synchronize", "reconcile"],
];

/** Abbreviations and the word they shorten; matched almost as well as the word itself. */
const ABBREVIATIONS: Record<string, string[]> = {
  amount: ["amt"], quantity: ["qty"], address: ["addr"], user: ["usr"], message: ["msg"],
  config: ["cfg", "conf"], configuration: ["cfg", "config"], transaction: ["txn", "tx"],
  password: ["pwd", "passwd", "pw"], image: ["img"], organization: ["org"], number: ["num"],
  count: ["cnt"], calculate: ["calc"], authenticate: ["auth"], authorization: ["authz"],
  button: ["btn"], index: ["idx"], information: ["info"], description: ["desc"], request: ["req"],
  response: ["res", "resp"], error: ["err"], context: ["ctx"], database: ["db"],
  repository: ["repo"], utility: ["util", "utils"], temporary: ["tmp", "temp"], value: ["val"],
  string: ["str"], format: ["fmt"], initialize: ["init"], delete: ["del"], manager: ["mgr"],
  service: ["svc"], implementation: ["impl"], generate: ["gen"], average: ["avg"],
  previous: ["prev"], current: ["cur", "curr"], source: ["src"], destination: ["dst", "dest"],
  reference: ["ref"], label: ["lbl"], customer: ["cust"], product: ["prod"], payment: ["pmt"],
  document: ["doc"], identifier: ["id"], minimum: ["min"], maximum: ["max"], percent: ["pct"],
  statistics: ["stats"], account: ["acct"], invoice: ["inv"],
};

const SYNONYMS = new Map<string, Set<string>>();
const CONCEPTS = new Map<string, Set<string>>();
function addGroups(groups: string[][], into: Map<string, Set<string>>) {
  for (const g of groups) {
    const ss = g.map(stem);
    for (const s of ss) {
      const set = into.get(s) ?? new Set<string>();
      for (const o of ss) if (o !== s) set.add(o);
      into.set(s, set);
    }
  }
}
addGroups(SYNONYM_GROUPS, SYNONYMS);
addGroups(CONCEPT_GROUPS, CONCEPTS);
const ABBREV = new Map<string, Set<string>>();
for (const [word, abbrs] of Object.entries(ABBREVIATIONS)) {
  for (const a of abbrs) {
    const w = stem(word);
    (ABBREV.get(w) ?? ABBREV.set(w, new Set()).get(w)!).add(a);
    (ABBREV.get(a) ?? ABBREV.set(a, new Set()).get(a)!).add(w);
  }
}

/**
 * Vietnamese words and phrases with their usual English names in code. Only
 * applied to words written with diacritics — unaccented Vietnamese collides
 * with English (`tin`, `in`, `gia`) — and only to add English alternatives:
 * the Vietnamese word still matches Vietnamese-named code as written.
 */
const VI_EN: Record<string, string[]> = {
  "tính": ["calculate", "compute"], "tính toán": ["calculate"], "phí": ["fee", "charge"],
  "vận chuyển": ["shipping", "delivery"], "giao hàng": ["delivery", "shipping"], "đơn hàng": ["order"],
  "đơn": ["order"], "hàng hóa": ["goods", "item"], "sản phẩm": ["product", "item"],
  "khách hàng": ["customer"], "người dùng": ["user"], "tài khoản": ["account"],
  "thanh toán": ["payment", "pay", "checkout"], "hoàn tiền": ["refund"], "giảm giá": ["discount"],
  "mã giảm giá": ["coupon", "voucher"], "khuyến mãi": ["promotion", "discount"], "chiết khấu": ["discount"],
  "thuế": ["tax"], "giá": ["price"], "tổng": ["total", "sum"], "tổng tiền": ["total", "amount"],
  "số tiền": ["amount"], "tiền": ["money", "amount"], "số lượng": ["quantity", "count"],
  "gửi": ["send"], "thông báo": ["notification", "notify"], "thư": ["mail"], "xóa": ["delete", "remove"],
  "xoá": ["delete", "remove"], "tạo": ["create"], "thêm": ["add", "insert"], "cập nhật": ["update"],
  "sửa": ["edit", "update"], "lưu": ["save", "store"], "lấy": ["get", "fetch"], "tìm": ["find", "search"],
  "tìm kiếm": ["search", "find"], "kiểm tra": ["validate", "check"], "xác thực": ["authenticate", "verify"],
  "xác nhận": ["confirm"], "đăng nhập": ["login"], "đăng xuất": ["logout"], "đăng ký": ["register", "signup"],
  "mật khẩu": ["password"], "hóa đơn": ["invoice", "bill"], "hoá đơn": ["invoice", "bill"],
  "địa chỉ": ["address"], "ngày": ["date", "day"], "thời gian": ["time"], "chuyển đổi": ["convert"],
  "định dạng": ["format"], "danh sách": ["list"], "tệp": ["file"], "tập tin": ["file"], "ảnh": ["image"],
  "hình ảnh": ["image"], "báo cáo": ["report"], "xuất": ["export"], "nhập": ["import"],
  "tải lên": ["upload"], "tải xuống": ["download"], "đồng bộ": ["sync"], "lịch": ["schedule", "calendar"],
  "tồn kho": ["inventory", "stock"], "kho": ["inventory", "warehouse"], "nhân viên": ["employee", "staff"],
  "quyền": ["permission"], "phân quyền": ["permission", "authorize"], "vai trò": ["role"],
  "mã hóa": ["encrypt", "encode"], "giải mã": ["decrypt", "decode"], "băm": ["hash"],
  "bộ nhớ đệm": ["cache"], "cấu hình": ["config"], "lỗi": ["error"], "nhật ký": ["log"],
  "tin nhắn": ["message"], "đánh giá": ["review", "rating"], "điểm": ["score", "point"],
  "giỏ hàng": ["cart"], "trạng thái": ["status", "state"], "hủy": ["cancel"], "huỷ": ["cancel"],
  "duyệt": ["approve"], "phê duyệt": ["approve"], "làm tròn": ["round"], "tỷ giá": ["exchange", "rate"],
  "tiền tệ": ["currency"], "chuyển khoản": ["transfer"], "ví": ["wallet"], "đặt hàng": ["order", "place"],
  "đặt chỗ": ["booking", "reservation"], "lãi": ["interest"], "công nợ": ["debt"], "hoàn trả": ["refund", "return"],
};
const VI_MAX_PHRASE = 3;

/** One unit of a query: a word, or a dictionary phrase, with the alternatives that satisfy it. */
export interface QueryTerm {
  /** As the user wrote it. */
  label: string;
  /** Any one alternative satisfies the term; every word of an alternative must match. */
  alts: Array<{ words: string[]; translated?: boolean }>;
}

/**
 * The query as terms. Vietnamese phrases found in the dictionary become one
 * term, satisfied by the Vietnamese words themselves or by an English name.
 */
export function parseQuery(query: string): { words: string[]; terms: QueryTerm[]; translated: string[] } {
  const words = queryTokens(query);
  const terms: QueryTerm[] = [];
  const translated: string[] = [];
  for (let i = 0; i < words.length; ) {
    let took = 0;
    for (let len = Math.min(VI_MAX_PHRASE, words.length - i); len >= 1 && !took; len--) {
      const phrase = words.slice(i, i + len);
      if (phrase.every(isAscii)) continue;
      const en = VI_EN[phrase.join(" ")];
      if (!en) continue;
      terms.push({ label: phrase.join(" "), alts: [{ words: phrase }, ...en.map((w) => ({ words: [w], translated: true }))] });
      translated.push(`${phrase.join(" ")} → ${en.join("/")}`);
      took = len;
    }
    if (!took) {
      terms.push({ label: words[i], alts: [{ words: [words[i]] }] });
      took = 1;
    }
    i += took;
  }
  return { words, terms, translated };
}

export type MatchQuality = "exact" | "accent" | "stem" | "abbrev" | "prefix" | "synonym" | "concept";
const QUALITY_SCORE: Record<MatchQuality, number> = {
  exact: 1, accent: 0.95, stem: 0.9, abbrev: 0.85, prefix: 0.65, synonym: 0.55, concept: 0.45,
};
/** A dictionary translation is a guess about the user's intent; it counts a little less. */
const TRANSLATED_FACTOR = 0.9;

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
  if (ABBREV.get(qs)?.has(ws) || ABBREV.get(q)?.has(w) || ABBREV.get(qs)?.has(w) || ABBREV.get(q)?.has(ws)) return "abbrev";
  const [short, long] = qs.length <= ws.length ? [qs, ws] : [ws, qs];
  // Five characters is where a prefix stops being a coincidence: `store` is
  // not `storage`, `fee` is not `feedback`. Shorter clippings (`calc`,
  // `auth`) are matched as abbreviations instead.
  if (short.length >= 5 && long.startsWith(short)) return "prefix";
  if (SYNONYMS.get(qs)?.has(ws)) return "synonym";
  if (CONCEPTS.get(qs)?.has(ws)) return "concept";
  return undefined;
}

/** The fields searched, and how much a match in each one counts. */
export const FIELD_WEIGHTS = {
  name: 6,
  qualifier: 3,
  signature: 2,
  doc: 2,
  path: 1.5,
  calls: 1.5,
  body: 0.6,
} as const;
export type Field = keyof typeof FIELD_WEIGHTS;

export interface SearchDoc {
  name: string[];
  qualifier: string[];
  signature: string[];
  doc: string[];
  path: string[];
  /** Words of the names this function calls. */
  calls?: string[];
  body?: string[];
}

export interface ScoredMatch {
  score: number;
  matched: number;
  reasons: string[];
  /** Every word matched only inside the body: weaker evidence, ranked after the rest. */
  bodyOnly?: boolean;
  /** Matched only through what it calls (and its body): behavioural evidence, ranked after direct matches. */
  callsOnly?: boolean;
}

/**
 * Syntax, not behaviour: words every body contains. A body that "matches"
 * `return` says nothing about what the function does.
 */
export const BODY_NOISE = new Set([
  "return", "const", "let", "var", "function", "if", "else", "for", "while", "do", "switch", "case",
  "break", "continue", "new", "this", "self", "true", "false", "null", "nil", "none", "undefined",
  "async", "await", "def", "func", "fn", "pub", "end", "try", "catch", "finally", "throw", "raise",
  "import", "from", "export", "class", "public", "private", "protected", "static", "void", "int",
  "string", "bool", "boolean", "number", "err", "error", "ctx", "args", "arg", "val", "value",
]);

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "sizeof", "super", "await",
  "elif", "def", "func", "fun", "fn", "foreach", "using", "lock", "match", "when", "guard", "with",
  "and", "or", "not", "in", "is", "as", "do", "else", "try", "yield", "assert", "constructor", "init",
  "this", "self", "print", "println", "printf", "require", "import", "include",
]);

/**
 * Names called in a piece of code: `foo(`, `obj.bar(`, `new Baz(`,
 * `pkg.Qux<T>(`. Lexical — a call written inside a string or comment counts
 * too — and the function's own name (its declaration) is left out.
 */
export function calleeNames(code: string, ownName?: string): string[] {
  const out = new Set<string>();
  const re = /([\p{L}_$][\p{L}\p{N}_$]*)\s*(?:<[^<>()\n]{0,80}>\s*)?\(/gu;
  for (let m: RegExpExecArray | null; (m = re.exec(code)); ) {
    const n = m[1];
    if (n === ownName || CALL_KEYWORDS.has(n.toLowerCase())) continue;
    out.add(n);
  }
  return [...out];
}

/**
 * A callee as a behaviour feature: case and underscores dropped, so
 * `lookupZoneRate` (TS) and `lookup_zone_rate` (Python) are the same call.
 */
export function calleeKey(name: string): string {
  return name.toLowerCase().replace(/_/g, "");
}

interface Hit { quality: MatchQuality; word: string }

function bestIn(q: string, words: Iterable<string>): Hit | undefined {
  let best: Hit | undefined;
  for (const w of words) {
    const m = matchWord(q, w);
    if (!m) continue;
    if (!best || QUALITY_SCORE[m] > QUALITY_SCORE[best.quality]) best = { quality: m, word: w };
    if (m === "exact") break;
  }
  return best;
}

/** How one query term matched one function, before weighting by rarity. */
export interface TermMatch {
  field: Field;
  quality: MatchQuality;
  value: number;
  reason: string;
}

const STRONG: ReadonlySet<MatchQuality> = new Set(["exact", "accent", "stem", "abbrev"]);

function bestWord(q: string, doc: SearchDoc, useBody: boolean) {
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
  return best;
}

/** The best way each term matches `doc`, or undefined for a term it does not match. */
export function matchTerms(terms: QueryTerm[], doc: SearchDoc, useBody: boolean): Array<TermMatch | undefined> {
  return terms.map((term) => {
    let best: TermMatch | undefined;
    for (const alt of term.alts) {
      const parts = alt.words.map((w) => bestWord(w, doc, useBody));
      if (parts.some((p) => !p)) continue;
      const ps = parts as NonNullable<(typeof parts)[number]>[];
      // A phrase is as strong as its weakest word, and lives in its weakest field.
      const weakest = ps.reduce((a, b) => (b.value < a.value ? b : a));
      let value = ps.reduce((a, b) => a + b.value, 0) / ps.length;
      if (alt.translated) value *= TRANSLATED_FACTOR;
      if (best && value <= best.value) continue;
      const tag = (p: (typeof ps)[number], w: string) =>
        p.quality === "exact" && !alt.translated
          ? ""
          : `(${[alt.translated ? `vi:${w}` : "", p.quality !== "exact" ? `${p.quality}${p.word !== w ? `:${p.word}` : ""}` : ""].filter(Boolean).join(",")})`;
      const reason =
        ps.length === 1
          ? `${term.label}→${ps[0].field}${tag(ps[0], alt.words[0])}`
          : `${term.label}→${ps.map((p, i) => `${p.field}${tag(p, alt.words[i])}`).join("+")}`;
      best = { field: weakest.field, quality: weakest.quality, value, reason };
    }
    return best;
  });
}

/**
 * Weigh a function's term matches into a score, or reject it.
 *
 * It needs at least half the terms (one of two is enough). A function whose
 * matches are all in what it calls or in its body is weaker evidence — the
 * word may be a local variable, or a call made in passing — so it must match
 * every term, strongly where the match is in the body, and it is flagged
 * (`callsOnly` / `bodyOnly`) so it ranks after direct matches.
 *
 * `weights` are per-term rarity weights averaging 1 (IDF); omitted, all 1.
 */
export function scoreMatches(terms: QueryTerm[], matches: Array<TermMatch | undefined>, weights?: number[]): ScoredMatch | undefined {
  const w = weights ?? terms.map(() => 1);
  let score = 0;
  let matched = 0;
  let wMatched = 0;
  let direct = false;
  let viaCalls = false;
  let strongInBody = true;
  let strongInCalls = true;
  const reasons: string[] = [];
  matches.forEach((m, i) => {
    if (!m) return;
    matched++;
    wMatched += w[i];
    score += m.value * w[i];
    if (m.field === "calls") {
      viaCalls = true;
      if (m.quality === "prefix") strongInCalls = false;
    } else if (m.field === "body") {
      const word = terms[i].alts[0].words[0];
      if (!STRONG.has(m.quality) || BODY_NOISE.has(word)) strongInBody = false;
    } else direct = true;
    reasons.push(m.reason);
  });
  const needed = Math.max(1, Math.ceil(terms.length / 2));
  if (matched < needed) return undefined;
  const bodyOnly = !direct && !viaCalls;
  const callsOnly = !direct && viaCalls;
  if ((bodyOnly || callsOnly) && matched < terms.length) return undefined;
  if (bodyOnly && !strongInBody) return undefined;
  if (callsOnly && (!strongInCalls || !strongInBody)) return undefined;
  // Covering more of the query (weighted by rarity) beats matching one word very well.
  const coverage = wMatched / w.reduce((a, b) => a + b, 0);
  return {
    score: Math.round(score * (0.4 + 0.6 * coverage) * 100) / 100,
    matched,
    reasons,
    ...(bodyOnly ? { bodyOnly: true } : {}),
    ...(callsOnly ? { callsOnly: true } : {}),
  };
}

/** Rarity weights (IDF) per term from document frequencies, normalised to average 1. */
export function idfWeights(df: number[], docs: number): number[] {
  if (!df.length) return [];
  const raw = df.map((d) => Math.log(1 + (docs - d + 0.5) / (d + 0.5)));
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return mean > 0 ? raw.map((r) => r / mean) : raw.map(() => 1);
}

/** Back-compat: score one function against plain query words, unweighted. */
export function scoreDoc(qTokens: string[], doc: SearchDoc, useBody: boolean): ScoredMatch | undefined {
  const terms = qTokens.map((q) => ({ label: q, alts: [{ words: [q] }] }));
  return scoreMatches(terms, matchTerms(terms, doc, useBody));
}

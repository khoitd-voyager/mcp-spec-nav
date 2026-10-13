import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  scanRepo,
  filterFiles,
  pathFilter,
  fingerprint,
  normaliseService,
  isTsFamily,
  RepoScan,
  SourceEntry,
} from "./project.js";
import { languageById } from "./languages.js";
import { extractFunctions, loadFailures, RawFunction } from "./treesitter.js";
import { extractTsFunctions, parseSource, tsImportsUsed } from "./tsparse.js";
import { extractBraceFunctions, BraceLang } from "./bracelang.js";
import { tsParseView } from "./sfc.js";
import { uniqueTokens, intern, calleeKey, parseQuery, matchTerms, scoreMatches, idfWeights, SearchDoc, TermMatch, calleeNames } from "./search.js";
import {
  CHAR_BUDGET,
  CHANGED_WARNING,
  decodeCursor,
  encodeCursor,
  paramsHash,
  takePage,
} from "./paging.js";

/**
 * The function catalog: every named function in every supported file, kept
 * per file and refreshed whenever a file's stamp changes.
 *
 * Every call re-walks the tree and re-stats each file, so a file added,
 * edited or deleted while the server runs is reflected on the next call —
 * there is no cache that can go stale, only a parse cache keyed on content.
 */

export interface FnRecord {
  id: string;
  service: string;
  file: string;
  language: string;
  /** Qualified: `OrderService.calculateFee`, `outer.inner`. */
  name: string;
  shortName: string;
  kind: string;
  signature: string;
  params: string[];
  returnType?: string;
  exported?: boolean;
  visibility?: string;
  isAsync?: boolean;
  isStatic?: boolean;
  /** Lines, 1-indexed and inclusive. */
  start: number;
  end: number;
  /** Columns on the start and end lines, 1-indexed and inclusive: where exactly it begins and ends. */
  startColumn: number;
  endColumn: number;
  /** Other names it is exported under: `module.exports`, `module.exports.x`, `default`, an alias. */
  exportedAs?: string[];
  /** The variable or property it was assigned to, when that is where its name comes from. */
  assignedTo?: string;
  /**
   * Ids of other functions assigned to the same variable or property. Which
   * one is in effect is decided at runtime; all are listed, none preferred.
   */
  alternatives?: string[];
  /** Doc comment, cut to DOC_LIMIT characters in listings. */
  doc?: string;
  docTruncated?: boolean;
  /** Content hash of the function's exact source text (start to end column). */
  hash: string;
}

export interface Indexed {
  rec: FnRecord;
  fullDoc?: string;
  search: SearchDoc;
  /** Names it calls, lower-cased: its behaviour, for spec_nav_similar_functions. */
  callees: string[];
  /** Exact extent in the file text, UTF-16 offsets, end exclusive. */
  startOffset: number;
  endOffset: number;
}

export interface FileCatalog {
  stamp: string;
  entry: SourceEntry;
  functions: Indexed[];
  /** Kotlin/Swift: offsets of declaration names, so call-site search skips them. */
  declOffsets?: Set<number>;
  anonymous: Array<{ start: number; end: number }>;
  errorLine?: number;
  errorMessage?: string;
  /** Set when the file's grammar would not load: no functions were read. */
  parserUnavailable?: string;
  readError?: string;
}

const DOC_LIMIT = 240;

const cache = new Map<string, FileCatalog>();

function hashText(code: string): string {
  return createHash("sha1").update(code).digest("hex").slice(0, 8);
}

/** 1-indexed column of the character at `offset`. */
function columnAt(text: string, offset: number): number {
  return offset - (text.lastIndexOf("\n", offset - 1) + 1) + 1;
}

/** The words an export alias adds: `module.exports.giveBack` → give, back. */
function aliasWords(exportedAs: string[] | undefined): string {
  return (exportedAs ?? [])
    .map((a) => a.replace(/^(module\.exports|exports)\.?/, "").replace(/^default$/, ""))
    .join(" ");
}

function toIndexed(entry: SourceEntry, raws: RawFunction[], text: string): Indexed[] {
  const seen = new Map<string, number>();
  const pathWords = uniqueTokens(entry.rel);
  const out = raws.map((r) => {
    const name = [...r.qualifier, r.name].join(".");
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    // Two functions with the same qualified name in one file (overloads in
    // some languages, two branches defining the same helper) get ~2, ~3.
    const idName = n > 1 ? `${name}~${n}` : name;
    const code = text.slice(r.startOffset, r.endOffset);
    // Hash the function's own text only, so editing a neighbour on the same
    // line leaves this id valid.
    const hash = hashText(code);
    const fullDoc = r.doc;
    const docTruncated = !!fullDoc && fullDoc.length > DOC_LIMIT;
    const rec: FnRecord = {
      id: `${entry.rel}::${idName}@${hash}`,
      service: entry.service,
      file: entry.rel,
      language: entry.language,
      name,
      shortName: r.name,
      kind: r.kind,
      signature: r.signature,
      params: r.params,
      returnType: r.returnType,
      exported: r.exported,
      visibility: r.visibility,
      isAsync: r.isAsync,
      isStatic: r.isStatic,
      start: r.start,
      end: r.end,
      startColumn: columnAt(text, r.startOffset),
      endColumn: columnAt(text, Math.max(r.startOffset, r.endOffset - 1)),
      exportedAs: r.exportedAs?.length ? r.exportedAs : undefined,
      // Said when it differs from the name; alternatives below always say it.
      assignedTo: r.assignedTo && r.assignedTo !== r.name ? r.assignedTo : undefined,
      doc: fullDoc ? (docTruncated ? fullDoc.slice(0, DOC_LIMIT - 1) + "…" : fullDoc) : undefined,
      docTruncated: docTruncated || undefined,
      hash,
    };
    const callees = calleeNames(code, r.name);
    return {
      rec,
      fullDoc,
      callees: [...new Set(callees.map((c) => intern(calleeKey(c))))],
      startOffset: r.startOffset,
      endOffset: r.endOffset,
      search: {
        // The names it is exported under are names a caller knows it by.
        name: uniqueTokens(`${r.name} ${aliasWords(r.exportedAs)}`),
        qualifier: uniqueTokens(r.qualifier.join(" ")),
        signature: uniqueTokens([...r.params, r.returnType ?? ""].join(" ")),
        doc: fullDoc ? uniqueTokens(fullDoc) : [],
        path: pathWords,
        // What it calls says what it does, whatever it is named.
        calls: uniqueTokens(callees.join(" ")),
        body: uniqueTokens(code),
      },
    };
  });

  // Several functions stored in one variable (`x = a` here, `x = b` there):
  // each is listed with the others' ids, since only runtime decides which
  // one a call reaches.
  const byBinding = new Map<string, number[]>();
  raws.forEach((r, i) => {
    if (r.bindingKey) byBinding.set(r.bindingKey, [...(byBinding.get(r.bindingKey) ?? []), i]);
  });
  for (const group of byBinding.values()) {
    for (const i of group) {
      const rec = out[i].rec;
      if (group.length > 1) {
        rec.alternatives = group.filter((j) => j !== i).map((j) => out[j].rec.id);
        rec.assignedTo = raws[i].assignedTo;
      }
    }
  }
  return out;
}

export async function catalogFile(entry: SourceEntry): Promise<FileCatalog> {
  const cached = cache.get(entry.abs);
  if (cached && cached.stamp === entry.stamp) {
    // Service assignment can change without the file changing (a
    // package.json added above it), so keep that current.
    if (cached.entry.service !== entry.service) {
      cached.entry = entry;
      for (const f of cached.functions) f.rec.service = entry.service;
    }
    return cached;
  }
  let text: string;
  try {
    text = readFileSync(entry.abs, "utf8");
  } catch (err) {
    const fc: FileCatalog = { stamp: entry.stamp, entry, functions: [], anonymous: [], readError: String(err) };
    cache.set(entry.abs, fc);
    return fc;
  }
  let fc: FileCatalog;
  const lang = languageById(entry.language);
  if (isTsFamily(entry.language)) {
    try {
      // A Vue/Svelte/Astro component is parsed as its script, offsets unchanged.
      const view = tsParseView(entry.ext, text);
      const r = extractTsFunctions(entry.abs, view.text, view.ext);
      fc = {
        stamp: entry.stamp,
        entry,
        functions: toIndexed(entry, r.functions, text),
        anonymous: r.anonymous,
        errorLine: r.errorLine,
        errorMessage: r.errorMessage,
      };
    } catch (err) {
      fc = { stamp: entry.stamp, entry, functions: [], anonymous: [], errorLine: 1, errorMessage: `parser crashed: ${err}` };
    }
  } else if (lang?.engine === "brace") {
    try {
      const r = extractBraceFunctions(text, lang.id as BraceLang);
      fc = {
        stamp: entry.stamp,
        entry,
        functions: toIndexed(entry, r.functions, text),
        anonymous: [],
        declOffsets: r.nameOffsets,
        errorLine: r.errorLine,
        errorMessage: r.errorLine ? "unbalanced brackets or unterminated string" : undefined,
      };
    } catch (err) {
      fc = { stamp: entry.stamp, entry, functions: [], anonymous: [], errorLine: 1, errorMessage: `scanner crashed: ${err}` };
    }
  } else {
    const r = await extractFunctions(text, lang!);
    if (!r) {
      const reason = loadFailures().find((f) => f.id === lang!.id)?.reason ?? "parse failed";
      fc = { stamp: entry.stamp, entry, functions: [], anonymous: [], parserUnavailable: reason };
    } else {
      fc = {
        stamp: entry.stamp,
        entry,
        functions: toIndexed(entry, r.functions, text),
        anonymous: [],
        errorLine: r.errorLine,
        errorMessage: r.errorLine ? "syntax error" : undefined,
      };
    }
  }
  cache.set(entry.abs, fc);
  return fc;
}

export interface Snapshot {
  scan: RepoScan;
  files: FileCatalog[];
  fingerprint: string;
  services?: string[];
}

/** Catalog the files in scope, refreshing whatever changed since last time. */
export async function snapshot(services?: string[]): Promise<Snapshot> {
  const scan = scanRepo();
  // Forget files that are gone, so a deleted file never answers a query.
  const live = new Set(scan.files.map((f) => f.abs));
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
  const entries = filterFiles(scan, services);
  const files: FileCatalog[] = [];
  for (const e of entries) files.push(await catalogFile(e));
  return { scan, files, fingerprint: fingerprint(entries), services: services?.map(normaliseService) };
}

/** One catalogued file, by path, refreshed if it changed. */
export async function fileCatalog(rel: string): Promise<{ fc?: FileCatalog; scan: RepoScan }> {
  const scan = scanRepo();
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const entry = scan.files.find((f) => f.rel === norm);
  return { fc: entry ? await catalogFile(entry) : undefined, scan };
}

/** Line ranges for labelling `spec_nav_map` hits, named first. */
export function labelRanges(fc: FileCatalog): Array<{ start: number; end: number; name: string; line: number }> {
  return [
    ...fc.functions.map((f) => ({ start: f.rec.start, end: f.rec.end, name: f.rec.name, line: f.rec.start })),
    ...fc.anonymous.map((a) => ({ start: a.start, end: a.end, name: "<anonymous>", line: a.start })),
  ];
}

// ---------------------------------------------------------------------------
// Coverage: what was and was not read. Every listing carries this, because
// "no such function" is only meaningful next to "and here is what we looked at".

export interface Coverage {
  filesScanned: number;
  byLanguage: Record<string, number>;
  parseErrors: Array<{ file: string; line?: number; message?: string }>;
  parserUnavailable: Array<{ language: string; files: number; reason: string }>;
  unreadable: string[];
  unsupportedSourceFiles: { total: number; byExtension: Record<string, number>; sample: string[] };
  skippedFiles: Array<{ file: string; reason: string }>;
  excludedDirs: { total: number; sample: string[] };
  anonymousFunctionsNotListed: number;
  /** True only when every file in scope was read and parsed without error. */
  complete: boolean;
  summary: string;
}

export function coverageOf(snap: Snapshot): Coverage {
  const inScope = pathFilter(snap.scan, snap.services);
  const byLanguage: Record<string, number> = {};
  const parseErrors: Coverage["parseErrors"] = [];
  const unavailable = new Map<string, { files: number; reason: string }>();
  const unreadable: string[] = [];
  let anon = 0;
  for (const fc of snap.files) {
    byLanguage[fc.entry.language] = (byLanguage[fc.entry.language] ?? 0) + 1;
    if (fc.readError) unreadable.push(fc.entry.rel);
    else if (fc.parserUnavailable) {
      const u = unavailable.get(fc.entry.language) ?? { files: 0, reason: fc.parserUnavailable };
      u.files++;
      unavailable.set(fc.entry.language, u);
    } else if (fc.errorLine) {
      parseErrors.push({ file: fc.entry.rel, line: fc.errorLine, message: fc.errorMessage });
    }
    anon += fc.anonymous.length;
  }
  const unsupported = snap.scan.unsupported.filter((r) => inScope(r));
  const byExt: Record<string, number> = {};
  for (const u of unsupported) {
    const ext = u.slice(u.lastIndexOf(".")).toLowerCase();
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  const skippedFiles = snap.scan.skippedFiles.filter((s) => inScope(s.file));
  const excluded = snap.scan.skippedDirs.filter((d) => inScope(d.dir));
  unreadable.push(...snap.scan.unreadable.filter((d) => inScope(d)));

  const gaps: string[] = [];
  if (parseErrors.length) gaps.push(`${parseErrors.length} file(s) with syntax errors (their function lists may be incomplete)`);
  if (unavailable.size) gaps.push(`${[...unavailable.values()].reduce((a, b) => a + b.files, 0)} file(s) whose parser failed to load`);
  if (unreadable.length) gaps.push(`${unreadable.length} unreadable path(s)`);
  if (unsupported.length) {
    gaps.push(
      `${unsupported.length} source file(s) in unsupported languages not read (` +
        Object.entries(byExt).map(([e, n]) => `${e} ${n}`).join(", ") + ")",
    );
  }
  if (skippedFiles.length) gaps.push(`${skippedFiles.length} file(s) skipped as minified or oversized`);
  const complete = gaps.length === 0;
  const langs = Object.entries(byLanguage).map(([l, n]) => `${l} ${n}`).join(", ");
  const summary =
    `${snap.files.length} files read (${langs || "none"}). ` +
    (complete
      ? "Every supported file in scope was parsed without errors."
      : `PARTIAL: ${gaps.join("; ")}.`) +
    (excluded.length ? ` ${excluded.length} dependency/build/virtualenv director${excluded.length === 1 ? "y" : "ies"} excluded by design.` : "") +
    (anon ? ` ${anon} inline anonymous function(s) (callbacks) have no name and are not listed.` : "");

  return {
    filesScanned: snap.files.length,
    byLanguage,
    parseErrors,
    parserUnavailable: [...unavailable].map(([language, u]) => ({ language, ...u })),
    unreadable,
    unsupportedSourceFiles: { total: unsupported.length, byExtension: byExt, sample: unsupported.slice(0, 10) },
    skippedFiles,
    excludedDirs: { total: excluded.length, sample: excluded.slice(0, 10).map((d) => `${d.dir} (${d.reason})`) },
    anonymousFunctionsNotListed: anon,
    complete,
    summary,
  };
}

export function renderCoverage(c: Coverage): string[] {
  const out = [`coverage: ${c.summary}`];
  for (const e of c.parseErrors.slice(0, 10)) out.push(`  syntax error: ${e.file}:${e.line}${e.message ? ` — ${e.message}` : ""}`);
  if (c.parseErrors.length > 10) out.push(`  … ${c.parseErrors.length - 10} more files with syntax errors (format:"json" lists all)`);
  for (const u of c.parserUnavailable) out.push(`  parser unavailable: ${u.language} (${u.files} files) — ${u.reason}`);
  return out;
}

// ---------------------------------------------------------------------------
// Listing

export interface ListArgs {
  services?: string[];
  file?: string;
  name?: string;
  kind?: string;
  language?: string;
  exportedOnly?: boolean;
  limit?: number;
  cursor?: string;
  format?: "text" | "json";
}

/** A path filter: substring, or a glob when it has `*`. */
export function fileMatcher(pattern?: string): (rel: string) => boolean {
  if (!pattern) return () => true;
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p.includes("*")) return (rel) => rel.includes(p);
  const re = new RegExp(
    "^" +
      p
        .split("**")
        .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
        .join(".*") +
      "$",
  );
  return (rel) => re.test(rel);
}

/** A name filter: case-insensitive substring of the qualified name, or /regex/. */
function nameMatcher(pattern?: string): (name: string) => boolean {
  if (!pattern) return () => true;
  const m = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    const re = new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i");
    return (n) => re.test(n);
  }
  const lower = pattern.toLowerCase();
  return (n) => n.toLowerCase().includes(lower);
}

export function sortKey(r: FnRecord): string {
  return `${r.file}\u0000${String(r.start).padStart(8, "0")}\u0000${r.id}`;
}

export function flags(r: FnRecord): string {
  return [
    r.kind,
    r.exported === true ? "exported" : r.exported === false && !r.visibility ? "not exported" : "",
    r.visibility && r.visibility !== "public" && r.visibility !== "exported" ? r.visibility : "",
    r.isStatic ? "static" : "",
    r.isAsync ? "async" : "",
  ].filter(Boolean).join(", ");
}

/** `12-40`, or `3:39-3:76` when columns matter (more than one function on a line). */
export function span(r: FnRecord): string {
  return r.startColumn > 1 || r.start === r.end
    ? `${r.start}:${r.startColumn}-${r.end}:${r.endColumn}`
    : `${r.start}-${r.end}`;
}

/** "1 of 2 functions assigned to `format`", when a variable holds several. */
function alternativesNote(r: FnRecord): string | undefined {
  if (!r.alternatives?.length) return undefined;
  return `1 of ${r.alternatives.length + 1} functions assigned to \`${r.assignedTo ?? r.shortName}\` — ` +
    `which one runs is decided at runtime; others: ${r.alternatives.join(", ")}`;
}

function renderFn(r: FnRecord, indent: string): string {
  const lines = [
    `${indent}${span(r)} [${flags(r)}] ${r.name}`,
    `${indent}    sig: ${r.signature}${r.returnType && !r.signature.includes(r.returnType) ? ` -> ${r.returnType}` : ""}`,
    `${indent}    id:  ${r.id}`,
  ];
  if (r.exportedAs) lines.push(`${indent}    exported as: ${r.exportedAs.join(", ")}`);
  const alt = alternativesNote(r);
  if (alt) lines.push(`${indent}    note: ${alt}`);
  if (r.doc) lines.push(`${indent}    doc: ${r.doc.replace(/\s+/g, " ")}${r.docTruncated ? " [doc truncated — spec_nav_read_function shows all]" : ""}`);
  return lines.join("\n");
}

export async function listFunctions(args: ListArgs): Promise<string> {
  const snap = await snapshot(args.services);
  const fileOk = fileMatcher(args.file);
  const nameOk = nameMatcher(args.name);
  const kind = args.kind?.toLowerCase();
  const all: FnRecord[] = [];
  for (const fc of snap.files) {
    if (!fileOk(fc.entry.rel)) continue;
    if (args.language && fc.entry.language !== args.language.toLowerCase()) continue;
    for (const f of fc.functions) {
      const r = f.rec;
      if (!nameOk(r.name)) continue;
      if (kind && !r.kind.toLowerCase().includes(kind)) continue;
      if (args.exportedOnly && r.exported !== true) continue;
      all.push(r);
    }
  }
  all.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

  const qHash = paramsHash({ ...args, cursor: undefined, format: undefined, limit: undefined });
  const cur = decodeCursor(args.cursor, "functions", qHash, snap.fingerprint);
  // Keyset, not offset: resume strictly after the last item returned, so a
  // file added mid-listing can shift nothing into a repeat.
  let start = 0;
  if (typeof cur.position === "string") {
    const after = cur.position;
    start = all.findIndex((r) => sortKey(r) > after);
    if (start < 0) start = all.length;
  }
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
  const coverage = coverageOf(snap);

  let lastFile = "";
  const page = takePage(all, start, limit, CHAR_BUDGET - 3000, (r) => {
    const header = r.file !== lastFile ? `\n${r.file}  (service ${r.service}, ${r.language})\n` : "";
    lastFile = r.file;
    return header + renderFn(r, "  ");
  });
  const shown = all.slice(start, page.end);
  const complete = page.end >= all.length;
  const nextCursor = complete
    ? undefined
    : encodeCursor({ t: "functions", q: qHash, p: sortKey(all[page.end - 1]), f: cur.fingerprint });

  if (args.format === "json") {
    return JSON.stringify({
      total: all.length,
      returned: shown.length,
      range: shown.length ? { from: start + 1, to: page.end } : null,
      complete,
      nextCursor,
      changedSinceFirstPage: cur.changedSinceFirstPage || undefined,
      coverage,
      functions: shown,
    });
  }

  const head = [
    `functions: ${all.length} match the filters` +
      (all.length ? ` — this page ${start + 1}-${page.end}` : "") +
      (complete ? " — COMPLETE (no further pages)" : ` — MORE: call again with cursor="${nextCursor}"`),
    ...renderCoverage(coverage),
    ...(cur.changedSinceFirstPage ? [CHANGED_WARNING] : []),
    "Each entry: lines (line:column when it shares a line) [kind, export/visibility] qualified name; sig; " +
      "id (for spec_nav_read_function); export aliases; doc.",
  ];
  return [...head, ...page.rendered].join("\n");
}

// ---------------------------------------------------------------------------
// Search

export interface FindArgs {
  query: string;
  services?: string[];
  file?: string;
  language?: string;
  searchBodies?: boolean;
  limit?: number;
  cursor?: string;
  format?: "text" | "json";
}

/**
 * Body-only matches beyond this many — and beyond this share of the functions
 * searched — are withheld as noise.
 */
const BODY_ONLY_MIN_CAP = 25;
const BODY_ONLY_SHARE = 0.1;

const TRANSLATION_NOTE =
  "NOTE: Vietnamese words are matched as written (diacritics optional: phí = phi), and words written WITH " +
  "diacritics are also matched through a small built-in Vietnamese→English dictionary of common domain " +
  "terms (shown under `translated`). Anything outside that dictionary is NOT translated: if the code is " +
  "English-named, add English keywords — or run a second, English query.";

export async function findFunctions(args: FindArgs): Promise<string> {
  const { words: q, terms, translated } = parseQuery(args.query);
  if (!q.length) throw new Error(`The query "${args.query}" has no searchable words. Use words from the behaviour you need, e.g. "calculate order fee".`);
  const snap = await snapshot(args.services);
  const fileOk = fileMatcher(args.file);
  const useBody = args.searchBodies ?? true;

  // One pass: every function's term matches, and how many functions each
  // term matches outside a body — its document frequency, for rarity weights.
  let considered = 0;
  const df = terms.map(() => 0);
  const needed = Math.max(1, Math.ceil(terms.length / 2));
  const pending: Array<{ rec: FnRecord; matches: Array<TermMatch | undefined> }> = [];
  for (const fc of snap.files) {
    if (!fileOk(fc.entry.rel)) continue;
    if (args.language && fc.entry.language !== args.language.toLowerCase()) continue;
    for (const f of fc.functions) {
      considered++;
      const matches = matchTerms(terms, f.search, useBody);
      let n = 0;
      matches.forEach((m, i) => {
        if (!m) return;
        n++;
        if (m.field !== "body") df[i]++;
      });
      if (n >= needed) pending.push({ rec: f.rec, matches });
    }
  }
  const weights = idfWeights(df, Math.max(considered, 1));
  type Hit = { rec: FnRecord; score: number; matched: number; reasons: string[]; bodyOnly?: boolean; callsOnly?: boolean };
  let hits: Hit[] = [];
  for (const p of pending) {
    const s = scoreMatches(terms, p.matches, weights);
    if (s) hits.push({ rec: p.rec, ...s });
  }
  // Words found in the bodies of a large share of functions are local-variable
  // vocabulary, not a description of any one of them: withhold those matches
  // and say so, rather than burying the real candidates.
  const bodyOnlyCount = hits.filter((h) => h.bodyOnly).length;
  const bodyOnlyWithheld = bodyOnlyCount > Math.max(BODY_ONLY_MIN_CAP, considered * BODY_ONLY_SHARE) ? bodyOnlyCount : 0;
  if (bodyOnlyWithheld) hits = hits.filter((h) => !h.bodyOnly);
  // Direct matches (name, signature, doc…) first, then matches through what
  // a function calls, then matches only in a body.
  const tier = (h: Hit) => (h.bodyOnly ? 2 : h.callsOnly ? 1 : 0);
  hits.sort((a, b) => tier(a) - tier(b) || b.score - a.score || (sortKey(a.rec) < sortKey(b.rec) ? -1 : 1));
  const nonEnglish = q.filter((w) => /[^\x00-\x7f]/.test(w));

  const qHash = paramsHash({ ...args, cursor: undefined, format: undefined, limit: undefined });
  const cur = decodeCursor(args.cursor, "find", qHash, snap.fingerprint);
  const start = typeof cur.position === "number" ? cur.position : 0;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const page = takePage(hits, start, limit, CHAR_BUDGET - 3000, (h, i) => {
    const r = h.rec;
    const alt = alternativesNote(r);
    return [
      `#${i + 1}  score ${h.score}${h.bodyOnly ? " [body only]" : h.callsOnly ? " [via calls]" : ""}  ${r.file}:${span(r)}  (service ${r.service}, ${r.language})`,
      `    [${flags(r)}] ${r.name}`,
      `    sig: ${r.signature}`,
      `    id:  ${r.id}`,
      ...(r.exportedAs ? [`    exported as: ${r.exportedAs.join(", ")}`] : []),
      `    why: ${h.reasons.join("  ")}`,
      ...(alt ? [`    note: ${alt}`] : []),
      ...(r.doc ? [`    doc: ${r.doc.replace(/\s+/g, " ")}${r.docTruncated ? " [truncated]" : ""}`] : []),
    ].join("\n");
  });
  const complete = page.end >= hits.length;
  const nextCursor = complete ? undefined : encodeCursor({ t: "find", q: qHash, p: page.end, f: cur.fingerprint });
  const coverage = coverageOf(snap);
  const services = [...new Set(hits.map((h) => h.rec.service))];
  const rarity = terms.length > 1
    ? terms.map((t, i) => `${t.label} ×${weights[i].toFixed(2)}`).join(", ")
    : undefined;

  if (args.format === "json") {
    return JSON.stringify({
      query: args.query,
      words: q,
      terms: terms.map((t) => t.label),
      translated: translated.length ? translated : undefined,
      termWeights: terms.length > 1 ? Object.fromEntries(terms.map((t, i) => [t.label, Math.round(weights[i] * 100) / 100])) : undefined,
      ranked: true,
      functionsConsidered: considered,
      totalCandidates: hits.length,
      returned: page.end - start,
      complete,
      nextCursor,
      changedSinceFirstPage: cur.changedSinceFirstPage || undefined,
      servicesWithCandidates: services,
      callsOnlyCandidates: hits.filter((h) => h.callsOnly).length,
      bodyOnlyCandidates: hits.filter((h) => h.bodyOnly).length,
      bodyOnlyWithheld: bodyOnlyWithheld || undefined,
      translationNote: nonEnglish.length ? TRANSLATION_NOTE : undefined,
      coverage,
      candidates: hits.slice(start, page.end).map((h) => ({
        ...h.rec,
        score: h.score,
        matchedWords: h.matched,
        why: h.reasons,
        ...(h.bodyOnly ? { bodyOnly: true } : {}),
        ...(h.callsOnly ? { callsOnly: true } : {}),
      })),
    });
  }
  return [
    `query: "${args.query}" → terms: ${terms.map((t) => t.label).join(", ")}` + (rarity ? `  (rarity weights: ${rarity})` : ""),
    ...(translated.length ? [`translated (built-in dictionary): ${translated.join("; ")}`] : []),
    `RANKED LEXICAL CANDIDATES, not a complete answer: ${hits.length} of ${considered} catalogued functions matched ` +
      `at least half the terms (by name, class/module, signature, doc, path, what it calls${useBody ? ", body" : ""}). ` +
      `Matching is by words, stems, abbreviations, prefixes, common verb synonyms and domain concepts; rarer ` +
      `words weigh more. A function doing the same job under unrelated words can still be missed — try ` +
      `other wording, spec_nav_similar_functions on a candidate or a draft, or browse spec_nav_functions.`,
    `Functions matching only through what they call need every term and are marked [via calls]: they ` +
      `call something with those words (often a wrapper or a caller of the real implementation).`,
    ...(useBody
      ? [`Functions matching only in their body need every word, are marked [body only] and ranked after the rest.` +
          (bodyOnlyWithheld
            ? ` ${bodyOnlyWithheld} body-only matches withheld: those words occur in too many function bodies to ` +
              `tell anything apart — add a more specific word.`
            : "")]
      : []),
    ...(nonEnglish.length ? [TRANSLATION_NOTE] : []),
    ...(services.length ? [`services with candidates: ${services.join(", ")}`] : []),
    hits.length
      ? `showing ${start + 1}-${page.end}` +
        (complete ? " — no further candidates" : ` — MORE: call again with cursor="${nextCursor}"`)
      : "no candidates",
    ...renderCoverage(coverage),
    ...(cur.changedSinceFirstPage ? [CHANGED_WARNING] : []),
    "Reading a candidate does not make it safe to import: check that the calling service may depend on " +
      "the one that owns it before reusing it.",
    "",
    ...page.rendered,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reading one function

export interface ReadArgs {
  id?: string;
  file?: string;
  name?: string;
  line?: number;
  fromLine?: number;
  maxLines?: number;
  /** From a previous part's `nextCursor`: continues there, relative to the function. */
  cursor?: string;
  format?: "text" | "json";
}

/**
 * Where to continue a long function: the function's id, its content hash,
 * and the line *within the function* to resume at. Relative, so a function
 * that moved (lines added above it) is still continued at the right place;
 * the hash, so one that changed is refused instead of read in mismatched parts.
 */
interface ReadCursor {
  t: "read";
  id: string;
  h: string;
  /** 0-based line offset within the function. */
  r: number;
  /** The function's start line when the cursor was issued. */
  s: number;
}

function decodeReadCursor(cursor: string): ReadCursor {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (c.t === "read" && typeof c.id === "string" && typeof c.r === "number") return c;
  } catch {
    // fall through
  }
  throw new Error("Invalid cursor. Pass the `nextCursor` from the previous part of spec_nav_read_function exactly as given.");
}

function parseId(id: string): { file: string; name: string; hash: string } {
  const at = id.lastIndexOf("@");
  const sep = id.indexOf("::");
  if (at < 0 || sep < 0 || sep > at) {
    throw new Error(`"${id}" is not a function id. Ids look like "path/to/file.ts::Class.method@1a2b3c4d" and come from spec_nav_functions or spec_nav_find_functions.`);
  }
  return { file: id.slice(0, sep), name: id.slice(sep + 2, at), hash: id.slice(at + 1) };
}

export class StaleIdError extends Error {}

function idName(ix: Indexed): string {
  return ix.rec.id.slice(ix.rec.id.indexOf("::") + 2, ix.rec.id.lastIndexOf("@"));
}

export async function resolveFunction(args: ReadArgs): Promise<{ fc: FileCatalog; ix: Indexed }> {
  if (args.id) {
    const { file, name, hash } = parseId(args.id);
    const { fc } = await fileCatalog(file);
    if (!fc) {
      throw new StaleIdError(
        `STALE ID: ${file} no longer exists (or is no longer scanned). The function may have moved — ` +
          `look it up again with spec_nav_find_functions or spec_nav_functions.`,
      );
    }
    const sameName = fc.functions.filter((f) => idName(f) === name);
    const exact = sameName.find((f) => f.rec.hash === hash);
    if (exact) return { fc, ix: exact };
    if (sameName.length) {
      throw new StaleIdError(
        `STALE ID: ${name} in ${file} has changed since this id was issued (content hash ${hash} → ` +
          `${sameName[0].rec.hash}). Line numbers and code you saw earlier may be out of date. ` +
          `Current id: ${sameName[0].rec.id} — read it again with that id.`,
      );
    }
    const similar = fc.functions.filter((f) => f.rec.shortName === name.split(".").pop()?.replace(/~\d+$/, ""));
    throw new StaleIdError(
      `STALE ID: no function ${name} in ${file} any more — it was renamed, moved or removed.` +
        (similar.length ? ` Same short name now: ${similar.map((s) => s.rec.id).join(", ")}.` : "") +
        ` Look it up again with spec_nav_functions { file: "${file}" }.`,
    );
  }
  if (!args.file || !args.name) throw new Error("Pass `id`, or `file` and `name` (optionally `line` to pick among same-named functions).");
  const { fc } = await fileCatalog(args.file);
  if (!fc) throw new Error(`No scanned file "${args.file}". Paths are relative to the repo root; spec_nav_functions lists them.`);
  const want = args.name;
  let matches = fc.functions.filter((f) => f.rec.name === want || idName(f) === want);
  if (!matches.length) matches = fc.functions.filter((f) => f.rec.shortName === want || f.rec.name.endsWith("." + want));
  // The name it is exported under: `giveBack` for `module.exports = { giveBack: computeRefund }`.
  if (!matches.length) {
    matches = fc.functions.filter((f) => f.rec.exportedAs?.some((a) => a === want || a.endsWith("." + want)));
  }
  if (args.line !== undefined) {
    const line = args.line;
    const containing = matches.filter((f) => f.rec.start <= line && line <= f.rec.end);
    containing.sort((a, b) => a.rec.end - a.rec.start - (b.rec.end - b.rec.start));
    matches = containing.slice(0, 1);
  }
  if (!matches.length) {
    const names = fc.functions.map((f) => f.rec.name);
    throw new Error(
      `No function "${want}" in ${fc.entry.rel}` +
        (names.length ? `. Functions there: ${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}` : " (no functions catalogued in it)."),
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `"${want}" is ambiguous in ${fc.entry.rel}; pass one of these ids, or a \`line\` inside the one you mean:\n` +
        matches.map((m) => `  ${m.rec.start}-${m.rec.end} ${m.rec.name}  id: ${m.rec.id}`).join("\n"),
    );
  }
  return { fc, ix: matches[0] };
}

/** Import lines the function's body plausibly uses, for non-TS languages. */
function genericImports(fc: FileCatalog, lines: string[], bodyText: string): { imports: string[]; narrowed: boolean } {
  const lang = languageById(fc.entry.language);
  if (!lang) return { imports: [], narrowed: false };
  const inFunction = (i: number) => fc.functions.some((f) => f.rec.start <= i + 1 && i + 1 <= f.rec.end);
  const stmts: string[] = [];
  let inGoBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (inFunction(i)) continue;
    if (lang.id === "go") {
      if (/^\s*import\s*\($/.test(l)) { inGoBlock = true; continue; }
      if (inGoBlock) {
        if (/^\s*\)/.test(l)) { inGoBlock = false; continue; }
        if (l.trim() && !/^\s*\/\//.test(l)) stmts.push(l.trim());
        continue;
      }
      if (/^\s*import\s+/.test(l)) stmts.push(l.trim());
      continue;
    }
    if (!lang.importLine.test(l)) continue;
    let stmt = l.trim();
    // Python `from x import (\n a,\n b\n)`.
    if (stmt.includes("(") && !stmt.includes(")")) {
      while (++i < lines.length) {
        stmt += " " + lines[i].trim();
        if (lines[i].includes(")")) break;
      }
    }
    stmts.push(stmt);
  }
  if (!lang.importsNameIdentifiers) return { imports: stmts, narrowed: false };
  const used = new Set(bodyText.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const KEYWORDS = new Set(["import", "from", "use", "as", "pub", "alias", "require", "static", "crate", "self", "super", "only", "except"]);
  const keep = stmts.filter((s) => {
    let words = s.match(/[A-Za-z_$][\w$]*/g) ?? [];
    // Go: `"github.com/x/pkg"` is used as `pkg.`; an alias comes first.
    if (lang.id === "go") {
      const m = s.match(/^(?:import\s+)?(\w+\s+)?"([^"]+)"/);
      words = m ? [m[1]?.trim() || m[2].split("/").pop()!.replace(/^go-|\.v\d+$/g, "")] : words;
    }
    return words.some((w) => !KEYWORDS.has(w) && used.has(w));
  });
  return { imports: keep, narrowed: true };
}

export async function readFunction(args: ReadArgs): Promise<{ text: string; isError?: boolean }> {
  const cursor = args.cursor ? decodeReadCursor(args.cursor) : undefined;
  let resolved: { fc: FileCatalog; ix: Indexed };
  try {
    // A cursor names the function itself, so later parts need nothing else.
    resolved = await resolveFunction(cursor ? { ...args, id: cursor.id } : args);
  } catch (err) {
    if (!(err instanceof StaleIdError)) throw err;
    return {
      text: cursor
        ? `STALE: the function changed between parts of this read, so the parts would not fit together. ` +
          `Read it again from the start. ${err.message}`
        : err.message,
      isError: true,
    };
  }
  const { fc, ix } = resolved;
  const r = ix.rec;
  const text = readFileSync(fc.entry.abs, "utf8");
  const bodyText = text.slice(ix.startOffset, ix.endOffset);
  // The catalog and this read are two file reads; a write between them would
  // show code the id does not describe.
  if (hashText(bodyText) !== r.hash) {
    return { text: `STALE: ${r.file} changed while it was being read. Look the function up again.`, isError: true };
  }
  const lines = text.split("\n");

  let imports: string[];
  let importsNote: string;
  if (isTsFamily(r.language)) {
    const view = tsParseView(fc.entry.ext, text);
    imports = tsImportsUsed(parseSource(fc.entry.abs, view.text, view.ext), bodyText);
    importsNote = "imports whose bound names appear in this function";
  } else {
    const g = genericImports(fc, lines, bodyText);
    imports = g.imports;
    importsNote = g.narrowed
      ? "file imports whose names appear in this function (best-effort)"
      : "all file-level imports (this language's imports name namespaces, not identifiers, so they are not narrowed)";
  }

  // The function's own text, start column to end column — nothing of a
  // neighbour sharing its first or last line. When only indentation precedes
  // it, that indentation is kept so the lines below still line up.
  const lineStart = text.lastIndexOf("\n", ix.startOffset - 1) + 1;
  const lead = text.slice(lineStart, ix.startOffset);
  const fnLines = ((/^[ \t]*$/.test(lead) ? lead : "") + bodyText).split("\n");

  const notes: string[] = [];
  let from: number;
  if (cursor) {
    from = r.start + cursor.r;
    if (r.start !== cursor.s) {
      notes.push(`The function moved from line ${cursor.s} to ${r.start} since the previous part (its code is ` +
        `unchanged); continuing at the same place in it.`);
    }
  } else {
    from = args.fromLine ?? r.start;
  }
  from = Math.min(Math.max(from, r.start), r.end);
  const maxLines = Math.min(Math.max(args.maxLines ?? 400, 1), 2000);
  const width = String(r.end).length;
  const page = takePage(
    fnLines.slice(from - r.start),
    0,
    maxLines,
    CHAR_BUDGET - 4000,
    (l, i) => `${String(from + i).padStart(width)}| ${l}`,
  );
  const lastShown = from + page.end - 1;
  const complete = lastShown >= r.end;
  const shownAll = from === r.start && complete;
  const nextCursor = complete
    ? undefined
    : Buffer.from(JSON.stringify({ t: "read", id: r.id, h: r.hash, r: lastShown + 1 - r.start, s: r.start } satisfies ReadCursor))
        .toString("base64url");
  const alt = alternativesNote(r);
  if (alt) notes.push(alt);

  if (args.format === "json") {
    return {
      text: JSON.stringify({
        ...r,
        doc: ix.fullDoc,
        docTruncated: undefined,
        imports,
        importsNote,
        source: fnLines.slice(from - r.start, lastShown - r.start + 1).join("\n"),
        shown: { from, to: lastShown },
        complete,
        nextCursor,
        nextFromLine: complete ? undefined : lastShown + 1,
        notes,
      }),
    };
  }
  return {
    text: [
      `${r.name}  [${flags(r)}]`,
      `id:   ${r.id}`,
      `file: ${r.file}:${span(r)}  (service ${r.service}, ${r.language})`,
      `sig:  ${r.signature}${r.returnType && !r.signature.includes(r.returnType) ? ` -> ${r.returnType}` : ""}`,
      ...(r.exportedAs ? [`exported as: ${r.exportedAs.join(", ")}`] : []),
      ...notes.map((n) => `note: ${n}`),
      ...(ix.fullDoc ? ["doc:", ...ix.fullDoc.split("\n").map((l) => `  ${l}`)] : []),
      `imports (${importsNote}):`,
      ...(imports.length ? imports.map((i) => `  ${i}`) : ["  (none found)"]),
      "",
      shownAll
        ? `source: lines ${r.start}-${r.end} (complete)`
        : `source: lines ${from}-${lastShown} of ${r.start}-${r.end}` +
          (complete
            ? " (end of function)"
            : ` — MORE: call again with the same id and fromLine=${lastShown + 1}, or with cursor="${nextCursor}"`),
      ...page.rendered,
      ...(complete
        ? []
        : [`… function continues at line ${lastShown + 1} (to ${r.end}). Prefer cursor="${nextCursor}": it ` +
            `follows the function if lines are added above it and refuses if the function itself changed; ` +
            `fromLine=${lastShown + 1} is a plain file line.`]),
      "",
      "Before reusing this from another service: check that service already depends on (or may depend on) " +
        `${r.service === "." ? "the root project" : r.service}, how it is consumed elsewhere (spec_nav_callers), ` +
        "and that it does what you need in every branch.",
    ].join("\n"),
  };
}

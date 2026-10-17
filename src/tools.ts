import { readFileSync } from "node:fs";
import { scanRepo, filterFiles, pathFilter, fingerprint, isTsFamily, REPO_ROOT, SourceEntry } from "./project.js";
import { languageById } from "./languages.js";
import { loadFailures } from "./treesitter.js";
import { catalogFile, labelRanges, snapshot, coverageOf, fileMatcher, DEFAULT_AROUND } from "./catalog.js";
import { boundariesAt, Place } from "./flow/trace.js";
import { CHAR_BUDGET, CHANGED_WARNING, decodeCursor, encodeCursor, paramsHash, takePage } from "./paging.js";

export interface MapHit {
  line: number;
  /** Enclosing function or method, from the AST — "-" at file scope. */
  enclosing: string;
  /** Last line of the enclosing function: how long a read of it would be. */
  enclosingEnd?: number;
  text: string;
  /** Lines around the hit when `context` was asked for, hits excluded. */
  around?: Array<{ line: number; text: string }>;
}

export interface MapFile {
  file: string;
  service: string;
  /** Config, docs and other non-code text: no functions, listed after code. */
  text?: boolean;
  hits: MapHit[];
}

/** Longest source line shown per hit; longer ones are cut and marked. */
const HIT_TEXT_LIMIT = 160;
/** Most context lines on either side of a hit. */
const MAX_CONTEXT = 10;
/** A read_function batch is suggested when a page names at most this many functions. */
const SUGGEST_READS = 10;
/** Enclosing functions up to this many lines are suggested whole; longer ones as windows. */
const SHORT_FUNCTION = 80;
const WINDOWS_PER_FILE = 12;

const cut = (t: string) => (t.length > HIT_TEXT_LIMIT ? t.slice(0, HIT_TEXT_LIMIT - 1) + "…" : t);

/** Comment and import lines in TypeScript/JavaScript. */
const TS_NOISE = /^\s*(\/\/|\*|\/\*|import\s|export\s*\{)/;

/** Lines matching the pattern, before anything knows what function they are in. */
function matchingLines(
  text: string,
  re: RegExp,
  noise: RegExp,
  includeComments: boolean,
): Array<{ idx: number; text: string }> {
  const matched: Array<{ idx: number; text: string }> = [];
  text.split("\n").forEach((raw, idx) => {
    // CRLF files: without this, `$` never matches a line.
    const lineText = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!re.test(lineText)) return;
    if (!includeComments && noise.test(lineText)) return;
    matched.push({ idx, text: cut(lineText.trim()) });
  });
  return matched;
}

/** Up to `n` lines either side of each hit, the hits themselves left out. */
function withContext(hits: MapHit[], lines: string[], n: number): MapHit[] {
  if (n <= 0) return hits;
  const hitLines = new Set(hits.map((h) => h.line));
  return hits.map((h) => {
    const around: Array<{ line: number; text: string }> = [];
    for (let l = Math.max(1, h.line - n); l <= Math.min(lines.length, h.line + n); l++) {
      if (!hitLines.has(l)) around.push({ line: l, text: cut(lines[l - 1].replace(/\s+$/, "")) });
    }
    return { ...h, around };
  });
}

/**
 * Attach an enclosing-function label to each matching line.
 *
 * Narrowest first, but a name the reader can act on beats precision: a line
 * inside a `.forEach(item => …)` belongs, for their purposes, to the named
 * function that contains the loop.
 */
function labelHits(
  matched: Array<{ idx: number; text: string }>,
  ranges: Array<{ start: number; end: number; name: string; line: number }>,
): MapHit[] {
  return matched.map(({ idx, text: lineText }) => {
    const lineNo = idx + 1;
    let named: (typeof ranges)[number] | undefined;
    let anon: (typeof ranges)[number] | undefined;
    for (const r of ranges) {
      if (r.start > lineNo || lineNo > r.end) continue;
      const span = r.end - r.start;
      if (r.name === "<anonymous>") {
        if (!anon || span < anon.end - anon.start) anon = r;
      } else if (!named || span < named.end - named.start) {
        named = r;
      }
    }
    const best = named ?? anon;
    return best
      ? { line: lineNo, enclosing: `${best.name}:${best.line}`, enclosingEnd: best.end, text: lineText }
      : { line: lineNo, enclosing: "-", text: lineText };
  });
}

export interface MapResult {
  pattern: string;
  servicesScanned: string[];
  languages: string[];
  unparsed: string[];
  totalFiles: number;
  totalHits: number;
  files: MapFile[];
  fingerprint: string;
  filesSearched: number;
  textFilesSearched: number;
  /** The `file` filter, when it left nothing to search although the scope had files. */
  fileFilterMatchedNothing?: string;
}

/**
 * Every line matching `pattern` across the whole repo — or the services named
 * — each tagged with the function it sits in.
 *
 * This is the survey step. Asking one service at a time is how a change that
 * spans six codebases ends up missing two of them, so the default is to scan
 * them all. Every hit is collected; `renderMap` pages through them so a large
 * result is read in parts rather than cut.
 */
export async function mapPattern(
  pattern: string,
  services?: string[],
  opts: { includeComments?: boolean; file?: string; context?: number; includeText?: boolean } = {},
): Promise<MapResult> {
  const scan = scanRepo();
  const fileOk = fileMatcher(opts.file);
  const scoped = filterFiles(scan, services);
  const entries = scoped.filter((e) => fileOk(e.rel));
  const inScope = pathFilter(scan, services);
  const scopedTexts = opts.includeText === false ? [] : scan.texts.filter((e) => inScope(e.rel, e.service));
  const texts = scopedTexts.filter((e) => fileOk(e.rel));
  const fileFilterMatchedNothing =
    opts.file && !entries.length && !texts.length && (scoped.length || scopedTexts.length) ? opts.file : undefined;
  const re = new RegExp(pattern, "i");
  // The whole-file pre-check needs `m`: without it `^` and `$` only match at
  // the start and end of the file, and a file with matching lines is skipped.
  const inFile = new RegExp(pattern, "im");
  const includeComments = opts.includeComments ?? false;
  const context = Math.min(Math.max(opts.context ?? 0, 0), MAX_CONTEXT);

  const out: MapFile[] = [];
  const scanned = new Set<string>();
  const languagesSeen = new Set<string>();
  let totalHits = 0;

  for (const entry of entries) {
    scanned.add(entry.service);
    // Text first: parsing every file to find a handful of hits is nearly all
    // of the runtime, so only files that contain the pattern are parsed.
    let text: string;
    try {
      text = readFileSync(entry.abs, "utf8");
    } catch {
      continue;
    }
    if (!inFile.test(text)) continue;
    const noise = isTsFamily(entry.language) ? TS_NOISE : languageById(entry.language)!.noise;
    const matched = matchingLines(text, re, noise, includeComments);
    if (!matched.length) continue;
    languagesSeen.add(entry.language);
    // No grammar means no function names, but the lines themselves are still
    // the answer to "where is this?" — report them with "-" rather than
    // dropping the file and implying the pattern is not there.
    const fc = await catalogFile(entry);
    const hits = withContext(labelHits(matched, labelRanges(fc)), text.split("\n"), context);
    out.push({ file: entry.rel, service: entry.service, hits });
    totalHits += hits.length;
  }

  // Config and docs after the code: on a long map the first page is the code,
  // and the rest still says which settings and docs name the same thing.
  const NO_NOISE = /(?!)/;
  for (const entry of texts) {
    scanned.add(entry.service);
    let text: string;
    try {
      text = readFileSync(entry.abs, "utf8");
    } catch {
      continue;
    }
    if (!inFile.test(text)) continue;
    const matched = matchingLines(text, re, NO_NOISE, true);
    if (!matched.length) continue;
    languagesSeen.add("text");
    const hits = withContext(
      matched.map(({ idx, text: t }) => ({ line: idx + 1, enclosing: "-", text: t })),
      text.split("\n"),
      context,
    );
    out.push({ file: entry.rel, service: entry.service, text: true, hits });
    totalHits += hits.length;
  }

  return {
    pattern,
    servicesScanned: [...scanned].sort(),
    languages: [...languagesSeen].sort(),
    // A grammar that would not load is reported, not hidden: silently
    // unlabelled output looks the same as code with no functions in it.
    unparsed: loadFailures().map((f) => `${f.id} (${f.reason})`),
    totalFiles: out.length,
    totalHits,
    files: out,
    fingerprint: fingerprint([...entries, ...texts]),
    filesSearched: entries.length,
    textFilesSearched: texts.length,
    fileFilterMatchedNothing,
  };
}

/**
 * Render one page of a map as flat text.
 *
 * JSON repeats a field name on every hit, which on a few hundred matches costs
 * more than the content. One line per hit reads the same and is half the size.
 *
 * Pages are cut by hit, in file order, and never drop anything: when the map
 * does not fit, the first page also carries the full list of files with their
 * hit counts (when that fits), so which services are involved is visible at
 * once and the detail follows page by page.
 */
export function renderMap(
  result: MapResult,
  args: {
    cursor?: string;
    services?: string[];
    includeComments?: boolean;
    pageSize?: number;
    file?: string;
    context?: number;
    includeText?: boolean;
  } = {},
): string {
  // Nothing scanned is not the same as nothing found, and the two look alike
  // once the output says "0 hits". Say which one it was.
  if (result.fileFilterMatchedNothing) {
    return [
      `pattern: ${result.pattern}`,
      `scanned: NOTHING — \`file\` "${result.fileFilterMatchedNothing}" matched no file in scope.`,
      ``,
      `This is not "the pattern is absent": nothing was searched. \`file\` is a path`,
      `substring ("services/order"), a glob ("be/*/src/**/*.ts"), or a regex — "/…/", or any`,
      `value with | ( ^ $ \\ ("services/(order|payment)"). Paths are relative to the root, e.g.`,
      `"be/BEXMP-order/src/services/order.ts". Drop \`file\` to search everything.`,
    ].join("\n");
  }
  if (!result.servicesScanned.length) {
    return [
      `pattern: ${result.pattern}`,
      `scanned: NOTHING — no project under the root held a file in a supported language.`,
      ``,
      `This is not "the pattern is absent": nothing was searched. Check that`,
      `SPEC_NAV_ROOT is the right repo, and that it contains source in one of the`,
      `supported languages (spec_nav_services lists what was found).`,
    ].join("\n");
  }

  type Item = { file: string; hit: MapHit; fileHits: number; text: boolean };
  const flat: Item[] = [];
  for (const f of result.files) for (const h of f.hits) flat.push({ file: f.file, hit: h, fileHits: f.hits.length, text: !!f.text });
  // Code sorts before text, as it is listed; the key keeps that order.
  const key = (i: Item) => `${i.text ? 1 : 0}\u0000${i.file}\u0000${String(i.hit.line).padStart(8, "0")}`;

  const qHash = paramsHash({
    p: result.pattern, s: args.services ?? null, c: !!args.includeComments,
    f: args.file ?? null, x: args.context ?? 0, t: args.includeText !== false,
  });
  const cur = decodeCursor(args.cursor, "map", qHash, result.fingerprint);
  let start = 0;
  if (typeof cur.position === "string") {
    const after = cur.position;
    start = flat.findIndex((i) => key(i) > after);
    if (start < 0) start = flat.length;
  }

  // The census of files is worth its space only on the first page of a
  // multi-page map, and only if it leaves room for hits.
  const census = result.files.map((f) => `  ${String(f.hits.length).padStart(4)} | ${f.file}`);
  const censusChars = census.reduce((a, l) => a + l.length + 1, 0);
  const firstPage = start === 0;

  const build = (withCensus: boolean) => {
    const budget = CHAR_BUDGET - 1500 - (withCensus ? censusChars : 0);
    let lastFile = start > 0 ? flat[start - 1].file : "";
    // Context lines already shown in this file: neighbouring hits share them.
    let shown = new Set<number>();
    const page = takePage(flat, start, args.pageSize ?? Number.MAX_SAFE_INTEGER, budget, (i) => {
      let header = "";
      if (i.file !== lastFile) {
        header = `\n${i.file}${i.fileHits > 1 ? `  (${i.fileHits} hits)` : ""}${i.text ? "  [text: no functions]" : ""}\n`;
        shown = new Set();
      }
      lastFile = i.file;
      const ctx = (pick: (l: number) => boolean) =>
        (i.hit.around ?? [])
          .filter((a) => pick(a.line) && !shown.has(a.line))
          .map((a) => (shown.add(a.line), `  ${a.line} : ${a.text}`));
      const before = ctx((l) => l < i.hit.line);
      const after = ctx((l) => l > i.hit.line);
      return [header + [...before, `  ${i.hit.line} | ${i.hit.enclosing} | ${i.hit.text}`].join("\n"), ...after].join("\n");
    });
    // A page that starts mid-file says so, so it is not read as the file's first hit.
    if (start > 0 && flat[start] && flat[start - 1].file === flat[start].file) {
      page.rendered.unshift(`\n${flat[start].file}  (continued)`);
    }
    return page;
  };

  let page = build(false);
  const complete = page.end >= flat.length;
  let withCensus = false;
  if (firstPage && !complete && censusChars <= CHAR_BUDGET * 0.4) {
    withCensus = true;
    page = build(true);
  }
  const done = page.end >= flat.length;
  const nextCursor = done
    ? undefined
    : encodeCursor({ t: "map", q: qHash, p: key(flat[page.end - 1]), f: cur.fingerprint });

  const header = [
    `pattern: ${result.pattern}`,
    `scanned: ${result.filesSearched} code files` +
      (result.textFilesSearched ? ` + ${result.textFilesSearched} text files (config, docs, SQL…)` : "") +
      ` in ${result.servicesScanned.length} project(s): ${result.servicesScanned.join(", ")}`,
    // Which languages were read is worth a line: it is how you notice that
    // the Go service you expected in the results was never parsed.
    ...(result.languages.length ? [`languages with hits: ${result.languages.join(", ")}`] : []),
    ...(result.unparsed.length ? [`NOT PARSED (hits shown without function names): ${result.unparsed.join("; ")}`] : []),
    `${result.totalHits} hits in ${result.totalFiles} files` +
      (flat.length
        ? ` — this page: hits ${start + 1}-${page.end}` +
          (done ? " — COMPLETE" : ` — MORE: call again with the same pattern and cursor="${nextCursor}"`)
        : ""),
    ...(cur.changedSinceFirstPage ? [CHANGED_WARNING] : []),
    ...(firstPage && !done && !withCensus
      ? [`(${result.totalFiles} files — too many to list on this page; they follow in order across pages.)`]
      : []),
  ];
  const onPage = flat.slice(start, page.end);
  // Service boundaries on this page, answered here rather than suggested: from
  // the flow graph once it is built; until then, the trace_flow call to make.
  const boundaries = boundariesAt(onPage.filter((i) => !i.text).map((i) => placeOf(i.file, i.hit)));
  const parts = [...header];
  if (boundaries?.length) parts.push("", "Service boundaries on this page (static flow graph; spec_nav_trace_flow for the whole chain):", ...boundaries.map((b) => `  ${b}`));
  if (withCensus) parts.push("", "All files with hits (count | file):", ...census);
  parts.push(
    "",
    "Format:  line | enclosing function:its line | source" + (args.context ? "   (context lines:  line : source)" : ""),
    ...page.rendered,
  );
  const next = [suggestReads(onPage), ...(boundaries ? [] : suggestTraces(onPage))].filter((s): s is string => !!s);
  if (next.length) parts.push("", ...next);
  return parts.join("\n");
}

/** A map hit as a place for the flow graph: file, line, and the function it is in. */
function placeOf(file: string, hit: MapHit): Place {
  const at = hit.enclosing.lastIndexOf(":");
  if (at <= 0) return { file, line: hit.line };
  const name = hit.enclosing.slice(0, at);
  return { file, line: hit.line, fnName: name.split(".").pop(), fnLine: Number(hit.enclosing.slice(at + 1)) };
}

/** An HTTP client call in a source line: axios, fetch, got, ky, an http service. */
export const HTTP_CALL =
  /\b(?:axios|fetch|got|ky|superagent)(?:\s*\.\s*(?:get|post|put|patch|delete|head|request))?\s*(?:<[^>]*>)?\s*\(|\bhttp(?:Service|Client)?\s*\.\s*(?:get|post|put|patch|delete|request)\s*(?:<[^>]*>)?\s*\(/i;
/** A file-based endpoint handler: Next.js/Medusa/SvelteKit route files, pages/api. */
export const ROUTE_FILE = /(^|\/)(api|app|routes)\/(.*\/)?(route|\+server)\.[cm]?[jt]sx?$|(^|\/)pages\/api\//;

/**
 * Where a hit crosses a service boundary, the next question is what is on the
 * other side — which spec_nav_trace_flow answers in one call. Agents did not
 * reach for it on their own, so the page offers it, at most once per kind.
 */
function suggestTraces(items: Array<{ file: string; hit: MapHit; text: boolean }>): string[] {
  const out: string[] = [];
  const named = (i: { hit: MapHit }) => {
    const at = i.hit.enclosing.lastIndexOf(":");
    const name = at > 0 ? i.hit.enclosing.slice(0, at) : "";
    return name && name !== "<anonymous>" ? name : undefined;
  };
  const client = items.find((i) => !i.text && named(i) && HTTP_CALL.test(i.hit.text));
  if (client) {
    out.push(
      `Next — ${client.file}:${client.hit.line} makes an HTTP call; which service and handler receive it: ` +
        `spec_nav_trace_flow ${JSON.stringify({ file: client.file, name: named(client), direction: "downstream" })}`,
    );
  }
  const route = items.find((i) => !i.text && named(i) && ROUTE_FILE.test(i.file));
  if (route) {
    out.push(
      `Next — ${route.file} is an endpoint handler; who calls it, across services: ` +
        `spec_nav_trace_flow ${JSON.stringify({ file: route.file, name: named(route), direction: "upstream" })}`,
    );
  }
  return out;
}

/**
 * The read that usually follows a focused map, ready to send, in one batch:
 * a short enclosing function whole, and for a long one (a 1,000-line component
 * or route handler) or a file-scope hit, only the lines around the hits — what
 * agents otherwise fetch with one Read per window. Left out when the page
 * spans too many places to be a focused result: narrowing the pattern is the
 * better next step then.
 */
function suggestReads(items: Array<{ file: string; hit: MapHit; text: boolean }>): string | undefined {
  const whole = new Map<string, { file: string; name: string; line: number }>();
  const windows = new Map<string, { file: string; lines: number[] }>();
  for (const i of items) {
    if (i.text) continue;
    const at = i.hit.enclosing.lastIndexOf(":");
    const name = at > 0 ? i.hit.enclosing.slice(0, at) : "";
    const start = at > 0 ? Number(i.hit.enclosing.slice(at + 1)) : 0;
    const length = i.hit.enclosingEnd ? i.hit.enclosingEnd - start + 1 : Infinity;
    if (name && name !== "<anonymous>" && length <= SHORT_FUNCTION) {
      whole.set(`${i.file}\u0000${i.hit.enclosing}`, { file: i.file, name, line: start });
    } else {
      const w = windows.get(i.file) ?? { file: i.file, lines: [] };
      if (w.lines.length < WINDOWS_PER_FILE) w.lines.push(i.hit.line);
      windows.set(i.file, w);
    }
  }
  const functions = [...whole.values(), ...windows.values()];
  if (!functions.length || functions.length > SUGGEST_READS) return undefined;
  const what = [
    whole.size ? `${whole.size} short function${whole.size === 1 ? "" : "s"} whole` : "",
    windows.size ? `±${DEFAULT_AROUND} lines around the hits in ${windows.size} file${windows.size === 1 ? "" : "s"} (long functions are not read whole)` : "",
  ].filter(Boolean).join(", ");
  return `Next — read them in one call (${what}): spec_nav_read_function ${JSON.stringify({ functions })}`;
}

/** The projects discoverable under the root, with what each holds. */
export async function listServices(): Promise<unknown> {
  const snap = await snapshot();
  const per = new Map<string, { files: number; functions: number; languages: Set<string> }>();
  for (const s of snap.scan.services) per.set(s, { files: 0, functions: 0, languages: new Set() });
  for (const fc of snap.files) {
    const p = per.get(fc.entry.service) ?? { files: 0, functions: 0, languages: new Set<string>() };
    p.files++;
    p.functions += fc.functions.length;
    p.languages.add(fc.entry.language);
    per.set(fc.entry.service, p);
  }
  const coverage = coverageOf(snap);
  return {
    root: REPO_ROOT,
    services: snap.scan.services,
    details: [...per].map(([service, p]) => ({
      service,
      files: p.files,
      functions: p.functions,
      languages: [...p.languages].sort(),
    })),
    note:
      "Each file belongs to exactly one service: the innermost project directory holding it. " +
      '"." is the root\'s own files (those outside every sub-project).',
    coverage: coverage.summary,
  };
}

export type { SourceEntry };

import { readFileSync } from "node:fs";
import { scanRepo, filterFiles, fingerprint, isTsFamily, REPO_ROOT, SourceEntry } from "./project.js";
import { languageById } from "./languages.js";
import { loadFailures } from "./treesitter.js";
import { catalogFile, labelRanges, snapshot, coverageOf } from "./catalog.js";
import { CHAR_BUDGET, CHANGED_WARNING, decodeCursor, encodeCursor, paramsHash, takePage } from "./paging.js";

export interface MapHit {
  line: number;
  /** Enclosing function or method, from the AST — "-" at file scope. */
  enclosing: string;
  text: string;
}

export interface MapFile {
  file: string;
  service: string;
  hits: MapHit[];
}

/** Longest source line shown per hit; longer ones are cut and marked. */
const HIT_TEXT_LIMIT = 160;

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
  text.split("\n").forEach((lineText, idx) => {
    if (!re.test(lineText)) return;
    if (!includeComments && noise.test(lineText)) return;
    const t = lineText.trim();
    matched.push({ idx, text: t.length > HIT_TEXT_LIMIT ? t.slice(0, HIT_TEXT_LIMIT - 1) + "…" : t });
  });
  return matched;
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
    return { line: lineNo, enclosing: best ? `${best.name}:${best.line}` : "-", text: lineText };
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
  opts: { includeComments?: boolean } = {},
): Promise<MapResult> {
  const scan = scanRepo();
  const entries = filterFiles(scan, services);
  const re = new RegExp(pattern, "i");
  const includeComments = opts.includeComments ?? false;

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
    if (!re.test(text)) continue;
    const noise = isTsFamily(entry.language) ? TS_NOISE : languageById(entry.language)!.noise;
    const matched = matchingLines(text, re, noise, includeComments);
    if (!matched.length) continue;
    languagesSeen.add(entry.language);
    // No grammar means no function names, but the lines themselves are still
    // the answer to "where is this?" — report them with "-" rather than
    // dropping the file and implying the pattern is not there.
    const fc = await catalogFile(entry);
    const hits = labelHits(matched, labelRanges(fc));
    out.push({ file: entry.rel, service: entry.service, hits });
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
    fingerprint: fingerprint(entries),
    filesSearched: entries.length,
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
  args: { cursor?: string; services?: string[]; includeComments?: boolean; pageSize?: number } = {},
): string {
  // Nothing scanned is not the same as nothing found, and the two look alike
  // once the output says "0 hits". Say which one it was.
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

  const flat: Array<{ file: string; hit: MapHit; fileHits: number }> = [];
  for (const f of result.files) for (const h of f.hits) flat.push({ file: f.file, hit: h, fileHits: f.hits.length });
  const key = (i: { file: string; hit: MapHit }) => `${i.file}\u0000${String(i.hit.line).padStart(8, "0")}`;

  const qHash = paramsHash({ p: result.pattern, s: args.services ?? null, c: !!args.includeComments });
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
    const page = takePage(flat, start, args.pageSize ?? Number.MAX_SAFE_INTEGER, budget, (i) => {
      const header =
        i.file !== lastFile
          ? `\n${i.file}${i.fileHits > 1 ? `  (${i.fileHits} hits)` : ""}\n`
          : "";
      lastFile = i.file;
      return `${header}  ${i.hit.line} | ${i.hit.enclosing} | ${i.hit.text}`;
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
    `scanned: ${result.filesSearched} files in ${result.servicesScanned.length} project(s): ${result.servicesScanned.join(", ")}`,
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
  const parts = [...header];
  if (withCensus) parts.push("", "All files with hits (count | file):", ...census);
  parts.push("", "Format:  line | enclosing function:its line | source", ...page.rendered);
  return parts.join("\n");
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

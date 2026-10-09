import { SyntaxKind, Project } from "ts-morph";
import { readFileSync, readdirSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin, extname, relative } from "node:path";
import {
  getProject,
  relPath,
  enclosingFunction,
  discoverServices,
  REPO_ROOT,
  SKIP_DIRS,
  EnclosingInfo,
} from "./project.js";
import { languageForExt, PARSEABLE_EXTENSIONS } from "./languages.js";
import { parseFile, functionRanges, enclosingRange, loadFailures } from "./treesitter.js";

/**
 * Shared with the project walker on purpose. Two lists that have to agree is a
 * list that eventually does not: a directory added to one and not the other
 * shows up as files appearing in a scan but their project never being listed.
 */
const SCAN_SKIP = SKIP_DIRS;

/** TypeScript, which goes through ts-morph rather than tree-sitter. */
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** Every extension we can attach a function name to. */
const SCANNABLE = new Set<string>([...TS_EXTENSIONS, ...PARSEABLE_EXTENSIONS]);

/** Absolute paths of the source files under a directory, by extension. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SCAN_SKIP.has(e.name) || e.name.startsWith(".")) continue;
        walk(pathJoin(d, e.name));
      } else if (e.isFile()) {
        // A .d.ts is generated declarations; a hit there is the type of the
        // thing, never the thing itself.
        if (e.name.endsWith(".d.ts")) continue;
        if (SCANNABLE.has(extname(e.name).toLowerCase())) out.push(pathJoin(d, e.name));
      }
    }
  };
  walk(dir);
  return out;
}


export interface CallSite {
  file: string;
  line: number;
  enclosing: string;
  enclosingLine: number;
  /** The enclosing function's parameters — is the value you need already here? */
  enclosingParams: string[];
  /** How many arguments this call site passes. */
  argCount: number;
  /** The call site's text, truncated. */
  snippet: string;
}

/**
 * Every call to `symbol`, with the enclosing function and its parameters.
 *
 * This is what you need before changing a signature: at each site, is the
 * value already in scope, and how many arguments are being passed?
 */
export function findCallers(service: string, symbol: string): {
  symbol: string;
  total: number;
  sites: CallSite[];
} {
  const project = getProject(service);
  const sites: CallSite[] = [];

  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath().includes("node_modules")) continue;
    // Only walk files whose text contains the name — far cheaper than every AST.
    if (!sf.getFullText().includes(symbol)) continue;

    sf.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const call = node.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression();
      const calleeName = expr.getKind() === SyntaxKind.PropertyAccessExpression
        ? expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName()
        : expr.getText();
      if (calleeName !== symbol) return;

      const enc: EnclosingInfo = enclosingFunction(call);
      sites.push({
        file: relPath(sf),
        line: call.getStartLineNumber(),
        enclosing: enc.name,
        enclosingLine: enc.line,
        enclosingParams: enc.params,
        argCount: call.getArguments().length,
        snippet: call.getText().replace(/\s+/g, " ").slice(0, 120),
      });
    });
  }

  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { symbol, total: sites.length, sites };
}





export interface MapHit {
  line: number;
  /** Enclosing function or method, from the AST — "-" at file scope. */
  enclosing: string;
  text: string;
}

export interface MapFile {
  file: string;
  hits: MapHit[];
}

interface LineRange {
  start: number;
  end: number;
  name: string;
  line: number;
}

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
    matched.push({ idx, text: lineText.trim().slice(0, 160) });
  });
  return matched;
}

/** TypeScript function ranges, via ts-morph. */
function tsFunctionRanges(sf: import("ts-morph").SourceFile): LineRange[] {
  const ranges: LineRange[] = [];
  sf.forEachDescendant((node) => {
    const k = node.getKind();
    if (
      k !== SyntaxKind.FunctionDeclaration &&
      k !== SyntaxKind.MethodDeclaration &&
      k !== SyntaxKind.ArrowFunction &&
      k !== SyntaxKind.FunctionExpression &&
      k !== SyntaxKind.Constructor
    ) {
      return;
    }
    let name: string | undefined = (node as any).getName?.();
    if (!name) {
      // An arrow or function expression carries no name of its own; the
      // one people use is on the variable or property it is assigned to.
      const varDecl = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      const propAssign = node.getFirstAncestorByKind(SyntaxKind.PropertyAssignment);
      name = varDecl?.getName() ?? propAssign?.getName();
    }
    if (!name && node.getKind() === SyntaxKind.Constructor) name = "constructor";
    ranges.push({
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
      name: name || "<anonymous>",
      line: node.getStartLineNumber(),
    });
  });
  return ranges;
}

/** Attach an enclosing-function label to each matching line. */
function labelHits(
  matched: Array<{ idx: number; text: string }>,
  ranges: LineRange[],
): MapHit[] {
  return matched.map(({ idx, text: lineText }) => {
    const lineNo = idx + 1;
    // Narrowest first, but a name the reader can act on beats precision:
    // a line inside a `.forEach(item => …)` belongs, for their purposes,
    // to the named function that contains the loop.
    let named: LineRange | undefined;
    let anon: LineRange | undefined;
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
    return {
      line: lineNo,
      enclosing: best ? `${best.name}:${best.line}` : "-",
      text: lineText,
    };
  });
}

/**
 * Every line matching `pattern` across the whole repo — or the services named
 * — each tagged with the function it sits in.
 *
 * This is the survey step. Asking one service at a time is how a change that
 * spans six codebases ends up missing two of them, so the default is to scan
 * them all. Nothing is truncated: the point is to see everything once rather
 * than discover it over twenty narrowing searches.
 *
 * TypeScript goes through ts-morph and everything else through tree-sitter.
 * Both produce the same thing — a line, its text, and the function around it
 * — so a polyglot repo reads as one list rather than one per language.
 */
export async function mapPattern(
  pattern: string,
  services?: string[],
  opts: { includeComments?: boolean; maxFiles?: number } = {},
): Promise<{
  pattern: string;
  servicesScanned: string[];
  languages: string[];
  unparsed: string[];
  totalFiles: number;
  totalHits: number;
  truncated: boolean;
  files: MapFile[];
}> {
  const targets = services?.length ? services : discoverServices();
  const re = new RegExp(pattern, "i");
  // Comments and imports mention a symbol without using it; they pad the
  // output and send the reader to the wrong line.
  const tsNoise = /^\s*(\/\/|\*|\/\*|import\s|export\s*\{)/;
  const includeComments = opts.includeComments ?? false;

  const out: MapFile[] = [];
  const scanned: string[] = [];
  const languagesSeen = new Set<string>();
  let totalHits = 0;
  const maxFiles = opts.maxFiles ?? 400;

  for (const service of targets) {
    // Find candidate files by reading text off disk. Parsing every file first
    // — whether into a ts-morph AST or a tree-sitter tree — costs thousands of
    // parses for a handful of hits, and that parse is nearly all the runtime.
    const candidates = listSourceFiles(pathResolve(REPO_ROOT, service));
    if (!candidates.length) continue;
    scanned.push(service);

    const withHits = candidates.filter((abs) => {
      try {
        return re.test(readFileSync(abs, "utf8"));
      } catch {
        return false;
      }
    });
    if (!withHits.length) continue;

    const tsHits = withHits.filter((f) => TS_EXTENSIONS.has(extname(f).toLowerCase()));
    const otherHits = withHits.filter((f) => !TS_EXTENSIONS.has(extname(f).toLowerCase()));

    // --- TypeScript, through ts-morph ---
    if (tsHits.length) {
      languagesSeen.add("typescript");
      // Only now is a project worth building, and only these files go into it.
      const project = new Project({
        skipFileDependencyResolution: true,
        useInMemoryFileSystem: false,
      });
      for (const abs of tsHits) {
        try {
          project.addSourceFileAtPath(abs);
        } catch {
          /* unreadable or not valid TS; skip */
        }
      }

      for (const sf of project.getSourceFiles()) {
        const matched = matchingLines(sf.getFullText(), re, tsNoise, includeComments);
        if (!matched.length) continue;
        const hits = labelHits(matched, tsFunctionRanges(sf));
        if (hits.length) {
          out.push({ file: relPath(sf), hits });
          totalHits += hits.length;
        }
      }
    }

    // --- Everything else, through tree-sitter ---
    for (const abs of otherHits) {
      const lang = languageForExt(extname(abs));
      if (!lang) continue;

      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }

      const matched = matchingLines(text, re, lang.noise, includeComments);
      if (!matched.length) continue;

      const root = await parseFile(text, lang);
      // No grammar means no function names, but the lines themselves are
      // still the answer to "where is this?" — report them with "-" rather
      // than dropping the file and implying the pattern is not there.
      const ranges = root ? functionRanges(root, lang) : [];
      languagesSeen.add(lang.id);

      const hits: MapHit[] = matched.map(({ idx, text: lineText }) => {
        const found = enclosingRange(ranges, idx + 1);
        return {
          line: idx + 1,
          enclosing: found ? `${found.name}:${found.line}` : "-",
          text: lineText,
        };
      });

      out.push({ file: relative(REPO_ROOT, abs), hits });
      totalHits += hits.length;
    }
  }

  out.sort((a, b) => a.file.localeCompare(b.file));
  const truncated = out.length > maxFiles;
  return {
    pattern,
    servicesScanned: scanned,
    languages: [...languagesSeen].sort(),
    // A grammar that would not load is reported, not hidden: silently
    // unlabelled output looks the same as code with no functions in it.
    unparsed: loadFailures().map((f) => `${f.id} (${f.reason})`),
    totalFiles: out.length,
    totalHits,
    truncated,
    files: truncated ? out.slice(0, maxFiles) : out,
  };
}

/**
 * Render a map as flat text.
 *
 * JSON repeats a field name on every hit, which on a few hundred matches costs
 * more than the content. One line per hit reads the same and is half the size.
 */
/** Roughly the point where a tool result stops fitting in a reply. */
const RENDER_CHAR_BUDGET = 30_000;
/** Lines kept per file once the budget forces a trim. */
const TRIMMED_HITS_PER_FILE = 6;

export function renderMap(result: Awaited<ReturnType<typeof mapPattern>>): string {
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

  const header = (note?: string) => [
    `pattern: ${result.pattern}`,
    `scanned: ${result.servicesScanned.join(", ")}`,
    // Which languages were read is worth a line: it is how you notice that
    // the Go service you expected in the results was never parsed.
    ...(result.languages.length ? [`languages: ${result.languages.join(", ")}`] : []),
    ...(result.unparsed.length ? [`NOT PARSED: ${result.unparsed.join("; ")}`] : []),
    `${result.totalHits} hits in ${result.totalFiles} files` +
      (result.truncated ? "  [FILE LIMIT REACHED]" : ""),
    ...(note ? [note] : []),
    "",
    "Format:  line | enclosing function | source",
  ];

  const body = (perFile?: number) => {
    const lines: string[] = [];
    for (const f of result.files) {
      lines.push("", f.file + (perFile && f.hits.length > perFile ? `  (${f.hits.length} hits)` : ""));
      const shown = perFile ? f.hits.slice(0, perFile) : f.hits;
      for (const h of shown) lines.push(`  ${h.line} | ${h.enclosing} | ${h.text}`);
      if (perFile && f.hits.length > perFile) {
        lines.push(`  … ${f.hits.length - perFile} more in this file`);
      }
    }
    return lines;
  };

  const full = [...header(), ...body()].join("\n");
  if (full.length <= RENDER_CHAR_BUDGET) return full;

  // A broad pattern over a large repo overflows what a reply can carry. Keep
  // every file — knowing a service is involved is the point of the map — but
  // show fewer lines of each.
  //
  // Stepping down and re-measuring matters: a fixed lines-per-file is not a
  // budget. A pattern like `toFixed\(` hits 330 files, and six lines each is
  // still three times over, so the trim has to answer "does it fit now?"
  // rather than "have I trimmed?".
  for (const perFile of [TRIMMED_HITS_PER_FILE, 3, 2, 1]) {
    const text = [
      ...header(
        `NOTE: output trimmed to ~${perFile} line${perFile === 1 ? "" : "s"} per file. ` +
          `Every file is listed; read the ones that matter, or re-run with a ` +
          `narrower pattern.`,
      ),
      ...body(perFile),
    ].join("\n");
    if (text.length <= RENDER_CHAR_BUDGET) return text;
  }

  // Even one line each does not fit, so the pattern is too broad to be a map.
  // Drop to a file census: which files and how many hits, no source text. That
  // still answers "what does this touch?", which is the question, and it says
  // plainly that the pattern needs narrowing.
  const census = [
    ...header(
      `NOTE: too many matches to show any source. Listing files and hit counts ` +
        `only — narrow the pattern (this one matches too much to be a map).`,
    ),
  ];
  for (const f of result.files) {
    census.push(`  ${String(f.hits.length).padStart(4)} | ${f.file}`);
  }
  const censusText = census.join("\n");
  if (censusText.length <= RENDER_CHAR_BUDGET) return censusText;

  // Still over: keep the files with the most hits and say how many were cut,
  // so the number is never silently wrong.
  const ranked = [...result.files].sort((a, b) => b.hits.length - a.hits.length);
  const kept: string[] = [];
  let used = 0;
  const limit = RENDER_CHAR_BUDGET - 600; // room for the header and the note
  for (const f of ranked) {
    const line = `  ${String(f.hits.length).padStart(4)} | ${f.file}`;
    if (used + line.length > limit) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [
    ...header(
      `NOTE: ${result.files.length} files matched — too many to list. Showing the ` +
        `${kept.length} with the most hits, ${result.files.length - kept.length} omitted. ` +
        `Narrow the pattern.`,
    ),
    ...kept,
  ].join("\n");
}

/** The TypeScript projects discoverable under the root. */
export function listServices(): { root: string; services: string[] } {
  return { root: process.env.SPEC_NAV_ROOT ?? process.cwd(), services: discoverServices() };
}

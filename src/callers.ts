import { Project, Node, SyntaxKind, ts, SourceFile } from "ts-morph";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import {
  scanRepo,
  filterFiles,
  enclosingFunction,
  relPath as realRelPath,
  isTsFamily,
  REPO_ROOT,
  SourceEntry,
  RepoScan,
  normaliseService,
} from "./project.js";
import { scriptKindFor, WRAPPERS } from "./tsparse.js";
import { CHAR_BUDGET, decodeCursor, encodeCursor, paramsHash, takePage } from "./paging.js";
import { fingerprint } from "./project.js";
import { SFC_EXTENSIONS, tsParseView, extractSfcScript } from "./sfc.js";
import { snapshot, DEFAULT_AROUND } from "./catalog.js";
import { boundariesAt } from "./flow/trace.js";
import { polyCallers, polyTarget, PolySite, PolyTarget } from "./polycallers.js";
import { isDynamicCallee, NameAsString } from "./dynamic.js";
import { HTTP_CALL, ROUTE_FILE } from "./tools.js";

/**
 * A Vue/Svelte/Astro component joins the TypeScript project as its script,
 * under this suffix — same directory, so its relative imports resolve, and
 * same offsets, so every line reported is the component's own.
 */
const SFC_SUFFIX = ".__spec_nav_sfc__.ts";

function tsPathOf(e: { abs: string; ext: string }): string {
  return SFC_EXTENSIONS.has(e.ext) ? e.abs + SFC_SUFFIX : e.abs;
}

function realPath(p: string): string {
  return p.endsWith(SFC_SUFFIX) ? p.slice(0, -SFC_SUFFIX.length) : p;
}

function relPath(abs: string): string {
  return realRelPath(realPath(abs));
}

/**
 * Call sites resolved through the TypeScript type checker.
 *
 * Name matching is what this replaced, and it is wrong in both directions: it
 * lists `cart.total()` when you asked about `Order.total`, and misses
 * `import { total as orderTotal }`. Here each candidate call is resolved to
 * the declaration it actually binds to, and anything the checker cannot
 * resolve (an untyped receiver in plain JS, an `any`) is reported as
 * unresolved rather than silently counted or dropped.
 */

// ---------------------------------------------------------------------------
// Module resolution: each file uses its own nearest tsconfig/jsconfig (so its
// `paths` aliases work), and a workspace package imported by name resolves to
// that package's source rather than to its built output.

const configCache = new Map<string, ts.CompilerOptions>();

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

function nearestConfig(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const c = path.join(dir, name);
      if (existsSync(c)) return c;
    }
    if (dir === REPO_ROOT || !dir.startsWith(REPO_ROOT)) return undefined;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function optionsFor(file: string): ts.CompilerOptions {
  const cfg = nearestConfig(file);
  if (!cfg) return DEFAULT_OPTIONS;
  const cached = configCache.get(cfg);
  if (cached) return cached;
  let opts = DEFAULT_OPTIONS;
  try {
    const read = ts.readConfigFile(cfg, ts.sys.readFile);
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(cfg), undefined, cfg);
      opts = { ...DEFAULT_OPTIONS, ...parsed.options, allowJs: true, noEmit: true, types: [] };
      // Bundler resolution is only valid with an ES module setting.
      if (opts.moduleResolution === ts.ModuleResolutionKind.Bundler &&
          opts.module !== undefined && opts.module < ts.ModuleKind.ES2015) {
        opts.moduleResolution = ts.ModuleResolutionKind.Node10;
      }
    }
  } catch {
    /* an unreadable config falls back to defaults */
  }
  configCache.set(cfg, opts);
  return opts;
}

/** tsconfig files can change between calls; forget what was read. */
export function clearConfigCache(): void {
  configCache.clear();
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function extensionOf(file: string): ts.Extension {
  if (file.endsWith(".d.ts")) return ts.Extension.Dts;
  const ext = path.extname(file);
  const map: Record<string, ts.Extension> = {
    ".ts": ts.Extension.Ts, ".tsx": ts.Extension.Tsx, ".js": ts.Extension.Js, ".jsx": ts.Extension.Jsx,
    ".mts": ts.Extension.Mts, ".cts": ts.Extension.Cts, ".mjs": ts.Extension.Mjs, ".cjs": ts.Extension.Cjs,
  };
  return map[ext] ?? ts.Extension.Ts;
}

/** Workspace packages by name → directory, from every package.json in a project dir. */
export function workspacePackages(scan: RepoScan): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of scan.services) {
    const pj = path.join(REPO_ROOT, s, "package.json");
    if (!existsSync(pj)) continue;
    try {
      const name = JSON.parse(readFileSync(pj, "utf8")).name;
      if (typeof name === "string" && name) out.set(name, path.join(REPO_ROOT, s));
    } catch {
      /* not JSON; ignore */
    }
  }
  return out;
}

export function firstExisting(base: string): string | undefined {
  if (existsSync(base) && SOURCE_EXTS.includes(path.extname(base)) && !base.endsWith(".d.ts")) return base;
  const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  for (const ext of SOURCE_EXTS) if (existsSync(stripped + ext)) return stripped + ext;
  for (const ext of SOURCE_EXTS) if (existsSync(path.join(base, "index" + ext))) return path.join(base, "index" + ext);
  return undefined;
}

/** `@repo/shared` or `@repo/shared/x` → a source file in that package, if one exists. */
export function resolveWorkspace(spec: string, pkgs: Map<string, string>): string | undefined {
  for (const [name, dir] of pkgs) {
    if (spec !== name && !spec.startsWith(name + "/")) continue;
    const sub = spec.slice(name.length + 1);
    if (sub) return firstExisting(path.join(dir, "src", sub)) ?? firstExisting(path.join(dir, sub));
    let pj: any = {};
    try {
      pj = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      /* ignore */
    }
    // Fields that point at source are preferred to ones that point at a build.
    for (const field of ["source", "types", "typings", "module", "main"]) {
      const v = pj[field];
      if (typeof v !== "string") continue;
      const p = path.join(dir, v);
      if (/[\\/](dist|build|lib|out)[\\/]/.test(p) || p.endsWith(".d.ts")) continue;
      const f = firstExisting(p);
      if (f) return f;
    }
    return firstExisting(path.join(dir, "src", "index")) ?? firstExisting(path.join(dir, "index"));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The project: one per server, synced with the disk on every call.

/** How many import steps from a file that mentions the name the checker may follow. */
const IMPORT_HOPS = 2;

interface State {
  project: Project;
  stamps: Map<string, string>;
  pkgs: Map<string, string>;
}
let state: State | undefined;

function getState(scan: RepoScan): State {
  const pkgs = workspacePackages(scan);
  if (!state) {
    const holder: { pkgs: Map<string, string>; depth?: Map<string, number> } = { pkgs };
    const project = new Project({
      compilerOptions: DEFAULT_OPTIONS,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      resolutionHost: (host) => ({
        resolveModuleNames: (names: string[], containingFile: string) =>
          names.map((n) => {
            // Imports are followed IMPORT_HOPS steps from the files in the
            // project, no further: the checker sees the types those files use,
            // without pulling a large repo's whole import graph into memory.
            const d = holder.depth?.get(path.normalize(containingFile));
            if (holder.depth && (d === undefined || d >= IMPORT_HOPS)) return undefined;
            const ws = resolveWorkspace(n, holder.pkgs);
            const r = ws
              ? { resolvedFileName: ws, extension: extensionOf(ws), isExternalLibraryImport: false }
              : ts.resolveModuleName(n, containingFile, optionsFor(containingFile), host).resolvedModule;
            if (r && holder.depth && d !== undefined) {
              const k = path.normalize(r.resolvedFileName);
              holder.depth.set(k, Math.min(holder.depth.get(k) ?? Infinity, d + 1));
            }
            return r;
          }),
      }),
    });
    state = { project, stamps: new Map(), pkgs };
    (state as any).holder = holder;
  } else {
    (state as any).holder.pkgs = pkgs;
    state.pkgs = pkgs;
  }
  // tsconfig files can change too; re-read them on each call.
  configCache.clear();
  return state;
}

/** Bring the project in line with the disk: add, refresh and forget files. */
function sync(st: State, entries: SourceEntry[]) {
  const live = new Set<string>();
  for (const e of entries) {
    const p = tsPathOf(e);
    live.add(p);
    if (st.stamps.get(p) === e.stamp) continue;
    let text: string;
    try {
      text = readFileSync(e.abs, "utf8");
    } catch {
      continue;
    }
    const view = tsParseView(e.ext, text);
    const existing = st.project.getSourceFile(p);
    if (existing) existing.replaceWithText(view.text);
    else st.project.createSourceFile(p, view.text, { overwrite: true, scriptKind: scriptKindFor(view.ext) });
    st.stamps.set(p, e.stamp);
  }
  for (const abs of [...st.stamps.keys()]) {
    if (live.has(abs)) continue;
    const sf = st.project.getSourceFile(abs);
    if (sf) st.project.removeSourceFile(sf);
    st.stamps.delete(abs);
  }
}

// ---------------------------------------------------------------------------
// Targets: the declarations being asked about.

interface Target {
  qualified: string;
  file: string;
  line: number;
  endLine: number;
  kind: string;
  isDefaultExport: boolean;
  /** Declaration nodes a call may bind to, as file:pos keys. */
  keys: Set<string>;
  /** Interface or base-class declarations a call may dispatch through. */
  related: Map<string, string>;
}

function key(n: Node): string {
  return `${n.getSourceFile().getFilePath()}:${n.getStart()}`;
}

function unwrapFn(n: Node | undefined): Node | undefined {
  while (n && (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isNonNullExpression(n) || Node.isSatisfiesExpression(n))) {
    n = n.getExpression();
  }
  if (!n) return undefined;
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) return n;
  if (Node.isCallExpression(n)) {
    const callee = n.getExpression();
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : Node.isIdentifier(callee) ? callee.getText() : "";
    if (!WRAPPERS.test(name)) return undefined;
    const a = n.getArguments()[0];
    const inner = a ? unwrapFn(a) : undefined;
    if (inner && (Node.isArrowFunction(inner) || Node.isFunctionExpression(inner))) return inner;
  }
  return undefined;
}

/** The container names around a declaration: class, object-literal variable, namespace. */
function qualifierOf(n: Node): string[] {
  const out: string[] = [];
  let cur: Node | undefined = n.getParent();
  while (cur && !Node.isSourceFile(cur)) {
    if (Node.isClassDeclaration(cur) || Node.isClassExpression(cur)) {
      const name = cur.getName() ?? (Node.isVariableDeclaration(cur.getParent()) ? (cur.getParent() as any).getName() : undefined);
      if (name) out.unshift(name);
    } else if (Node.isObjectLiteralExpression(cur)) {
      const p = cur.getParent();
      if (p && (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p))) out.unshift(p.getName());
    } else if (Node.isModuleDeclaration(cur)) {
      out.unshift(cur.getName());
    } else if (Node.isFunctionDeclaration(cur) || Node.isMethodDeclaration(cur)) {
      const name = cur.getName();
      if (name) out.unshift(name);
    }
    cur = cur.getParent();
  }
  return out;
}

function declName(n: Node): string | undefined {
  if (Node.isFunctionDeclaration(n)) return n.getName() ?? (n.hasModifier(SyntaxKind.DefaultKeyword) ? "default" : undefined);
  if (Node.isMethodDeclaration(n) || Node.isPropertyDeclaration(n) || Node.isPropertyAssignment(n) ||
      Node.isVariableDeclaration(n) || Node.isGetAccessorDeclaration(n) || Node.isMethodSignature(n)) {
    return n.getName();
  }
  return undefined;
}

/** Declarations in a file that define a function called `base`. */
function functionDecls(sf: SourceFile, base: string): Node[] {
  const out: Node[] = [];
  sf.forEachDescendant((n) => {
    if (Node.isFunctionDeclaration(n) && n.hasBody() && declName(n) === base) out.push(n);
    else if (Node.isMethodDeclaration(n) && n.hasBody() && n.getName() === base) out.push(n);
    else if ((Node.isPropertyDeclaration(n) || Node.isPropertyAssignment(n) || Node.isVariableDeclaration(n)) &&
             n.getName() === base && unwrapFn(n.getInitializer())) {
      out.push(n);
    }
  });
  return out;
}

function kindOf(n: Node): string {
  if (Node.isFunctionDeclaration(n)) return "function";
  if (Node.isMethodDeclaration(n)) return "method";
  return Node.isArrowFunction(unwrapFn((n as any).getInitializer?.()) as Node) ? "arrow function" : "function expression";
}

function buildTarget(n: Node): Target {
  const keys = new Set<string>([key(n)]);
  const fn = unwrapFn((n as any).getInitializer?.());
  if (fn) keys.add(key(fn));
  for (const d of n.getSymbol()?.getDeclarations() ?? []) keys.add(key(d));
  const related = new Map<string, string>();
  const name = declName(n)!;
  const cls = n.getParent();
  if (Node.isMethodDeclaration(n) && cls && Node.isClassDeclaration(cls)) {
    // Calls through an interface the class implements, or a base class it
    // extends, may land here at runtime; the checker binds them to the
    // interface or base declaration instead.
    for (const impl of cls.getImplements()) {
      for (const d of impl.getExpression().getSymbol()?.getDeclarations() ?? []) {
        if (Node.isInterfaceDeclaration(d)) {
          const m = d.getMethod(name) ?? d.getProperty(name);
          if (m) related.set(key(m), `${d.getName()}.${name} (interface)`);
        }
      }
    }
    let base = cls.getBaseClass();
    while (base) {
      const m = base.getMethod(name);
      if (m) related.set(key(m), `${base.getName()}.${name} (base class)`);
      base = base.getBaseClass();
    }
  }
  const sf = n.getSourceFile();
  const isDefaultExport =
    (Node.isFunctionDeclaration(n) && n.hasModifier(SyntaxKind.DefaultKeyword)) ||
    sf.getStatements().some((s) => Node.isExportAssignment(s) && s.getExpression().getText() === name);
  return {
    qualified: [...qualifierOf(n), name].join("."),
    file: relPath(sf.getFilePath()),
    line: n.getStartLineNumber(),
    endLine: n.getEndLineNumber(),
    kind: kindOf(n),
    isDefaultExport,
    keys,
    related,
  };
}

// ---------------------------------------------------------------------------

export interface CallersArgs {
  symbol: string;
  service?: string;
  file?: string;
  className?: string;
  searchServices?: string[];
  limit?: number;
  cursor?: string;
  format?: "json" | "text";
}

/**
 * File text by stamp. Every callers call scans the text of every TS/JS file
 * for the name; re-reading a large repo from disk each time was a good part of
 * the wait. A changed stamp reads the file again.
 */
const textCache = new Map<string, { stamp: string; text: string }>();
function textOf(e: SourceEntry): string | undefined {
  const hit = textCache.get(e.abs);
  if (hit && hit.stamp === e.stamp) return hit.text;
  try {
    const text = readFileSync(e.abs, "utf8");
    textCache.set(e.abs, { stamp: e.stamp, text });
    return text;
  } catch {
    textCache.delete(e.abs);
    return undefined;
  }
}

export interface CallSite {
  file: string;
  line: number;
  enclosing: string;
  enclosingLine: number;
  /** The enclosing function's parameters — is the value you need already here? */
  enclosingParams: string[];
  /** How many arguments this call site passes (calls only). */
  argCount?: number;
  /** The source line of the call site, cut around the call when it is long. */
  snippet: string;
  /** How the call's result is used: `template string`, `String(…)`, `+=`, `assigned`, `returned`… */
  usage?: string;
  /** Which target declaration it resolved to. */
  target?: string;
  resolution: "resolved" | "via-interface-or-base" | "unresolved" | "reference" | "dynamic" | "likely" | "ambiguous";
  reason?: string;
  /** Set for sites outside TypeScript/JavaScript. */
  language?: string;
  /** For an ambiguous site: the declarations it may bind to. */
  candidates?: string[];
}


/** Longest snippet; a longer line is cut to a window around the call. */
const SNIPPET_LIMIT = 160;
/** Calling functions up to this many lines are suggested whole; longer ones as windows. */
const SHORT_FUNCTION = 80;

/**
 * The call's source line, not just the call expression. The expression alone
 * hides what a change to the return value breaks: `${f(x)}`, `String(f(x))`,
 * `total += f(x)` all read as `f(x)`. A call that starts on its own line
 * (`String(\n  f(x)\n)`) still hides its wrapper here — `usage` covers that.
 */
function snippetOf(node: Node): string {
  const sf = node.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
  const raw = sf.getFullText().split("\n")[line - 1] ?? "";
  const indent = raw.length - raw.trimStart().length;
  const text = raw.trim();
  if (text.length <= SNIPPET_LIMIT) return text.replace(/\s+/g, " ");
  const from = Math.max(0, column - 1 - indent - 50);
  const to = Math.min(text.length, from + SNIPPET_LIMIT - 2);
  return ((from > 0 ? "…" : "") + text.slice(from, to) + (to < text.length ? "…" : "")).replace(/\s+/g, " ");
}

const CONVERTERS = new Set(["String", "Number", "Boolean", "parseFloat", "parseInt", "BigInt", "JSON.stringify"]);

/**
 * How the value a call returns is used. Changing what a function returns —
 * a number that may now be null, say — breaks call sites by how they use it,
 * not by where they are, so the sites are worth grouping by this first.
 */
function usageOf(call: Node): string {
  let n: Node = call;
  const via: string[] = [];
  for (;;) {
    const p = n.getParent();
    if (!p) break;
    if (Node.isParenthesizedExpression(p) || Node.isAwaitExpression(p) || Node.isAsExpression(p) || Node.isNonNullExpression(p) || Node.isTypeAssertion(p) || Node.isSatisfiesExpression(p)) {
      n = p;
      continue;
    }
    if (Node.isConditionalExpression(p) && p.getCondition() !== n) {
      via.push("a ?: branch");
      n = p;
      continue;
    }
    if (Node.isBinaryExpression(p) && ["??", "||", "&&"].includes(p.getOperatorToken().getText()) && p.getLeft() === n) {
      via.push(`${p.getOperatorToken().getText()} fallback`);
      n = p;
      continue;
    }
    break;
  }
  const p = n.getParent();
  const suffix = via.length ? ` (through ${via.join(", ")})` : "";
  let use = "other";
  if (!p) use = "other";
  else if (Node.isTemplateSpan(p)) use = "template string ${…}";
  else if (Node.isCallExpression(p) && p.getExpression() !== n) {
    const callee = p.getExpression().getText();
    use = CONVERTERS.has(callee) ? `${callee}(…)` : `argument of ${callee.length > 40 ? callee.slice(0, 39) + "…" : callee}()`;
  } else if (Node.isPropertyAccessExpression(p) && p.getExpression() === n) use = `.${p.getName()} on the result`;
  else if (Node.isElementAccessExpression(p) && p.getExpression() === n) use = "[…] on the result";
  else if (Node.isBinaryExpression(p)) {
    const op = p.getOperatorToken().getText();
    if (op === "=") use = p.getRight() === n ? "assigned" : "other";
    else if (/^[-+*/%]=$|^\*\*=$/.test(op)) use = `${op} (accumulated)`;
    else if (/^[-+*/%]$|^\*\*$/.test(op)) use = `arithmetic ${op}`;
    else if (/^[<>]=?$|^[!=]==?$/.test(op)) use = `compared ${op}`;
    else use = `operand of ${op}`;
  } else if (Node.isPrefixUnaryExpression(p)) use = `unary ${p.getText().charAt(0)}`;
  else if (Node.isVariableDeclaration(p)) use = "assigned";
  else if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) use = "object property";
  else if (Node.isReturnStatement(p) || Node.isArrowFunction(p)) use = "returned";
  else if (Node.isExpressionStatement(p)) use = "result unused";
  else if (Node.isArrayLiteralExpression(p)) use = "array element";
  else if (Node.isIfStatement(p) || Node.isWhileStatement(p)) use = "condition";
  else if (Node.isSpreadElement(p) || Node.isSpreadAssignment(p)) use = "spread";
  else use = p.getKindName();
  return use + suffix;
}

/** Last line of each site's enclosing function, kept out of the output: it only sizes the read hint. */
const enclosingEnd = new WeakMap<CallSite, number>();

function siteOf(node: Node, extra: Partial<CallSite> & Pick<CallSite, "resolution">, wholeLine = false): CallSite {
  const enc = enclosingFunction(node);
  const sf = node.getSourceFile();
  const isCall = !wholeLine && (Node.isCallExpression(node) || Node.isNewExpression(node));
  const text = wholeLine ? sf.getFullText().split("\n")[node.getStartLineNumber() - 1].trim().replace(/\s+/g, " ") : snippetOf(node);
  const site: CallSite = {
    file: relPath(node.getSourceFile().getFilePath()),
    line: node.getStartLineNumber(),
    enclosing: enc.name,
    enclosingLine: enc.line,
    enclosingParams: enc.params,
    snippet: text.length > SNIPPET_LIMIT ? text.slice(0, SNIPPET_LIMIT - 1) + "…" : text,
    ...(isCall ? { usage: usageOf(node) } : {}),
    ...extra,
  };
  if (enc.endLine) enclosingEnd.set(site, enc.endLine);
  return site;
}

/** Lines of `text` where a template uses `name`, as offsets: `save(…)` calls, `@click="save"` handlers. */
function templateUses(text: string, ranges: Array<[number, number]>, name: string): Array<{ offset: number; isCall: boolean }> {
  const out: Array<{ offset: number; isCall: boolean }> = [];
  const re = new RegExp(`(^|[^\\w$.])(${name.replace(/[$]/g, "\\$")})(?![\\w$])(\\s*\\()?`, "g");
  for (const [a, b] of ranges) {
    const part = text.slice(a, b);
    for (let m: RegExpExecArray | null; (m = re.exec(part)); ) {
      out.push({ offset: a + m.index + m[1].length, isCall: !!m[3] });
    }
  }
  return out;
}

function lineOfOffset(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export async function findCallers(args: CallersArgs): Promise<string> {
  const raw = args.symbol.trim();
  const parts = raw.split(".");
  const base = parts[parts.length - 1];
  const qualifierWanted = [...parts.slice(0, -1)];
  if (args.className) qualifierWanted.push(args.className);
  if (!/^[\p{L}_$#][\p{L}\p{N}_$]*$/u.test(base)) throw new Error(`"${raw}" is not a function or method name.`);

  const scan = scanRepo();
  const allTs = scan.files.filter((f) => isTsFamily(f.language));
  const searchAll = filterFiles(scan, args.searchServices);
  const searchEntries = searchAll.filter((f) => isTsFamily(f.language));
  const searchPoly = searchAll.filter((f) => !isTsFamily(f.language));
  const notes: string[] = [];
  const wantFile = args.file?.replace(/\\/g, "/").replace(/^\.\//, "");
  const fileMatches = (rel: string) => !wantFile || rel === wantFile || rel.endsWith("/" + wantFile);

  // --- declarations by this name, from the catalog (parsed once, cached)
  const snap = await snapshot();
  const serviceFilter = args.service ? new Set(filterFiles(scan, [args.service]).map((f) => f.rel)) : undefined;
  const inScope = (rel: string) => fileMatches(rel) && (!serviceFilter || serviceFilter.has(rel));
  const polySameName: PolyTarget[] = [];
  let tsDeclared = false;
  /** Services holding a TS/JS declaration that matches what was asked. */
  const declServices = new Set<string>();
  for (const fc of snap.files) {
    let text: string | undefined;
    for (const f of fc.functions) {
      if (f.rec.shortName !== base) continue;
      if (isTsFamily(f.rec.language)) {
        const q = f.rec.name.split(".").slice(0, -1);
        if (inScope(f.rec.file) && qualifierWanted.every((w) => q.includes(w))) {
          tsDeclared = true;
          declServices.add(fc.entry.service);
        }
        continue;
      }
      if (f.rec.language === "kotlin") text ??= readFileSync(fc.entry.abs, "utf8");
      polySameName.push(polyTarget(f.rec, fc.entry.abs, text));
    }
  }
  const polyQualifierOk = (t: PolyTarget) => !qualifierWanted.length || qualifierWanted.every((w) => t.containers.includes(w));
  let polyTargets = polySameName.filter((t) => polyQualifierOk(t) && inScope(t.rec.file));

  // --- TS/JS is skipped when only other-language declarations were asked
  // about: TS/JS cannot call them directly, and building the type-checked
  // project is the slow part.
  const tsText = new Map<string, string>();
  for (const f of allTs) {
    const t = textOf(f);
    if (t !== undefined) tsText.set(f.abs, t);
  }
  const tsMentioned = searchEntries.some((f) => tsText.get(f.abs)?.includes(base));
  const runTs = tsMentioned && (tsDeclared || !polyTargets.length);

  // A call can only bind to a declaration its file can import: one in its own
  // service, or in a service it imports by package name or by a relative path
  // that leaves its own directory. Other services are left out of the
  // type-checked project — with a common name (`list`, `detail`) they were most
  // of its files and most of the time.
  const reachable = (() => {
    if (!tsDeclared || declServices.has(".")) return undefined;
    const pkgs = workspacePackages(scan);
    const declDirs = [...declServices].map((s) => path.join(REPO_ROOT, s) + path.sep);
    // Only the declaring service's own package: one nested inside it
    // (`storefront/ckeditor5`) is a project of its own.
    const declPkgs = [...pkgs].filter(([, dir]) => declDirs.includes(dir + path.sep)).map(([n]) => n);
    const out = new Set(declServices);
    const inDecl = (abs: string) => declDirs.some((d) => (abs + path.sep).startsWith(d) || d.startsWith(abs + path.sep));
    // tsconfig `paths` aliases that point into a declaring service (`@shared/*` → `../shared/src/*`).
    clearConfigCache();
    const aliasCache = new Map<ts.CompilerOptions, string[]>();
    const aliasesInto = (opts: ts.CompilerOptions): string[] => {
      let got = aliasCache.get(opts);
      if (got) return got;
      got = [];
      const basePath = (opts as any).pathsBasePath ?? opts.baseUrl;
      for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
        if (basePath && targets.some((t) => inDecl(path.resolve(basePath, t.replace(/\*.*$/, ""))))) got.push(pattern.replace(/\*.*$/, ""));
      }
      aliasCache.set(opts, got);
      return got;
    };
    const SPEC =/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;
    for (const f of allTs) {
      if (out.has(f.service)) continue;
      const text = tsText.get(f.abs);
      if (!text) continue;
      let aliases: string[] | undefined;
      for (const m of text.matchAll(SPEC)) {
        const spec = m[1];
        const hit = spec.startsWith(".")
          ? declDirs.some((d) => (path.resolve(path.dirname(f.abs), spec) + path.sep).startsWith(d))
          : declPkgs.some((n) => spec === n || spec.startsWith(n + "/")) ||
            (aliases ??= aliasesInto(optionsFor(f.abs))).some((a) => spec.startsWith(a));
        if (hit) {
          out.add(f.service);
          break;
        }
      }
    }
    return out;
  })();
  const reachableTs = reachable ? allTs.filter((f) => reachable.has(f.service)) : allTs;
  if (reachable) {
    const left = [...new Set(allTs.map((f) => f.service))].filter((s) => !reachable.has(s));
    if (left.length) {
      notes.push(`Searched only ${[...reachable].join(", ")}: the declaration is not importable from the other ${left.length} service(s) (no package or relative import reaches it), so they cannot call it directly.`);
    }
  }
  /** The name as a whole identifier, not inside a longer one (`list` in `playlist`). */
  const wordIn = (names: Iterable<string>) => {
    const alt = [...names].map((x) => x.replace(/[$]/g, "\\$")).join("|");
    return new RegExp(`(^|[^\\p{L}\\p{N}_$])(${alt})(?![\\p{L}\\p{N}_$])`, "u");
  };

  // Only files that can matter join the type-checked project: those naming the
  // function or an alias of it, and those importing a declaring file under any
  // name (`import r from "./round"`). Files they import are read on demand by
  // the checker. Loading every file of a large repo exhausts the heap.
  const relevant = (() => {
    const names = new Set([base]);
    for (let round = 0; round < 5; round++) {
      const before = names.size;
      for (const [, text] of tsText) {
        if (![...names].some((n) => text.includes(n))) continue;
        for (const m of text.matchAll(/([\p{L}_$][\p{L}\p{N}_$]*)\s+as\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu)) {
          if (names.has(m[1])) names.add(m[2]);
        }
      }
      if (names.size === before) break;
    }
    const declStems = new Set<string>();
    const declAbs = new Set<string>();
    for (const fc of snap.files) {
      if (!isTsFamily(fc.entry.language) || !fc.functions.some((f) => f.rec.shortName === base)) continue;
      declAbs.add(fc.entry.abs);
      // Only a default export can be imported under a name that is not its own.
      const b = base.replace(/[$]/g, "\\$");
      const isDefault = new RegExp(`export\\s+default\\s+(async\\s+)?(function\\s*\\*?\\s*)?${b}\\b|export\\s*=\\s*${b}\\b|module\\.exports\\s*=\\s*${b}\\b`).test(tsText.get(fc.entry.abs) ?? "");
      if (!isDefault) continue;
      const stem = path.basename(fc.entry.rel).replace(/\.[^.]+$/, "");
      declStems.add(stem === "index" ? path.basename(path.dirname(fc.entry.rel)) : stem);
    }
    const stemRe = declStems.size
      ? new RegExp(`["'\`][^"'\`]*\\b(${[...declStems].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(\\.[a-z]+)?["'\`]`)
      : undefined;
    const nameRe = wordIn(names);
    const files = reachableTs.filter((f) => {
      const text = tsText.get(f.abs);
      if (!text) return false;
      return nameRe.test(text) || (!!stemRe && stemRe.test(text));
    });
    return { files, names, declAbs };
  })();
  const relevantTs = relevant.files;

  const resolved: CallSite[] = [];
  const viaRelated: CallSite[] = [];
  const unresolved: CallSite[] = [];
  const references: CallSite[] = [];
  const dynamic: CallSite[] = [];
  const nameAsString: NameAsString = { count: 0, samples: [] };
  const otherSymbols = new Map<string, number>();
  let targets: Target[] = [];

  // Large repos: the files are analysed in batches, each in a fresh project
  // with the declaring files, so memory stays bounded however many files
  // mention a common name.
  const BATCH = 150;
  const declEntries = reachableTs.filter((f) => relevant.declAbs.has(f.abs));
  // Barrels and re-export files are how a function reaches its callers under
  // another path or name: their imports are always followed.
  const reexporters = allTs.filter((f) => /\bexport\s+(\*|\{[^}]*\}|\*\s+as\s+[\w$]+)\s+from\s/.test(tsText.get(f.abs) ?? ""))
    .map((f) => path.normalize(tsPathOf(f)));
  const chunks: SourceEntry[][] = [];
  if (runTs) {
    if (relevantTs.length <= BATCH * 1.5) chunks.push(relevantTs);
    else for (let i = 0; i < relevantTs.length; i += BATCH) chunks.push(relevantTs.slice(i, i + BATCH));
  }
  if (runTs) {
    for (const chunk of chunks) {
      if (chunks.length > 1) state = undefined;
      const batchFiles = [...new Map([...chunk, ...declEntries].map((f) => [f.abs, f])).values()];
      const scanSet = new Set(chunk.map((f) => f.abs));
      const st = getState(scan);
      (st as any).holder.depth = new Map([...batchFiles.map((f) => path.normalize(tsPathOf(f))), ...reexporters].map((p) => [p, 0]));
      sync(st, batchFiles);
      const project = st.project;
      const tsSf = (e: SourceEntry) => project.getSourceFile(tsPathOf(e));

      // --- targets
      const inProject = new Set(batchFiles.map((f) => f.abs));
      let targetFiles = (args.service ? filterFiles(scan, [args.service]).filter((f) => isTsFamily(f.language)) : allTs).filter((f) => inProject.has(f.abs));
      if (wantFile) targetFiles = targetFiles.filter((f) => fileMatches(f.rel));
      const collectTargets = (files: SourceEntry[]) => {
        const out: Target[] = [];
        for (const e of files) {
          const sf = tsSf(e);
          if (!sf || !sf.getFullText().includes(base)) continue;
          for (const d of functionDecls(sf, base)) {
            const t = buildTarget(d);
            const q = t.qualified.split(".").slice(0, -1);
            if (qualifierWanted.length && !qualifierWanted.every((w) => q.includes(w))) continue;
            out.push(t);
          }
        }
        return out;
      };
      targets = collectTargets(targetFiles);
      // `service` used to mean "the service to search"; a caller asking about a
      // function another service declares should still get an answer.
      if (!targets.length && !polyTargets.length && args.service && !wantFile) {
        targets = collectTargets(batchFiles);
        if (targets.length && !notes.some((n) => n.includes("is not declared in"))) {
          notes.push(`"${raw}" is not declared in ${normaliseService(args.service)}; using the declaration(s) found elsewhere in the repo.`);
        }
      }
      const targetKeys = new Map<string, Target>();
      const relatedKeys = new Map<string, { target: Target; via: string }>();
      for (const t of targets) {
        for (const k of t.keys) targetKeys.set(k, t);
        for (const [k, via] of t.related) relatedKeys.set(k, { target: t, via });
      }

      // --- names a target may be called by: its own, plus aliases from
      // `import { x as y }` / `export { x as y }`, followed through re-exports.
      // Aliases found in any relevant file, so a batch knows names defined in another.
      const names = new Set<string>([base, ...relevant.names]);
      const tsFiles = batchFiles.map(tsSf).filter((s): s is SourceFile => !!s);
      for (let round = 0; round < 5; round++) {
        const before = names.size;
        for (const sf of tsFiles) {
          const text = sf.getFullText();
          if (![...names].some((n) => text.includes(n))) continue;
          for (const spec of [...sf.getDescendantsOfKind(SyntaxKind.ImportSpecifier), ...sf.getDescendantsOfKind(SyntaxKind.ExportSpecifier)]) {
            const cn = spec.compilerNode as ts.ImportSpecifier | ts.ExportSpecifier;
            const orig = (cn.propertyName ?? cn.name).text;
            if (names.has(orig)) names.add(cn.name.text);
          }
        }
        if (names.size === before) break;
      }
      // Default exports are imported under any name the importer picks.
      const targetFileSet = new Set(targets.filter((t) => t.isDefaultExport).map((t) => path.join(REPO_ROOT, t.file)));
      const defaultAliases = new Map<string, Set<string>>();
      if (targetFileSet.size) {
        for (const sf of tsFiles) {
          for (const imp of sf.getImportDeclarations()) {
            const d = imp.getDefaultImport();
            if (!d) continue;
            const target = imp.getModuleSpecifierSourceFile()?.getFilePath();
            if (target && targetFileSet.has(path.normalize(target))) {
              const set = defaultAliases.get(sf.getFilePath()) ?? new Set<string>();
              set.add(d.getText());
              defaultAliases.set(sf.getFilePath(), set);
            }
          }
        }
      }

      const classify = (nameNode: Node): { t?: Target; via?: string; other?: string; reason?: string } => {
        let sym = nameNode.getSymbol();
        if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
        const decls = sym?.getDeclarations() ?? [];
        for (const d of decls) {
          const t = targetKeys.get(key(d));
          if (t) return { t };
        }
        for (const d of decls) {
          const r = relatedKeys.get(key(d));
          if (r) return { t: r.target, via: r.via };
        }
        // A value bound by destructuring or `const f = require(...)` points at
        // the binding, not the function; the value's type still knows.
        const typeSym = nameNode.getType().getSymbol();
        for (const d of typeSym?.getDeclarations() ?? []) {
          const t = targetKeys.get(key(d));
          if (t) return { t };
        }
        if (!decls.length) {
          return { reason: sym ? "symbol has no declaration (dynamic or built-in)" : "receiver type unknown (untyped JS, `any`, or unresolved import)" };
        }
        const d = decls[0];
        const dn = declName(d) ?? base;
        const where = `${relPath(d.getSourceFile().getFilePath())}:${d.getStartLineNumber()}`;
        if (d.getSourceFile().getFilePath().includes("node_modules")) return { other: `${dn} (library: ${where.replace(/.*node_modules\//, "")})` };
        return { other: `${[...qualifierOf(d), dn].join(".")} (${where})` };
      };

      for (const e of searchEntries) {
        if (!scanSet.has(e.abs)) continue;
        const sf = tsSf(e);
        if (!sf) continue;
        const text = sf.getFullText();
        const local = defaultAliases.get(sf.getFilePath());
        const fileNames = local ? new Set([...names, ...local]) : names;
        const isSfc = SFC_EXTENSIONS.has(e.ext);
        if (![...fileNames].some((n) => text.includes(n)) && !isSfc) continue;
        /** Local names in this file bound to a target: for a component's template. */
        const boundHere = new Map<string, Target>();

        sf.forEachDescendant((node) => {
          // `obj["name"]`, and the name as a plain string: dynamic dispatch, events, routes.
          if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
            const lit = node.getLiteralText();
            if (!fileNames.has(lit)) return;
            const parent = node.getParent();
            if (parent && (Node.isImportDeclaration(parent) || Node.isExportDeclaration(parent) || Node.isLiteralTypeNode(parent))) return;
            if (parent && Node.isElementAccessExpression(parent) && parent.getArgumentExpression() === node) {
              const c = classify(node);
              const cp = parent.getParent();
              const isCall = !!cp && Node.isCallExpression(cp) && cp.getExpression() === parent;
              if (c.t) {
                const site = siteOf(isCall ? cp! : parent, {
                  resolution: c.via ? "via-interface-or-base" : isCall ? "resolved" : "reference",
                  target: c.t.qualified,
                  reason: `${isCall ? "called" : "used"} through a string key, obj["${lit}"]`,
                  ...(isCall ? { argCount: (cp as any).getArguments().length } : {}),
                });
                (c.via ? viaRelated : isCall ? resolved : references).push(site);
                return;
              }
            }
            if (!targets.length) return;
            // A dynamic call only where a string is how the call is made: `obj["x"]`,
            // `Reflect.get(o, "x")`, `_.invoke(o, "x")`. Anywhere else (test titles,
            // decorators, enum values, route names) the string is counted, not listed.
            const inCall = parent && Node.isCallExpression(parent) && parent.getArguments().includes(node as any) &&
              isDynamicCallee(parent.getExpression().getText());
            if ((parent && Node.isElementAccessExpression(parent)) || inCall) {
              dynamic.push(siteOf(node, { resolution: "dynamic", reason: inCall ? `the name passed to ${parent!.getExpression().getText()}() — a dynamic call; check by hand` : `obj["${lit}"] on a receiver the type checker cannot follow — a dynamic call; check by hand` }, true));
            } else {
              const sf2 = node.getSourceFile();
              nameAsString.count++;
              if (nameAsString.samples.length < 5) {
                nameAsString.samples.push(`${relPath(sf2.getFilePath())}:${node.getStartLineNumber()} ${sf2.getFullText().split("\n")[node.getStartLineNumber() - 1].trim().slice(0, 80)}`);
              }
            }
            return;
          }
          if (!Node.isIdentifier(node) && !Node.isPrivateIdentifier(node)) return;
          if (!fileNames.has(node.getText())) return;
          const parent = node.getParent();
          if (!parent) return;
          if (Node.isImportSpecifier(parent) || Node.isImportClause(parent)) {
            if (isSfc) {
              const c = classify(node);
              if (c.t) boundHere.set(node.getText(), c.t);
            }
            return;
          }
          // Skip the declarations themselves and import/export plumbing.
          if (Node.isExportSpecifier(parent)) return;
          if ((Node.isFunctionDeclaration(parent) || Node.isMethodDeclaration(parent) || Node.isVariableDeclaration(parent) ||
               Node.isPropertyDeclaration(parent) || Node.isPropertyAssignment(parent) || Node.isMethodSignature(parent) ||
               Node.isPropertySignature(parent) || Node.isParameterDeclaration(parent) || Node.isBindingElement(parent) ||
               Node.isShorthandPropertyAssignment(parent) || Node.isClassDeclaration(parent) ||
               Node.isGetAccessorDeclaration(parent) || Node.isSetAccessorDeclaration(parent)) &&
              (parent as any).getNameNode?.() === node) {
            if (isSfc) {
              const c = classify(node);
              if (c.t) boundHere.set(node.getText(), c.t);
            }
            return;
          }
          // Is it the callee of a call? `f()`, `obj.f()`, `obj?.f()`, `f.call(…)`.
          let callee: Node = node;
          let via: string | undefined;
          if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) callee = parent;
          else if (Node.isPropertyAccessExpression(parent) && parent.getExpression() !== node) return;
          // `f.call(this, x)`, `obj.f.apply(this, xs)`: a call of f. `f.bind(o)`: a reference.
          const up = callee === node ? parent : callee.getParent();
          if (up && Node.isPropertyAccessExpression(up) && up.getExpression() === callee) {
            const m = up.getName();
            if (!["call", "apply", "bind"].includes(m)) return; // `f.x` — the object, not a call of f
            if (m !== "bind") {
              callee = up;
              via = `called through .${m}()`;
            }
          }
          const cp = callee.getParent();
          const isCall = !!cp && (Node.isCallExpression(cp) || Node.isNewExpression(cp)) && cp.getExpression() === callee;
          // Uses inside a type (`typeof f`) are not runtime uses.
          if (!isCall && node.getFirstAncestor((a) => Node.isTypeNode(a)) ) return;

          const c = classify(node);
          if (isCall) {
            const call = cp as any;
            const extra = { argCount: call.getArguments().length - (via === "called through .call()" ? 1 : 0), ...(via ? { reason: via } : {}) };
            if (c.t && !c.via) resolved.push(siteOf(cp!, { ...extra, resolution: "resolved", target: c.t.qualified }));
            else if (c.t && c.via) viaRelated.push(siteOf(cp!, { ...extra, resolution: "via-interface-or-base", target: c.t.qualified, reason: `bound to ${c.via}` }));
            else if (c.other) otherSymbols.set(c.other, (otherSymbols.get(c.other) ?? 0) + 1);
            // An unresolved call is only interesting when it is by the target's own name.
            else if (node.getText() === base || local?.has(node.getText()) || relevant.names.has(node.getText())) {
              unresolved.push(siteOf(cp!, { ...extra, resolution: "unresolved", reason: c.reason }));
            }
          } else if (c.t) {
            // Passed as a callback, assigned, exported: not a call, but a change
            // to the signature reaches it all the same.
            references.push(siteOf(node, {
              resolution: "reference",
              target: c.t.qualified,
              reason: c.via ? `via ${c.via}` : "used as a value, not called here",
            }, true));
          }
        });

        // A component's template calls what its script imports or declares.
        if (isSfc && boundHere.size) {
          const fileText = readFileSync(e.abs, "utf8");
          const tpl = extractSfcScript(fileText, e.ext).template;
          const lines = fileText.split("\n");
          for (const [local, t] of boundHere) {
            for (const u of templateUses(fileText, tpl, local)) {
              const line = lineOfOffset(fileText, u.offset);
              const snippet = lines[line - 1].trim().replace(/\s+/g, " ");
              const site: CallSite = {
                file: e.rel,
                line,
                enclosing: "<template>",
                enclosingLine: line,
                enclosingParams: [],
                snippet: snippet.length > 120 ? snippet.slice(0, 119) + "…" : snippet,
                target: t.qualified,
                resolution: u.isCall ? "resolved" : "reference",
                reason: u.isCall ? `called in the component template (via ${local})` : `template event handler or binding (via ${local})`,
              };
              (u.isCall ? resolved : references).push(site);
            }
          }
        }
      }
    }
    if (chunks.length > 1) {
      state = undefined;
      notes.push(`${relevantTs.length} TypeScript/JavaScript files mention the name; they were type-checked in ${chunks.length} batches to bound memory.`);
    }
  } else if (tsMentioned && polyTargets.length) {
    notes.push(`TypeScript/JavaScript was not searched: "${raw}" is declared only in ${[...new Set(polyTargets.map((t) => t.rec.language))].join(", ")}, which TS/JS code cannot call directly (only through an API, which is not traced).`);
  }

  // --- other languages: name- and import-based binding, not type-checked.
  if (!targets.length && !polyTargets.length && args.service && !wantFile) {
    polyTargets = polySameName.filter(polyQualifierOk);
  }
  let poly: Awaited<ReturnType<typeof polyCallers>> = { sites: [], otherSameName: new Map(), notAnalyzed: [], nameAsString: { count: 0, samples: [] } };
  if (polyTargets.length || polySameName.length) {
    poly = await polyCallers(base, polyTargets, searchPoly, polySameName);
  }
  const fromPoly = (p: PolySite): CallSite => ({
    file: p.file,
    line: p.line,
    enclosing: p.enclosing,
    enclosingLine: p.enclosingLine,
    enclosingParams: p.enclosingParams,
    snippet: p.snippet,
    target: p.target,
    resolution: p.resolution,
    reason: p.reason,
    language: p.language,
    ...(p.candidates ? { candidates: p.candidates } : {}),
  });
  const likely: CallSite[] = [];
  const ambiguous: CallSite[] = [];
  for (const p of poly.sites) {
    const c = fromPoly(p);
    if (p.resolution === "resolved") resolved.push(c);
    else if (p.resolution === "reference") references.push(c);
    else if (p.resolution === "likely") likely.push(c);
    else if (p.resolution === "ambiguous") ambiguous.push(c);
    else dynamic.push(c);
  }
  for (const [k, n] of poly.otherSameName) otherSymbols.set(k, (otherSymbols.get(k) ?? 0) + n);
  nameAsString.count += poly.nameAsString.count;
  nameAsString.samples.push(...poly.nameAsString.samples.slice(0, Math.max(0, 5 - nameAsString.samples.length)));
  const otherLang = poly.notAnalyzed;

  const byLoc = (a: CallSite, b: CallSite) => a.file.localeCompare(b.file) || a.line - b.line;
  for (const list of [resolved, viaRelated, unresolved, references, dynamic, likely, ambiguous]) list.sort(byLoc);

  const all = [...resolved, ...viaRelated, ...references, ...likely, ...ambiguous, ...unresolved, ...dynamic];
  const qHash = paramsHash({ ...args, cursor: undefined, limit: undefined, format: undefined });
  const fp = fingerprint(scan.files);
  const cur = decodeCursor(args.cursor, "callers", qHash, fp);
  const start = typeof cur.position === "number" ? cur.position : 0;
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  // An explicit limit is a request to see that many: the usual reply budget
  // cut a `limit: 300` to 75 sites, and the agent took the page for the whole.
  const budget = args.limit ? Math.max(CHAR_BUDGET - 5000, Math.min(args.limit * 450, MAX_EXPLICIT_BUDGET)) : CHAR_BUDGET - 5000;
  const page = takePage(all, start, limit, budget, (s) => JSON.stringify(s));
  const shown = all.slice(start, page.end);
  const complete = page.end >= all.length;
  const nextCursor = complete ? undefined : encodeCursor({ t: "callers", q: qHash, p: page.end, f: cur.fingerprint });
  // What a partial page leaves out, said first and per file: "182 sites" with
  // 75 listed read as the full list, and the two files left out were where
  // the change broke.
  let partial: string | undefined;
  let nextPage: string | undefined;
  if (!complete) {
    const rest = new Map<string, number>();
    for (const s of all.slice(page.end)) rest.set(s.file, (rest.get(s.file) ?? 0) + 1);
    const list = [...rest].sort((a, b) => b[1] - a[1]);
    const named = list.slice(0, 12).map(([f, n]) => `${f} ${n}`).join(", ");
    partial =
      `PARTIAL PAGE: sites ${shown.length ? start + 1 : 0}-${page.end} of ${all.length}. NOT SHOWN YET: ${all.length - page.end} ` +
      `site(s) in ${list.length} file(s): ${named}${list.length > 12 ? `, … ${list.length - 12} more file(s)` : ""}. ` +
      `Fetch the rest before concluding anything about "all callers" (see nextPage).`;
    const again = Object.fromEntries(Object.entries({ ...args, cursor: nextCursor }).filter(([, v]) => v !== undefined));
    nextPage = `Next — the next page: spec_nav_callers ${JSON.stringify(again)}`;
  }
  // How the result is used, over ALL sites, not just this page.
  const usage: Record<string, number> = {};
  for (const s of all) if (s.usage) usage[s.usage] = (usage[s.usage] ?? 0) + 1;
  const usageSorted = Object.fromEntries(Object.entries(usage).sort((a, b) => b[1] - a[1]));
  // Service boundaries, answered inline once the flow graph is built: who calls
  // an endpoint a site sits in, where the target's own HTTP calls land. Until
  // then, the trace_flow call to make.
  const boundaries = boundariesAt([
    ...targets.map((t) => ({
      file: t.file, line: t.line, toLine: t.endLine,
      fnName: t.qualified.split(".").pop(), fnLine: t.line,
    })),
    ...all
      .filter((s) => s.resolution !== "unresolved" && s.resolution !== "dynamic")
      .slice(0, 300)
      .map((s) => ({ file: s.file, line: s.line, fnName: s.enclosing.split(".").pop(), fnLine: s.enclosingLine })),
  ]);
  const traces = boundaries ? [] : traceHints(
    [...targets.map((t) => ({ name: t.qualified, file: t.file, line: t.line }))],
    all,
  );

  const allTargets = [
    ...targets.map((t) => ({ name: t.qualified, file: t.file, line: t.line, kind: t.kind, resolvedBy: "type checker" })),
    ...polyTargets.map((t) => ({ name: t.rec.name, file: t.rec.file, line: t.rec.start, kind: t.rec.kind, language: t.rec.language, resolvedBy: "names and imports (not type-checked)" })),
  ];
  // Exhaustive only where a type checker bound every call and nothing else is open.
  // A plain-string mention can still feed a computed call (`obj[map.key]()`), so it keeps this false.
  const exhaustive = targets.length > 0 && !polyTargets.length && unresolved.length === 0 && dynamic.length === 0 &&
    likely.length === 0 && ambiguous.length === 0 && otherLang.length === 0 && nameAsString.count === 0;
  if (!allTargets.length) {
    notes.push(
      `No function or method named "${raw}" was found` +
        (args.service ? ` in ${normaliseService(args.service)}` : "") +
        (args.file ? ` in ${args.file}` : "") +
        `. Every TS/JS call by that name is listed as unresolved; check the name, or pass file/className.`,
    );
  } else if (allTargets.length > 1) {
    notes.push(
      `${allTargets.length} declarations match "${raw}"; sites are attributed to each via \`target\`. ` +
        `Pass \`file\` and/or \`className\` (or "Class.method" as symbol) to ask about one.`,
    );
  }
  if (polyTargets.length) {
    notes.push(
      `${[...new Set(polyTargets.map((t) => t.rec.language))].join(", ")} sites are bound by evidence — same file/class, ` +
        `qualifier, import, package, or a receiver declared with the class's type — not by a type checker; each site's ` +
        `reason says which. "likely" = only declaration of the name but binding unproven; "ambiguous" = several ` +
        `declarations could match.`,
    );
  }
  if (otherSymbols.size) notes.push(`Calls by the same name that resolve to a different declaration (or none in the repo) are excluded and counted in otherSymbolsSameName.`);
  if (unresolved.length) notes.push(`${unresolved.length} call(s) by this name could not be resolved to a declaration; inspect them — they may or may not be calls of the target.`);
  if (dynamic.length) notes.push(`${dynamic.length} place(s) pass the name to a dynamic-dispatch API (obj["name"], getattr, send, call_user_func, getMethod, reflection…) — dynamic calls; check them by hand.`);
  if (nameAsString.count) notes.push(`The name also appears ${nameAsString.count} time(s) as a plain string elsewhere (test titles, routes, enum values, event names…); not listed as calls — see nameAsStringElsewhere for samples.`);
  if (otherLang.length) notes.push(`${otherLang.length} file(s) mention "${base}" but could not be parsed; they are not analysed (use spec_nav_map).`);
  notes.push(
    "Not counted anywhere: calls whose name is computed at runtime (not written as a literal), calls through " +
      "HTTP/RPC/queues, calls in unsupported file types, and code outside the repo. " +
      (exhaustive ? "Within those limits every call to the target(s) was resolved." : "So this is NOT a complete list of call sites."),
  );

  const result = {
    symbol: raw,
    total: resolved.length,
    totals: {
      resolved: resolved.length,
      viaInterfaceOrBase: viaRelated.length,
      references: references.length,
      likely: likely.length,
      ambiguous: ambiguous.length,
      unresolved: unresolved.length,
      dynamic: dynamic.length,
      otherSymbolsSameName: [...otherSymbols.values()].reduce((a, b) => a + b, 0),
    },
    exhaustive,
    ...(partial ? { partial, nextPage } : {}),
    ...(Object.keys(usageSorted).length
      ? {
          usage: usageSorted,
          usageNote:
            "How each call's result is used, counted over ALL sites (every page). Changing what the function " +
            "returns breaks sites by how they use it: group them by `usage` first.",
        }
      : {}),
    ...(boundaries?.length ? { boundaries } : {}),
    targets: allTargets,
    sites: shown.filter((s) => s.resolution === "resolved"),
    viaInterfaceOrBase: shown.filter((s) => s.resolution === "via-interface-or-base"),
    references: shown.filter((s) => s.resolution === "reference"),
    likely: shown.filter((s) => s.resolution === "likely"),
    ambiguous: shown.filter((s) => s.resolution === "ambiguous"),
    unresolved: shown.filter((s) => s.resolution === "unresolved"),
    dynamic: shown.filter((s) => s.resolution === "dynamic"),
    otherSymbolsSameName: Object.fromEntries(otherSymbols),
    nameAsStringElsewhere: nameAsString,
    notAnalyzedOtherLanguages: { count: otherLang.length, files: otherLang.slice(0, 30) },
    page: {
      from: shown.length ? start + 1 : 0,
      to: page.end,
      of: all.length,
      complete,
      nextCursor,
      changedSinceFirstPage: cur.changedSinceFirstPage || undefined,
    },
    notes,
    next: nextReads(shown),
    ...(traces.length ? { nextTrace: traces } : {}),
  };
  return JSON.stringify(result, null, args.format === "json" ? undefined : 1);
}

/** Largest reply for an explicit `limit`, in characters (about 30k tokens). */
const MAX_EXPLICIT_BUDGET = 120_000;

/** The text of the function declared at `line` of `file`: from that line to its closing brace. */
function functionText(file: string, line: number): string {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, file), "utf8");
  } catch {
    return "";
  }
  const lines = text.split("\n").slice(line - 1, line + 300);
  let depth = 0;
  let opened = false;
  const out: string[] = [];
  for (const l of lines) {
    out.push(l);
    for (const ch of l) {
      if (ch === "{") (depth++, (opened = true));
      else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) break;
  }
  return out.join("\n");
}

/**
 * Callers stop at HTTP: a target that sends a request has callers on the other
 * side of it that this list cannot show, and sites in endpoint handlers are
 * reached by HTTP from elsewhere. spec_nav_trace_flow follows both; agents did
 * not reach for it unprompted, so the result offers the call.
 */
function traceHints(targets: Array<{ name: string; file: string; line: number }>, all: CallSite[]): string[] {
  const out: string[] = [];
  const t = targets.find((x) => HTTP_CALL.test(functionText(x.file, x.line)));
  if (t) {
    const name = t.name.split(".").pop()!;
    out.push(
      `Next — ${t.name} makes an HTTP call: which service and handler receive it: ` +
        `spec_nav_trace_flow ${JSON.stringify({ file: t.file, name: t.name.includes(".") ? t.name : name, direction: "downstream" })}`,
    );
  }
  const r = all.find((s) => ROUTE_FILE.test(s.file) && s.enclosing && !s.enclosing.startsWith("<"));
  if (r) {
    out.push(
      `Next — ${r.file} (${r.enclosing}) is an endpoint handler: who calls it, across services: ` +
        `spec_nav_trace_flow ${JSON.stringify({ file: r.file, name: r.enclosing, direction: "upstream" })}`,
    );
  }
  return out;
}

/**
 * The calling functions on this page, as one ready read_function batch — what
 * usually follows a callers check before a change. Left out when the page has
 * more than ten of them: that is a list to triage, not to read whole.
 */
function nextReads(shown: CallSite[]): string | undefined {
  // A short calling function is read whole; a long one (a 1,000-line component
  // or handler) only around the calls, which is what the caller needs to see.
  const whole = new Map<string, { file: string; name: string; line: number }>();
  const windows = new Map<string, { file: string; lines: number[] }>();
  for (const s of shown) {
    if (s.resolution === "unresolved" || s.resolution === "dynamic" || s.resolution === "reference") continue;
    const end = enclosingEnd.get(s);
    if (s.enclosing && !s.enclosing.startsWith("<") && end && end - s.enclosingLine + 1 <= SHORT_FUNCTION) {
      whole.set(`${s.file}\u0000${s.enclosing}\u0000${s.enclosingLine}`, { file: s.file, name: s.enclosing, line: s.enclosingLine });
    } else {
      const w = windows.get(s.file) ?? { file: s.file, lines: [] };
      if (w.lines.length < 12) w.lines.push(s.line);
      windows.set(s.file, w);
    }
  }
  const functions = [...whole.values(), ...windows.values()];
  if (!functions.length || functions.length > 10) return undefined;
  const what = [
    whole.size ? `${whole.size} short calling function${whole.size === 1 ? "" : "s"} whole` : "",
    windows.size ? `±${DEFAULT_AROUND} lines around the calls in ${windows.size} file${windows.size === 1 ? "" : "s"} (long functions are not read whole)` : "",
  ].filter(Boolean).join(", ");
  return `Next — read the callers in one call (${what}): spec_nav_read_function ${JSON.stringify({ functions })}`;
}

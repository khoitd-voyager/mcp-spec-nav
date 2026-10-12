import { Project, Node, SyntaxKind, ts, SourceFile } from "ts-morph";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import {
  scanRepo,
  filterFiles,
  enclosingFunction,
  relPath,
  REPO_ROOT,
  SourceEntry,
  RepoScan,
  normaliseService,
} from "./project.js";
import { scriptKindFor, WRAPPERS } from "./tsparse.js";
import { CHAR_BUDGET, decodeCursor, encodeCursor, paramsHash, takePage } from "./paging.js";
import { fingerprint } from "./project.js";

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

function optionsFor(file: string): ts.CompilerOptions {
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
function workspacePackages(scan: RepoScan): Map<string, string> {
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

function firstExisting(base: string): string | undefined {
  if (existsSync(base) && SOURCE_EXTS.includes(path.extname(base)) && !base.endsWith(".d.ts")) return base;
  const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  for (const ext of SOURCE_EXTS) if (existsSync(stripped + ext)) return stripped + ext;
  for (const ext of SOURCE_EXTS) if (existsSync(path.join(base, "index" + ext))) return path.join(base, "index" + ext);
  return undefined;
}

/** `@repo/shared` or `@repo/shared/x` → a source file in that package, if one exists. */
function resolveWorkspace(spec: string, pkgs: Map<string, string>): string | undefined {
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

interface State {
  project: Project;
  stamps: Map<string, string>;
  pkgs: Map<string, string>;
}
let state: State | undefined;

function getState(scan: RepoScan): State {
  const pkgs = workspacePackages(scan);
  if (!state) {
    const holder: { pkgs: Map<string, string> } = { pkgs };
    const project = new Project({
      compilerOptions: DEFAULT_OPTIONS,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      resolutionHost: (host) => ({
        resolveModuleNames: (names: string[], containingFile: string) =>
          names.map((n) => {
            const ws = resolveWorkspace(n, holder.pkgs);
            if (ws) return { resolvedFileName: ws, extension: extensionOf(ws), isExternalLibraryImport: false };
            return ts.resolveModuleName(n, containingFile, optionsFor(containingFile), host).resolvedModule;
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
    live.add(e.abs);
    if (st.stamps.get(e.abs) === e.stamp) continue;
    let text: string;
    try {
      text = readFileSync(e.abs, "utf8");
    } catch {
      continue;
    }
    const existing = st.project.getSourceFile(e.abs);
    if (existing) existing.replaceWithText(text);
    else st.project.createSourceFile(e.abs, text, { overwrite: true, scriptKind: scriptKindFor(e.ext) });
    st.stamps.set(e.abs, e.stamp);
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

export interface CallSite {
  file: string;
  line: number;
  enclosing: string;
  enclosingLine: number;
  /** The enclosing function's parameters — is the value you need already here? */
  enclosingParams: string[];
  /** How many arguments this call site passes (calls only). */
  argCount?: number;
  /** The call site's text, truncated. */
  snippet: string;
  /** Which target declaration it resolved to. */
  target?: string;
  resolution: "resolved" | "via-interface-or-base" | "unresolved" | "reference";
  reason?: string;
}

const TS_LANGS = new Set(["typescript", "javascript"]);

function siteOf(node: Node, extra: Partial<CallSite> & Pick<CallSite, "resolution">, wholeLine = false): CallSite {
  const enc = enclosingFunction(node);
  const sf = node.getSourceFile();
  const text = (wholeLine
    ? sf.getFullText().split("\n")[node.getStartLineNumber() - 1].trim()
    : node.getText()
  ).replace(/\s+/g, " ");
  return {
    file: relPath(node.getSourceFile().getFilePath()),
    line: node.getStartLineNumber(),
    enclosing: enc.name,
    enclosingLine: enc.line,
    enclosingParams: enc.params,
    snippet: text.length > 120 ? text.slice(0, 119) + "…" : text,
    ...extra,
  };
}

export function findCallers(args: CallersArgs): string {
  const raw = args.symbol.trim();
  const parts = raw.split(".");
  const base = parts[parts.length - 1];
  const qualifierWanted = [...parts.slice(0, -1)];
  if (args.className) qualifierWanted.push(args.className);
  if (!/^[A-Za-z_$#][\w$]*$/.test(base)) throw new Error(`"${raw}" is not a function or method name.`);

  const scan = scanRepo();
  const allTs = scan.files.filter((f) => TS_LANGS.has(f.language));
  const searchEntries = filterFiles(scan, args.searchServices).filter((f) => TS_LANGS.has(f.language));
  const st = getState(scan);
  sync(st, allTs);
  const project = st.project;

  // --- targets
  let targetFiles = args.service ? filterFiles(scan, [args.service]).filter((f) => TS_LANGS.has(f.language)) : allTs;
  if (args.file) {
    const want = args.file.replace(/\\/g, "/").replace(/^\.\//, "");
    targetFiles = targetFiles.filter((f) => f.rel === want || f.rel.endsWith("/" + want));
    if (!targetFiles.length) throw new Error(`No TypeScript/JavaScript file "${args.file}" in scope.`);
  }
  const collectTargets = (files: SourceEntry[]) => {
    const out: Target[] = [];
    for (const e of files) {
      const sf = project.getSourceFile(e.abs);
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
  let targets = collectTargets(targetFiles);
  const notes: string[] = [];
  // `service` used to mean "the service to search"; a caller asking about a
  // function another service declares should still get an answer.
  if (!targets.length && args.service && !args.file) {
    targets = collectTargets(allTs);
    if (targets.length) {
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
  const names = new Set<string>([base]);
  const tsFiles = allTs.map((e) => project.getSourceFile(e.abs)).filter((s): s is SourceFile => !!s);
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

  // --- call sites and references
  const resolved: CallSite[] = [];
  const viaRelated: CallSite[] = [];
  const unresolved: CallSite[] = [];
  const references: CallSite[] = [];
  const otherSymbols = new Map<string, number>();

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
    const sf = project.getSourceFile(e.abs);
    if (!sf) continue;
    const text = sf.getFullText();
    const local = defaultAliases.get(sf.getFilePath());
    const fileNames = local ? new Set([...names, ...local]) : names;
    if (![...fileNames].some((n) => text.includes(n))) continue;

    sf.forEachDescendant((node) => {
      if (!Node.isIdentifier(node) && !Node.isPrivateIdentifier(node)) return;
      if (!fileNames.has(node.getText())) return;
      const parent = node.getParent();
      if (!parent) return;
      // Skip the declarations themselves and import/export plumbing.
      if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent) || Node.isImportClause(parent)) return;
      if ((Node.isFunctionDeclaration(parent) || Node.isMethodDeclaration(parent) || Node.isVariableDeclaration(parent) ||
           Node.isPropertyDeclaration(parent) || Node.isPropertyAssignment(parent) || Node.isMethodSignature(parent) ||
           Node.isPropertySignature(parent) || Node.isParameterDeclaration(parent) || Node.isBindingElement(parent) ||
           Node.isShorthandPropertyAssignment(parent) || Node.isClassDeclaration(parent) ||
           Node.isGetAccessorDeclaration(parent) || Node.isSetAccessorDeclaration(parent)) &&
          (parent as any).getNameNode?.() === node) {
        return;
      }
      // Is it the callee of a call? `f()`, `obj.f()`, `obj?.f()`.
      let callee: Node = node;
      if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) callee = parent;
      else if (Node.isPropertyAccessExpression(parent)) return; // `f.x` — the object, not a call of f
      const cp = callee.getParent();
      const isCall = !!cp && (Node.isCallExpression(cp) || Node.isNewExpression(cp)) && cp.getExpression() === callee;
      // Uses inside a type (`typeof f`) are not runtime uses.
      if (!isCall && node.getFirstAncestor((a) => Node.isTypeNode(a)) ) return;

      const c = classify(node);
      if (isCall) {
        const call = cp as any;
        const extra = { argCount: call.getArguments().length };
        if (c.t && !c.via) resolved.push(siteOf(cp!, { ...extra, resolution: "resolved", target: c.t.qualified }));
        else if (c.t && c.via) viaRelated.push(siteOf(cp!, { ...extra, resolution: "via-interface-or-base", target: c.t.qualified, reason: `bound to ${c.via}` }));
        else if (c.other) otherSymbols.set(c.other, (otherSymbols.get(c.other) ?? 0) + 1);
        // An unresolved call is only interesting when it is by the target's own name.
        else if (node.getText() === base || local?.has(node.getText())) {
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
  }

  // Other languages: name mentions only, never analysed.
  const wordRe = new RegExp(`\\b${base.replace(/[$]/g, "\\$")}\\b`);
  const otherLang = filterFiles(scan, args.searchServices)
    .filter((f) => !TS_LANGS.has(f.language))
    .filter((f) => {
      try {
        return wordRe.test(readFileSync(f.abs, "utf8"));
      } catch {
        return false;
      }
    })
    .map((f) => f.rel);

  const byLoc = (a: CallSite, b: CallSite) => a.file.localeCompare(b.file) || a.line - b.line;
  resolved.sort(byLoc);
  viaRelated.sort(byLoc);
  unresolved.sort(byLoc);
  references.sort(byLoc);

  const all = [...resolved, ...viaRelated, ...references, ...unresolved];
  const qHash = paramsHash({ ...args, cursor: undefined, limit: undefined, format: undefined });
  const fp = fingerprint(allTs);
  const cur = decodeCursor(args.cursor, "callers", qHash, fp);
  const start = typeof cur.position === "number" ? cur.position : 0;
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const page = takePage(all, start, limit, CHAR_BUDGET - 5000, (s) => JSON.stringify(s));
  const shown = all.slice(start, page.end);
  const complete = page.end >= all.length;
  const nextCursor = complete ? undefined : encodeCursor({ t: "callers", q: qHash, p: page.end, f: cur.fingerprint });

  const exhaustive = targets.length > 0 && unresolved.length === 0 && otherLang.length === 0;
  if (!targets.length) {
    notes.push(
      `No TypeScript/JavaScript function or method named "${raw}" was found` +
        (args.service ? ` in ${normaliseService(args.service)}` : "") +
        (args.file ? ` in ${args.file}` : "") +
        `. Every call by that name is listed as unresolved; check the name, or pass file/className.`,
    );
  } else if (new Set(targets.map((t) => t.qualified)).size > 1 || targets.length > 1) {
    notes.push(
      `${targets.length} declarations match "${raw}"; sites are attributed to each via \`target\`. ` +
        `Pass \`file\` and/or \`className\` (or "Class.method" as symbol) to ask about one.`,
    );
  }
  if (otherSymbols.size) notes.push(`Calls by the same name that resolve to a different declaration are excluded and counted in otherSymbolsSameName.`);
  if (unresolved.length) notes.push(`${unresolved.length} call(s) by this name could not be resolved to a declaration; inspect them — they may or may not be calls of the target.`);
  if (otherLang.length) notes.push(`${otherLang.length} file(s) in other languages mention "${base}"; they are not analysed (use spec_nav_map).`);
  notes.push(
    "Not counted anywhere: dynamic calls (obj[name]()), calls in unsupported file types, and code outside the repo. " +
      (exhaustive ? "Within those limits every call to the target(s) was resolved." : "So this is NOT a complete list of call sites."),
  );

  const result = {
    symbol: raw,
    total: resolved.length,
    totals: {
      resolved: resolved.length,
      viaInterfaceOrBase: viaRelated.length,
      references: references.length,
      unresolved: unresolved.length,
      otherSymbolsSameName: [...otherSymbols.values()].reduce((a, b) => a + b, 0),
    },
    exhaustive,
    targets: targets.map((t) => ({ name: t.qualified, file: t.file, line: t.line, kind: t.kind })),
    sites: shown.filter((s) => s.resolution === "resolved"),
    viaInterfaceOrBase: shown.filter((s) => s.resolution === "via-interface-or-base"),
    references: shown.filter((s) => s.resolution === "reference"),
    unresolved: shown.filter((s) => s.resolution === "unresolved"),
    otherSymbolsSameName: Object.fromEntries(otherSymbols),
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
  };
  return JSON.stringify(result, null, args.format === "json" ? undefined : 1);
}

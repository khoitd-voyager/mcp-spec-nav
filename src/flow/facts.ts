import { readFileSync, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { ts } from "ts-morph";
import { REPO_ROOT, RepoScan, SourceEntry, isTsFamily } from "../project.js";
import { optionsFor, resolveWorkspace, workspacePackages, firstExisting, clearConfigCache } from "../callers.js";
import { catalogFile, Indexed } from "../catalog.js";
import { FileFacts, StrVal, NameRef, Part, InstanceFact, concat, lit, withVia, show } from "./model.js";
import { extractTs, TS_PREFILTER, isFileRoute } from "./tsfacts.js";
import { extractPython, PY_PREFILTER } from "./pyfacts.js";

/**
 * Facts per file, cached by the file's stamp — the same freshness rule as the
 * function catalog: every query re-walks the tree, so an edited, added or
 * deleted file is reflected on the next call.
 *
 * Communication facts count only for files that match the family's prefilter
 * (the inventory). A file outside it may still be parsed later for its direct
 * calls, when a traced flow passes through it; its communication facts are
 * then ignored, so the answer never depends on which files a query happened
 * to visit.
 */

interface CacheEntry {
  stamp: string;
  analysed: boolean;
  facts?: FileFacts;
}

const cache = new Map<string, CacheEntry>();

export function familyOf(language: string): "ts" | "python" | undefined {
  if (isTsFamily(language)) return "ts";
  if (language === "python") return "python";
  return undefined;
}

async function extract(entry: SourceEntry, text: string, analysed: boolean): Promise<FileFacts> {
  if (familyOf(entry.language) === "ts") {
    try {
      return extractTs(entry, text, analysed);
    } catch (err) {
      const f = extractTsFallback(entry, analysed);
      f.parseError = `adapter crashed: ${err instanceof Error ? err.message : err}`;
      return f;
    }
  }
  return extractPython(entry, text, analysed);
}

function extractTsFallback(entry: SourceEntry, analysed: boolean): FileFacts {
  return {
    rel: entry.rel, service: entry.service, language: entry.language, stamp: entry.stamp, family: "ts", analysed,
    imports: new Map(), consts: new Map(), exportAs: new Map(), reexports: [], classes: new Map(), newVars: new Map(), varTypes: new Map(),
    calls: [], routers: new Map(), routes: [], mounts: [], instances: new Map(), clients: [], pending: [],
    handlers: [], sends: [], ports: [], globalPrefix: [], kafka: new Map(), notes: [], unproven: [],
  };
}

/** Forget files that are gone. */
export function pruneCache(scan: RepoScan): void {
  const live = new Set(scan.files.map((f) => f.abs));
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
}

/** The inventory: facts of every file whose text names a supported library or looks like HTTP. */
export async function analysedFacts(entries: SourceEntry[]): Promise<FileFacts[]> {
  const out: FileFacts[] = [];
  for (const e of entries) {
    const fam = familyOf(e.language);
    if (!fam) continue;
    let ce = cache.get(e.abs);
    if (!ce || ce.stamp !== e.stamp) {
      let text: string;
      try {
        text = readFileSync(e.abs, "utf8");
      } catch {
        continue;
      }
      const analysed = fam === "ts" ? TS_PREFILTER.test(text) || isFileRoute(e.rel) : PY_PREFILTER.test(text);
      ce = { stamp: e.stamp, analysed, facts: analysed ? await extract(e, text, true) : undefined };
      cache.set(e.abs, ce);
    }
    if (ce.analysed && ce.facts) out.push(ce.facts);
  }
  return out;
}

/** Facts of one file, parsed if needed — for its direct calls and exports. */
export async function factsOf(e: SourceEntry): Promise<FileFacts | undefined> {
  const fam = familyOf(e.language);
  if (!fam) return undefined;
  let ce = cache.get(e.abs);
  if (ce && ce.stamp === e.stamp && ce.facts) return ce.facts;
  let text: string;
  try {
    text = readFileSync(e.abs, "utf8");
  } catch {
    return undefined;
  }
  const analysed = fam === "ts" ? TS_PREFILTER.test(text) || isFileRoute(e.rel) : PY_PREFILTER.test(text);
  ce = { stamp: e.stamp, analysed, facts: await extract(e, text, analysed) };
  cache.set(e.abs, ce);
  return ce.facts;
}

// ---------------------------------------------------------------------------
// The repo as the linker sees it: entries by path, module resolution.

export class Repo {
  readonly byRel = new Map<string, SourceEntry>();
  private readonly byAbs = new Map<string, SourceEntry>();
  private readonly pkgs: Map<string, string>;
  private readonly specCache = new Map<string, string | undefined>();

  constructor(readonly scan: RepoScan) {
    for (const f of scan.files) {
      this.byRel.set(f.rel, f);
      this.byAbs.set(path.normalize(f.abs), f);
    }
    this.pkgs = workspacePackages(scan);
    clearConfigCache();
  }

  entry(rel: string): SourceEntry | undefined {
    return this.byRel.get(rel);
  }

  async facts(rel: string): Promise<FileFacts | undefined> {
    const e = this.byRel.get(rel);
    return e ? factsOf(e) : undefined;
  }

  async functions(rel: string): Promise<Indexed[]> {
    const e = this.byRel.get(rel);
    if (!e) return [];
    return (await catalogFile(e)).functions;
  }

  /** The repo file a module specifier names, from `fromRel`; undefined for a library or a file not scanned. */
  resolveSpec(fromRel: string, spec: string, family: "ts" | "python"): string | undefined {
    const k = `${family}\0${fromRel}\0${spec}`;
    if (this.specCache.has(k)) return this.specCache.get(k);
    const r = family === "ts" ? this.resolveTs(fromRel, spec) : this.resolvePy(fromRel, spec);
    this.specCache.set(k, r);
    return r;
  }

  private relIfScanned(abs: string | undefined): string | undefined {
    if (!abs) return undefined;
    const e = this.byAbs.get(path.normalize(abs));
    return e?.rel;
  }

  private resolveTs(fromRel: string, spec: string): string | undefined {
    const fromAbs = path.join(REPO_ROOT, fromRel);
    if (spec.startsWith(".") || spec.startsWith("/")) {
      return this.relIfScanned(firstExisting(path.resolve(path.dirname(fromAbs), spec)));
    }
    const ws = resolveWorkspace(spec, this.pkgs);
    if (ws) return this.relIfScanned(ws);
    try {
      const r = ts.resolveModuleName(spec, fromAbs, optionsFor(fromAbs), ts.sys).resolvedModule;
      if (!r || r.isExternalLibraryImport || /[\\/]node_modules[\\/]/.test(r.resolvedFileName)) return undefined;
      return this.relIfScanned(r.resolvedFileName.endsWith(".d.ts") ? undefined : r.resolvedFileName);
    } catch {
      return undefined;
    }
  }

  /** `.routers.orders` (relative) or `app.routers.orders` (from any enclosing directory). */
  private resolvePy(fromRel: string, spec: string): string | undefined {
    const fromAbs = path.join(REPO_ROOT, fromRel);
    const dots = spec.match(/^\.*/)![0].length;
    const mod = spec.slice(dots);
    const asPath = mod ? mod.split(".").join(path.sep) : "";
    const tryBase = (base: string) => {
      for (const c of [base + ".py", path.join(base, "__init__.py")]) {
        if (existsSync(c) && statSync(c).isFile()) return this.relIfScanned(c);
      }
      return undefined;
    };
    if (dots > 0) {
      let dir = path.dirname(fromAbs);
      for (let i = 1; i < dots; i++) dir = path.dirname(dir);
      return tryBase(asPath ? path.join(dir, asPath) : dir);
    }
    let dir = path.dirname(fromAbs);
    for (;;) {
      const r = tryBase(path.join(dir, asPath));
      if (r) return r;
      if (dir === REPO_ROOT || !dir.startsWith(REPO_ROOT)) return undefined;
      const up = path.dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
  }

  /** Python: `from .pkg import mod` where mod is a submodule file rather than a name in pkg/__init__.py. */
  pySubmodule(fromRel: string, spec: string, name: string): string | undefined {
    const joined = spec.endsWith(".") ? spec + name : `${spec}.${name}`;
    return this.resolveSpec(fromRel, joined, "python");
  }
}

// ---------------------------------------------------------------------------
// Following names across files.

export type Found =
  | { kind: "const"; file: string; value: StrVal; line: number }
  /** An object of constants (`SUM = { cmd: "sum" }`), one level deep. */
  | { kind: "object"; file: string; entries: Array<[string, StrVal]>; line: number }
  | { kind: "router"; file: string; local: string }
  | { kind: "instance"; file: string; inst: InstanceFact }
  | { kind: "function"; file: string; fn: Indexed }
  | { kind: "class"; file: string; name: string }
  | { kind: "module"; file: string };

const MAX_HOPS = 8;

/** What `ref` names, as seen from file `from`: something in that file, or what an import brings in. */
export async function resolveRef(repo: Repo, from: FileFacts, ref: NameRef, depth = 0): Promise<Found | undefined> {
  if (depth > MAX_HOPS) return undefined;
  const own = await findLocal(repo, from, ref.local, ref.path);
  if (own) return own;
  const imp = from.imports.get(ref.local);
  if (!imp) return undefined;
  let target = repo.resolveSpec(from.rel, imp.spec, from.family);
  if (!target) return undefined;
  if (imp.imported === "*" || imp.imported === "cjs") {
    if (!ref.path.length) {
      // require("./x") is whatever module.exports holds.
      const value = imp.imported === "cjs" ? await lookupExport(repo, target, "default", [], depth + 1) : undefined;
      return value ?? { kind: "module", file: target };
    }
    return lookupExport(repo, target, ref.path[0], ref.path.slice(1), depth + 1);
  }
  // Python: `from .routers import orders` where orders is a module file.
  if (from.family === "python") {
    const sub = repo.pySubmodule(from.rel, imp.spec, imp.imported);
    if (sub) {
      if (!ref.path.length) return { kind: "module", file: sub };
      return lookupExport(repo, sub, ref.path[0], ref.path.slice(1), depth + 1);
    }
  }
  return lookupExport(repo, target, imp.imported, ref.path, depth + 1);
}

/** A name exported by (or, in Python, defined at module level in) `file`. */
export async function lookupExport(repo: Repo, file: string, name: string, rest: string[], depth: number): Promise<Found | undefined> {
  if (depth > MAX_HOPS) return undefined;
  const f = await repo.facts(file);
  if (!f) return undefined;
  const local = f.exportAs.get(name) ?? name;
  const own = await findLocal(repo, f, local, rest);
  if (own) return own;
  if (f.imports.has(local)) return resolveRef(repo, f, { local, path: rest }, depth + 1);
  for (const re of f.reexports) {
    const t = repo.resolveSpec(f.rel, re.spec, f.family);
    if (!t) continue;
    if (re.names) {
      const orig = re.names.get(name);
      if (orig !== undefined) return lookupExport(repo, t, orig, rest, depth + 1);
    } else {
      const r = await lookupExport(repo, t, name, rest, depth + 1);
      if (r) return r;
    }
  }
  if (f.family === "python") {
    const sub = repo.pySubmodule(f.rel, ".", name);
    if (sub && sub !== file) {
      if (!rest.length) return { kind: "module", file: sub };
      return lookupExport(repo, sub, rest[0], rest.slice(1), depth + 1);
    }
  }
  return undefined;
}

/** A router, client instance, constant, function or class defined in this file under `local`. */
async function findLocal(repo: Repo, f: FileFacts, local: string, rest: string[]): Promise<Found | undefined> {
  if (!rest.length) {
    if (f.routers.has(local)) return { kind: "router", file: f.rel, local };
    if (f.routers.has(`fn:${local}`)) return { kind: "router", file: f.rel, local: `fn:${local}` };
    const inst = f.instances.get(local);
    if (inst) return { kind: "instance", file: f.rel, inst };
  }
  const ck = [local, ...rest].join(".");
  const c = f.consts.get(ck);
  if (c) return { kind: "const", file: f.rel, value: { parts: c.parts, via: c.via }, line: c.line };
  const prefix = ck + ".";
  const members = [...f.consts].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("."));
  if (members.length) {
    return {
      kind: "object", file: f.rel, line: members[0][1].line,
      entries: members.map(([k, v]) => [k.slice(prefix.length), { parts: v.parts, via: v.via }] as [string, StrVal]),
    };
  }
  const fns = await repo.functions(f.rel);
  if (!rest.length) {
    const fn = topLevel(fns, local);
    if (fn) return { kind: "function", file: f.rel, fn };
    if (fns.some((x) => x.rec.name.startsWith(local + "."))) return { kind: "class", file: f.rel, name: local };
  } else if (rest.length === 1) {
    const m = fns.find((x) => x.rec.name === `${local}.${rest[0]}`);
    if (m) return { kind: "function", file: f.rel, fn: m };
    const cls = f.newVars.get(local);
    if (cls) {
      const mm = fns.find((x) => x.rec.name === `${cls}.${rest[0]}`);
      if (mm) return { kind: "function", file: f.rel, fn: mm };
    }
  }
  return undefined;
}

/** A top-level function by the name it is bound to (or exported as, for `default`). */
export function topLevel(fns: Indexed[], name: string): Indexed | undefined {
  if (name === "default") {
    return fns.find((x) => !x.rec.name.includes(".") &&
      (x.rec.name === "default" || x.rec.exportedAs?.includes("default") || x.rec.exportedAs?.includes("module.exports")));
  }
  return fns.find((x) => x.rec.name === name) ??
    fns.find((x) => !x.rec.name.includes(".") && x.rec.exportedAs?.some((a) => a === name || a.endsWith("." + name)));
}

/** A string with every imported name replaced by what it resolves to, or by an unknown part saying why not. */
export async function resolveStr(repo: Repo, from: FileFacts, v: StrVal, depth = 0): Promise<StrVal> {
  if (!v.parts.some((p) => p.k === "ref")) return v;
  const pieces: StrVal[] = [];
  for (const p of v.parts) {
    if (p.k !== "ref") {
      pieces.push({ parts: [p], via: [] });
      continue;
    }
    const name = [p.local, ...p.path].join(".");
    const found = depth < MAX_HOPS ? await resolveRef(repo, from, { local: p.local, path: p.path }) : undefined;
    if (found?.kind === "const") {
      const tf = await repo.facts(found.file);
      const inner = tf ? await resolveStr(repo, tf, found.value, depth + 1) : found.value;
      pieces.push(withVia(inner, `${name} = "${show(inner)}" (${found.file}:${found.line})`));
    } else {
      const imp = from.imports.get(p.local);
      const why = imp && !repo.resolveSpec(from.rel, imp.spec, from.family) ? `imported from "${imp.spec}", outside the repo` : "not a constant the analysis can read";
      const unknown: Part = { k: "dyn", text: name };
      pieces.push({ parts: [unknown], via: [`${name}: ${why}`] });
    }
  }
  return concat(lit(""), ...pieces, { parts: [], via: v.via });
}

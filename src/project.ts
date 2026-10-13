import { Node, SyntaxKind } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { languageForExt, PARSEABLE_EXTENSIONS } from "./languages.js";
import { SFC_EXTENSIONS, sfcLanguage } from "./sfc.js";

/** Root the `service` arguments resolve against; from env, else cwd. */
export const REPO_ROOT = process.env.SPEC_NAV_ROOT
  ? path.resolve(process.env.SPEC_NAV_ROOT)
  : process.cwd();

/**
 * Directories that always hold dependencies, caches or build output. A hit in
 * `node_modules/` or `site-packages/` is somebody else's code, and reporting
 * it buries the handful of lines that are actually yours.
 *
 * Names that are *sometimes* output and sometimes source are not here — see
 * `isSkippedDir`. `packages/` is the clearest case: in a JS monorepo it is
 * where half the code lives, and only NuGet uses it for downloaded packages.
 */
export const SKIP_DIRS = new Set([
  // JS/TS
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".svelte-kit",
  // Python
  "__pycache__",
  "site-packages",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".eggs",
  // Go, PHP, Ruby
  "vendor",
  // Rust
  "target",
  // JVM
  ".gradle",
  // General
  ".git",
  "coverage",
]);

/** Names that are build or dependency output only in the right context. */
function isSkippedDir(parentNames: Set<string>, name: string, abs: string): string | undefined {
  if (SKIP_DIRS.has(name)) return "dependency/build";
  if (name.startsWith(".")) return "hidden";
  // A virtualenv is recognised by its marker, not its name: `env/` is also a
  // perfectly ordinary source folder in a TS app (`src/env/index.ts`).
  if (fs.existsSync(path.join(abs, "pyvenv.cfg"))) return "python virtualenv";
  // bin/ and obj/ are .NET output only next to a project file; elsewhere
  // `bin/` is where a CLI's entry scripts live.
  if ((name === "bin" || name === "obj") && [...parentNames].some(isDotnetProjectFile)) {
    return "dotnet build output";
  }
  // NuGet's packages folder holds .nupkg archives or a repositories.config.
  if (name === "packages" && isNugetPackagesDir(abs)) return "nuget packages";
  return undefined;
}

function isDotnetProjectFile(n: string): boolean {
  return n.endsWith(".csproj") || n.endsWith(".fsproj") || n.endsWith(".vbproj") || n.endsWith(".sln");
}

function isNugetPackagesDir(abs: string): boolean {
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    if (entries.some((e) => e.name === "repositories.config")) return true;
    for (const e of entries.slice(0, 20)) {
      if (!e.isDirectory()) continue;
      const inner = fs.readdirSync(path.join(abs, e.name));
      if (inner.some((n) => n.endsWith(".nupkg"))) return true;
    }
  } catch {
    /* unreadable: treat as source and let the walker report it */
  }
  return false;
}

/**
 * Files that mark a directory as the root of a project, across the languages
 * we can read. A project boundary is how output is grouped into services; it
 * does not stop the walk — a project inside a project is still found.
 */
const PROJECT_MARKERS = new Set([
  // TypeScript / JavaScript
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  // Python
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  // Go
  "go.mod",
  // Java / Kotlin / JVM
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  // Ruby
  "Gemfile",
  "Rakefile",
  // Rust
  "Cargo.toml",
  // PHP
  "composer.json",
  // C#
  "Directory.Build.props",
  // Elixir, Scala
  "mix.exs",
  "build.sbt",
]);

/** A .csproj/.sln has a variable name, so it is matched by extension. */
const PROJECT_MARKER_EXTENSIONS = [".csproj", ".sln", ".fsproj", ".gemspec"];

/** TypeScript and JavaScript go through the TypeScript parser, not tree-sitter. */
export const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
export const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/** Every extension we can attach a function name to. */
export const SCANNABLE = new Set<string>([...TS_EXTENSIONS, ...JS_EXTENSIONS, ...SFC_EXTENSIONS, ...PARSEABLE_EXTENSIONS]);

/**
 * Languages read by the TypeScript parser: TS, JS, and the script blocks of
 * Vue/Svelte/Astro components.
 */
export const TS_FAMILY = new Set(["typescript", "javascript", "vue", "svelte", "astro"]);
export function isTsFamily(language: string): boolean {
  return TS_FAMILY.has(language);
}

/**
 * Extensions of source code we cannot parse. Counted and reported so that "no
 * match" in a repo full of .vue or .kt files is not mistaken for "absent".
 */
const UNSUPPORTED_SOURCE = new Set([
  ".lua", ".dart", ".m", ".mm",
  ".sql", ".pl", ".pm", ".r", ".clj", ".cljs", ".hs", ".fs", ".fsx", ".vb", ".groovy",
  ".erl", ".ml", ".zig", ".nim", ".jl", ".cr", ".sol", ".erb", ".ejs", ".hbs", ".twig",
  ".coffee", ".mdx", ".graphql", ".gql", ".proto",
]);

/** Files bigger than this are almost always generated or minified bundles. */
export const MAX_FILE_BYTES = 1_500_000;

export interface SourceEntry {
  abs: string;
  /** Path relative to REPO_ROOT, always with forward slashes. */
  rel: string;
  /** The innermost project containing the file, or "." for the root. */
  service: string;
  ext: string;
  /** "typescript", "javascript", "vue", "svelte", "astro", or a tree-sitter/brace language id. */
  language: string;
  size: number;
  /** Changes whenever the file's content can have changed. */
  stamp: string;
}

export interface RepoScan {
  root: string;
  services: string[];
  files: SourceEntry[];
  /** Source files in languages we cannot parse (relative paths). */
  unsupported: string[];
  /** Directories not entered, with why. Relative paths. */
  skippedDirs: Array<{ dir: string; reason: string }>;
  /** Supported-language files left out, with why (too large, minified). */
  skippedFiles: Array<{ file: string; reason: string }>;
  /** Directories that could not be read. */
  unreadable: string[];
}

function assertRoot() {
  // An unreadable root is a configuration mistake, not an empty repo. Left to
  // the walker it would return no files, and the caller would report "0 hits"
  // — indistinguishable from having searched the whole repo and found
  // nothing. The usual cause is SPEC_NAV_ROOT still holding a placeholder.
  if (!fs.existsSync(REPO_ROOT)) {
    throw new Error(
      `SPEC_NAV_ROOT points at "${REPO_ROOT}", which does not exist. ` +
        `Set it to the absolute path of the repo to scan.`,
    );
  }
  if (!fs.statSync(REPO_ROOT).isDirectory()) {
    throw new Error(`SPEC_NAV_ROOT points at "${REPO_ROOT}", which is not a directory.`);
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function languageOf(ext: string): string | undefined {
  if (TS_EXTENSIONS.has(ext)) return "typescript";
  if (JS_EXTENSIONS.has(ext)) return "javascript";
  return sfcLanguage(ext) ?? languageForExt(ext)?.id;
}

/**
 * Walk the whole repo once: find every project at any depth, and every source
 * file, each assigned to exactly one project — the innermost one holding it.
 *
 * There is no depth limit. A repo that nests services four levels down is not
 * unusual, and a limit there is a silent hole: the files are simply never
 * listed, and nothing in the output says so. The walk is cheap (readdir plus a
 * stat per source file), and it runs on every call so results always reflect
 * the checkout as it is now.
 *
 * Root files are covered too: when the root holds `src/` next to `services/`,
 * `src/` belongs to the root project "." rather than being dropped because
 * sub-projects were found.
 */
export function scanRepo(): RepoScan {
  assertRoot();
  const projects: string[] = [];
  const files: SourceEntry[] = [];
  const unsupported: string[] = [];
  const skippedDirs: RepoScan["skippedDirs"] = [];
  const skippedFiles: RepoScan["skippedFiles"] = [];
  const unreadable: string[] = [];

  const walk = (dir: string, rel: string, service: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(rel || ".");
      return;
    }
    // Symlinks are not followed: they are how a workspace links packages into
    // node_modules, and following them would list the same file twice or loop.
    const names = new Set(entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name));
    const isProject =
      names.has("src") ||
      [...names].some(
        (n) => PROJECT_MARKERS.has(n) || PROJECT_MARKER_EXTENSIONS.some((ext) => n.endsWith(ext)),
      );
    let current = service;
    if (rel && isProject) {
      projects.push(rel);
      current = rel;
    }

    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const why = isSkippedDir(names, e.name, abs);
        if (why) {
          // Hidden directories are not worth a line each (.git, .idea, .vscode).
          if (why !== "hidden") skippedDirs.push({ dir: childRel, reason: why });
          continue;
        }
        walk(abs, childRel, current);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        // A .d.ts is generated declarations; a hit there is the type of the
        // thing, never the thing itself.
        if (e.name.endsWith(".d.ts") || e.name.endsWith(".d.mts") || e.name.endsWith(".d.cts")) continue;
        if (!SCANNABLE.has(ext)) {
          if (UNSUPPORTED_SOURCE.has(ext)) unsupported.push(toPosix(childRel));
          continue;
        }
        let st: fs.BigIntStats;
        try {
          st = fs.statSync(abs, { bigint: true });
        } catch {
          continue;
        }
        if (/\.min\.(js|mjs|cjs)$/.test(e.name)) {
          skippedFiles.push({ file: childRel, reason: "minified" });
          continue;
        }
        if (st.size > BigInt(MAX_FILE_BYTES)) {
          skippedFiles.push({ file: childRel, reason: `over ${MAX_FILE_BYTES} bytes` });
          continue;
        }
        files.push({
          abs,
          rel: toPosix(childRel),
          service: current,
          ext,
          language: languageOf(ext)!,
          size: Number(st.size),
          // Nanosecond mtime, ctime and size: an edit inside the same
          // millisecond that keeps the size still moves ctime.
          stamp: `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`,
        });
      }
    }
  };

  walk(REPO_ROOT, "", ".");
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // The root counts as a project when it owns files of its own, or when
  // nothing below it is a project (a single-project checkout).
  const services = [...projects];
  if (!projects.length || files.some((f) => f.service === ".")) services.push(".");
  return { root: REPO_ROOT, services: services.sort(), files, unsupported, skippedDirs, skippedFiles, unreadable };
}

/** Every project under the root, at any depth. */
export function discoverServices(): string[] {
  return scanRepo().services;
}

/**
 * Narrow a scan to the named services.
 *
 * "." means the root project's own files. Anything else is a directory under
 * the root and selects everything beneath it, nested projects included — so
 * "services" selects every service under it, and "services/api" includes
 * "services/api/plugins/x" if that is its own project.
 */
export function filterFiles(scan: RepoScan, services?: string[]): SourceEntry[] {
  if (!services?.length) return scan.files;
  const inScope = pathFilter(scan, services);
  return scan.files.filter((f) => inScope(f.rel, f.service));
}

/** A predicate for "is this path inside the named services". */
export function pathFilter(scan: RepoScan, services?: string[]): (rel: string, service?: string) => boolean {
  if (!services?.length) return () => true;
  const wanted = services.map((s) => normaliseService(s));
  for (const s of wanted) {
    if (s === ".") continue;
    const abs = path.resolve(REPO_ROOT, s);
    if (!fs.existsSync(abs)) {
      throw new Error(
        `No service "${s}" under ${REPO_ROOT}. Check SPEC_NAV_ROOT or the service name ` +
          `(spec_nav_services lists them).`,
      );
    }
  }
  return (rel, service) =>
    wanted.some((s) => {
      if (s !== ".") return rel === s || rel.startsWith(s + "/");
      // Root project: files assigned to ".", or, for paths with no service
      // (unsupported files), those not under any sub-project.
      if (service !== undefined) return service === ".";
      return !scan.services.some((sv) => sv !== "." && rel.startsWith(sv + "/"));
    });
}

export function normaliseService(s: string): string {
  const t = toPosix(s.trim()).replace(/^\.\//, "").replace(/\/+$/, "");
  return t === "" ? "." : t;
}

/** A short, stable hash of a list of file stamps — changes when any file does. */
export function fingerprint(files: SourceEntry[]): string {
  const h = createHash("sha1");
  for (const f of files) h.update(f.rel).update("\0").update(f.stamp).update("\n");
  return h.digest("hex").slice(0, 12);
}

/** Path relative to REPO_ROOT, with forward slashes. */
export function relPath(abs: string): string {
  return toPosix(path.relative(REPO_ROOT, abs));
}

export interface EnclosingInfo {
  /** Enclosing function or method name, or "<top-level>". */
  name: string;
  /** Line where the enclosing function is declared. */
  line: number;
  /** Condensed signature, to see whether a needed parameter is there. */
  signature: string;
  /** The enclosing function's parameter names. */
  params: string[];
}

const FUNCTION_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/**
 * The function or method enclosing a node — the thing you most need per call
 * site: editing here, is the value you must pass already in scope?
 */
export function enclosingFunction(node: Node): EnclosingInfo {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (FUNCTION_KINDS.has(current.getKind())) {
      const fn = current as any;
      const params: string[] =
        typeof fn.getParameters === "function"
          ? fn.getParameters().map((p: any) => p.getName())
          : [];
      let name = "<anonymous>";
      if (typeof fn.getName === "function" && fn.getName()) {
        name = fn.getName();
      } else {
        // arrow/function expression assigned to a variable: use the variable name
        const decl = current.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        if (decl) name = decl.getName();
        else if (current.getKind() === SyntaxKind.Constructor) name = "constructor";
      }
      // A method's class is what tells two `save`s apart.
      const cls = current.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
      if (cls?.getName() && current.getParent() === cls) name = `${cls.getName()}.${name}`;
      const sigParts: string[] =
        typeof fn.getParameters === "function"
          ? fn.getParameters().map((p: any) => p.getText())
          : [];
      return {
        name,
        line: current.getStartLineNumber(),
        signature: `${name}(${sigParts.join(", ")})`,
        params,
      };
    }
    current = current.getParent();
  }
  return { name: "<top-level>", line: 1, signature: "<top-level>", params: [] };
}

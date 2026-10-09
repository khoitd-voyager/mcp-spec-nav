import { Project, SourceFile, Node, SyntaxKind } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";

/** Root the `service` arguments resolve against; from env, else cwd. */
export const REPO_ROOT = process.env.SPEC_NAV_ROOT
  ? path.resolve(process.env.SPEC_NAV_ROOT)
  : process.cwd();

/** ts-morph projects, loaded lazily per service — a monorepo has many. */
const projects = new Map<string, Project>();

/** A service's tsconfig, so ts-morph resolves its path aliases. */
function findTsConfig(serviceDir: string): string | undefined {
  const candidate = path.join(serviceDir, "tsconfig.json");
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Directories that hold dependencies or build output. Each language brings its
 * own: a hit in `vendor/` or `site-packages/` is somebody else's code, and
 * reporting it buries the handful of lines that are actually yours.
 */
export const SKIP_DIRS = new Set([
  // JS/TS
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  // Python
  "__pycache__",
  "site-packages",
  "venv",
  ".venv",
  "env",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "eggs",
  // Go, PHP, Ruby
  "vendor",
  // Rust
  "target",
  // JVM
  ".gradle",
  // C#
  "bin",
  "obj",
  "packages",
  // General
  ".git",
  "coverage",
]);

/**
 * Files that mark a directory as the root of a project, across the languages
 * we can read. A project boundary matters more than it sounds: it is where
 * descent stops, so a monorepo comes back as a list of services rather than
 * one undifferentiated tree.
 */
const PROJECT_MARKERS = new Set([
  // TypeScript / JavaScript
  "tsconfig.json",
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
  ".gemspec",
  // Rust
  "Cargo.toml",
  // PHP
  "composer.json",
  // C#
  "Directory.Build.props",
]);

/** A .csproj/.sln has a variable name, so it is matched by extension. */
const PROJECT_MARKER_EXTENSIONS = [".csproj", ".sln", ".fsproj", ".gemspec"];

/**
 * Every directory under the root that looks like a project — one holding a
 * manifest for any language we can read, or a plain `src/`. Searched two
 * levels deep, which covers both `packages/web` and a monorepo's
 * `be/some-service`.
 *
 * This is what lets one call span a whole repo: a change rarely stops at one
 * service, and asking service by service is how things get missed. A polyglot
 * repo is the case where that matters most — a Go backend and a Python worker
 * sharing a constant is exactly the change a per-language tool loses track of.
 */
export function discoverServices(maxDepth = 2): string[] {
  // An unreadable root is a configuration mistake, not an empty repo. Left to
  // the walker below it would return no services, and the caller would report
  // "0 hits" — indistinguishable from having searched the whole repo and found
  // nothing, which is the worst possible answer to be wrong about. The usual
  // cause is SPEC_NAV_ROOT still holding the README's placeholder path.
  if (!fs.existsSync(REPO_ROOT)) {
    throw new Error(
      `SPEC_NAV_ROOT points at "${REPO_ROOT}", which does not exist. ` +
        `Set it to the absolute path of the repo to scan.`,
    );
  }
  if (!fs.statSync(REPO_ROOT).isDirectory()) {
    throw new Error(`SPEC_NAV_ROOT points at "${REPO_ROOT}", which is not a directory.`);
  }

  const found: string[] = [];

  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name));
    const hasMarker =
      names.has("src") ||
      [...names].some(
        (n) => PROJECT_MARKERS.has(n) || PROJECT_MARKER_EXTENSIONS.some((ext) => n.endsWith(ext)),
      );
    if (rel && hasMarker) {
      found.push(rel);
      return; // don't descend into a project we already took
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };

  walk(REPO_ROOT, "", 0);
  // The root itself may be a single project with no sub-services; scanning
  // nothing is worse than scanning one directory.
  if (!found.length) found.push(".");
  return found.sort();
}

/**
 * Load a service's project. Uses its tsconfig when present so aliases resolve;
 * otherwise globs *.ts.
 */
export function getProject(service: string): Project {
  const cached = projects.get(service);
  if (cached) return cached;

  const serviceDir = path.resolve(REPO_ROOT, service);
  if (!fs.existsSync(serviceDir)) {
    throw new Error(
      `No service "${service}" under ${REPO_ROOT}. ` +
        `Check SPEC_NAV_ROOT or the service name.`,
    );
  }

  const tsConfigFilePath = findTsConfig(serviceDir);
  const project = tsConfigFilePath
    ? new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false })
    : new Project({ skipFileDependencyResolution: true });

  if (!tsConfigFilePath) {
    project.addSourceFilesAtPaths([
      path.join(serviceDir, "src/**/*.ts"),
      path.join(serviceDir, "src/**/*.tsx"),
      `!${path.join(serviceDir, "**/node_modules/**")}`,
    ]);
  }

  projects.set(service, project);
  return project;
}

/** Path relative to REPO_ROOT — keeps output short and quotable. */
export function relPath(sf: SourceFile): string {
  return path.relative(REPO_ROOT, sf.getFilePath());
}

/** A node's 1-indexed line. */
export function lineOf(node: Node): number {
  return node.getStartLineNumber();
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

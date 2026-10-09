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

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".git",
  "coverage",
  ".turbo",
]);

/**
 * Every directory under the root that looks like a TypeScript project — one
 * holding a tsconfig.json or a src/ directory. Searched two levels deep, which
 * covers both `packages/web` and a monorepo's `be/some-service`.
 *
 * This is what lets one call span a whole repo: a change rarely stops at one
 * service, and asking service by service is how things get missed.
 */
export function discoverServices(maxDepth = 2): string[] {
  const found: string[] = [];

  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name));
    if (rel && (names.has("tsconfig.json") || names.has("src"))) {
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

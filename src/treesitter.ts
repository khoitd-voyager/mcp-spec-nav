import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { LangSpec } from "./languages.js";

/**
 * Grammar .wasm files are found relative to this module, not the cwd — the
 * server runs from wherever the client launched it, which is never where the
 * package lives.
 *
 * The build rewrites `import.meta.url` to the CJS `__filename`, since the
 * source is ESM but the bundle is CJS and `import.meta` is empty there.
 */
const moduleUrl: string = import.meta.url;

/**
 * Tree-sitter grammars, loaded on demand.
 *
 * Every grammar is a .wasm file between 200KB and 5MB. Loading all seven to
 * answer a question about a Python file would cost more than the scan, so each
 * one is read the first time a file needs it and kept after that.
 */

type TSParser = any;
type TSLanguage = any;
type TSNode = any;

let runtime: { Parser: any; Language: any } | undefined;
let initPromise: Promise<void> | undefined;
const grammars = new Map<string, TSLanguage>();
const parsers = new Map<string, TSParser>();

/** Grammars that failed to load, with the reason — reported once, not per file. */
const failed = new Map<string, string>();

const requireFrom = createRequire(moduleUrl);

/**
 * Locate a grammar's .wasm on disk.
 *
 * `require.resolve` finds it through normal module resolution, which keeps
 * working when this file is bundled and when the package is run straight out
 * of `npx`'s cache. A .wasm is not a module, so resolution is done against the
 * grammar's package.json and the path rebuilt from there.
 */
function resolveWasm(wasmPath: string): string {
  const [pkg, ...rest] = wasmPath.split("/");
  const pkgJson = requireFrom.resolve(`${pkg}/package.json`);
  return pkgJson.replace(/package\.json$/, rest.join("/"));
}

async function ensureRuntime(): Promise<{ Parser: any; Language: any }> {
  if (runtime) return runtime;
  if (!initPromise) {
    initPromise = (async () => {
      // Required rather than imported: the bundle is CJS, and web-tree-sitter
      // ships a CJS build whose .wasm sits beside it.
      const ts = requireFrom("web-tree-sitter");
      await ts.Parser.init();
      runtime = { Parser: ts.Parser, Language: ts.Language };
    })();
  }
  await initPromise;
  if (!runtime) throw new Error("tree-sitter runtime failed to initialise");
  return runtime;
}

/**
 * A parser for a language, or undefined if its grammar will not load.
 *
 * Returning undefined rather than throwing is deliberate: one unusable
 * grammar should cost that language's files, not the whole scan.
 */
export async function parserFor(lang: LangSpec): Promise<TSParser | undefined> {
  if (failed.has(lang.id)) return undefined;
  const cached = parsers.get(lang.id);
  if (cached) return cached;

  try {
    const { Parser, Language } = await ensureRuntime();
    let grammar = grammars.get(lang.id);
    if (!grammar) {
      grammar = await Language.load(readFileSync(resolveWasm(lang.wasm)));
      grammars.set(lang.id, grammar);
    }
    const parser = new Parser();
    parser.setLanguage(grammar);
    parsers.set(lang.id, parser);
    return parser;
  } catch (err) {
    failed.set(lang.id, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/** Languages whose grammar could not be loaded, to surface in output. */
export function loadFailures(): Array<{ id: string; reason: string }> {
  return [...failed].map(([id, reason]) => ({ id, reason }));
}

export interface ScopeRange {
  /** 1-indexed first line. */
  start: number;
  /** 1-indexed last line. */
  end: number;
  /** Function name, qualified with its class when there is one. */
  name: string;
  /** Line the function is declared on. */
  line: number;
}

function nodeName(node: TSNode, lang: LangSpec): string | undefined {
  const field = lang.containerNameField?.[node.type];
  const named = node.childForFieldName(field ?? "name");
  if (named?.text) return named.text;
  // Some grammars put a decorated or exported definition one level up; the
  // name lives on the inner node, which we reach on its own visit.
  return undefined;
}

/**
 * The identifier buried under a C/C++ `declarator`.
 *
 * `int total(int)` nests it as function_definition → function_declarator →
 * identifier, and `int *total(int)` adds a pointer_declarator in between, so
 * the search descends rather than assuming a depth. Stops at the first
 * identifier found breadth-first, which is the function's own name — the
 * parameter names sit deeper, inside the parameter_list.
 */
function declaratorName(node: TSNode): string | undefined {
  let current: TSNode | undefined = node.childForFieldName("declarator");
  while (current) {
    if (current.type === "identifier" || current.type === "field_identifier") {
      return current.text;
    }
    // operator overloads and destructors have their own node types
    if (current.type === "operator_name" || current.type === "destructor_name") {
      return current.text;
    }
    const next: TSNode | undefined = current.childForFieldName("declarator");
    if (next) {
      current = next;
      continue;
    }
    // A function_declarator holds the name as a plain child, not a field.
    let found: TSNode | undefined;
    for (let i = 0; i < current.childCount; i++) {
      const c = current.child(i);
      if (c && (c.type === "identifier" || c.type === "field_identifier" ||
                c.type === "qualified_identifier" || c.type === "operator_name")) {
        found = c;
        break;
      }
    }
    if (found) return found.text;
    break;
  }
  return undefined;
}

/**
 * For a macro-call definition (`def total(s)` in Elixir), the keyword being
 * called and the name it defines.
 */
function callDefinitionParts(
  node: TSNode,
): { keyword: string; name: string } | undefined {
  const target = node.childForFieldName("target") ?? node.child(0);
  if (!target || target.type !== "identifier") return undefined;
  const keyword = target.text;
  const args = node.childForFieldName("arguments") ?? node.child(1);
  if (!args) return undefined;
  for (let i = 0; i < args.childCount; i++) {
    const a = args.child(i);
    if (!a) continue;
    // `def total(s)` — the name is itself a call, with the params as args.
    if (a.type === "call") {
      const inner = a.childForFieldName("target") ?? a.child(0);
      if (inner?.text) return { keyword, name: inner.text };
    }
    // `def total do` — a bare identifier, no parentheses.
    if (a.type === "identifier" || a.type === "alias") {
      return { keyword, name: a.text };
    }
  }
  return undefined;
}

/**
 * The type a method hangs off, for languages that declare it in a receiver
 * rather than nesting the method in the type — Go's `func (o *Order) Total()`.
 * The name sits in a `type_identifier` under the receiver, one level deeper
 * when the receiver is a pointer.
 */
function receiverType(node: TSNode): string | undefined {
  const recv = node.childForFieldName("receiver");
  if (!recv) return undefined;
  const stack: TSNode[] = [recv];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "type_identifier") return n.text;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return undefined;
}

/**
 * Every named function in a file, as line ranges.
 *
 * One pass, collecting ranges, rather than a tree walk per matching line —
 * the same reason the TypeScript path collects ranges first: descending the
 * tree once per hit is what dominates runtime on a large file.
 */
export function functionRanges(root: TSNode, lang: LangSpec): ScopeRange[] {
  const fnTypes = new Set(lang.functionNodes);
  const containerTypes = new Set(lang.containerNodes);
  const ranges: ScopeRange[] = [];

  const callDef = lang.callDefinition;

  /** Class/module names enclosing the current node, outermost first. */
  const walk = (node: TSNode, scope: string[]) => {
    let nextScope = scope;

    // Elixir and friends: a definition is a call to `def`/`defmodule`, so
    // which it is depends on the keyword rather than the node type.
    if (callDef && node.type === callDef.node) {
      const parts = callDefinitionParts(node);
      if (parts) {
        if (callDef.containerKeywords.includes(parts.keyword)) {
          nextScope = [...scope, parts.name];
        } else if (callDef.functionKeywords.includes(parts.keyword)) {
          ranges.push({
            start: node.startPosition.row + 1,
            end: node.endPosition.row + 1,
            name: scope.length ? `${scope.join(".")}.${parts.name}` : parts.name,
            line: node.startPosition.row + 1,
          });
          nextScope = [...scope, parts.name];
        }
      }
    } else if (containerTypes.has(node.type)) {
      const name = nodeName(node, lang);
      // An anonymous container (`impl Trait for T` with no simple type, a
      // bare `module`) adds nothing a reader can act on, so it is skipped
      // rather than inserted as a placeholder.
      if (name) nextScope = [...scope, name];
    } else if (fnTypes.has(node.type)) {
      const name = lang.declaratorNodes?.includes(node.type)
        ? declaratorName(node)
        : nodeName(node, lang);
      if (name) {
        // A receiver-declared method is not nested inside its type, so the
        // qualifier comes from the receiver instead of the walked scope.
        const receiver = lang.receiverNodes?.includes(node.type)
          ? receiverType(node)
          : undefined;
        const qualifier = receiver ? [...scope, receiver] : scope;
        ranges.push({
          start: node.startPosition.row + 1,
          end: node.endPosition.row + 1,
          // `Order.total` rather than `total`: the qualifier is what makes a
          // common method name identifiable.
          name: qualifier.length ? `${qualifier.join(".")}.${name}` : name,
          line: node.startPosition.row + 1,
        });
        // A nested function's name is qualified by the function holding it.
        nextScope = [...scope, name];
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, nextScope);
    }
  };

  walk(root, []);
  return ranges;
}

/**
 * The narrowest named function containing a line.
 *
 * Narrowest wins so a method beats the class around it. Unnamed scopes were
 * never collected, so a line in a callback is attributed to the named
 * function that contains it — which is the answer a reader wants.
 */
export function enclosingRange(ranges: ScopeRange[], line: number): ScopeRange | undefined {
  let best: ScopeRange | undefined;
  for (const r of ranges) {
    if (r.start > line || line > r.end) continue;
    if (!best || r.end - r.start < best.end - best.start) best = r;
  }
  return best;
}

/** Parse a file's text, or undefined if its grammar is unavailable. */
export async function parseFile(text: string, lang: LangSpec): Promise<TSNode | undefined> {
  const parser = await parserFor(lang);
  if (!parser) return undefined;
  try {
    // A file that does not parse cleanly still yields a tree; tree-sitter
    // recovers around errors, and a partly-labelled file beats none.
    return parser.parse(text)?.rootNode;
  } catch {
    return undefined;
  }
}

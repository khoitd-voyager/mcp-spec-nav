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
    if (!lang.wasm) throw new Error(`${lang.id} has no tree-sitter grammar`);
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

/** One function as tree-sitter sees it, before the catalog adds ids. */
export interface RawFunction {
  name: string;
  /** Enclosing class/module/function names, outermost first. */
  qualifier: string[];
  kind: string;
  /** 1-indexed, inclusive; decorators and attributes are included. */
  start: number;
  end: number;
  /**
   * The exact extent, as offsets into the file text (UTF-16 code units, the
   * unit of JavaScript strings; end exclusive). Lines alone cannot tell two
   * functions on one line apart.
   */
  startOffset: number;
  endOffset: number;
  signature: string;
  params: string[];
  returnType?: string;
  exported?: boolean;
  /** Names it is exported under besides its own: `default`, `module.exports.x`, an `as` alias. */
  exportedAs?: string[];
  /**
   * Identity of the variable or property the function is stored in, when
   * that is how it gets its name; functions sharing one are alternative
   * values of the same variable.
   */
  bindingKey?: string;
  /** The variable or property as written: `calculateTax`, `api.loadUser`. */
  assignedTo?: string;
  visibility?: string;
  isStatic?: boolean;
  isAsync?: boolean;
  doc?: string;
}

/**
 * A class, interface, struct, impl block, module… — whatever its language
 * groups members in — by its whole extent, so it can be read as one unit.
 */
export interface RawType {
  name: string;
  /** Enclosing scopes, outermost first, as for functions. */
  qualifier: string[];
  /** `class`, `interface`, `struct`, `impl`, `module`, … */
  kind: string;
  /** 1-indexed, inclusive; decorators, annotations and modifiers included, the doc comment above not. */
  start: number;
  end: number;
  startOffset: number;
  endOffset: number;
}

export interface TreeSitterResult {
  functions: RawFunction[];
  types: RawType[];
  /** Line of the first syntax error, if the file did not parse cleanly. */
  errorLine?: number;
}

const COMMENT_TYPES = /comment/;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Parameter list text items, comments dropped. */
function paramItems(params: TSNode | null | undefined): string[] {
  if (!params) return [];
  const out: string[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const c = params.namedChild(i);
    if (!c || COMMENT_TYPES.test(c.type)) continue;
    out.push(collapse(c.text));
  }
  return out;
}

/** The parameters node of a function, wherever its grammar keeps it. */
function paramsNode(node: TSNode, lang: LangSpec): TSNode | undefined {
  const direct = node.childForFieldName("parameters");
  if (direct) return direct;
  if (lang.declaratorNodes?.includes(node.type)) {
    // C/C++: the parameter list hangs off the function_declarator.
    let d: TSNode | undefined = node.childForFieldName("declarator");
    while (d) {
      const p = d.childForFieldName("parameters");
      if (p) return p;
      d = d.childForFieldName("declarator");
    }
  }
  return undefined;
}

/** Elixir `def total(a, b)`: the args of the inner call. */
function elixirParams(node: TSNode): string[] {
  const args = node.childForFieldName("arguments") ?? node.child(1);
  const head = args?.namedChild(0);
  if (head?.type === "call") {
    const inner = head.namedChildren?.find?.((c: TSNode) => c.type === "arguments") ?? head.child(1);
    return paramItems(inner);
  }
  return [];
}

/**
 * The text from a function's first character to the start of its body,
 * collapsed onto one line — what a reader needs to call it.
 */
function signatureOf(node: TSNode, body: TSNode | undefined): string {
  const text: string = node.text;
  let sig = body ? text.slice(0, body.startIndex - node.startIndex) : text.split("\n")[0];
  sig = collapse(sig).replace(/\s*(\{|=>|=|:)\s*$/, "").replace(/\s+do$/, "");
  return sig.length > 300 ? sig.slice(0, 299) + "…" : sig;
}

function modifiersText(node: TSNode): string {
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === "modifiers" || c.type === "modifier" || c.type === "visibility_modifier" ||
        c.type === "static_modifier" || c.type === "abstract_modifier" || c.type === "final_modifier" ||
        c.type === "storage_class_specifier") {
      parts.push(c.text);
    }
  }
  return parts.join(" ");
}

function visibilityOf(node: TSNode, name: string, lang: LangSpec, keyword?: string):
  { visibility?: string; exported?: boolean; isStatic?: boolean } {
  const mods = modifiersText(node);
  const isStatic = /\bstatic\b/.test(mods) || undefined;
  if (lang.visibilityByName === "go") {
    const exported = /^[A-Z]/.test(name);
    return { exported, visibility: exported ? "exported" : "package" };
  }
  if (lang.visibilityByName === "python") {
    if (/^__.*__$/.test(name)) return { visibility: "public" };
    if (name.startsWith("_")) return { visibility: "private", exported: false };
    return { visibility: "public" };
  }
  if (lang.id === "elixir") {
    const priv = keyword === "defp" || keyword === "defmacrop";
    return { visibility: priv ? "private" : "public", exported: !priv };
  }
  if (lang.id === "rust") {
    const pub = /\bpub\b/.test(mods);
    return { visibility: pub ? "pub" : "private", exported: pub };
  }
  if (lang.id === "c") {
    // `static` at file scope is internal linkage, not a static method.
    return /\bstatic\b/.test(mods) ? { visibility: "static (file-local)", exported: false } : { exported: true };
  }
  const m = mods.match(/\b(public|private|protected|internal)\b/);
  return { visibility: m?.[1], isStatic };
}

/**
 * The comment block directly above a function, by reading lines upward —
 * grammars disagree on where a comment attaches (Ruby hangs it off the class
 * body, not the method), but "the lines right above it" never does.
 */
export function docAbove(lines: string[], startLine: number, commentLine: RegExp): string | undefined {
  const { from, to } = docLines(lines, startLine, commentLine);
  const out = lines.slice(from, to);
  if (!out.length) return undefined;
  const cleaned = out
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#+|--)\s?/, "").replace(/\s*\*\/\s*$/, ""))
    .join("\n")
    .trim();
  return cleaned || undefined;
}

/**
 * The comment block directly above `startLine` (1-indexed), as 0-indexed
 * lines [from, to); empty when there is none. Annotations between the
 * comment and the declaration are stepped over, not included.
 */
export function docLines(lines: string[], startLine: number, commentLine: RegExp): { from: number; to: number } {
  let i = startLine - 2; // 0-indexed line above
  // Attributes and annotations sit between a doc comment and its function.
  while (i >= 0 && /^\s*(#\[|@\w+(\(.*\))?\s*$|\[\w)/.test(lines[i]) && !commentLine.test(lines[i])) i--;
  const to = i + 1;
  let inBlock = false;
  while (i >= 0) {
    const l = lines[i];
    if (!inBlock && /\*\/\s*$/.test(l) && !/^\s*\/\*/.test(l)) {
      inBlock = true;
      i--;
      continue;
    }
    if (inBlock) {
      if (/^\s*\/\*/.test(l)) inBlock = false;
      i--;
      continue;
    }
    if (!commentLine.test(l)) break;
    i--;
  }
  return { from: i + 1, to };
}

/** A Python docstring: the first statement of the body, when it is a string. */
function pythonDocstring(node: TSNode): string | undefined {
  const body = node.childForFieldName("body");
  const first = body?.namedChild(0);
  if (first?.type !== "expression_statement") return undefined;
  const str = first.namedChild(0);
  if (str?.type !== "string") return undefined;
  return str.text.replace(/^[rubfRUBF]*("""|\'\'\'|"|')/, "").replace(/("""|\'\'\'|"|')$/, "").trim() || undefined;
}

/** Elixir `@doc "..."` or `@doc """ ... """` right above a def. */
function elixirDoc(text: string, startIndex: number): string | undefined {
  const before = text.slice(Math.max(0, startIndex - 4000), startIndex);
  const m = before.match(/@doc\s+("""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)")\s*$/);
  return m ? (m[2] ?? m[3] ?? "").trim() || undefined : undefined;
}

/** The first syntax error in a tree, as a 1-indexed line. */
function firstErrorLine(root: TSNode): number | undefined {
  if (!root.hasError) return undefined;
  const stack: TSNode[] = [root];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.isError || n.isMissing) return n.startPosition.row + 1;
    if (!n.hasError) continue;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return root.startPosition.row + 1;
}

/**
 * Every named function in a file, with what a reader needs to decide whether
 * to reuse it: qualified name, kind, signature, parameters, return type,
 * visibility and doc comment.
 *
 * One walk, using the parse tree's own node types — so a method keeps the
 * name its language gives it rather than one guessed from indentation.
 * Anonymous functions (Go func literals, Rust closures) carry no name and are
 * not listed; a line inside one is attributed to the named function around it.
 */
export async function extractFunctions(text: string, lang: LangSpec): Promise<TreeSitterResult | undefined> {
  const parser = await parserFor(lang);
  if (!parser) return undefined;
  let tree: any;
  try {
    tree = parser.parse(text);
  } catch {
    return undefined;
  }
  if (!tree) return undefined;
  try {
    return { ...walkFunctions(tree.rootNode, lang, text), errorLine: firstErrorLine(tree.rootNode) };
  } finally {
    // Trees live in WASM memory, which the JS garbage collector never sees.
    // Not deleting them leaks a little per file, which on a big repo is a lot.
    tree.delete();
  }
}

/** `class_declaration` → class, `impl_item` → impl, Go `type_spec` → struct/interface/type. */
function typeKind(node: TSNode): string {
  if (node.type === "type_spec") {
    const t = node.childForFieldName("type")?.type;
    return t === "struct_type" || t === "interface_type" ? t.replace(/_type$/, "") : "type";
  }
  return node.type.replace(/_(declaration|definition|item|specifier)$/, "");
}

function walkFunctions(root: TSNode, lang: LangSpec, text: string): { functions: RawFunction[]; types: RawType[] } {
  const fnTypes = new Set(lang.functionNodes);
  const containerTypes = new Set(lang.containerNodes);
  const typeOnly = new Set(lang.typeNodes ?? []);
  const out: RawFunction[] = [];
  const types: RawType[] = [];
  const lines = text.split("\n");
  const callDef = lang.callDefinition;

  type Scope = { name: string; isFunction: boolean };

  const recordType = (node: TSNode, name: string, scope: Scope[], kind = typeKind(node)) => {
    // C/C++ `struct Foo x;` names a type without declaring it.
    if (/_specifier$/.test(node.type) && !node.childForFieldName("body")) return;
    let outer = node.parent?.type === "decorated_definition" ? node.parent : node;
    // Go `type Order struct {…}`: the `type` keyword belongs to it, unless it is one of a group.
    if (node.type === "type_spec" && node.parent?.type === "type_declaration") {
      let specs = 0;
      for (let i = 0; i < node.parent.namedChildCount; i++) if (node.parent.namedChild(i)?.type === "type_spec") specs++;
      if (specs === 1) outer = node.parent;
    }
    types.push({
      name,
      qualifier: scope.map((s) => s.name),
      kind,
      start: outer.startPosition.row + 1,
      end: node.endPosition.row + 1,
      startOffset: outer.startIndex,
      endOffset: node.endIndex,
    });
  };

  const record = (node: TSNode, name: string, scope: Scope[], keyword?: string, receiver?: string) => {
    const qualifier = scope.map((s) => s.name);
    if (receiver) qualifier.push(receiver);
    const inFunction = scope.length > 0 && scope[scope.length - 1].isFunction;
    const inContainer = !!receiver || (scope.length > 0 && !scope[scope.length - 1].isFunction);
    // Python decorators and Rust attributes belong with the function.
    const outer = node.parent?.type === "decorated_definition" ? node.parent : node;
    const start = outer.startPosition.row + 1;
    const end = node.endPosition.row + 1;

    let kind = inFunction ? "nested function" : inContainer ? "method" : "function";
    if (lang.constructorNodes?.includes(node.type) || lang.constructorNames?.includes(name)) kind = "constructor";
    if (node.type === "property_declaration") kind = "property";
    if (node.type === "local_function_statement") kind = "nested function";
    if (node.type === "singleton_method") kind = "method";

    const body = node.childForFieldName("body") ?? undefined;
    const params = callDef && node.type === callDef.node ? elixirParams(node) : paramItems(paramsNode(node, lang));
    let returnType: string | undefined;
    for (const f of lang.returnFields ?? []) {
      const r = node.childForFieldName(f);
      if (r) {
        returnType = collapse(r.text);
        break;
      }
    }
    const vis = visibilityOf(node, name, lang, keyword);
    const isStatic = vis.isStatic || node.type === "singleton_method" || undefined;
    let doc: string | undefined;
    if (lang.id === "python") doc = pythonDocstring(node);
    if (!doc && lang.id === "elixir") doc = elixirDoc(text, node.startIndex);
    if (!doc) doc = docAbove(lines, start, lang.commentLine);

    out.push({
      name,
      qualifier,
      kind,
      start,
      end,
      // tree-sitter's indices are UTF-16 code units here, as JS strings are.
      startOffset: outer.startIndex,
      endOffset: node.endIndex,
      signature: signatureOf(node, body),
      params,
      returnType,
      exported: vis.exported,
      visibility: vis.visibility,
      isStatic,
      isAsync: /^\s*async\b/.test(node.text) || undefined,
      doc,
    });
  };

  const walk = (node: TSNode, scope: Scope[]) => {
    let nextScope = scope;

    // Elixir and friends: a definition is a call to `def`/`defmodule`, so
    // which it is depends on the keyword rather than the node type.
    if (callDef && node.type === callDef.node) {
      const parts = callDefinitionParts(node);
      if (parts) {
        if (callDef.containerKeywords.includes(parts.keyword)) {
          recordType(node, parts.name, scope, parts.keyword.replace(/^def/, ""));
          nextScope = [...scope, { name: parts.name, isFunction: false }];
        } else if (callDef.functionKeywords.includes(parts.keyword)) {
          record(node, parts.name, scope, parts.keyword);
          nextScope = [...scope, { name: parts.name, isFunction: true }];
        }
      }
    } else if (containerTypes.has(node.type)) {
      const name = nodeName(node, lang);
      // An anonymous container (`impl Trait for T` with no simple type, a
      // bare `module`) adds nothing a reader can act on, so it is skipped
      // rather than inserted as a placeholder.
      if (name) {
        recordType(node, name, scope);
        nextScope = [...scope, { name, isFunction: false }];
      }
    } else if (typeOnly.has(node.type)) {
      // A type that holds no functions itself (a Rust struct, a Go type):
      // recorded so it can be read with the methods declared elsewhere.
      const name = nodeName(node, lang);
      if (name) recordType(node, name, scope);
    } else if (fnTypes.has(node.type)) {
      const name = lang.declaratorNodes?.includes(node.type)
        ? declaratorName(node)
        : nodeName(node, lang);
      if (name) {
        // A receiver-declared method is not nested inside its type, so the
        // qualifier comes from the receiver instead of the walked scope.
        const receiver = lang.receiverNodes?.includes(node.type) ? receiverType(node) : undefined;
        record(node, name, scope, undefined, receiver);
        // A nested function's name is qualified by the function holding it.
        nextScope = [...scope, ...(receiver ? [{ name: receiver, isFunction: false }] : []), { name, isFunction: true }];
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, nextScope);
    }
  };

  walk(root, []);
  return { functions: out, types };
}

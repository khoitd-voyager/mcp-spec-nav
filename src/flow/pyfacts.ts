import { languageById } from "../languages.js";
import { parserFor } from "../treesitter.js";
import type { SourceEntry } from "../project.js";
import {
  FileFacts,
  StrVal,
  HandlerRef,
  NameRef,
  emptyFacts,
  lit,
  dyn,
  env,
  concat,
  withVia,
  literal,
  show,
  HTTP_VERBS,
} from "./model.js";

/**
 * Communication facts in Python, read with tree-sitter:
 *
 *  - HTTP servers: FastAPI (`FastAPI()`, `APIRouter(prefix=…)`,
 *    `include_router`, `@app.get`…) and Flask (`Flask()`, `Blueprint`,
 *    `register_blueprint`, `@app.route`, `@bp.get`…, `add_url_rule`).
 *  - HTTP clients: requests, httpx (and `httpx.Client(base_url=…)`), aiohttp
 *    `ClientSession(base_url=…)`.
 *
 * A router is recognised by the class it is built from, imported from fastapi
 * or flask; a client by the module it comes from — never by a variable name.
 */

type Node = any;

export const PY_PREFILTER =
  /\b(?:requests|httpx|aiohttp|FastAPI|APIRouter|Flask|Blueprint|include_router|register_blueprint|add_url_rule|add_api_route|uvicorn)\b|@\w+\.(?:get|post|put|patch|delete|route|api_route)\s*\(/;

const VERBS = new Set<string>(HTTP_VERBS);
const CLIENT_MODULES = new Set(["requests", "httpx"]);
const SESSION_CLASSES: Record<string, string> = {
  Client: "httpx", AsyncClient: "httpx", Session: "requests", ClientSession: "aiohttp",
};

function unquoteContent(n: Node): string {
  // string_content children carry the raw text; escape sequences are their own nodes.
  return n.text;
}

const ESCAPES: Record<string, string> = { "\\n": "\n", "\\t": "\t", "\\\\": "\\", "\\'": "'", '\\"': '"', "\\/": "/" };

export async function extractPython(entry: SourceEntry, text: string, analysed: boolean): Promise<FileFacts> {
  const facts = emptyFacts({
    rel: entry.rel,
    service: entry.service,
    language: entry.language,
    stamp: entry.stamp,
    family: "python",
    analysed,
  });
  const parser = await parserFor(languageById("python")!);
  if (!parser) {
    facts.parseError = "python grammar unavailable";
    return facts;
  }
  let tree: any;
  try {
    tree = parser.parse(text);
  } catch (err) {
    facts.parseError = `parse failed: ${err}`;
    return facts;
  }
  if (!tree) {
    facts.parseError = "parse failed";
    return facts;
  }
  try {
    walk(tree.rootNode, text, entry, facts);
  } catch (err) {
    // One odd file costs that file's facts, not the whole query.
    facts.parseError = `adapter crashed: ${err instanceof Error ? err.message : err}`;
  } finally {
    tree.delete();
  }
  return facts;
}

function walk(root: Node, text: string, entry: SourceEntry, facts: FileFacts) {
  const lines = text.split("\n");
  const lineOf = (n: Node) => n.startPosition.row + 1;
  const snippet = (n: Node) => {
    const t = (lines[lineOf(n) - 1] ?? "").trim().replace(/\s+/g, " ");
    return t.length > 140 ? t.slice(0, 139) + "…" : t;
  };
  const where = (n: Node) => `${entry.rel}:${lineOf(n)}`;
  const analysed = facts.analysed;
  if (root.hasError) {
    const stack = [root];
    while (stack.length) {
      const n = stack.shift();
      if (n.isError || n.isMissing) {
        facts.parseError = `syntax error at line ${lineOf(n)}`;
        break;
      }
      for (let i = 0; i < n.childCount; i++) if (n.child(i).hasError || n.child(i).isError || n.child(i).isMissing) stack.push(n.child(i));
    }
  }

  /** Node wrappers are new objects on every access: key them by extent. */
  const key = (n: Node): string => `${n.startIndex}:${n.endIndex}:${n.type}`;
  const named = (n: Node): Node[] => {
    const out: Node[] = [];
    for (let i = 0; i < n.namedChildCount; i++) out.push(n.namedChild(i));
    return out;
  };

  // -------------------------------------------------------------------------
  // Imports.

  const moduleText = (n: Node | null): string => {
    if (!n) return "";
    if (n.type === "relative_import") {
      let dots = "";
      let rest = "";
      for (const c of named(n)) {
        if (c.type === "import_prefix") dots = c.text;
        else rest = c.text;
      }
      return dots + rest;
    }
    return n.text;
  };

  for (const st of named(root)) {
    if (st.type === "import_statement") {
      for (const c of named(st)) {
        if (c.type === "dotted_name") facts.imports.set(c.text.split(".")[0], { spec: c.text.split(".")[0], imported: "*", line: lineOf(st) });
        else if (c.type === "aliased_import") {
          const name = c.childForFieldName("name")?.text;
          const alias = c.childForFieldName("alias")?.text;
          if (name && alias) facts.imports.set(alias, { spec: name, imported: "*", line: lineOf(st) });
        }
      }
    } else if (st.type === "import_from_statement") {
      const modNode = st.childForFieldName("module_name");
      const mod = moduleText(modNode);
      for (let i = 0; i < st.namedChildCount; i++) {
        const c = st.namedChild(i);
        if (modNode && key(c) === key(modNode)) continue;
        if (c.type === "dotted_name") facts.imports.set(c.text, { spec: mod, imported: c.text, line: lineOf(st) });
        else if (c.type === "aliased_import") {
          const name = c.childForFieldName("name")?.text;
          const alias = c.childForFieldName("alias")?.text;
          if (name && alias) facts.imports.set(alias, { spec: mod, imported: name, line: lineOf(st) });
        }
      }
    }
  }
  const importOf = (name: string) => facts.imports.get(name);
  /** `FastAPI` from fastapi, or `fastapi.FastAPI`. */
  const ctorFrom = (fn: Node | null): { cls: string; module: string } | undefined => {
    if (!fn) return undefined;
    if (fn.type === "identifier") {
      const imp = importOf(fn.text);
      if (imp && imp.imported !== "*") return { cls: imp.imported, module: imp.spec.split(".")[0] };
      return undefined;
    }
    if (fn.type === "attribute") {
      const obj = fn.childForFieldName("object");
      const attr = fn.childForFieldName("attribute")?.text;
      if (obj?.type === "identifier" && attr) {
        const imp = importOf(obj.text);
        if (imp && imp.imported === "*") return { cls: attr, module: imp.spec.split(".")[0] };
      }
    }
    return undefined;
  };

  // -------------------------------------------------------------------------
  // Assignments: module level, per function, per class (self.x).

  const fnOf = (n: Node): Node | undefined => {
    for (let p = n.parent; p; p = p.parent) if (p.type === "function_definition") return p;
    return undefined;
  };
  const classOf = (n: Node): Node | undefined => {
    for (let p = n.parent; p; p = p.parent) if (p.type === "class_definition") return p;
    return undefined;
  };

  /** Assignments to a plain name, keyed by scope (function, class or module) then name. */
  const assigns = new Map<string, Map<string, Node[]>>();
  /** self.x = … inside a class's methods: class → attr → right-hand sides. */
  const selfAssigns = new Map<string, { cls: Node; attrs: Map<string, Node[]> }>();
  /** Class-level constants: class name → name → right-hand side. */
  const classConsts = new Map<string, Map<string, Node>>();
  const params = new Map<string, Map<string, Node>>();
  const rootKey = key(root);

  const collect = (n: Node) => {
    if (n.type === "assignment") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left && right) {
        if (left.type === "identifier") {
          const scope = fnOf(n) ?? classOf(n) ?? root;
          const m = assigns.get(key(scope)) ?? new Map<string, Node[]>();
          m.set(left.text, [...(m.get(left.text) ?? []), right]);
          assigns.set(key(scope), m);
          if (scope.type === "class_definition") {
            const cname = scope.childForFieldName("name")?.text;
            if (cname) {
              const cm = classConsts.get(cname) ?? new Map<string, Node>();
              cm.set(left.text, right);
              classConsts.set(cname, cm);
            }
          }
        } else if (left.type === "attribute" && left.childForFieldName("object")?.text === "self") {
          const cls = classOf(n);
          const attr = left.childForFieldName("attribute")?.text;
          if (cls && attr) {
            const e = selfAssigns.get(key(cls)) ?? { cls, attrs: new Map<string, Node[]>() };
            e.attrs.set(attr, [...(e.attrs.get(attr) ?? []), right]);
            selfAssigns.set(key(cls), e);
          }
        }
      }
    }
    if (n.type === "function_definition") {
      const ps = n.childForFieldName("parameters");
      const m = new Map<string, Node>();
      for (const p of ps ? named(ps) : []) {
        const id = p.type === "identifier" ? p : named(p).find((c: Node) => c.type === "identifier");
        if (id) m.set(id.text, p);
      }
      params.set(key(n), m);
    }
    for (const c of named(n)) collect(c);
  };
  collect(root);

  // -------------------------------------------------------------------------
  // Strings.

  const seenKeys = new Set<string>();
  const seen = {
    has: (n: Node) => seenKeys.has(key(n)),
    add: (n: Node) => seenKeys.add(key(n)),
    delete: (n: Node) => seenKeys.delete(key(n)),
  };

  const strOf = (n0: Node | null | undefined, depth = 0): StrVal => {
    if (!n0) return dyn("(missing)");
    let n = n0;
    while (n.type === "parenthesized_expression" && n.namedChildCount === 1) n = n.namedChild(0);
    if (depth > 12) return dyn(n.text);
    switch (n.type) {
      case "string": {
        const vals: StrVal[] = [];
        for (const c of named(n)) {
          if (c.type === "string_content") vals.push(lit(unquoteContent(c)));
          else if (c.type === "escape_sequence") vals.push(lit(ESCAPES[c.text] ?? c.text));
          else if (c.type === "interpolation") vals.push(strOf(c.childForFieldName("expression") ?? c.namedChild(0), depth + 1));
        }
        return vals.length ? concat(...vals) : lit("");
      }
      case "concatenated_string":
        return concat(...named(n).map((c: Node) => strOf(c, depth + 1)));
      case "integer":
        return lit(n.text);
      case "binary_operator": {
        const op = n.childForFieldName("operator")?.text;
        if (op === "+") return concat(strOf(n.childForFieldName("left"), depth + 1), strOf(n.childForFieldName("right"), depth + 1));
        return dyn(n.text);
      }
      case "boolean_operator": {
        // os.getenv("X") or "http://default"
        const l = strOf(n.childForFieldName("left"), depth + 1);
        const r = literal(strOf(n.childForFieldName("right"), depth + 1));
        if (n.text.includes(" or ") && l.parts.length === 1 && l.parts[0].k === "env") return { parts: [{ ...l.parts[0], fallback: r }], via: l.via };
        return dyn(n.text);
      }
      case "identifier":
        return identVal(n, depth);
      case "attribute":
        return attrVal(n, depth);
      case "subscript": {
        // os.environ["X"]
        const v = n.childForFieldName("value");
        const sub = n.childForFieldName("subscript");
        if (v?.text === "os.environ" && sub?.type === "string") {
          const k = literal(strOf(sub, depth + 1));
          if (k !== undefined) return env(k);
        }
        return dyn(n.text);
      }
      case "call": {
        const fn = n.childForFieldName("function");
        const args = n.childForFieldName("arguments");
        const pos = args ? named(args).filter((a: Node) => a.type !== "keyword_argument" && a.type !== "comment") : [];
        const f = fn?.text;
        if ((f === "os.getenv" || f === "os.environ.get" || f === "getenv") && pos[0]) {
          const k = literal(strOf(pos[0], depth + 1));
          const fb = pos[1] ? literal(strOf(pos[1], depth + 1)) : undefined;
          if (k !== undefined) return env(k, fb);
        }
        if (f === "str" && pos.length === 1) return strOf(pos[0], depth + 1);
        return dyn(n.text);
      }
      default:
        return dyn(n.text);
    }
  };

  const note = (name: string, v: StrVal, at: Node): StrVal =>
    v.parts.length === 1 && v.parts[0].k === "dyn" ? v : withVia(v, `${name} = "${show(v)}" (${where(at)})`);

  /** The single value a name is given in a scope, if it is given exactly once. */
  const single = (scope: Node, name: string): Node | undefined => {
    const list = assigns.get(key(scope))?.get(name);
    return list && list.length === 1 ? list[0] : undefined;
  };

  const identVal = (id: Node, depth: number): StrVal => {
    const name = id.text;
    const fn = fnOf(id);
    if (fn) {
      const local = assigns.get(key(fn))?.get(name);
      if (local) {
        if (local.length !== 1 || seen.has(local[0])) return dyn(name);
        seen.add(local[0]);
        try {
          return note(name, strOf(local[0], depth + 1), local[0]);
        } finally {
          seen.delete(local[0]);
        }
      }
      if (params.get(key(fn))?.has(name)) return dyn(name);
    }
    const mod = single(root, name);
    if (mod && !seen.has(mod)) {
      seen.add(mod);
      try {
        return note(name, strOf(mod, depth + 1), mod);
      } finally {
        seen.delete(mod);
      }
    }
    if (importOf(name)) return { parts: [{ k: "ref", local: name, path: [] }], via: [] };
    return dyn(name);
  };

  const attrChain = (n: Node): { root: Node; path: string[] } => {
    const path: string[] = [];
    let cur = n;
    while (cur.type === "attribute") {
      path.unshift(cur.childForFieldName("attribute")?.text ?? "");
      cur = cur.childForFieldName("object");
    }
    return { root: cur, path };
  };

  const attrVal = (n: Node, depth: number): StrVal => {
    const { root: r, path } = attrChain(n);
    if (r?.type !== "identifier") return dyn(n.text);
    if (r.text === "self" && path.length === 1) {
      const cls = classOf(n);
      const list = cls && selfAssigns.get(key(cls))?.attrs.get(path[0]);
      if (list && list.length === 1 && !seen.has(list[0])) {
        seen.add(list[0]);
        try {
          return note(`self.${path[0]}`, strOf(list[0], depth + 1), list[0]);
        } finally {
          seen.delete(list[0]);
        }
      }
      return dyn(n.text);
    }
    // Class constants: Topics.ORDER_CREATED
    const cc = classConsts.get(r.text);
    if (cc && path.length === 1 && cc.has(path[0])) {
      const v = cc.get(path[0])!;
      if (!seen.has(v)) {
        seen.add(v);
        try {
          return note(`${r.text}.${path[0]}`, strOf(v, depth + 1), v);
        } finally {
          seen.delete(v);
        }
      }
    }
    if (importOf(r.text)) return { parts: [{ k: "ref", local: r.text, path }], via: [] };
    return dyn(n.text);
  };

  // Module-level constants, and class constants, for other files to import.
  for (const [name, list] of assigns.get(rootKey) ?? []) {
    if (list.length !== 1) continue;
    const v = strOf(list[0]);
    if (v.parts.length === 1 && v.parts[0].k === "dyn") continue;
    if (list[0].type === "call" || list[0].type === "dictionary" || list[0].type === "list") continue;
    facts.consts.set(name, { ...v, line: lineOf(list[0]) });
  }
  for (const [cls, m] of classConsts) {
    for (const [name, rhs] of m) {
      const v = strOf(rhs);
      if (v.parts.length === 1 && v.parts[0].k === "dyn") continue;
      facts.consts.set(`${cls}.${name}`, { ...v, line: lineOf(rhs) });
    }
  }

  // -------------------------------------------------------------------------
  // Arguments.

  const argsOf = (call: Node): { pos: Node[]; kw: Map<string, Node> } => {
    const a = call.childForFieldName("arguments");
    const pos: Node[] = [];
    const kw = new Map<string, Node>();
    for (const c of a ? named(a) : []) {
      if (c.type === "keyword_argument") {
        const k = c.childForFieldName("name")?.text;
        const v = c.childForFieldName("value");
        if (k && v) kw.set(k, v);
      } else if (c.type !== "comment") pos.push(c);
    }
    return { pos, kw };
  };

  const strsOf = (n: Node | undefined): StrVal[] => {
    if (!n) return [];
    if (n.type === "list" || n.type === "tuple") return named(n).map((c: Node) => strOf(c));
    return [strOf(n)];
  };

  // -------------------------------------------------------------------------
  // Routers, client instances, classes.

  /** Classify a constructor call; registers routers and instances under `local`. */
  const classify = (rhs: Node, local: string, line: number): "router" | "instance" | undefined => {
    if (rhs?.type !== "call") return undefined;
    const ctor = ctorFrom(rhs.childForFieldName("function"));
    if (!ctor) return undefined;
    const { pos, kw } = argsOf(rhs);
    if (ctor.module === "fastapi" && ctor.cls === "FastAPI") {
      facts.routers.set(local, { local, kind: "app", lib: "fastapi", prefix: kw.has("root_path") ? undefined : undefined, line });
      return "router";
    }
    if (ctor.module === "fastapi" && ctor.cls === "APIRouter") {
      facts.routers.set(local, { local, kind: "router", lib: "fastapi", prefix: kw.get("prefix") ? strOf(kw.get("prefix")) : undefined, line });
      return "router";
    }
    if (ctor.module === "flask" && ctor.cls === "Flask") {
      facts.routers.set(local, { local, kind: "app", lib: "flask", line });
      return "router";
    }
    if (ctor.module === "flask" && ctor.cls === "Blueprint") {
      const p = kw.get("url_prefix") ?? pos[2];
      facts.routers.set(local, { local, kind: "router", lib: "flask", prefix: p ? strOf(p) : undefined, line });
      return "router";
    }
    const lib = SESSION_CLASSES[ctor.cls];
    if (lib && lib === ctor.module) {
      const b = kw.get("base_url");
      facts.instances.set(local, { local, lib, base: b ? strOf(b) : undefined, line });
      return "instance";
    }
    return undefined;
  };

  const classAttrTypes = new Map<string, Map<string, string>>();
  if (analysed) {
    for (const [name, list] of assigns.get(rootKey) ?? []) {
      if (list.length === 1) classify(list[0], name, lineOf(list[0]));
    }
  }
  for (const { cls, attrs: m } of selfAssigns.values()) {
    const cname = cls.childForFieldName("name")?.text;
    if (!cname) continue;
    const types = new Map<string, string>();
    for (const [attr, list] of m) {
      if (list.length !== 1) continue;
      const rhs = list[0];
      if (analysed) classify(rhs, `${cname}.self.${attr}`, lineOf(rhs));
      if (rhs.type === "call") {
        const fn = rhs.childForFieldName("function");
        if (fn?.type === "identifier" && /^[A-Z]/.test(fn.text)) types.set(attr, fn.text);
      } else if (rhs.type === "identifier") {
        // self.repo = repo, with `repo: OrderRepo` in __init__'s parameters.
        const fn = fnOf(rhs);
        const p = fn && params.get(key(fn))?.get(rhs.text);
        const t = p?.childForFieldName?.("type")?.text;
        if (t && /^[A-Za-z_][\w.]*$/.test(t)) types.set(attr, t.split(".").pop()!);
      }
    }
    classAttrTypes.set(cname, types);
    facts.classes.set(cname, { props: types, line: lineOf(cls) });
  }
  // `x = OrderService()`: for `x.method()` calls.
  for (const [name, list] of assigns.get(rootKey) ?? []) {
    for (const rhs of list) {
      const fn = rhs.type === "call" ? rhs.childForFieldName("function") : undefined;
      if (fn?.type === "identifier" && /^[A-Z]/.test(fn.text)) {
        const prev = facts.newVars.get(name);
        facts.newVars.set(name, prev === undefined || prev === fn.text ? fn.text : "");
      }
    }
  }

  /** with httpx.Client(base_url=…) as client: */
  const withInstances = new Map<string, true>();
  const collectWith = (n: Node) => {
    if (n.type === "as_pattern") {
      const value = n.namedChild(0);
      const alias = n.childForFieldName("alias")?.namedChild?.(0) ?? n.childForFieldName("alias");
      if (value && alias?.type === "identifier" && classify(value, alias.text, lineOf(n)) === "instance") withInstances.set(alias.text, true);
    }
    for (const c of named(n)) collectWith(c);
  };
  if (analysed) collectWith(root);

  /** What a call's receiver is: a router, a client module, a client instance, or an import. */
  const recvOf = (obj: Node): { k: "router"; local: string } | { k: "module"; lib: string } | { k: "instance"; lib: string; base?: StrVal } | { k: "imported"; ref: NameRef } | undefined => {
    if (obj.type === "identifier") {
      if (facts.routers.has(obj.text)) return { k: "router", local: obj.text };
      const inst = facts.instances.get(obj.text);
      if (inst) return { k: "instance", lib: inst.lib, base: inst.base };
      const imp = importOf(obj.text);
      if (imp?.imported === "*" && CLIENT_MODULES.has(imp.spec)) return { k: "module", lib: imp.spec };
      if (imp) return { k: "imported", ref: { local: obj.text, path: [] } };
      return undefined;
    }
    if (obj.type === "attribute" && obj.childForFieldName("object")?.text === "self") {
      const cls = classOf(obj);
      const cname = cls?.childForFieldName("name")?.text;
      const attr = obj.childForFieldName("attribute")?.text;
      const inst = cname && facts.instances.get(`${cname}.self.${attr}`);
      if (inst) return { k: "instance", lib: inst.lib, base: inst.base };
    }
    if (obj.type === "attribute") {
      const { root: r, path } = attrChain(obj);
      if (r?.type === "identifier" && importOf(r.text)) return { k: "imported", ref: { local: r.text, path } };
    }
    return undefined;
  };

  const childRef = (n: Node | undefined): NameRef | undefined => {
    if (!n) return undefined;
    if (n.type === "identifier") return { local: n.text, path: [] };
    if (n.type === "attribute") {
      const { root: r, path } = attrChain(n);
      if (r?.type === "identifier") return { local: r.text, path };
    }
    return undefined;
  };

  const handlerName = (n: Node | undefined): HandlerRef => {
    const ref = childRef(n);
    return ref ? { k: "name", local: ref.local, path: ref.path, line: n ? lineOf(n) : 0 } : { k: "unknown", text: n?.text ?? "(none)" };
  };

  // -------------------------------------------------------------------------
  // Decorated route handlers.

  const onDecorated = (dd: Node) => {
    const def = dd.childForFieldName("definition");
    if (def?.type !== "function_definition") return;
    const nameNode = def.childForFieldName("name");
    for (const dec of named(dd)) {
      if (dec.type !== "decorator") continue;
      const call = dec.namedChild(0);
      if (call?.type !== "call") continue;
      const fn = call.childForFieldName("function");
      if (fn?.type !== "attribute") continue;
      const obj = fn.childForFieldName("object");
      const m = fn.childForFieldName("attribute")?.text;
      if (obj?.type !== "identifier" || !m) continue;
      const known = facts.routers.get(obj.text);
      const imported = !known && importOf(obj.text);
      if (!known && !imported) continue;
      const { pos, kw } = argsOf(call);
      const pathNode = pos[0] ?? kw.get("path") ?? kw.get("rule");
      let methods: string[] | undefined;
      if (VERBS.has(m)) methods = [m.toUpperCase()];
      else if (m === "route" || m === "api_route") {
        const ms = kw.get("methods");
        methods = ms ? strsOf(ms).map((v) => literal(v)?.toUpperCase() ?? "ALL") : [m === "route" ? "GET" : "GET"];
      }
      if (!methods || !pathNode) continue;
      for (const method of methods) {
        facts.routes.push({
          adapter: known?.lib ?? "python-router",
          method,
          path: strOf(pathNode),
          router: { local: obj.text, path: [] },
          handler: { k: "self", offset: nameNode.startIndex },
          line: lineOf(dd),
          offset: dd.startIndex,
        });
      }
    }
  };

  // -------------------------------------------------------------------------
  // Calls.

  const addClient = (adapter: string, method: string | undefined, url: Node | undefined, at: Node, base?: StrVal, methodNote?: string) => {
    if (!url) return;
    facts.clients.push({
      adapter, method, url: strOf(url), base, methodNote,
      line: lineOf(at), offset: at.startIndex, text: snippet(at),
    });
  };

  const onCall = (call: Node) => {
    const fn = call.childForFieldName("function");
    if (!fn) return;
    // Direct calls.
    if (fn.type === "identifier") {
      facts.calls.push({ offset: fn.startIndex, line: lineOf(call), form: "bare", name: fn.text, text: snippet(call) });
    } else if (fn.type === "attribute") {
      const obj = fn.childForFieldName("object");
      const attr = fn.childForFieldName("attribute");
      if (obj && attr) {
        if (obj.type === "identifier" && obj.text === "self") {
          facts.calls.push({ offset: attr.startIndex, line: lineOf(call), form: "this", name: attr.text, text: snippet(call) });
        } else if (obj.type === "attribute" && obj.childForFieldName("object")?.text === "self") {
          facts.calls.push({ offset: attr.startIndex, line: lineOf(call), form: "thisProp", name: attr.text, recv: obj.childForFieldName("attribute")?.text, text: snippet(call) });
        } else if (obj.type === "identifier") {
          facts.calls.push({ offset: attr.startIndex, line: lineOf(call), form: "member", name: attr.text, recv: obj.text, text: snippet(call) });
        }
      }
    }
    if (!analysed || fn.type !== "attribute") return;
    const obj = fn.childForFieldName("object");
    const m = fn.childForFieldName("attribute")?.text;
    if (!obj || !m) return;
    const { pos, kw } = argsOf(call);

    // uvicorn.run(app, port=8000), app.run(port=5000)
    if ((m === "run" && (obj.text === "uvicorn" || facts.routers.get(obj.text)?.kind === "app"))) {
      const p = kw.get("port");
      const t = p && literal(strOf(p));
      if (t !== undefined && /^\d+$/.test(t)) facts.ports.push({ port: Number(t), line: lineOf(call) });
      else if (p) {
        const v = strOf(p);
        const e = v.parts[0];
        if (v.parts.length === 1 && e.k === "env" && e.fallback && /^\d+$/.test(e.fallback)) {
          facts.ports.push({ port: Number(e.fallback), line: lineOf(call), note: `default when ${e.name} is unset` });
        }
      }
    }

    const r = recvOf(obj);
    if (!r) {
      if (VERBS.has(m) && pos[0]?.type === "string" && /^[rbuRBU]*["']\//.test(pos[0].text) && facts.unproven.length < 50) {
        facts.unproven.push({ line: lineOf(call), text: snippet(call) });
      }
      return;
    }
    if (r.k === "router") {
      const lib = facts.routers.get(r.local)!.lib;
      if (m === "include_router" || m === "register_blueprint") {
        const child = childRef(pos[0]);
        const p = kw.get(m === "include_router" ? "prefix" : "url_prefix");
        if (child) facts.mounts.push({
          lib, parent: r.local, prefix: p ? strOf(p) : lit(""), child, line: lineOf(call),
          replacesOwnPrefix: m === "register_blueprint" && !!p,
        });
      } else if (m === "mount" && pos[0] && pos[1]) {
        const child = childRef(pos[1]);
        if (child) facts.mounts.push({ lib, parent: r.local, prefix: strOf(pos[0]), child, line: lineOf(call) });
      } else if (m === "add_url_rule" || m === "add_api_route") {
        const view = kw.get(m === "add_url_rule" ? "view_func" : "endpoint") ?? pos[m === "add_url_rule" ? 2 : 1];
        const ms = kw.get("methods");
        const methods = ms ? strsOf(ms).map((v) => literal(v)?.toUpperCase() ?? "ALL") : ["GET"];
        if (pos[0]) for (const method of methods) {
          facts.routes.push({
            adapter: lib, method, path: strOf(pos[0]), router: { local: r.local, path: [] },
            handler: handlerName(view), line: lineOf(call), offset: call.startIndex,
          });
        }
      }
      return;
    }
    if (r.k === "module" || r.k === "instance") {
      const base = r.k === "instance" ? r.base : undefined;
      if (VERBS.has(m)) addClient(r.lib, m.toUpperCase(), pos[0] ?? kw.get("url"), call, base);
      else if (m === "request") {
        const me = pos[0] ?? kw.get("method");
        const t = me ? literal(strOf(me)) : undefined;
        addClient(r.lib, t?.toUpperCase(), pos[1] ?? kw.get("url"), call, base, t === undefined ? `method ${me?.text ?? "?"} computed` : undefined);
      }
      return;
    }
    if (r.k === "imported" && VERBS.has(m) && pos[0]) {
      const url = strOf(pos[0]);
      facts.pending.push({ recv: r.ref, verb: m, url, line: lineOf(call), offset: call.startIndex, text: snippet(call) });
    }
  };

  const visit = (n: Node) => {
    if (n.type === "call") onCall(n);
    else if (analysed && n.type === "decorated_definition") onDecorated(n);
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
  };
  visit(root);
  void classAttrTypes;
}

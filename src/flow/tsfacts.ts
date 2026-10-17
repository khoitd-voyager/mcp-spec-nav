import { ts } from "ts-morph";
import { parseSource, fileChecker, WRAPPERS } from "../tsparse.js";
import { tsParseView } from "../sfc.js";
import type { SourceEntry } from "../project.js";
import {
  FileFacts,
  StrVal,
  HandlerRef,
  KeyVal,
  NameRef,
  RouterFact,
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
 * Communication facts in TypeScript and JavaScript (and the scripts of
 * Vue/Svelte/Astro components), read with the TypeScript parser and a
 * one-file binder — no type checker, no other files. Each adapter recognises
 * a library by how it is imported or declared, never by a variable's name
 * alone:
 *
 *  - HTTP servers: Express (`express()`, `Router()`), Fastify (`fastify()`,
 *    plugins), koa-router, NestJS controllers (`@Controller` + `@Get`…).
 *  - HTTP clients: `fetch`, axios (and `axios.create` instances), NestJS
 *    `HttpService`, medusa-js `client.request(method, path)`.
 *  - RPC and events: NestJS microservices (`@MessagePattern`/`@EventPattern`
 *    with `ClientProxy.send`/`emit`), `@nestjs/event-emitter`
 *    (`@OnEvent` with `EventEmitter2.emit`), kafkajs producers and consumers.
 *
 * Strings are resolved as far as the file allows — literals, templates,
 * `+`, `const`s, object and enum members, `process.env` — and an imported name
 * is left as a reference for the linker.
 */

/** Files worth parsing for communication: a library or an HTTP-looking call is named. */
export const TS_PREFILTER =
  /\b(?:express|fastify|Fastify|koa-router|fetch|ofetch|axios|HttpService|kafkajs|setGlobalPrefix)\b|@medusajs\/medusa-js|\$fetch\b|@koa\/router|@nestjs\/(?:common|microservices|event-emitter|axios)\b|\.(?:producer|consumer)\s*\(|\.(?:get|post|put|patch|delete|all|head|options)\s*\(\s*['"`]\//;

/** Files whose location is their route: Medusa, Next.js (app and pages), SvelteKit. */
const FILE_ROUTE = /(^|\/)(src\/api\/(.+\/)?route|(src\/)?app\/(.+\/)?route|src\/routes\/(.+\/)?\+server)\.[cm]?[jt]sx?$|(^|\/)(src\/)?pages\/api\/.+\.[jt]sx?$/;
export function isFileRoute(rel: string): boolean {
  return FILE_ROUTE.test(rel);
}

const ROUTE_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

/**
 * The route a file stands for, by the framework's convention, as segments
 * relative to the service: `src/api/store/orders/[id]/route.ts` (Medusa) is
 * `/store/orders/:id`; `app/(shop)/api/items/[...slug]/route.ts` (Next.js) is
 * `/api/items/*`; `pages/api/health.ts` is `/api/health`; SvelteKit's
 * `src/routes/api/users/[id]/+server.ts` is `/api/users/:id`.
 */
function fileRouteOf(entry: SourceEntry): { adapter: string; path: string; pages?: boolean } | undefined {
  if (!FILE_ROUTE.test(entry.rel)) return undefined;
  const inService = entry.service === "." ? entry.rel : entry.rel.slice(entry.service.length + 1);
  const parts = inService.split("/");
  const file = parts.pop()!;
  let adapter: string | undefined;
  let segs: string[] = [];
  let pages = false;
  if (/^route\.[cm]?[jt]sx?$/.test(file) && parts[0] === "src" && parts[1] === "api") {
    adapter = "medusa (file routes)";
    segs = parts.slice(2);
  } else if (/^route\.[cm]?[jt]sx?$/.test(file) && (parts[0] === "app" || (parts[0] === "src" && parts[1] === "app"))) {
    adapter = "next (app router)";
    segs = parts.slice(parts[0] === "app" ? 1 : 2);
  } else if (/^\+server\.[jt]s$/.test(file) && parts[0] === "src" && parts[1] === "routes") {
    adapter = "sveltekit";
    segs = parts.slice(2);
  } else {
    const p = parts[0] === "pages" ? 1 : parts[0] === "src" && parts[1] === "pages" ? 2 : -1;
    if (p < 0 || parts[p] !== "api") return undefined;
    adapter = "next (pages api)";
    const name = file.replace(/\.[^.]+$/, "");
    segs = [...parts.slice(p), ...(name === "index" ? [] : [name])];
    pages = true;
  }
  const out: string[] = [];
  for (const sg of segs) {
    if (/^\(.*\)$/.test(sg) || sg.startsWith("@")) continue; // route groups and parallel-route slots
    let m: RegExpMatchArray | null;
    if ((m = sg.match(/^\[\[?\.\.\.(\w+)\]?\]$/))) out.push("*");
    else if ((m = sg.match(/^\[\[?(\w+)(?:=\w+)?\]?\]$/))) out.push(`:${m[1]}`);
    else out.push(sg);
  }
  return { adapter, path: "/" + out.join("/"), pages };
}

const FETCH_LIBS = ["node-fetch", "undici", "cross-fetch", "isomorphic-fetch", "ofetch"];
const NEST_ROUTE: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", Options: "OPTIONS", Head: "HEAD",
  All: "ALL", Sse: "GET",
};
const CLIENT_PROXY = /^(ClientProxy|ClientKafka|ClientRMQ|ClientRedis|ClientNats|ClientMqtt|ClientTCP|ClientGrpcProxy)$/;
const VERBS = new Set<string>(HTTP_VERBS);
const ROUTE_VERBS = new Set<string>([...HTTP_VERBS, "all"]);

type Recv =
  | { k: "router"; local: string }
  | { k: "axios-module" }
  | { k: "express-module" }
  | { k: "instance"; lib: string; base?: StrVal; note?: string }
  | { k: "nest-client" }
  | { k: "emitter2" }
  | { k: "producer"; kafkaVar?: string }
  | { k: "consumer"; kafkaVar?: string; group?: StrVal; varKey: string }
  | { k: "imported"; ref: NameRef };

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ||
        ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isAwaitExpression(e)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function typeName(t: ts.TypeNode | undefined): string | undefined {
  if (!t) return undefined;
  if (ts.isTypeReferenceNode(t)) return t.typeName.getText().split(".").pop();
  return undefined;
}

export function extractTs(entry: SourceEntry, text: string, analysed: boolean): FileFacts {
  const facts = emptyFacts({
    rel: entry.rel,
    service: entry.service,
    language: entry.language,
    stamp: entry.stamp,
    family: "ts",
    analysed,
  });
  const view = tsParseView(entry.ext, text);
  const sf = parseSource(entry.abs, view.text, view.ext);
  const diags: ts.DiagnosticWithLocation[] = (sf as any).parseDiagnostics ?? [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  if (diags[0]) facts.parseError = `syntax error at line ${lineOf(diags[0].start)}`;
  const lines = text.split("\n");
  const snippet = (n: ts.Node) => {
    const t = (lines[lineOf(n.getStart(sf)) - 1] ?? "").trim().replace(/\s+/g, " ");
    return t.length > 140 ? t.slice(0, 139) + "…" : t;
  };
  const where = (n: ts.Node) => `${entry.rel}:${lineOf(n.getStart(sf))}`;

  let checker: ts.TypeChecker | undefined;
  const declOf = (id: ts.Identifier): ts.Declaration | undefined => {
    checker ??= fileChecker(sf);
    try {
      return checker.getSymbolAtLocation(id)?.declarations?.[0];
    } catch {
      return undefined;
    }
  };

  // -------------------------------------------------------------------------
  // Imports, including CommonJS `require`.

  const requireSpec = (e: ts.Expression | undefined): string | undefined => {
    if (!e) return undefined;
    const u = unwrap(e);
    if (ts.isCallExpression(u) && ts.isIdentifier(u.expression) && u.expression.text === "require" &&
        u.arguments.length === 1 && ts.isStringLiteralLike(u.arguments[0])) {
      return u.arguments[0].text;
    }
    return undefined;
  };

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const line = lineOf(st.getStart(sf));
      const c = st.importClause;
      if (c?.name) facts.imports.set(c.name.text, { spec, imported: "default", line });
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) facts.imports.set(c.namedBindings.name.text, { spec, imported: "*", line });
        else for (const el of c.namedBindings.elements) facts.imports.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text, line });
      }
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) &&
               ts.isStringLiteral(st.moduleReference.expression)) {
      facts.imports.set(st.name.text, { spec: st.moduleReference.expression.text, imported: "*", line: lineOf(st.getStart(sf)) });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const spec = requireSpec(d.initializer);
        if (!spec) continue;
        const line = lineOf(d.getStart(sf));
        if (ts.isIdentifier(d.name)) facts.imports.set(d.name.text, { spec, imported: "cjs", line });
        else if (ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const from = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            facts.imports.set(el.name.text, { spec, imported: from, line });
          }
        }
      }
    }
  }
  const libOf = (name: string) => facts.imports.get(name)?.spec;
  const isLib = (name: string, ...libs: string[]) => {
    const s = libOf(name);
    return !!s && libs.some((l) => s === l || s.startsWith(l + "/"));
  };
  const fileMentions = (lib: string) => [...facts.imports.values()].some((i) => i.spec === lib || i.spec.startsWith(lib + "/"));
  const isImportDecl = (d: ts.Declaration | undefined) =>
    !!d && (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isImportEqualsDeclaration(d) ||
      (ts.isVariableDeclaration(d) && !!requireSpec(d.initializer)) ||
      (ts.isBindingElement(d) && ts.isVariableDeclaration(d.parent.parent) && !!requireSpec(d.parent.parent.initializer)));

  // -------------------------------------------------------------------------
  // Strings.

  const seen = new Set<ts.Node>();

  const constInit = (d: ts.Declaration): ts.Expression | undefined => {
    if (!ts.isVariableDeclaration(d) || !d.initializer) return undefined;
    const list = d.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
    return d.initializer;
  };

  /** The object literal a const name holds, following `const a = b` aliases. */
  const objectOf = (e: ts.Expression, depth = 0): ts.ObjectLiteralExpression | undefined => {
    const u = unwrap(e);
    if (ts.isObjectLiteralExpression(u)) return u;
    if (depth > 5 || !ts.isIdentifier(u)) return undefined;
    const d = declOf(u);
    const init = d && constInit(d);
    return init ? objectOf(init, depth + 1) : undefined;
  };

  const propOf = (obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined => {
    for (const p of obj.properties) {
      const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
      if (name !== key) continue;
      if (ts.isPropertyAssignment(p)) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p)) return p.name;
    }
    return undefined;
  };

  const strOf = (e0: ts.Expression | undefined, depth = 0): StrVal => {
    if (!e0) return dyn("(missing)");
    const e = unwrap(e0);
    if (depth > 12) return dyn(e.getText(sf));
    if (ts.isStringLiteralLike(e)) return lit(e.text);
    if (ts.isNumericLiteral(e)) return lit(e.text);
    if (ts.isTemplateExpression(e)) {
      let v = lit(e.head.text);
      for (const span of e.templateSpans) v = concat(v, strOf(span.expression, depth + 1), lit(span.literal.text));
      return v;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) return concat(strOf(e.left, depth + 1), strOf(e.right, depth + 1));
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const l = strOf(e.left, depth + 1);
        const r = literal(strOf(e.right, depth + 1));
        if (l.parts.length === 1 && l.parts[0].k === "env") return { parts: [{ ...l.parts[0], fallback: r }], via: l.via };
        return dyn(e.getText(sf));
      }
      return dyn(e.getText(sf));
    }
    if (ts.isIdentifier(e)) return identVal(e, depth);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return memberVal(e, depth);
    if (ts.isCallExpression(e)) {
      const c = unwrap(e.expression);
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
      if (name === "String" && e.arguments.length === 1) return strOf(e.arguments[0], depth + 1);
      if (name === "toString" && ts.isPropertyAccessExpression(c)) return strOf(c.expression, depth + 1);
      if ((name === "encodeURIComponent" || name === "encodeURI") && e.arguments.length === 1) {
        const inner = strOf(e.arguments[0], depth + 1);
        const t = literal(inner);
        return t !== undefined ? lit(name === "encodeURI" ? encodeURI(t) : encodeURIComponent(t)) : dyn(e.arguments[0].getText(sf));
      }
      if (name === "join" && ts.isPropertyAccessExpression(c) && ts.isArrayLiteralExpression(unwrap(c.expression))) {
        const sep = e.arguments.length ? literal(strOf(e.arguments[0], depth + 1)) : ",";
        if (sep !== undefined) {
          const items = (unwrap(c.expression) as ts.ArrayLiteralExpression).elements.map((x) => strOf(x, depth + 1));
          return concat(...items.flatMap((v, i) => (i ? [lit(sep), v] : [v])));
        }
      }
      return dyn(e.getText(sf));
    }
    return dyn(e.getText(sf));
  };

  const identVal = (id: ts.Identifier, depth: number): StrVal => {
    const d = declOf(id);
    if (!d) return dyn(id.text);
    if (isImportDecl(d)) return { parts: [{ k: "ref", local: id.text, path: [] }], via: [] };
    if (ts.isParameter(d)) return dyn(id.text);
    if (ts.isEnumMember(d)) return d.initializer ? strOf(d.initializer, depth + 1) : dyn(id.text);
    if (ts.isBindingElement(d)) {
      // `const { ORDERS } = ROUTES`
      const decl = d.parent.parent;
      if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isObjectBindingPattern(d.parent)) {
        const key = d.propertyName && ts.isIdentifier(d.propertyName) ? d.propertyName.text : id.text;
        const obj = constInit(decl) && objectOf(decl.initializer);
        const v = obj && propOf(obj, key);
        if (v && !seen.has(d)) {
          seen.add(d);
          try {
            return note(id.text, strOf(v, depth + 1), d);
          } finally {
            seen.delete(d);
          }
        }
      }
      return dyn(id.text);
    }
    const init = constInit(d);
    if (!init || seen.has(d)) return dyn(id.text);
    seen.add(d);
    try {
      return note(id.text, strOf(init, depth + 1), d);
    } finally {
      seen.delete(d);
    }
  };

  /** `API = "/api" (web/src/config.ts:3)`, when naming it says something. */
  const note = (name: string, v: StrVal, at: ts.Node): StrVal =>
    v.parts.length === 1 && v.parts[0].k === "dyn" ? v : withVia(v, `${name} = "${show(v)}" (${where(at)})`);

  const memberChain = (e: ts.Expression): { root: ts.Expression; path: string[] } | undefined => {
    const path: string[] = [];
    let cur = unwrap(e);
    for (;;) {
      if (ts.isPropertyAccessExpression(cur)) {
        path.unshift(cur.name.text);
        cur = unwrap(cur.expression);
      } else if (ts.isElementAccessExpression(cur) && ts.isStringLiteralLike(cur.argumentExpression)) {
        path.unshift(cur.argumentExpression.text);
        cur = unwrap(cur.expression);
      } else {
        return { root: cur, path };
      }
    }
  };

  const memberVal = (e: ts.PropertyAccessExpression | ts.ElementAccessExpression, depth: number): StrVal => {
    const ch = memberChain(e);
    if (!ch) return dyn(e.getText(sf));
    const rootText = ch.root.getText(sf);
    // this.baseUrl, from the class's own property initializer when nothing reassigns it.
    if (ch.root.kind === ts.SyntaxKind.ThisKeyword && ch.path.length === 1) {
      const v = thisPropVal(e, ch.path[0], depth);
      if (v) return v;
    }
    // process.env.X, import.meta.env.X
    if ((rootText === "process" && ch.path[0] === "env" && ch.path.length === 2) ||
        (ts.isMetaProperty(ch.root) && ch.path[0] === "env" && ch.path.length === 2)) {
      return env(ch.path[1]);
    }
    if (!ts.isIdentifier(ch.root)) return dyn(e.getText(sf));
    const d = declOf(ch.root);
    if (!d) return dyn(e.getText(sf));
    if (isImportDecl(d)) return { parts: [{ k: "ref", local: ch.root.text, path: ch.path }], via: [] };
    if (ts.isEnumDeclaration(d) && ch.path.length === 1) {
      const m = d.members.find((x) => (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) && x.name.text === ch.path[0]);
      if (m?.initializer) return note(`${ch.root.text}.${ch.path[0]}`, strOf(m.initializer, depth + 1), m);
      return dyn(e.getText(sf));
    }
    const init = constInit(d);
    if (!init) return dyn(e.getText(sf));
    let obj = objectOf(init);
    let value: ts.Expression | undefined;
    for (let i = 0; i < ch.path.length && obj; i++) {
      value = propOf(obj, ch.path[i]);
      if (!value) return dyn(e.getText(sf));
      obj = i < ch.path.length - 1 ? objectOf(value) : undefined;
    }
    if (!value || seen.has(value)) return dyn(e.getText(sf));
    seen.add(value);
    try {
      return note(`${ch.root.text}.${ch.path.join(".")}`, strOf(value, depth + 1), value);
    } finally {
      seen.delete(value);
    }
  };

  const thisPropVal = (at: ts.Node, prop: string, depth: number): StrVal | undefined => {
    let cls: ts.ClassLikeDeclaration | undefined;
    for (let p: ts.Node | undefined = at.parent; p && !cls; p = p.parent) {
      if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) cls = p;
    }
    if (!cls) return undefined;
    const decl = cls.members.find((m) => ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name) && m.name.text === prop) as
      ts.PropertyDeclaration | undefined;
    if (!decl?.initializer || seen.has(decl)) return undefined;
    const reassigned = new RegExp(`this\\.${prop}\\s*=[^=]`).test(cls.getText(sf).slice(decl.getEnd() - cls.getStart(sf)));
    if (reassigned) return undefined;
    seen.add(decl);
    try {
      return note(`this.${prop}`, strOf(decl.initializer, depth + 1), decl);
    } finally {
      seen.delete(decl);
    }
  };

  /** Strings the value may be: an array literal gives several. */
  const strsOf = (e: ts.Expression | undefined): StrVal[] => {
    if (!e) return [lit("")];
    const u = unwrap(e);
    if (ts.isArrayLiteralExpression(u)) return u.elements.map((x) => strOf(x));
    return [strOf(u)];
  };

  const keysOf = (e: ts.Expression | undefined): KeyVal[] => {
    if (!e) return [];
    const u = unwrap(e);
    if (ts.isArrayLiteralExpression(u)) return u.elements.flatMap((x) => keysOf(x));
    if (ts.isRegularExpressionLiteral(u)) {
      const m = u.text.match(/^\/(.*)\/([a-z]*)$/s);
      return m ? [{ k: "regex", source: m[1], flags: m[2] }] : [];
    }
    const obj = objectOf(u);
    if (obj) {
      const entries: Array<[string, StrVal]> = [];
      for (const p of obj.properties) {
        if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
        const v = ts.isPropertyAssignment(p) ? strOf(p.initializer) : ts.isShorthandPropertyAssignment(p) ? strOf(p.name) : undefined;
        if (v) entries.push([p.name.text, v]);
      }
      return [{ k: "obj", entries }];
    }
    return [{ k: "str", v: strOf(u) }];
  };

  // -------------------------------------------------------------------------
  // Exported constants (every top-level const, enum and CommonJS export).

  const putConst = (name: string, e: ts.Expression, line: number, depth = 0) => {
    const obj = objectOf(e);
    if (obj && depth < 4) {
      for (const p of obj.properties) {
        if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
        if (ts.isPropertyAssignment(p)) putConst(`${name}.${p.name.text}`, p.initializer, lineOf(p.getStart(sf)), depth + 1);
      }
      return;
    }
    const u = unwrap(e);
    if (ts.isArrowFunction(u) || ts.isFunctionExpression(u) || ts.isCallExpression(u) || ts.isNewExpression(u) ||
        ts.isClassExpression(u) || ts.isArrayLiteralExpression(u)) return;
    const v = strOf(e);
    if (v.parts.length === 1 && v.parts[0].k === "dyn") return;
    facts.consts.set(name, { ...v, line });
  };

  const isModuleExports = (e: ts.Expression) => collapse(unwrap(e).getText(sf)) === "module.exports";
  const cjsName = (e: ts.Expression): string | undefined => {
    const u = unwrap(e);
    if (!ts.isPropertyAccessExpression(u)) return undefined;
    const obj = collapse(u.expression.getText(sf));
    return obj === "exports" || obj === "module.exports" ? u.name.text : undefined;
  };
  /** `export default <expr>` and `module.exports = <expr>` that is not a name: kept under "default". */
  const defaultValues: ts.Expression[] = [];

  for (const st of sf.statements) {
    const line = lineOf(st.getStart(sf));
    if (ts.isVariableStatement(st)) {
      if (!(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && !requireSpec(d.initializer)) putConst(d.name.text, d.initializer, lineOf(d.getStart(sf)));
      }
    } else if (ts.isEnumDeclaration(st)) {
      for (const m of st.members) {
        if (m.initializer && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
          putConst(`${st.name.text}.${m.name.text}`, m.initializer, lineOf(m.getStart(sf)));
        }
      }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name &&
               ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      facts.exportAs.set("default", st.name.text);
    } else if (ts.isExportAssignment(st)) {
      const u = unwrap(st.expression);
      if (ts.isIdentifier(u)) facts.exportAs.set("default", u.text);
      else {
        putConst("default", u, line);
        defaultValues.push(u);
      }
    } else if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        const names = new Map<string, string>();
        for (const el of st.exportClause.elements) names.set(el.name.text, (el.propertyName ?? el.name).text);
        if (spec) facts.reexports.push({ spec, names });
        else for (const [as, local] of names) if (as !== local) facts.exportAs.set(as, local);
      } else if (spec && !st.exportClause) {
        facts.reexports.push({ spec });
      }
    } else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) &&
               st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = st.expression;
      const r = unwrap(right);
      if (isModuleExports(left)) {
        if (ts.isIdentifier(r)) facts.exportAs.set("default", r.text);
        else if (ts.isObjectLiteralExpression(r)) {
          for (const p of r.properties) {
            if (ts.isShorthandPropertyAssignment(p)) continue;
            if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
              const v = unwrap(p.initializer);
              if (ts.isIdentifier(v)) facts.exportAs.set(p.name.text, v.text);
              else putConst(p.name.text, v, lineOf(p.getStart(sf)));
            }
          }
        } else {
          putConst("default", r, line);
          defaultValues.push(r);
        }
      } else {
        const n = cjsName(left);
        if (n) {
          if (ts.isIdentifier(r)) facts.exportAs.set(n, r.text);
          else putConst(n, r, line);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pass 1: what each variable, parameter and class property holds.

  const varKind = new Map<ts.Node, Recv>();
  const kafkaByDecl = new Map<ts.Node, string>();
  const classProps = new Map<string, Map<string, { type?: string; recv?: Recv }>>();

  /** What an initializer creates, when it is something an adapter knows. */
  const classify = (init: ts.Expression, local: string, line: number): Recv | undefined => {
    const e = unwrap(init);
    if (ts.isCallExpression(e)) {
      const c = unwrap(e.expression);
      if (ts.isIdentifier(c)) {
        if (isLib(c.text, "express") && facts.imports.get(c.text)!.imported !== "Router") {
          facts.routers.set(local, { local, kind: "app", lib: "express", line });
          return { k: "router", local };
        }
        if (isLib(c.text, "express") && facts.imports.get(c.text)!.imported === "Router") {
          facts.routers.set(local, { local, kind: "router", lib: "express", line });
          return { k: "router", local };
        }
        if (isLib(c.text, "fastify")) {
          facts.routers.set(local, { local, kind: "app", lib: "fastify", line });
          return { k: "router", local };
        }
      }
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
        const obj = c.expression.text;
        if (c.name.text === "Router" && isLib(obj, "express")) {
          facts.routers.set(local, { local, kind: "router", lib: "express", line });
          return { k: "router", local };
        }
        if (c.name.text === "create" && isLib(obj, "axios")) {
          const o = e.arguments[0] && objectOf(e.arguments[0]);
          const b = o && propOf(o, "baseURL");
          const r: Recv = { k: "instance", lib: "axios", base: b ? strOf(b) : undefined };
          facts.instances.set(local, { local, lib: "axios", base: r.base, line });
          return r;
        }
        const kafkaVar = kafkaVarOf(c.expression);
        if (c.name.text === "producer" && kafkaVar !== undefined) return { k: "producer", kafkaVar };
        if (c.name.text === "consumer" && kafkaVar !== undefined) {
          const o = e.arguments[0] && objectOf(e.arguments[0]);
          const g = o && propOf(o, "groupId");
          return { k: "consumer", kafkaVar, group: g ? strOf(g) : undefined, varKey: local };
        }
      }
    }
    if (ts.isNewExpression(e) && ts.isIdentifier(unwrap(e.expression))) {
      const cls = (unwrap(e.expression) as ts.Identifier).text;
      if (isLib(cls, "@koa/router", "koa-router")) {
        const o = e.arguments?.[0] && objectOf(e.arguments[0]);
        const p = o && propOf(o, "prefix");
        facts.routers.set(local, { local, kind: "router", lib: "koa-router", prefix: p ? strOf(p) : undefined, line });
        return { k: "router", local };
      }
      if (isLib(cls, "koa")) {
        facts.routers.set(local, { local, kind: "app", lib: "koa", line });
        return { k: "router", local };
      }
      if (cls === "Kafka" && isLib(cls, "kafkajs")) {
        const o = e.arguments?.[0] && objectOf(e.arguments[0]);
        const b = o && propOf(o, "brokers");
        facts.kafka.set(local, { brokers: b ? strsOf(b) : undefined, line });
        return undefined;
      }
    }
    return undefined;
  };

  /** The Kafka variable a `.producer()` / `.consumer()` is called on: "" when not provably a Kafka client. */
  const kafkaVarOf = (e: ts.Expression): string | undefined => {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) {
      const d = declOf(u);
      if (d && kafkaByDecl.has(d)) return kafkaByDecl.get(d);
      if (d && ts.isParameter(d) && typeName(d.type) === "Kafka") return "";
      // A Kafka client shared from another module: which brokers it uses is not read here.
      if (d && isImportDecl(d)) return "";
    }
    if (ts.isPropertyAccessExpression(u) && u.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const cls = classOf(u);
      const p = cls ? classProps.get(cls)?.get(u.name.text) : undefined;
      if (p?.type === "Kafka") return "";
    }
    return undefined;
  };

  const classOf = (n: ts.Node): string | undefined => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if ((ts.isClassDeclaration(p) || ts.isClassExpression(p))) return p.name?.text ?? "<anonymous class>";
    }
    return undefined;
  };

  const recvFromType = (t: string | undefined, init?: Recv): Recv | undefined => {
    if (init) return init;
    if (!t) return undefined;
    if (t === "HttpService") return { k: "instance", lib: "nest-http" };
    if (CLIENT_PROXY.test(t)) return { k: "nest-client" };
    if (t === "EventEmitter2") return { k: "emitter2" };
    if (t === "Producer") return { k: "producer" };
    if (t === "Consumer") return { k: "consumer", varKey: "" };
    if (t === "AxiosInstance") return { k: "instance", lib: "axios", note: "an AxiosInstance property: its baseURL is set elsewhere" };
    return undefined;
  };

  /** A function whose first parameter is a router or Fastify instance: `fn:<name>`. */
  const paramRouterOf = new Map<ts.Node, string>();
  const fnName = (fn: ts.FunctionLikeDeclaration): string | undefined => {
    if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? (ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? "default" : undefined);
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
      if (ts.isExportAssignment(fn.parent)) return "default";
      return `@${fn.getStart(sf)}`;
    }
    return undefined;
  };
  const usesFastify = fileMentions("fastify") || fileMentions("fastify-plugin");
  const usesExpress = fileMentions("express");
  const considerParamRouter = (fn: ts.FunctionLikeDeclaration) => {
    const p = fn.parameters[0];
    if (!p || !ts.isIdentifier(p.name)) return;
    const t = p.type ? collapse(p.type.getText(sf)) : "";
    let lib: string | undefined;
    let kind: RouterFact["kind"] = "plugin";
    if (/\bFastifyInstance\b/.test(t)) lib = "fastify";
    else if (/^(express\.)?Router$/.test(t)) { lib = "express"; kind = "router"; }
    else if (/^(express\.)?(Express|Application)$/.test(t)) { lib = "express"; kind = "router"; }
    else if (!t && usesFastify && /^(fastify|app|server|instance)$/.test(p.name.text)) lib = "fastify";
    else if (!t && usesExpress && /^(router|app)$/.test(p.name.text)) { lib = "express"; kind = "router"; }
    if (!lib) return;
    const name = fnName(fn);
    if (!name) return;
    const local = `fn:${name}`;
    facts.routers.set(local, { local, kind, lib, line: lineOf(fn.getStart(sf)) });
    paramRouterOf.set(p, local);
  };

  /** The class a value is declared as: `x as T`, `<T>x`, `container.resolve<T>(…)`. */
  const declaredTypeOf = (init: ts.Expression): string | undefined => {
    let e: ts.Expression = init;
    while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) return typeName(e.type);
    if (ts.isCallExpression(e) && e.typeArguments?.length === 1) {
      const c = unwrap(e.expression);
      const name = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : "";
      // Dependency containers: Awilix/Medusa `resolve<T>`, Nest `moduleRef.get<T>` is not included —
      // `get<T>` is also axios's response type.
      if (name === "resolve") return typeName(e.typeArguments[0]);
    }
    return undefined;
  };
  const noteVarType = (name: string, type: string | undefined) => {
    if (!type || !/^[A-Z]/.test(type)) return;
    const prev = facts.varTypes.get(name);
    facts.varTypes.set(name, prev === undefined || prev === type ? type : "");
  };

  const pass1 = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const line = lineOf(n.getStart(sf));
      const r = analysed ? classify(n.initializer, n.name.text, line) : undefined;
      if (r) varKind.set(n, r);
      const u = unwrap(n.initializer);
      noteVarType(n.name.text, typeName(n.type) ?? declaredTypeOf(n.initializer));
      if (ts.isNewExpression(u) && ts.isIdentifier(unwrap(u.expression))) {
        const cls = (unwrap(u.expression) as ts.Identifier).text;
        if (cls === "Kafka" && isLib(cls, "kafkajs")) kafkaByDecl.set(n, n.name.text);
        const prev = facts.newVars.get(n.name.text);
        facts.newVars.set(n.name.text, prev === undefined || prev === cls ? cls : "");
      }
    }
    if (analysed && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))) considerParamRouter(n);
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.type && !ts.isParameterPropertyDeclaration(n, n.parent)) {
      noteVarType(n.name.text, typeName(n.type));
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !n.initializer && n.type) noteVarType(n.name.text, typeName(n.type));
    if ((ts.isClassDeclaration(n) || ts.isClassExpression(n))) {
      const cls = n.name?.text ?? "<anonymous class>";
      const props = classProps.get(cls) ?? new Map<string, { type?: string; recv?: Recv }>();
      for (const m of n.members) {
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) {
            if (!ts.isIdentifier(p.name) || !ts.isParameterPropertyDeclaration(p, m)) continue;
            props.set(p.name.text, { type: typeName(p.type) });
          }
        } else if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
          const recv = analysed && m.initializer ? classify(m.initializer, `this.${m.name.text}`, lineOf(m.getStart(sf))) : undefined;
          const u = m.initializer && unwrap(m.initializer);
          const newType = u && ts.isNewExpression(u) && ts.isIdentifier(unwrap(u.expression)) ? (unwrap(u.expression) as ts.Identifier).text : undefined;
          props.set(m.name.text, { type: typeName(m.type) ?? newType, recv });
        }
      }
      classProps.set(cls, props);
    }
    // `this.producer = kafka.producer()` in a constructor or method.
    if (analysed && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const cls = classOf(n);
      if (cls) {
        const props = classProps.get(cls) ?? new Map();
        const recv = classify(n.right, `this.${n.left.name.text}`, lineOf(n.getStart(sf)));
        if (recv) props.set(n.left.name.text, { ...(props.get(n.left.name.text) ?? {}), recv });
        classProps.set(cls, props);
      }
    }
    ts.forEachChild(n, pass1);
  };
  ts.forEachChild(sf, pass1);
  for (const [cls, props] of classProps) {
    const m = new Map<string, string>();
    for (const [k, v] of props) if (v.type) m.set(k, v.type);
    facts.classes.set(cls, { props: m, line: 0 });
  }

  // Fastify plugins passed inline to `register`: their first parameter is the instance.
  // (Collected in pass 1 via considerParamRouter with an `@offset` name.)

  const recvOf = (e0: ts.Expression): Recv | undefined => {
    const e = unwrap(e0);
    if (ts.isIdentifier(e)) {
      if (isLib(e.text, "axios") && ["default", "*", "cjs"].includes(facts.imports.get(e.text)!.imported)) return { k: "axios-module" };
      if (isLib(e.text, "express")) return { k: "express-module" };
      const d = declOf(e);
      if (d) {
        const v = varKind.get(d);
        if (v) return v;
        const pr = paramRouterOf.get(d);
        if (pr) return { k: "router", local: pr };
        if (ts.isParameter(d)) return recvFromType(typeName(d.type));
        if (isImportDecl(d)) return { k: "imported", ref: { local: e.text, path: [] } };
        if (ts.isVariableDeclaration(d)) return recvFromType(typeName(d.type));
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(e)) {
      if (e.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const cls = classOf(e);
        const p = cls ? classProps.get(cls)?.get(e.name.text) : undefined;
        return p ? recvFromType(p.type, p.recv) : undefined;
      }
      const ch = memberChain(e);
      if (ch && ts.isIdentifier(ch.root) && isImportDecl(declOf(ch.root))) {
        return { k: "imported", ref: { local: ch.root.text, path: ch.path } };
      }
    }
    return undefined;
  };

  // -------------------------------------------------------------------------
  // Handlers.

  const handlerOf = (e0: ts.Expression | undefined, depth = 0): HandlerRef => {
    if (!e0) return { k: "unknown", text: "(none)" };
    const e = unwrap(e0);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      return { k: "inline", start: e.getStart(sf), end: e.getEnd(), line: lineOf(e.getStart(sf)) };
    }
    if (ts.isIdentifier(e)) return { k: "name", local: e.text, path: [], line: lineOf(e.getStart(sf)) };
    if (ts.isPropertyAccessExpression(e)) {
      // `ctrl.list.bind(ctrl)`
      if (e.name.text === "bind") return handlerOf(e.expression, depth + 1);
      const ch = memberChain(e);
      if (ch && ts.isIdentifier(ch.root)) return { k: "name", local: ch.root.text, path: ch.path, line: lineOf(e.getStart(sf)) };
    }
    if (ts.isCallExpression(e) && depth < 3) {
      const c = unwrap(e.expression);
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
      if (name === "bind" && ts.isPropertyAccessExpression(c)) return handlerOf(c.expression, depth + 1);
      if (WRAPPERS.test(name) && e.arguments.length) return handlerOf(e.arguments[0], depth + 1);
    }
    return { k: "unknown", text: collapse(e.getText(sf)).slice(0, 80) };
  };

  // -------------------------------------------------------------------------
  // Pass 2: calls and decorated classes.

  const kafkaBrokersOf = (kafkaVar: string | undefined) => (kafkaVar ? facts.kafka.get(kafkaVar)?.brokers : undefined);
  const consumerRuns = new Map<string, HandlerRef>();

  const addRoute = (adapter: string, method: string, pathExpr: ts.Expression | undefined, router: NameRef | undefined,
                    handler: HandlerRef, at: ts.Node, controller?: StrVal[]) => {
    for (const p of strsOf(pathExpr)) {
      facts.routes.push({
        adapter, method, path: p, router, controller, handler,
        line: lineOf(at.getStart(sf)), offset: at.getStart(sf),
      });
    }
  };

  const addClient = (adapter: string, method: string | undefined, url: StrVal, at: ts.Node,
                     extra: { base?: StrVal; methodNote?: string; urlConstructor?: boolean } = {}) => {
    facts.clients.push({
      adapter, method, url, ...extra,
      line: lineOf(at.getStart(sf)), offset: at.getStart(sf), text: snippet(at),
    });
  };

  /** The URL argument: a string, `new URL(path, base)`, or `new Request(url, init)`. */
  const urlArg = (e: ts.Expression | undefined): { url: StrVal; base?: StrVal; urlConstructor?: boolean; init?: ts.Expression } => {
    if (!e) return { url: dyn("(missing)") };
    const u = unwrap(e);
    if (ts.isNewExpression(u) && ts.isIdentifier(u.expression)) {
      if (u.expression.text === "URL" && u.arguments?.length) {
        return { url: strOf(u.arguments[0]), base: u.arguments[1] ? strOf(u.arguments[1]) : undefined, urlConstructor: true };
      }
      if (u.expression.text === "Request" && u.arguments?.length) {
        return { ...urlArg(u.arguments[0]), init: u.arguments[1] };
      }
    }
    return { url: strOf(u) };
  };

  const methodFrom = (init: ts.Expression | undefined, dflt: string): { method?: string; note?: string } => {
    const o = init && objectOf(init);
    if (init && !o) return { method: undefined, note: `options ${collapse(init.getText(sf)).slice(0, 40)} not readable` };
    const m = o && propOf(o, "method");
    if (!m) return { method: dflt };
    const t = literal(strOf(m));
    return t !== undefined ? { method: t.toUpperCase() } : { method: undefined, note: `method ${collapse(m.getText(sf))} computed` };
  };

  const fromConfig = (adapter: string, cfg: ts.Expression | undefined, at: ts.Node, base?: StrVal, dfltUrl?: ts.Expression) => {
    const o = cfg && objectOf(cfg);
    const urlE = (o && propOf(o, "url")) ?? dfltUrl;
    if (!urlE) return;
    const b = o && propOf(o, "baseURL");
    const m = methodFrom(cfg, "GET");
    addClient(adapter, m.method, strOf(urlE), at, { base: b ? strOf(b) : base, methodNote: m.note });
  };

  const isFetch = (c: ts.Expression): string | undefined => {
    if (ts.isIdentifier(c)) {
      if (c.text === "fetch" || c.text === "$fetch" || c.text === "ofetch") {
        const d = declOf(c);
        if (!d) return c.text === "fetch" ? "fetch" : "ofetch";
        if (isImportDecl(d) && isLib(c.text, ...FETCH_LIBS)) return c.text === "fetch" ? "fetch" : "ofetch";
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(c) && c.name.text === "fetch" && /^(window|globalThis|self)$/.test(c.expression.getText(sf))) return "fetch";
    return undefined;
  };

  const mountChild = (e: ts.Expression): NameRef | undefined => {
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return { local: u.text, path: [] };
    if (ts.isCallExpression(u)) {
      const spec = requireSpec(u);
      if (spec) {
        const local = `require@${u.getStart(sf)}`;
        facts.imports.set(local, { spec, imported: "cjs", line: lineOf(u.getStart(sf)) });
        return { local, path: [] };
      }
      // koa: app.use(router.routes())
      const c = unwrap(u.expression);
      if (ts.isPropertyAccessExpression(c) && (c.name.text === "routes" || c.name.text === "middleware")) return mountChild(c.expression);
      return undefined;
    }
    if (ts.isPropertyAccessExpression(u)) {
      const ch = memberChain(u);
      if (ch && ts.isIdentifier(ch.root)) return { local: ch.root.text, path: ch.path };
    }
    if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) {
      const local = `fn:@${u.getStart(sf)}`;
      return facts.routers.has(local) ? { local, path: [] } : undefined;
    }
    return undefined;
  };

  const onCall = (n: ts.CallExpression) => {
    const c = unwrap(n.expression);
    const args = n.arguments;

    // Direct calls, for following a flow through the code between services.
    if (ts.isIdentifier(c)) {
      facts.calls.push({ offset: c.getStart(sf), line: lineOf(c.getStart(sf)), form: "bare", name: c.text, text: snippet(n) });
    } else if (ts.isPropertyAccessExpression(c)) {
      const obj = unwrap(c.expression);
      if (obj.kind === ts.SyntaxKind.ThisKeyword) {
        facts.calls.push({ offset: c.name.getStart(sf), line: lineOf(c.getStart(sf)), form: "this", name: c.name.text, text: snippet(n) });
      } else if (ts.isPropertyAccessExpression(obj) && obj.expression.kind === ts.SyntaxKind.ThisKeyword) {
        facts.calls.push({ offset: c.name.getStart(sf), line: lineOf(c.getStart(sf)), form: "thisProp", name: c.name.text, recv: obj.name.text, text: snippet(n) });
      } else if (ts.isIdentifier(obj)) {
        facts.calls.push({ offset: c.name.getStart(sf), line: lineOf(c.getStart(sf)), form: "member", name: c.name.text, recv: obj.text, text: snippet(n) });
      }
    }
    if (!analysed) return;

    const f = isFetch(c);
    if (f) {
      const a = urlArg(args[0]);
      const m = methodFrom(args[1] ?? a.init, "GET");
      addClient(f, m.method, a.url, n, { base: a.base, urlConstructor: a.urlConstructor, methodNote: m.note });
      return;
    }
    if (ts.isIdentifier(c)) {
      const r = recvOf(c);
      // axios(config) / axios(url, config), and the same on an instance.
      if (r?.k === "axios-module" || (r?.k === "instance" && r.lib === "axios")) {
        const base = r.k === "instance" ? r.base : undefined;
        if (args[0] && objectOf(args[0])) fromConfig("axios", args[0], n, base);
        else if (args[0]) fromConfig("axios", args[1], n, base, args[0]);
        return;
      }
      // registerRoutes(app): a function whose first parameter is a router, handed the app.
      if (args[0]) {
        const a0 = recvOf(args[0]);
        if (a0?.k === "router") facts.mounts.push({ lib: "call", parent: a0.local, prefix: lit(""), child: { local: c.text, path: [] }, line: lineOf(n.getStart(sf)) });
      }
      return;
    }
    if (!ts.isPropertyAccessExpression(c)) return;
    const m = c.name.text;
    const recvExpr = unwrap(c.expression);

    // router.route("/x").get(h).post(h2): walk down the chain to the .route() call.
    if (ROUTE_VERBS.has(m) && ts.isCallExpression(recvExpr)) {
      let root: ts.Expression = recvExpr;
      while (ts.isCallExpression(root)) {
        const callee = unwrap(root.expression);
        if (!ts.isPropertyAccessExpression(callee) || !ROUTE_VERBS.has(callee.name.text)) break;
        root = unwrap(callee.expression);
      }
      const routeCallee = ts.isCallExpression(root) ? unwrap(root.expression) : undefined;
      if (routeCallee && ts.isPropertyAccessExpression(routeCallee) && routeCallee.name.text === "route") {
        const r = recvOf(routeCallee.expression);
        if (r?.k === "router") {
          addRoute(facts.routers.get(r.local)?.lib ?? "express", m.toUpperCase(), (root as ts.CallExpression).arguments[0],
            { local: r.local, path: [] }, handlerOf(args[args.length - 1]), n);
        }
        return;
      }
    }

    // medusa-js: `this.client.request("GET", path)` in a resource class, or
    // `medusa.client.request(…)` — only in a file that imports @medusajs/medusa-js.
    if (m === "request" && args.length >= 2 && ts.isPropertyAccessExpression(recvExpr) && recvExpr.name.text === "client" &&
        fileMentions("@medusajs/medusa-js")) {
      const verb = literal(strOf(args[0]))?.toUpperCase();
      if (verb && VERBS.has(verb.toLowerCase())) {
        addClient("medusa-js", verb, strOf(args[1]), n, {
          methodNote: "the client's baseUrl is set where the Medusa client is created",
        });
        return;
      }
    }

    const r = recvOf(recvExpr);
    if (m === "listen") {
      const p = portOf(args[0]);
      if (p) facts.ports.push({ ...p, line: lineOf(n.getStart(sf)) });
    }
    if (m === "setGlobalPrefix" && args[0]) {
      const o = args[1] && objectOf(args[1]);
      facts.globalPrefix.push({
        value: strOf(args[0]),
        line: lineOf(n.getStart(sf)),
        note: o && propOf(o, "exclude") ? "some routes are excluded from the global prefix (exclude option)" : undefined,
      });
    }
    if (m === "enableVersioning") facts.notes.push(`${where(n)}: enableVersioning — versioned NestJS routes get a version segment not modelled here`);
    if (!r) {
      if (VERBS.has(m) && args[0] && ts.isStringLiteralLike(unwrap(args[0])) && /^\//.test((unwrap(args[0]) as ts.StringLiteral).text)) {
        if (facts.unproven.length < 50) facts.unproven.push({ line: lineOf(n.getStart(sf)), text: snippet(n) });
      }
      return;
    }

    switch (r.k) {
      case "router": {
        const lib = facts.routers.get(r.local)?.lib ?? "express";
        if (ROUTE_VERBS.has(m) && args.length >= 2) {
          addRoute(lib, m.toUpperCase(), args[0], { local: r.local, path: [] }, handlerOf(args[args.length - 1]), n);
        } else if (m === "route" && lib === "fastify" && args[0]) {
          // fastify.route({ method, url, handler })
          const o = objectOf(args[0]);
          const url = o && (propOf(o, "url") ?? propOf(o, "path"));
          if (o && url) {
            const me = propOf(o, "method");
            const methods = me ? strsOf(me).map((v) => literal(v)?.toUpperCase() ?? "ALL") : ["GET"];
            for (const mm of methods) addRoute(lib, mm, url, { local: r.local, path: [] }, handlerOf(propOf(o, "handler")), n);
          }
        } else if (m === "use") {
          const first = args[0] && unwrap(args[0]);
          const hasPrefix = !!first && (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first) ||
            (ts.isIdentifier(first) && !recvOf(first) && literal(strOf(first)) !== undefined));
          const prefix = hasPrefix ? strOf(first!) : lit("");
          for (const a of hasPrefix ? args.slice(1) : args) {
            const child = mountChild(a);
            if (child) facts.mounts.push({ lib, parent: r.local, prefix, child, line: lineOf(n.getStart(sf)) });
          }
        } else if (m === "register" && args[0]) {
          const o = args[1] && objectOf(args[1]);
          const p = o && propOf(o, "prefix");
          const child = mountChild(args[0]);
          if (child) facts.mounts.push({ lib, parent: r.local, prefix: p ? strOf(p) : lit(""), child, line: lineOf(n.getStart(sf)) });
        }
        return;
      }
      case "axios-module":
      case "instance": {
        const adapter = r.k === "axios-module" ? "axios" : r.lib;
        const base = r.k === "instance" ? r.base : undefined;
        if (VERBS.has(m) && args[0]) {
          addClient(adapter, m.toUpperCase(), strOf(args[0]), n, { base, methodNote: r.k === "instance" ? r.note : undefined });
        } else if (m === "request" && args[0]) {
          fromConfig(adapter, args[0], n, base);
        }
        return;
      }
      case "nest-client":
        if ((m === "send" || m === "emit") && args[0]) {
          facts.sends.push({
            adapter: "nest-microservices", kind: m === "send" ? "rpc" : "event", keys: keysOf(args[0]),
            line: lineOf(n.getStart(sf)), offset: n.getStart(sf), text: snippet(n),
          });
        }
        return;
      case "emitter2":
        if ((m === "emit" || m === "emitAsync") && args[0]) {
          facts.sends.push({
            adapter: "nest-event-emitter", kind: "event", keys: keysOf(args[0]),
            line: lineOf(n.getStart(sf)), offset: n.getStart(sf), text: snippet(n),
          });
        }
        return;
      case "producer": {
        const o = args[0] && objectOf(args[0]);
        if (m === "send" && o) {
          const t = propOf(o, "topic");
          if (t) facts.sends.push({
            adapter: "kafkajs", kind: "event", keys: keysOf(t), brokers: kafkaBrokersOf(r.kafkaVar),
            line: lineOf(n.getStart(sf)), offset: n.getStart(sf), text: snippet(n),
          });
        } else if (m === "sendBatch" && o) {
          const tm = propOf(o, "topicMessages");
          const arr = tm && unwrap(tm);
          const keys = arr && ts.isArrayLiteralExpression(arr)
            ? arr.elements.flatMap((x) => {
                const xo = objectOf(x);
                const t = xo && propOf(xo, "topic");
                return t ? keysOf(t) : [];
              })
            : [];
          if (keys.length) facts.sends.push({
            adapter: "kafkajs", kind: "event", keys, brokers: kafkaBrokersOf(r.kafkaVar),
            line: lineOf(n.getStart(sf)), offset: n.getStart(sf), text: snippet(n),
          });
        }
        return;
      }
      case "consumer": {
        const o = args[0] && objectOf(args[0]);
        if (m === "subscribe" && o) {
          const t = propOf(o, "topic") ?? propOf(o, "topics");
          if (t) facts.handlers.push({
            adapter: "kafkajs", kind: "event", keys: keysOf(t), handler: { k: "self", offset: n.getStart(sf) },
            consumerVar: r.varKey || collapse(recvExpr.getText(sf)), brokers: kafkaBrokersOf(r.kafkaVar), group: r.group,
            line: lineOf(n.getStart(sf)), offset: n.getStart(sf),
          });
        } else if (m === "run" && o) {
          const h = propOf(o, "eachMessage") ?? propOf(o, "eachBatch");
          if (h) consumerRuns.set(r.varKey || collapse(recvExpr.getText(sf)), handlerOf(h));
        }
        return;
      }
      case "imported":
        if (VERBS.has(m) && args[0]) {
          const url = strOf(args[0]);
          if (url.parts.some((p) => p.k === "lit" && p.v.startsWith("/")) || literal(url) !== undefined) {
            facts.pending.push({
              recv: r.ref, verb: m, url, handler: args.length >= 2 ? handlerOf(args[args.length - 1]) : undefined,
              line: lineOf(n.getStart(sf)), offset: n.getStart(sf), text: snippet(n),
            });
          }
        } else if (m === "use" || m === "register") {
          // A router imported from another file, mounting something: rare; not modelled.
        }
        return;
      default:
        return;
    }
  };

  const portOf = (e: ts.Expression | undefined): { port: number; note?: string } | undefined => {
    if (!e) return undefined;
    const u = unwrap(e);
    if (ts.isNumericLiteral(u)) return { port: Number(u.text) };
    const o = objectOf(u);
    if (o) return portOf(propOf(o, "port"));
    if (ts.isBinaryExpression(u) && (u.operatorToken.kind === ts.SyntaxKind.BarBarToken || u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      const r = portOf(u.right);
      return r ? { port: r.port, note: `default when ${collapse(u.left.getText(sf))} is unset` } : undefined;
    }
    if (ts.isIdentifier(u)) {
      const t = literal(strOf(u));
      if (t !== undefined && /^\d+$/.test(t)) return { port: Number(t) };
      const d = declOf(u);
      const init = d && constInit(d);
      return init ? portOf(init) : undefined;
    }
    if (ts.isCallExpression(u) && ts.isIdentifier(u.expression) && /^(Number|parseInt)$/.test(u.expression.text)) return portOf(u.arguments[0]);
    return undefined;
  };

  const decoratorsOf = (n: ts.Node): Array<{ name: string; args: readonly ts.Expression[]; node: ts.Decorator }> => {
    const ds = ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : [];
    const out: Array<{ name: string; args: readonly ts.Expression[]; node: ts.Decorator }> = [];
    for (const d of ds) {
      const e = d.expression;
      if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) out.push({ name: e.expression.text, args: e.arguments, node: d });
      else if (ts.isIdentifier(e)) out.push({ name: e.text, args: [], node: d });
    }
    return out;
  };

  const onClass = (cls: ts.ClassLikeDeclaration) => {
    const decs = decoratorsOf(cls);
    const ctrl = decs.find((d) => d.name === "Controller" && isLib("Controller", "@nestjs/common"));
    let controller: StrVal[] | undefined;
    if (ctrl) {
      const a = ctrl.args[0];
      const o = a && objectOf(a);
      controller = !a ? [lit("")] : o ? (propOf(o, "path") ? strsOf(propOf(o, "path")) : [lit("")]) : strsOf(a);
      if (o && propOf(o, "version")) facts.notes.push(`${where(cls)}: controller version ${collapse(propOf(o, "version")!.getText(sf))} — the version segment is not modelled`);
    }
    for (const m of cls.members) {
      if (!ts.isMethodDeclaration(m)) continue;
      const nameNode = m.name;
      for (const d of decoratorsOf(m)) {
        const http = NEST_ROUTE[d.name];
        if (http && controller && isLib(d.name, "@nestjs/common")) {
          addRoute("nestjs", http, d.args[0], undefined, { k: "self", offset: nameNode.getStart(sf) }, m, controller);
        } else if ((d.name === "MessagePattern" || d.name === "EventPattern") && isLib(d.name, "@nestjs/microservices") && d.args[0]) {
          facts.handlers.push({
            adapter: "nest-microservices", kind: d.name === "MessagePattern" ? "rpc" : "event", keys: keysOf(d.args[0]),
            handler: { k: "self", offset: nameNode.getStart(sf) }, line: lineOf(m.getStart(sf)), offset: m.getStart(sf),
          });
        } else if (d.name === "OnEvent" && isLib(d.name, "@nestjs/event-emitter") && d.args[0]) {
          facts.handlers.push({
            adapter: "nest-event-emitter", kind: "event", keys: keysOf(d.args[0]),
            handler: { k: "self", offset: nameNode.getStart(sf) }, line: lineOf(m.getStart(sf)), offset: m.getStart(sf),
          });
        } else if (d.name === "Version" && isLib(d.name, "@nestjs/common")) {
          facts.notes.push(`${where(m)}: @Version on ${m.name.getText(sf)} — the version segment is not modelled`);
        }
      }
    }
  };

  const pass2 = (n: ts.Node) => {
    if (ts.isCallExpression(n)) onCall(n);
    if (analysed && (ts.isClassDeclaration(n) || ts.isClassExpression(n))) onClass(n);
    ts.forEachChild(n, pass2);
  };
  ts.forEachChild(sf, pass2);

  // File-based routes: the file's location is the path, its exported HTTP-method functions the handlers.
  const fileRoute = analysed ? fileRouteOf(entry) : undefined;
  if (fileRoute) {
    for (const st of sf.statements) {
      const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
      const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const add = (method: string, nameNode: ts.Node) =>
        facts.routes.push({
          adapter: fileRoute.adapter, method, path: lit(fileRoute.path), absolute: true,
          handler: { k: "self", offset: nameNode.getStart(sf) }, line: lineOf(st.getStart(sf)), offset: st.getStart(sf),
        });
      if (fileRoute.pages) {
        if (ts.isExportAssignment(st)) add("ALL", st.expression);
        else if (ts.isFunctionDeclaration(st) && exported && isDefault) add("ALL", st.name ?? st);
        continue;
      }
      if (!exported) continue;
      if (ts.isFunctionDeclaration(st) && st.name && ROUTE_EXPORTS.has(st.name.text)) add(st.name.text, st.name);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && ROUTE_EXPORTS.has(d.name.text)) add(d.name.text, d.initializer ?? d.name);
        }
      }
    }
  }

  // A consumer's subscriptions are handled by its `run({ eachMessage })`.
  for (const h of facts.handlers) {
    if (h.adapter !== "kafkajs" || !h.consumerVar) continue;
    const run = consumerRuns.get(h.consumerVar);
    if (run) h.handler = run;
  }

  // `export default express.Router()` / `export default axios.create(…)`: the value is the export.
  for (const v of defaultValues) {
    const r = classify(v, "default", lineOf(v.getStart(sf)));
    void r;
  }
  return facts;
}

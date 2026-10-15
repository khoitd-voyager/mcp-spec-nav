/**
 * The shared model of static cross-service flow tracing.
 *
 * Everything here is read from source, never observed at runtime: a URL, a
 * topic or an RPC pattern is only as known as the code that builds it. So a
 * value is kept as the parts it was written with — literal text, an
 * environment variable, something computed — and every step that turned a
 * name into text is remembered, so the output can say how it knows.
 */

/** One piece of a string value as the source builds it. */
export type Part =
  | { k: "lit"; v: string }
  /** An environment variable: its value is configuration, not code. */
  | { k: "env"; name: string; fallback?: string }
  /** Anything else not known statically: a parameter, a call, a mutable variable. */
  | { k: "dyn"; text: string }
  /** A name imported from another file, resolved when files are linked. */
  | { k: "ref"; local: string; path: string[] };

export interface StrVal {
  parts: Part[];
  /** How names in it were resolved, with where: `API = "/api" (web/src/config.ts:1)`. */
  via: string[];
}

export function lit(v: string): StrVal {
  return { parts: [{ k: "lit", v }], via: [] };
}

export function dyn(text: string): StrVal {
  const t = text.replace(/\s+/g, " ").trim();
  return { parts: [{ k: "dyn", text: t.length > 60 ? t.slice(0, 59) + "…" : t }], via: [] };
}

export function env(name: string, fallback?: string): StrVal {
  return { parts: [{ k: "env", name, ...(fallback !== undefined ? { fallback } : {}) }], via: [] };
}

export function concat(...vals: StrVal[]): StrVal {
  const parts: Part[] = [];
  const via: string[] = [];
  for (const v of vals) {
    for (const p of v.parts) {
      if (p.k === "lit" && p.v === "") continue;
      const last = parts[parts.length - 1];
      if (p.k === "lit" && last?.k === "lit") parts[parts.length - 1] = { k: "lit", v: last.v + p.v };
      else parts.push(p);
    }
    for (const w of v.via) if (!via.includes(w)) via.push(w);
  }
  return { parts, via };
}

export function withVia(v: StrVal, note: string): StrVal {
  return { parts: v.parts, via: v.via.includes(note) ? v.via : [...v.via, note] };
}

/** The text, when every part is literal. */
export function literal(v: StrVal | undefined): string | undefined {
  if (!v || !v.parts.length) return v && !v.parts.length ? "" : undefined;
  return v.parts.every((p) => p.k === "lit") ? v.parts.map((p) => (p as { v: string }).v).join("") : undefined;
}

export function hasRefs(v: StrVal): boolean {
  return v.parts.some((p) => p.k === "ref");
}

/** As a reader would write it: `/api/orders/${id}`, `${env:ORDERS_URL}/orders`. */
export function show(v: StrVal): string {
  return v.parts
    .map((p) =>
      p.k === "lit" ? p.v
        : p.k === "env" ? `\${env:${p.name}}`
          : p.k === "ref" ? `\${${[p.local, ...p.path].join(".")}}`
            : `\${${p.text}}`,
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Per-file facts: what one file says, before any other file is consulted.

/** Where the function handling a route or message is. */
export type HandlerRef =
  /** A function written inline as the argument: its own extent. */
  | { k: "inline"; start: number; end: number; line: number }
  /** A name (`listOrders`, `ctrl.list`), resolved when files are linked. */
  | { k: "name"; local: string; path: string[]; line: number }
  /** The decorated function or method itself: the catalog function at this offset. */
  | { k: "self"; offset: number }
  /** Not determinable (a call that returns a handler, a spread…). */
  | { k: "unknown"; text: string };

/** A name in this file, or a name imported into it (`path` is the member chain). */
export interface NameRef {
  local: string;
  path: string[];
}

export type RouterKind = "app" | "router" | "plugin";

export interface RouterFact {
  /** Variable name, or `fn:<name>` for a Fastify plugin function's instance parameter. */
  local: string;
  kind: RouterKind;
  lib: string;
  /** A prefix the router itself carries: `new Router({ prefix })`, `APIRouter(prefix=…)`, `Blueprint(url_prefix=…)`. */
  prefix?: StrVal;
  line: number;
}

export interface RouteFact {
  adapter: string;
  /** Upper-case HTTP method, or "ALL". */
  method: string;
  path: StrVal;
  /** The router or app it is registered on (not set for NestJS). */
  router?: NameRef;
  /** NestJS: the controller's path(s). */
  controller?: StrVal[];
  /** File-based routing (Next.js, Medusa, SvelteKit): `path` is already the full path. */
  absolute?: boolean;
  handler: HandlerRef;
  line: number;
  offset: number;
}

export interface MountFact {
  lib: string;
  /** The router or app it is mounted on, by local name. */
  parent: string;
  prefix: StrVal;
  child: NameRef;
  /** Flask: a blueprint's own url_prefix is replaced, not extended, by the one given here. */
  replacesOwnPrefix?: boolean;
  line: number;
}

/** An HTTP client object with a base URL: `axios.create({ baseURL })`, `httpx.Client(base_url=…)`. */
export interface InstanceFact {
  local: string;
  lib: string;
  base?: StrVal;
  line: number;
}

export interface ClientFact {
  adapter: string;
  /** Upper-case, or undefined when the method itself is computed. */
  method?: string;
  methodNote?: string;
  url: StrVal;
  /** Base URL from the client instance, joined to `url` unless that is absolute. */
  base?: StrVal;
  /** `new URL(path, base)`: an absolute path keeps only the base's origin. */
  urlConstructor?: boolean;
  line: number;
  offset: number;
  text: string;
}

/**
 * A call on a name imported from another file — `api.get("/orders")` — that
 * is a client call if the name turns out to be an HTTP client instance, or a
 * route if it is a router. Decided when files are linked, from what the other
 * file exports.
 */
export interface PendingVerbFact {
  recv: NameRef;
  verb: string;
  url: StrVal;
  handler?: HandlerRef;
  line: number;
  offset: number;
  text: string;
}

/** An RPC pattern or topic. */
export type KeyVal =
  | { k: "str"; v: StrVal }
  /** NestJS object patterns: `{ cmd: "sum" }`, compared as canonical JSON. */
  | { k: "obj"; entries: Array<[string, StrVal]> }
  /** kafkajs `subscribe({ topic: /orders\..*\/ })`. */
  | { k: "regex"; source: string; flags: string };

export interface MsgHandlerFact {
  adapter: string;
  kind: "rpc" | "event";
  keys: KeyVal[];
  handler: HandlerRef;
  /** kafkajs: the consumer variable, to join `subscribe` with `run`. */
  consumerVar?: string;
  brokers?: StrVal[];
  group?: StrVal;
  line: number;
  offset: number;
}

export interface MsgSendFact {
  adapter: string;
  kind: "rpc" | "event";
  keys: KeyVal[];
  brokers?: StrVal[];
  line: number;
  offset: number;
  text: string;
}

/** A direct call, as written: resolved to a function only on evidence. */
export interface CallFact {
  offset: number;
  line: number;
  /** `foo()`, `this.foo()` / `self.foo()`, `this.dep.foo()` / `self.dep.foo()`, `X.foo()`. */
  form: "bare" | "this" | "thisProp" | "member";
  name: string;
  recv?: string;
  text: string;
}

export interface ImportFact {
  /** Module specifier as written; Python relative imports keep their leading dots. */
  spec: string;
  /**
   * The name imported: a name, "default", "*" for the module itself, or "cjs"
   * for `require()` — the module.exports value, whose members are the named exports.
   */
  imported: string;
  line: number;
}

export interface FileFacts {
  rel: string;
  service: string;
  language: string;
  stamp: string;
  /** "ts" or "python": the family whose adapters read it. */
  family: "ts" | "python";
  /** The file matched the communication prefilter, so its communication facts count. */
  analysed: boolean;
  parseError?: string;

  imports: Map<string, ImportFact>;
  /** Exported constant strings, flattened: `API`, `ROUTES.orders`, `Topics.OrderCreated`. */
  consts: Map<string, StrVal & { line: number }>;
  /** Exported name → local name, for names exported under another name (`export { a as b }`, `module.exports = x`). */
  exportAs: Map<string, string>;
  /** `export … from "x"`: names (or every name) re-exported from another module. */
  reexports: Array<{ spec: string; names?: Map<string, string> }>;
  /** Exported or module-level classes: name → property name → declared type. */
  classes: Map<string, { props: Map<string, string>; line: number }>;
  /** `const svc = new OrdersService()` → svc → OrdersService ("" when assigned more than one class). */
  newVars: Map<string, string>;
  /**
   * Variables and parameters with a declared type: `svc: OrdersService`, `x as OrdersService`,
   * `container.resolve<OrdersService>(…)` ("" when the name has several types in the file).
   */
  varTypes: Map<string, string>;
  calls: CallFact[];

  routers: Map<string, RouterFact>;
  routes: RouteFact[];
  mounts: MountFact[];
  instances: Map<string, InstanceFact>;
  clients: ClientFact[];
  pending: PendingVerbFact[];
  handlers: MsgHandlerFact[];
  sends: MsgSendFact[];
  /** Ports a server in this file listens on, as written. */
  ports: Array<{ port: number; line: number; note?: string }>;
  /** NestJS `app.setGlobalPrefix(…)`. */
  globalPrefix: Array<{ value: StrVal; line: number; note?: string }>;
  /** kafkajs `new Kafka({ brokers })`, per variable. */
  kafka: Map<string, { brokers?: StrVal[]; line: number }>;
  /** Things a reader should know that do not fit elsewhere (`@Version`, `enableVersioning`). */
  notes: string[];
  /**
   * Calls that look like HTTP (`x.get("/orders", …)`) on an object no adapter
   * could identify. Not traced — counted, so a gap is visible.
   */
  unproven: Array<{ line: number; text: string }>;
}

export function emptyFacts(
  base: Pick<FileFacts, "rel" | "service" | "language" | "stamp" | "family" | "analysed">,
): FileFacts {
  return {
    ...base,
    imports: new Map(),
    consts: new Map(),
    exportAs: new Map(),
    reexports: [],
    classes: new Map(),
    newVars: new Map(),
    varTypes: new Map(),
    calls: [],
    routers: new Map(),
    routes: [],
    mounts: [],
    instances: new Map(),
    clients: [],
    pending: [],
    handlers: [],
    sends: [],
    ports: [],
    globalPrefix: [],
    kafka: new Map(),
    notes: [],
    unproven: [],
  };
}

export const HTTP_VERBS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

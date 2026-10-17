import { readFileSync, existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, RepoScan, fingerprint } from "../project.js";
import { catalogFile } from "../catalog.js";
import {
  FileFacts,
  StrVal,
  HandlerRef,
  KeyVal,
  RouteFact,
  ClientFact,
  Part,
  concat,
  lit,
  literal,
  show,
} from "./model.js";
import { Repo, analysedFacts, pruneCache, resolveRef, resolveStr, familyOf } from "./facts.js";

/**
 * Linking: per-file facts become endpoints (routes, RPC handlers, event
 * consumers) and communication edges (a client call, an RPC call or an event
 * sent, joined to the endpoints that receive it).
 *
 * A link is made on the communication key — HTTP method and path, RPC
 * pattern, topic — and narrowed by whatever pins the other side down: the
 * host in a URL matched to a service (docker-compose service name, project
 * directory or package name, listening port), the broker a Kafka client is
 * configured with. A name alone is never enough when several services or
 * brokers could be meant: that is reported as ambiguous, with the
 * candidates, and not followed.
 */

export type Resolution = "resolved" | "partial" | "ambiguous" | "unresolved" | "unmatched";
export type Confidence = "high" | "medium" | "low" | "none";

/** A piece of code a flow passes through: a catalogued function, an inline handler, or a file's top level. */
export interface Unit {
  key: string;
  file: string;
  service: string;
  line: number;
  label: string;
  /** Function id, for spec_nav_read_function. */
  id?: string;
  start: number;
  end: number;
  inline?: boolean;
}

/** A segment of a route template. */
export type RSeg = { t: "lit"; v: string } | { t: "param"; name: string } | { t: "rest"; name: string };

export interface Endpoint {
  uid: string;
  protocol: "http" | "rpc" | "event";
  adapter: string;
  /** What a sender must use to reach it: `http`, `nest-microservices:rpc`, `kafkajs`… */
  channel: string;
  method?: string;
  display: string;
  segs?: RSeg[];
  /** The route's path is computed: it cannot be matched. */
  pathDynamic?: boolean;
  /** The router is not mounted anywhere visible: the route's full path is not known. */
  prefixUnknown?: boolean;
  key?: string;
  /** Wildcard or regex handlers. */
  pattern?: RegExp;
  service: string;
  file: string;
  line: number;
  handler?: Unit;
  handlerNote?: string;
  evidence: string[];
  brokers?: string;
}

export interface CommEdge {
  kind: "http" | "rpc" | "event";
  adapter: string;
  /** What the code sends, as resolved: `GET /api/orders/${id}`, `event order.created`. */
  call: string;
  /** RPC pattern or topic, when known (canonical JSON for object patterns). */
  key?: string;
  source: Unit;
  site: { file: string; line: number; text: string; offset: number };
  targets: Endpoint[];
  candidates: Endpoint[];
  resolution: Resolution;
  confidence: Confidence;
  evidence: string[];
  reason?: string;
}

export interface FlowCoverage {
  filesAnalysed: { ts: number; python: number };
  parseErrors: string[];
  adapters: Map<string, { routes: number; clients: number; handlers: number; sends: number }>;
  unproven: { count: number; samples: string[] };
  droppedRoutes: { count: number; samples: string[] };
  unmounted: string[];
  dynamicRoutes: string[];
  noAdapter: Map<string, number>;
  notes: string[];
  composeFiles: string[];
  /** HTTP client calls that matched no route in the repo (not counting external hosts). */
  unmatchedClients: { count: number; total: number };
}

export interface Graph {
  fingerprint: string;
  repo: Repo;
  endpoints: Endpoint[];
  edges: CommEdge[];
  inline: Map<string, Array<{ start: number; end: number; line: number }>>;
  coverage: FlowCoverage;
}

// ---------------------------------------------------------------------------
// Units.

export async function unitAt(repo: Repo, inline: Graph["inline"], rel: string, offset: number): Promise<Unit> {
  const e = repo.entry(rel);
  let best: { start: number; end: number; unit: () => Unit } | undefined;
  if (e) {
    for (const f of (await catalogFile(e)).functions) {
      if (f.startOffset <= offset && offset < f.endOffset && (!best || f.endOffset - f.startOffset < best.end - best.start)) {
        best = { start: f.startOffset, end: f.endOffset, unit: () => fnUnit(f.rec, f.startOffset, f.endOffset) };
      }
    }
  }
  for (const s of inline.get(rel) ?? []) {
    if (s.start <= offset && offset < s.end && (!best || s.end - s.start < best.end - best.start)) {
      best = { start: s.start, end: s.end, unit: () => inlineUnit(rel, e?.service ?? ".", s) };
    }
  }
  if (best) return best.unit();
  return { key: `${rel}#top`, file: rel, service: e?.service ?? ".", line: 1, label: "<top level>", start: 0, end: Number.MAX_SAFE_INTEGER };
}

export function fnUnit(rec: { id: string; file: string; service: string; start: number; name: string }, start: number, end: number): Unit {
  return { key: rec.id, id: rec.id, file: rec.file, service: rec.service, line: rec.start, label: rec.name, start, end };
}

function inlineUnit(rel: string, service: string, s: { start: number; end: number; line: number }): Unit {
  return { key: `${rel}@${s.start}`, file: rel, service, line: s.line, label: "<inline handler>", start: s.start, end: s.end, inline: true };
}

// ---------------------------------------------------------------------------
// Paths.

/** Route template segments; undefined when the path is computed. */
export function routeSegs(v: StrVal): RSeg[] | undefined {
  const t = literal(v);
  if (t === undefined) return undefined;
  const out: RSeg[] = [];
  for (const raw of t.split("?")[0].split("/")) {
    if (!raw) continue;
    let m: RegExpMatchArray | null;
    if (raw === "*" || raw === "**" || raw === "(.*)" || /^\*\w*$/.test(raw)) out.push({ t: "rest", name: raw });
    else if ((m = raw.match(/^:(\w+)\??(\(.*\))?$/))) out.push({ t: "param", name: m[1] });
    else if ((m = raw.match(/^\{(\w+)(?::path)\}$/))) out.push({ t: "rest", name: m[1] });
    else if ((m = raw.match(/^\{(\w+)(?::[^}]*)?\}$/))) out.push({ t: "param", name: m[1] });
    else if ((m = raw.match(/^<path:(\w+)>$/))) out.push({ t: "rest", name: m[1] });
    else if ((m = raw.match(/^<(?:\w+:)?(\w+)>$/))) out.push({ t: "param", name: m[1] });
    else out.push({ t: "lit", v: raw });
  }
  return out;
}

export function segsDisplay(segs: RSeg[]): string {
  return "/" + segs.map((s) => (s.t === "lit" ? s.v : s.t === "param" ? `:${s.name}` : "*")).join("/");
}

/** A segment of a client URL: literal text, or a pattern where parts are computed. */
export interface CSeg {
  lit?: string;
  re?: RegExp;
  text: string;
}

export interface UrlInfo {
  host?: string;
  /** The URL starts with something unknown (an environment variable, a computed base). */
  base?: { text: string; env?: string; fallback?: string };
  segs: CSeg[];
  unresolved?: string;
}

const PH = "\u0000";

export function analyseUrl(v: StrVal): UrlInfo {
  // Literal text with each unknown part as a numbered placeholder.
  const unknown: Part[] = [];
  let s = "";
  for (const p of v.parts) {
    if (p.k === "lit") s += p.v;
    else {
      s += `${PH}${unknown.length}${PH}`;
      unknown.push(p);
    }
  }
  // The query string and fragment do not select a route.
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  const describe = (p: Part) => (p.k === "env" ? `env ${p.name}` : p.k === "dyn" ? p.text : p.k === "ref" ? p.local : "");
  let host: string | undefined;
  let base: UrlInfo["base"];
  let rest = s;
  const abs = s.match(/^(?:https?:)?\/\/([^/]*)(.*)$/i);
  if (abs) {
    if (abs[1].includes(PH)) {
      const i = Number(abs[1].split(PH)[1]);
      const p = unknown[i];
      base = { text: `host ${describe(p)}`, ...(p.k === "env" ? { env: p.name, fallback: p.fallback } : {}) };
    } else {
      host = abs[1].toLowerCase();
    }
    rest = abs[2];
  } else if (s.startsWith(PH)) {
    // ${BASE}/orders: the base is unknown, the rest is a path.
    const m = s.match(new RegExp(`^${PH}(\\d+)${PH}(.*)$`, "s"))!;
    const p = unknown[Number(m[1])];
    rest = m[2];
    if (p.k === "env") base = { text: `env ${p.name}`, env: p.name, fallback: p.fallback };
    else base = { text: describe(p) };
    if (rest && !rest.startsWith("/")) {
      return { segs: [], unresolved: `the URL is built from ${describe(p)} followed by "${rest.replace(new RegExp(`${PH}\\d+${PH}`, "g"), "…")}" — no path can be read` };
    }
    if (!rest.replace(new RegExp(`${PH}\\d+${PH}`, "g"), "").replace(/\//g, "")) {
      return { segs: [], base, unresolved: `the URL is entirely computed (${describe(p)})` };
    }
  } else if (!s.startsWith("/")) {
    return { segs: [], unresolved: s ? `relative URL "${s.replace(new RegExp(`${PH}\\d+${PH}`, "g"), "…")}" without a leading "/" (relative to the current page)` : "empty URL" };
  }
  const segs: CSeg[] = [];
  for (const raw of rest.split("/")) {
    if (!raw) continue;
    if (!raw.includes(PH)) {
      segs.push({ lit: raw, text: raw });
      continue;
    }
    const pieces = raw.split(PH);
    let re = "";
    let text = "";
    pieces.forEach((piece, i) => {
      if (i % 2 === 0) {
        re += piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text += piece;
      } else {
        re += "[^/]+";
        text += `\${${describe(unknown[Number(piece)])}}`;
      }
    });
    segs.push({ re: new RegExp(`^${re}$`), text });
  }
  return { host, base, segs };
}

interface SegMatch {
  /** Client segments computed where the route has fixed text: possible, not shown. */
  weak: number;
  exact: number;
}

function matchSegs(client: CSeg[], route: RSeg[]): SegMatch | undefined {
  let weak = 0;
  let exact = 0;
  for (let i = 0; i < route.length; i++) {
    const r = route[i];
    if (r.t === "rest") return { weak, exact };
    const c = client[i];
    if (!c) return undefined;
    if (r.t === "param") continue;
    if (c.lit !== undefined) {
      if (c.lit !== r.v) return undefined;
      exact++;
    } else if (c.re!.test(r.v)) weak++;
    else return undefined;
  }
  return client.length === route.length ? { weak, exact } : undefined;
}

/**
 * The route's tail against the client's whole path: for a client whose base
 * path is unknown. Only on strong text — every fixed segment of the client
 * equal to a fixed segment of the route, at least two of them — since a short
 * tail like `/oauth/token`, or one that lands on route parameters, is as likely
 * an external API as this one.
 */
function matchSuffix(client: CSeg[], route: RSeg[]): SegMatch | undefined {
  const fixed = client.filter((c) => c.lit !== undefined).length;
  if (route.some((r) => r.t === "rest") || route.length < client.length || fixed < 2) return undefined;
  const m = matchSegs(client, route.slice(route.length - client.length));
  return m && m.exact === fixed ? m : undefined;
}

// ---------------------------------------------------------------------------
// Services: which one a host names.

interface ComposeService {
  name: string;
  dir?: string;
  ports: number[];
  aliases: string[];
  file: string;
  line: number;
}

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

/**
 * The `services:` block of a compose file: names, build directories, ports.
 * Only that subset of YAML, read by indentation — enough to tie a hostname in
 * a URL to the directory it is built from.
 */
function readCompose(file: string): ComposeService[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
  const lines = text.split("\n");
  const out: ComposeService[] = [];
  const indentOf = (l: string) => l.match(/^ */)![0].length;
  const unq = (v: string) => v.trim().replace(/^["']|["']$/g, "");
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (start < 0) return out;
  let svcIndent = -1;
  let keyIndent = -1;
  let cur: ComposeService | undefined;
  let inKey: string | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].replace(/\s+#.*$/, "");
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = indentOf(l);
    if (ind === 0) break;
    if (svcIndent < 0) svcIndent = ind;
    const t = l.trim();
    if (ind === svcIndent) {
      const m = t.match(/^["']?([\w.-]+)["']?:\s*$/);
      cur = m ? { name: m[1], ports: [], aliases: [], file: rel, line: i + 1 } : undefined;
      if (cur) out.push(cur);
      keyIndent = -1;
      inKey = undefined;
      continue;
    }
    if (!cur || ind < svcIndent) continue;
    if (keyIndent < 0) keyIndent = ind;
    if (ind === keyIndent) {
      const kv = t.match(/^([\w-]+):\s*(.*)$/);
      inKey = kv?.[1];
      const val = kv ? unq(kv[2]) : "";
      if (inKey === "build" && val) cur.dir = val;
      if ((inKey === "container_name" || inKey === "hostname") && val) cur.aliases.push(val);
      continue;
    }
    if (inKey === "build") {
      const c = t.match(/^context:\s*(.+)$/);
      if (c) cur.dir = unq(c[1]);
    } else if (inKey === "ports" || inKey === "expose") {
      const item = t.match(/^-\s*(.+)$/);
      if (!item) continue;
      const parts = unq(item[1]).split("/")[0].split(":");
      // "host:container", "ip:host:container", or a single port.
      const hostPort = parts.length === 3 ? parts[1] : parts[0];
      if (/^\d+$/.test(hostPort)) cur.ports.push(Number(hostPort));
    }
  }
  for (const s of out) {
    if (s.dir) s.dir = path.relative(REPO_ROOT, path.resolve(path.dirname(file), s.dir)).split(path.sep).join("/") || ".";
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const stripSuffix = (s: string) => s.replace(/(service|svc|server|api|app|backend)$/, "");

interface HostPin {
  service?: string;
  evidence: string[];
  conflict?: string;
}

class ServiceMap {
  private names = new Map<string, Array<{ service: string; why: string }>>();
  private ports = new Map<number, Array<{ service: string; why: string }>>();
  readonly compose: ComposeService[] = [];

  constructor(private readonly scan: RepoScan, servicePorts: Map<string, Array<{ port: number; where: string; note?: string }>>) {
    const add = <K>(m: Map<K, Array<{ service: string; why: string }>>, k: K, service: string, why: string) => {
      const list = m.get(k) ?? [];
      if (!list.some((x) => x.service === service)) list.push({ service, why });
      m.set(k, list);
    };
    for (const s of scan.services) {
      if (s === ".") continue;
      add(this.names, norm(path.basename(s)), s, `project directory ${s}`);
      const pj = path.join(REPO_ROOT, s, "package.json");
      if (existsSync(pj)) {
        try {
          const name = JSON.parse(readFileSync(pj, "utf8")).name;
          if (typeof name === "string" && name) add(this.names, norm(name.replace(/^@[^/]+\//, "")), s, `package name ${name}`);
        } catch {
          /* not JSON */
        }
      }
    }
    for (const f of COMPOSE_FILES) {
      const abs = path.join(REPO_ROOT, f);
      if (existsSync(abs) && statSync(abs).isFile()) this.compose.push(...readCompose(abs));
    }
    for (const c of this.compose) {
      const svc = c.dir ? this.serviceOfDir(c.dir) : undefined;
      if (!svc) continue;
      const why = `docker-compose service "${c.name}" builds ${c.dir} (${c.file}:${c.line})`;
      for (const n of [c.name, ...c.aliases]) add(this.names, `compose:${n.toLowerCase()}`, svc, why);
      for (const p of c.ports) add(this.ports, p, svc, `${why}, port ${p}`);
    }
    for (const [service, ps] of servicePorts) {
      for (const p of ps) add(this.ports, p.port, service, `listens on ${p.port} (${p.where}${p.note ? `, ${p.note}` : ""})`);
    }
  }

  /** The innermost project containing `dir`. */
  serviceOfDir(dir: string): string | undefined {
    let best: string | undefined;
    for (const s of this.scan.services) {
      if (s === ".") continue;
      if ((dir === s || dir.startsWith(s + "/")) && (!best || s.length > best.length)) best = s;
    }
    return best;
  }

  pin(host: string): HostPin {
    const [hostname, portText] = host.split(":");
    const port = portText ? Number(portText) : undefined;
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(hostname);
    const byName = local ? [] : this.byName(hostname);
    const byPort = port !== undefined ? this.ports.get(port) ?? [] : [];
    if (byName.length === 1) {
      const n = byName[0];
      if (port !== undefined && byPort.length && !byPort.some((p) => p.service === n.service)) {
        return { evidence: [], conflict: `host "${hostname}" names ${n.service} (${n.why}) but port ${port} is ${byPort.map((p) => p.service).join(", ")}` };
      }
      return { service: n.service, evidence: [`host "${host}" → ${n.service}: ${n.why}`] };
    }
    if (byName.length > 1) return { evidence: [], conflict: `host "${hostname}" could be ${byName.map((b) => b.service).join(" or ")}` };
    if ((local || !hostname) && byPort.length === 1) return { service: byPort[0].service, evidence: [`host "${host}" → ${byPort[0].service}: ${byPort[0].why}`] };
    if (byPort.length > 1) return { evidence: [], conflict: `port ${port} is used by ${byPort.map((p) => p.service).join(" and ")}` };
    return { evidence: [] };
  }

  private byName(hostname: string): Array<{ service: string; why: string }> {
    const h = hostname.toLowerCase();
    const compose = this.names.get(`compose:${h}`) ?? this.names.get(`compose:${h.split(".")[0]}`);
    if (compose?.length) return compose;
    const first = norm(h.split(".")[0]);
    const exact = this.names.get(first);
    if (exact?.length) return exact;
    const stripped = stripSuffix(first);
    if (stripped.length < 3) return [];
    const out: Array<{ service: string; why: string }> = [];
    for (const [k, v] of this.names) {
      if (k.startsWith("compose:")) continue;
      if (stripSuffix(k) === stripped) for (const x of v) if (!out.some((o) => o.service === x.service)) out.push(x);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// The graph.

let last: Graph | undefined;

const COMM_HINT =
  /https?:\/\/[\w.-]+|\bHandleFunc\b|\.(?:GET|POST|PUT|DELETE)\(|@(?:Get|Post|Put|Delete|Request)Mapping|@KafkaListener|RestTemplate|WebClient|HttpClient|\bgrpc\b|\bkafka\b|\bamqp\b|rabbitmq|\bnats\b|\bsqs\b|pubsub|Faraday|Net::HTTP|reqwest|axum|actix_web|Guzzle|Route::(?:get|post)/i;
const hintCache = new Map<string, { stamp: string; hit: boolean }>();

function composeStamp(): string {
  return COMPOSE_FILES.map((f) => {
    try {
      const st = statSync(path.join(REPO_ROOT, f));
      return `${f}:${st.mtimeMs}:${st.size}`;
    } catch {
      return "";
    }
  }).join("|");
}

/** The graph already built for the repo as it is now, or undefined — never builds one. */
export function currentGraph(scan: RepoScan): Graph | undefined {
  if (!last) return undefined;
  return last.fingerprint === fingerprint(scan.files) + ":" + composeStamp() ? last : undefined;
}

export async function buildGraph(scan: RepoScan): Promise<Graph> {
  const fp = fingerprint(scan.files) + ":" + composeStamp();
  if (last && last.fingerprint === fp) return last;
  pruneCache(scan);
  const repo = new Repo(scan);
  const facts = await analysedFacts(scan.files);
  const coverage: FlowCoverage = {
    filesAnalysed: { ts: 0, python: 0 },
    parseErrors: [],
    adapters: new Map(),
    unproven: { count: 0, samples: [] },
    droppedRoutes: { count: 0, samples: [] },
    unmounted: [],
    dynamicRoutes: [],
    noAdapter: new Map(),
    notes: [],
    composeFiles: [],
    unmatchedClients: { count: 0, total: 0 },
  };
  const bump = (adapter: string, k: "routes" | "clients" | "handlers" | "sends") => {
    const a = coverage.adapters.get(adapter) ?? { routes: 0, clients: 0, handlers: 0, sends: 0 };
    a[k]++;
    coverage.adapters.set(adapter, a);
  };

  const inline: Graph["inline"] = new Map();
  const addInline = (rel: string, h: HandlerRef) => {
    if (h.k !== "inline") return;
    const list = inline.get(rel) ?? [];
    if (!list.some((s) => s.start === h.start)) list.push({ start: h.start, end: h.end, line: h.line });
    inline.set(rel, list);
  };
  for (const f of facts) {
    coverage.filesAnalysed[f.family]++;
    if (f.parseError) coverage.parseErrors.push(`${f.rel}: ${f.parseError}`);
    coverage.unproven.count += f.unproven.length;
    for (const u of f.unproven) if (coverage.unproven.samples.length < 5) coverage.unproven.samples.push(`${f.rel}:${u.line} ${u.text}`);
    for (const n of f.notes) if (coverage.notes.length < 20) coverage.notes.push(n);
    for (const r of f.routes) addInline(f.rel, r.handler);
    for (const h of f.handlers) addInline(f.rel, h.handler);
    for (const p of f.pending) if (p.handler) addInline(f.rel, p.handler);
  }
  // Languages with no adapter: count files that look like they talk to other services.
  for (const e of scan.files) {
    if (familyOf(e.language)) continue;
    let h = hintCache.get(e.abs);
    if (!h || h.stamp !== e.stamp) {
      let text = "";
      try {
        text = readFileSync(e.abs, "utf8");
      } catch {
        /* unreadable */
      }
      h = { stamp: e.stamp, hit: COMM_HINT.test(text) };
      hintCache.set(e.abs, h);
    }
    if (h.hit) coverage.noAdapter.set(e.language, (coverage.noAdapter.get(e.language) ?? 0) + 1);
  }

  const byRel = new Map(facts.map((f) => [f.rel, f]));
  const factsFor = async (rel: string) => byRel.get(rel) ?? (await repo.facts(rel));
  const unit = (rel: string, offset: number) => unitAt(repo, inline, rel, offset);

  const handlerUnit = async (f: FileFacts, h: HandlerRef): Promise<{ unit?: Unit; note?: string }> => {
    if (h.k === "self") return { unit: await unit(f.rel, h.offset) };
    if (h.k === "inline") return { unit: await unit(f.rel, h.start) };
    if (h.k === "unknown") return { note: `handler \`${h.text}\` is not a name the analysis can follow` };
    const found = await resolveRef(repo, f, { local: h.local, path: h.path });
    if (found?.kind === "function") return { unit: fnUnit(found.fn.rec, found.fn.startOffset, found.fn.endOffset) };
    return { note: `handler \`${[h.local, ...h.path].join(".")}\` (${f.rel}:${h.line}) not resolved to a function` };
  };

  // --- Routers and mounts ------------------------------------------------
  const routerId = async (f: FileFacts, ref: { local: string; path: string[] }): Promise<string | undefined> => {
    if (!ref.path.length && f.routers.has(ref.local)) return `${f.rel}#${ref.local}`;
    if (!ref.path.length && f.routers.has(`fn:${ref.local}`)) return `${f.rel}#fn:${ref.local}`;
    const found = await resolveRef(repo, f, ref);
    return found?.kind === "router" ? `${found.file}#${found.local}` : undefined;
  };
  const routerFact = async (id: string) => {
    const i = id.indexOf("#");
    const ff = await factsFor(id.slice(0, i));
    return ff ? { f: ff, r: ff.routers.get(id.slice(i + 1)) } : undefined;
  };
  const mountsByChild = new Map<string, Array<{ f: FileFacts; parent: string; prefix: StrVal; replaces?: boolean; line: number }>>();
  for (const f of facts) {
    for (const m of f.mounts) {
      const child = await routerId(f, m.child);
      if (!child) continue;
      const list = mountsByChild.get(child) ?? [];
      list.push({ f, parent: `${f.rel}#${m.parent}`, prefix: m.prefix, replaces: m.replacesOwnPrefix, line: m.line });
      mountsByChild.set(child, list);
    }
  }

  type Prefix = { prefix: StrVal; evidence: string[]; unknown: boolean };
  const prefixMemo = new Map<string, Prefix[]>();
  const prefixesOf = async (id: string, seen: Set<string>): Promise<Prefix[]> => {
    const memo = prefixMemo.get(id);
    if (memo) return memo;
    const rf = await routerFact(id);
    if (!rf?.r) return [{ prefix: lit(""), evidence: [], unknown: true }];
    const own = rf.r.prefix ? await resolveStr(repo, rf.f, rf.r.prefix) : undefined;
    const ownNote = own && literal(own) !== "" ? [`${rf.r.local} has its own prefix "${show(own)}" (${rf.f.rel}:${rf.r.line})`] : [];
    if (rf.r.kind === "app") {
      const r = [{ prefix: own ?? lit(""), evidence: ownNote, unknown: false }];
      prefixMemo.set(id, r);
      return r;
    }
    const mounts = (mountsByChild.get(id) ?? []).slice(0, 10);
    const out: Prefix[] = [];
    for (const m of mounts) {
      if (seen.has(m.parent)) continue;
      const parents = await prefixesOf(m.parent, new Set([...seen, id]));
      const mp = await resolveStr(repo, m.f, m.prefix);
      for (const pp of parents) {
        out.push({
          prefix: concat(pp.prefix, lit("/"), mp, lit("/"), m.replaces ? lit("") : own ?? lit("")),
          evidence: [...pp.evidence, `mounted${literal(mp) ? ` at "${show(mp)}"` : ""} on ${m.parent.split("#")[1]} (${m.f.rel}:${m.line})`,
            ...(m.replaces ? [] : ownNote)],
          unknown: pp.unknown,
        });
      }
    }
    const r = out.length ? out : [{ prefix: own ?? lit(""), evidence: [...ownNote, `${rf.r.local.replace(/^fn:/, "")} (${rf.f.rel}:${rf.r.line}) is not mounted anywhere the analysis can see — its full path is not known`], unknown: true }];
    prefixMemo.set(id, r);
    return r;
  };

  // --- Nest global prefixes and ports per service ------------------------
  const globalPrefix = new Map<string, Array<{ value: StrVal; where: string; note?: string }>>();
  const servicePorts = new Map<string, Array<{ port: number; where: string; note?: string }>>();
  for (const f of facts) {
    for (const g of f.globalPrefix) {
      const list = globalPrefix.get(f.service) ?? [];
      list.push({ value: await resolveStr(repo, f, g.value), where: `${f.rel}:${g.line}`, note: g.note });
      globalPrefix.set(f.service, list);
    }
    for (const p of f.ports) {
      const list = servicePorts.get(f.service) ?? [];
      list.push({ port: p.port, where: `${f.rel}:${p.line}`, note: p.note });
      servicePorts.set(f.service, list);
    }
  }
  const services = new ServiceMap(scan, servicePorts);
  coverage.composeFiles = [...new Set(services.compose.map((c) => c.file))];

  // --- HTTP endpoints -----------------------------------------------------
  const endpoints: Endpoint[] = [];
  const addEndpoint = (e: Endpoint) => {
    if (!endpoints.some((x) => x.uid === e.uid)) endpoints.push(e);
  };
  const httpRoute = async (f: FileFacts, r: RouteFact, rid: string | undefined) => {
    bump(r.adapter, "routes");
    const own = await resolveStr(repo, f, r.path);
    const h = await handlerUnit(f, r.handler);
    const variants: Prefix[] = [];
    if (r.controller) {
      const gps = globalPrefix.get(f.service) ?? [];
      const gpList: Prefix[] = gps.length
        ? gps.map((g) => ({ prefix: g.value, evidence: [`global prefix "${show(g.value)}" (${g.where})${g.note ? ` — ${g.note}` : ""}`], unknown: false }))
        : [{ prefix: lit(""), evidence: [], unknown: false }];
      for (const gp of gpList) {
        for (const c of r.controller) {
          const cv = await resolveStr(repo, f, c);
          variants.push({ prefix: concat(gp.prefix, lit("/"), cv), evidence: [...gp.evidence, ...(literal(cv) ? [`@Controller("${show(cv)}")`] : [])], unknown: false });
        }
      }
    } else if (r.absolute) {
      variants.push({ prefix: lit(""), evidence: [`file-based route: the path is the file's location`], unknown: false });
    } else if (rid) {
      variants.push(...(await prefixesOf(rid, new Set())));
    }
    for (const v of variants) {
      const full = concat(v.prefix, lit("/"), own);
      const segs = routeSegs(full);
      const display = `${r.method} ${segs ? segsDisplay(segs) : show(full).replace(/\/+/g, "/")}`;
      const where = `${f.rel}:${r.line}`;
      const ep: Endpoint = {
        uid: `http|${display}|${where}`,
        protocol: "http",
        adapter: r.adapter,
        channel: "http",
        method: r.method,
        display,
        segs,
        pathDynamic: !segs,
        prefixUnknown: v.unknown,
        service: f.service,
        file: f.rel,
        line: r.line,
        handler: h.unit,
        handlerNote: h.note,
        evidence: [`route ${r.method} "${show(own)}" — ${r.adapter} (${where})`, ...v.evidence, ...own.via],
      };
      if (!segs) coverage.dynamicRoutes.push(`${where} ${display}`);
      if (v.unknown && !coverage.unmounted.includes(v.evidence[v.evidence.length - 1])) coverage.unmounted.push(v.evidence[v.evidence.length - 1]);
      addEndpoint(ep);
    }
  };

  const pendingClients: Array<{ f: FileFacts; c: ClientFact; baseFile?: FileFacts }> = [];
  for (const f of facts) {
    for (const r of f.routes) {
      if (r.controller || r.absolute) {
        await httpRoute(f, r, undefined);
        continue;
      }
      const rid = r.router ? await routerId(f, r.router) : undefined;
      if (!rid) {
        coverage.droppedRoutes.count++;
        if (coverage.droppedRoutes.samples.length < 5) coverage.droppedRoutes.samples.push(`${f.rel}:${r.line} ${r.method} ${show(r.path)} (on ${r.router ? [r.router.local, ...r.router.path].join(".") : "?"}: not identified as a router)`);
        continue;
      }
      await httpRoute(f, r, rid);
    }
    // A call on an imported name: a route if it is a router, a client call if it is a client instance.
    for (const p of f.pending) {
      const found = await resolveRef(repo, f, p.recv);
      if (found?.kind === "router" && p.handler) {
        const ff = await factsFor(found.file);
        await httpRoute(f, {
          adapter: ff?.routers.get(found.local)?.lib ?? "express", method: p.verb.toUpperCase(), path: p.url,
          handler: p.handler, line: p.line, offset: p.offset,
        }, `${found.file}#${found.local}`);
      } else if (found?.kind === "instance") {
        const bf = await factsFor(found.file);
        pendingClients.push({
          f,
          c: { adapter: found.inst.lib, method: p.verb.toUpperCase(), url: p.url, base: found.inst.base, line: p.line, offset: p.offset, text: p.text },
          baseFile: bf,
        });
      }
    }
  }

  // --- RPC handlers and event consumers -----------------------------------
  const brokerSets = new Set<string>();
  const brokersKey = async (f: FileFacts, bs: StrVal[] | undefined): Promise<string | undefined> => {
    if (!bs?.length) return undefined;
    const vals: string[] = [];
    for (const b of bs) {
      const t = literal(await resolveStr(repo, f, b));
      if (t === undefined) return undefined;
      vals.push(t);
    }
    return vals.sort().join(",");
  };
  for (const f of facts) {
    for (const k of f.kafka.values()) {
      const key = await brokersKey(f, k.brokers);
      if (key) brokerSets.add(key);
    }
  }

  const keyOf = async (f: FileFacts, k: KeyVal): Promise<{ text?: string; display: string; pattern?: RegExp; via: string[] }> => {
    if (k.k === "regex") {
      try {
        return { display: `/${k.source}/${k.flags}`, pattern: new RegExp(k.source, k.flags), via: [] };
      } catch {
        return { display: `/${k.source}/`, via: [] };
      }
    }
    // An imported object pattern: `send(SUM, …)` with `SUM = { cmd: "sum" }` in another file.
    const only = k.k === "str" && k.v.parts.length === 1 ? k.v.parts[0] : undefined;
    if (only?.k === "ref") {
      const found = await resolveRef(repo, f, { local: only.local, path: only.path });
      const ff = found?.kind === "object" ? await factsFor(found.file) : undefined;
      if (found?.kind === "object" && ff) {
        const r = await keyOf(ff, { k: "obj", entries: found.entries });
        return { ...r, via: [...r.via, `${[only.local, ...only.path].join(".")} = ${r.display} (${found.file}:${found.line})`] };
      }
    }
    if (k.k === "obj") {
      const entries: Array<[string, string]> = [];
      const via: string[] = [];
      let complete = true;
      const shown: string[] = [];
      for (const [name, v] of k.entries) {
        const r = await resolveStr(repo, f, v);
        via.push(...r.via);
        const t = literal(r);
        if (t === undefined) complete = false;
        else entries.push([name, t]);
        shown.push(`${name}: ${t !== undefined ? JSON.stringify(t) : show(r)}`);
      }
      entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      return { text: complete ? JSON.stringify(Object.fromEntries(entries)) : undefined, display: `{ ${shown.join(", ")} }`, via };
    }
    const r = await resolveStr(repo, f, k.v);
    const t = literal(r);
    return { text: t, display: t !== undefined ? t : show(r), via: r.via };
  };

  const wildcard = (key: string): RegExp | undefined => {
    if (!key.includes("*")) return undefined;
    const re = key.split(".").map((s) => (s === "**" ? ".*" : s === "*" ? "[^.]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.");
    return new RegExp(`^${re}$`);
  };

  for (const f of facts) {
    for (const h of f.handlers) {
      bump(h.adapter, "handlers");
      const hu = await handlerUnit(f, h.handler);
      const brokers = h.adapter === "kafkajs" ? await brokersKey(f, h.brokers) : undefined;
      const group = h.group ? literal(await resolveStr(repo, f, h.group)) : undefined;
      for (const k of h.keys) {
        const kv = await keyOf(f, k);
        const pattern = kv.pattern ?? (h.adapter === "nest-event-emitter" && kv.text ? wildcard(kv.text) : undefined);
        const label = h.kind === "rpc" ? "rpc" : "event";
        const display = `${label} ${kv.display}${h.adapter === "kafkajs" ? " (kafka)" : ""}`;
        const where = `${f.rel}:${h.line}`;
        addEndpoint({
          uid: `${h.adapter}|${h.kind}|${kv.display}|${where}`,
          protocol: h.kind,
          adapter: h.adapter,
          channel: `${h.adapter}:${h.kind}`,
          display,
          key: kv.text,
          pattern,
          service: f.service,
          file: f.rel,
          line: h.line,
          handler: hu.unit,
          handlerNote: hu.note ?? (h.adapter === "kafkajs" && h.handler.k === "self" ? "no consumer.run({ eachMessage }) found for this consumer in the same file: the subscribing function is shown" : undefined),
          evidence: [
            `${h.adapter} ${h.kind === "rpc" ? "handler" : "consumer"} of ${kv.display} (${where})`,
            ...(group ? [`consumer group "${group}"`] : []),
            ...(brokers ? [`brokers ${brokers}`] : []),
            ...kv.via,
          ],
          brokers,
        });
      }
    }
  }

  // --- Edges --------------------------------------------------------------
  const edges: CommEdge[] = [];
  const httpEndpoints = endpoints.filter((e) => e.protocol === "http");

  const httpEdge = async (f: FileFacts, c: ClientFact, baseFile?: FileFacts) => {
    bump(c.adapter, "clients");
    const url = await resolveStr(repo, f, c.url);
    const base = c.base ? await resolveStr(repo, baseFile ?? f, c.base) : undefined;
    const full = joinUrl(url, base, c.urlConstructor);
    const info = analyseUrl(full);
    const source = await unit(f.rel, c.offset);
    const call = `${c.method ?? "?"} ${show(full)}`;
    const evidence: string[] = [
      `${c.adapter} ${c.method ?? "(method computed)"} "${show(url)}"${base ? ` with base "${show(base)}"` : ""} (${f.rel}:${c.line})`,
      ...full.via,
      ...(c.methodNote ? [c.methodNote] : []),
    ];
    const edge: CommEdge = {
      kind: "http", adapter: c.adapter, call, source,
      site: { file: f.rel, line: c.line, text: c.text, offset: c.offset },
      targets: [], candidates: [], resolution: "unresolved", confidence: "none", evidence,
    };
    edges.push(edge);
    if (info.unresolved) {
      edge.reason = info.unresolved;
      return;
    }
    const methodOk = (e: Endpoint) => !c.method || e.method === "ALL" || e.method === c.method || (c.method === "HEAD" && e.method === "GET");
    type Cand = { e: Endpoint; m: SegMatch; suffix: boolean };
    const exact: Cand[] = [];
    const suffix: Cand[] = [];
    for (const e of httpEndpoints) {
      if (!e.segs || !methodOk(e)) continue;
      const m = matchSegs(info.segs, e.segs);
      if (m && !e.prefixUnknown) exact.push({ e, m, suffix: false });
      else {
        const s = matchSuffix(info.segs, e.segs);
        if (s && (e.prefixUnknown || info.base)) suffix.push({ e, m: s, suffix: true });
        else if (m && e.prefixUnknown) suffix.push({ e, m, suffix: true });
      }
    }
    let pool = exact.length ? exact : info.base ? suffix : suffix.filter((x) => x.e.prefixUnknown);
    let partial = !exact.length && pool.length > 0;
    let pinned = false;
    const pinHost = info.host ?? (info.base?.fallback ? analyseUrl(lit(info.base.fallback)).host : undefined);
    if (pinHost) {
      const pin = services.pin(pinHost);
      if (pin.service) {
        const narrowed = pool.filter((x) => x.e.service === pin.service);
        evidence.push(...pin.evidence.map((x) => (info.host ? x : `fallback ${x} (the variable may override it)`)));
        if (!narrowed.length) {
          edge.resolution = "unmatched";
          edge.reason = `${pin.service} has no route matching ${call}`;
          edge.candidates = pool.map((x) => x.e);
          return;
        }
        pool = narrowed;
        pinned = !!info.host;
      } else if (pin.conflict) {
        evidence.push(pin.conflict);
        partial = true;
      } else if (info.host) {
        evidence.push(`host "${info.host}" does not match any service in this repo (no docker-compose service, project directory, package name or listening port)`);
        if (!pool.length) {
          edge.resolution = "unmatched";
          edge.reason = `external host ${info.host}: nothing in the repo answers it`;
          return;
        }
        partial = true;
      }
    }
    if (info.base) {
      evidence.push(`base URL ${info.base.text} is configuration, not code — the target service is not proven`);
      partial = true;
    }
    if (!pool.length) {
      edge.resolution = "unmatched";
      edge.reason = `no route in the repo matches ${call}`;
      return;
    }
    // Most specific first: fewest guessed segments, then most fixed text.
    pool.sort((a, b) => a.m.weak - b.m.weak || b.m.exact - a.m.exact);
    const best = pool.filter((x) => x.m.weak === pool[0].m.weak && x.m.exact === pool[0].m.exact);
    if (best.length > 1) {
      edge.resolution = "ambiguous";
      edge.confidence = "none";
      edge.candidates = best.map((x) => x.e);
      edge.reason = `${best.length} routes match equally well${pinned ? "" : " and nothing pins the target service"}`;
      return;
    }
    const t = best[0];
    edge.targets = [t.e];
    if (pool.length > 1) evidence.push(`also matched less specifically: ${pool.filter((x) => x !== t).slice(0, 3).map((x) => `${x.e.display} (${x.e.file}:${x.e.line})`).join(", ")}`);
    evidence.push(`matches ${t.e.display}${t.m.weak ? ` (${t.m.weak} computed segment(s) against fixed route text)` : ""}${t.suffix ? " on the path's tail" : ""}`);
    if (partial || t.suffix) {
      edge.resolution = "partial";
      edge.confidence = "low";
      return;
    }
    edge.resolution = "resolved";
    let conf: Confidence = pinned || t.e.service === f.service ? "high" : "medium";
    if (t.m.weak || !c.method) conf = conf === "high" ? "medium" : "low";
    if (!pinned && t.e.service === f.service && info.host === undefined) evidence.push("client and route are in the same service");
    edge.confidence = conf;
  };

  for (const f of facts) for (const c of f.clients) await httpEdge(f, c);
  for (const p of pendingClients) await httpEdge(p.f, p.c, p.baseFile);

  const httpEdges = edges.filter((e) => e.kind === "http" && e.resolution !== "unresolved");
  coverage.unmatchedClients = {
    count: httpEdges.filter((e) => e.resolution === "unmatched" && /^no route in the repo/.test(e.reason ?? "")).length,
    total: httpEdges.length,
  };

  const handlerEndpoints = endpoints.filter((e) => e.protocol !== "http");
  for (const f of facts) {
    for (const s of f.sends) {
      bump(s.adapter, "sends");
      const source = await unit(f.rel, s.offset);
      const brokers = s.adapter === "kafkajs" ? await brokersKey(f, s.brokers) : undefined;
      for (const k of s.keys) {
        const kv = await keyOf(f, k);
        const channel = `${s.adapter}:${s.kind}`;
        const label = s.kind === "rpc" ? "rpc" : "event";
        const edge: CommEdge = {
          kind: s.kind, adapter: s.adapter, call: `${label} ${kv.display}`, key: kv.text, source,
          site: { file: f.rel, line: s.line, text: s.text, offset: s.offset },
          targets: [], candidates: [], resolution: "unresolved", confidence: "none",
          evidence: [`${s.adapter} ${s.adapter === "kafkajs" ? "produce to topic" : s.kind === "rpc" ? "send" : "emit"} ${kv.display} (${f.rel}:${s.line})`, ...kv.via, ...(brokers ? [`brokers ${brokers}`] : [])],
        };
        edges.push(edge);
        if (kv.text === undefined) {
          edge.reason = `the ${s.kind === "rpc" ? "pattern" : "topic"} is computed: ${kv.display}`;
          continue;
        }
        let cands = handlerEndpoints.filter((e) => e.channel === channel && (e.key === kv.text || (e.pattern?.test(kv.text!) ?? false)));
        if (s.adapter === "nest-event-emitter") {
          const other = cands.filter((e) => e.service !== f.service);
          cands = cands.filter((e) => e.service === f.service);
          if (other.length) edge.evidence.push(`also handled in ${[...new Set(other.map((o) => o.service))].join(", ")} — not linked: EventEmitter2 delivers within one process`);
        }
        if (!cands.length) {
          edge.resolution = "unmatched";
          edge.reason = `no ${s.kind === "rpc" ? "handler" : "consumer"} of ${kv.display} in the repo${s.adapter === "nest-event-emitter" ? ` (${f.service})` : ""}`;
          continue;
        }
        if (s.adapter === "kafkajs" && brokerSets.size > 1) {
          const matching = cands.filter((e) => !e.brokers || !brokers || e.brokers === brokers);
          if (!brokers || matching.some((e) => !e.brokers)) {
            edge.resolution = "ambiguous";
            edge.candidates = matching;
            edge.reason = `${brokerSets.size} Kafka broker configurations in the repo, and the ${!brokers ? "producer's" : "consumer's"} is not known — the topic name alone does not say which cluster`;
            continue;
          }
          cands = matching;
          if (!cands.length) {
            edge.resolution = "unmatched";
            edge.reason = `consumers of ${kv.display} exist only on other brokers`;
            continue;
          }
          edge.evidence.push(`producer and consumer use the same brokers (${brokers})`);
        } else if (s.adapter === "kafkajs" && brokerSets.size === 1) {
          edge.evidence.push("one Kafka broker configuration in the repo");
        }
        if (s.kind === "rpc" && cands.length > 1) {
          edge.resolution = "ambiguous";
          edge.candidates = cands;
          edge.reason = `${cands.length} handlers of ${kv.display} — an RPC reaches one; the transport configuration decides which`;
          continue;
        }
        const viaPattern = cands.some((e) => e.key !== kv.text);
        edge.targets = cands;
        edge.resolution = "resolved";
        if (cands.length > 1) edge.evidence.push(`delivered to all ${cands.length} consumers (publish/subscribe)`);
        if (viaPattern) edge.evidence.push("matched through a wildcard or regex subscription");
        const sameProcess = s.adapter === "nest-event-emitter";
        const pinnedBrokers = s.adapter === "kafkajs" && brokerSets.size > 1;
        edge.confidence = viaPattern ? "low" : sameProcess || pinnedBrokers ? "high" : "medium";
        if (s.adapter === "nest-microservices") edge.evidence.push("transport configuration (ClientsModule / createMicroservice) not checked");
      }
    }
  }

  last = { fingerprint: fp, repo, endpoints, edges, inline, coverage };
  return last;
}

/** A client's URL with its instance's base, as the library joins them. */
function joinUrl(url: StrVal, base: StrVal | undefined, urlConstructor?: boolean): StrVal {
  if (!base) return url;
  const first = url.parts[0];
  const firstText = first?.k === "lit" ? first.v : "";
  if (/^(https?:)?\/\//i.test(firstText)) return url;
  // new URL("/x", base): an absolute path keeps only the base's origin.
  if (urlConstructor && firstText.startsWith("/")) {
    const b = base.parts[0];
    const m = b?.k === "lit" ? b.v.match(/^((?:https?:)?\/\/[^/]+)/i) : null;
    if (m) return concat({ parts: [{ k: "lit", v: m[1] }], via: base.via }, url);
    return concat(base, url);
  }
  return concat(base, firstText.startsWith("/") ? lit("") : lit("/"), url);
}

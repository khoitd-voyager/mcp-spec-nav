import { scanRepo } from "../project.js";
import { resolveFunction, StaleIdError } from "../catalog.js";
import { CHAR_BUDGET, CHANGED_WARNING, decodeCursor, encodeCursor, paramsHash, takePage } from "../paging.js";
import { lit } from "./model.js";
import { buildGraph, currentGraph, Graph, Unit, Endpoint, CommEdge, Resolution, Confidence, fnUnit, routeSegs, analyseUrl, segsDisplay, FlowCoverage } from "./link.js";
import { callsFrom, callsInto } from "./calls.js";
import { prewarmFacts } from "./facts.js";

/**
 * `spec_nav_trace_flow`: follow a flow through communication between
 * services — HTTP client → route → handler, RPC call → handler, event or
 * topic → consumers — and, between those, the direct calls inside a service.
 *
 * Static: built from source, not observed. Every step names the line that
 * makes the call, the line that receives it, the evidence that joins them,
 * a confidence earned from that evidence, and whether the link was resolved,
 * partly resolved, ambiguous, unresolved or unmatched. Only resolved and
 * partial links are followed; ambiguous ones list their candidates.
 */

export interface TraceArgs {
  id?: string;
  file?: string;
  name?: string;
  line?: number;
  endpoint?: string;
  topic?: string;
  direction?: "downstream" | "upstream" | "both";
  maxDepth?: number;
  followCalls?: boolean;
  includePartial?: boolean;
  limit?: number;
  cursor?: string;
  format?: "text" | "json";
}

export interface NodeRef {
  kind: "function" | "inline" | "top" | "endpoint" | "topic";
  label: string;
  file?: string;
  line?: number;
  service?: string;
  id?: string;
}

export interface Step {
  depth: number;
  direction: "downstream" | "upstream";
  kind: "call" | "http" | "rpc" | "event" | "handler";
  from: NodeRef;
  to?: NodeRef;
  /** What is sent and what receives it: `GET /api/orders/${id} → GET /api/orders/:id`. */
  via?: string;
  at: { file: string; line: number; text?: string };
  resolution: Resolution;
  confidence: Confidence;
  evidence: string[];
  reason?: string;
  candidates?: NodeRef[];
  /** Why the flow stops here: a cycle, the depth limit, an unfollowed link. */
  stop?: string;
}

const DEFAULT_DEPTH = 6;
const MAX_DEPTH = 20;
/** Traversal stops after this many steps, whatever maxDepth says, and says so. */
const TRAVERSAL_LIMIT = 3000;

function unitRef(u: Unit): NodeRef {
  return {
    kind: u.inline ? "inline" : u.id ? "function" : "top",
    label: u.label,
    file: u.file,
    line: u.line,
    service: u.service,
    ...(u.id ? { id: u.id } : {}),
  };
}

function endpointRef(e: Endpoint): NodeRef {
  return { kind: "endpoint", label: e.display, file: e.file, line: e.line, service: e.service };
}

type Node = { t: "unit"; unit: Unit } | { t: "endpoint"; ep: Endpoint } | { t: "topic"; key: string };

function nodeKey(n: Node): string {
  return n.t === "unit" ? `u:${n.unit.key}` : n.t === "endpoint" ? `e:${n.ep.uid}` : `t:${n.key}`;
}

function edgeVia(e: CommEdge, target?: Endpoint): string {
  return target ? `${e.call} → ${target.display}` : e.call;
}

function inUnit(g: Graph, u: Unit, file: string, offset: number): boolean {
  if (file !== u.file || offset < u.start || offset >= u.end) return false;
  // Code inside an inline handler nested in this unit runs when that handler does, not when this does.
  return !(g.inline.get(file) ?? []).some((s) => s.start > u.start && s.end <= u.end && s.start <= offset && offset < s.end);
}

function commStep(e: CommEdge, target: Endpoint | undefined, depth: number, direction: Step["direction"]): Step {
  const evidence = [...e.evidence, ...(target ? target.evidence : [])];
  if (target?.handlerNote) evidence.push(target.handlerNote);
  return {
    depth,
    direction,
    kind: e.kind,
    from: unitRef(e.source),
    to: target ? (target.handler ? unitRef(target.handler) : endpointRef(target)) : undefined,
    via: edgeVia(e, target),
    at: { file: e.site.file, line: e.site.line, text: e.site.text },
    resolution: e.resolution,
    confidence: e.confidence,
    evidence,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.candidates.length ? { candidates: e.candidates.map((c) => (c.handler ? { ...unitRef(c.handler), label: `${c.display} → ${c.handler.label}` } : endpointRef(c))) } : {}),
  };
}

async function startNodes(g: Graph, args: TraceArgs): Promise<{ nodes: Node[]; label: string; error?: string }> {
  if (args.id || (args.file && args.name)) {
    try {
      const { ix } = await resolveFunction({ id: args.id, file: args.file, name: args.name, line: args.line });
      const u = fnUnit(ix.rec, ix.startOffset, ix.endOffset);
      return { nodes: [{ t: "unit", unit: u }], label: `${ix.rec.name} (${ix.rec.file}:${ix.rec.start}, id ${ix.rec.id})` };
    } catch (err) {
      if (err instanceof StaleIdError) return { nodes: [], label: "", error: err.message };
      throw err;
    }
  }
  if (args.endpoint) {
    const m = args.endpoint.trim().match(/^(?:([A-Za-z]+)\s+)?(\S+)$/);
    if (!m) return { nodes: [], label: "", error: `endpoint "${args.endpoint}": expected "METHOD /path" or "/path"` };
    const method = m[1]?.toUpperCase();
    const http = g.endpoints.filter((e) => e.protocol === "http" && e.segs && (!method || e.method === method || e.method === "ALL"));
    // A route template first ("/orders/:id"), then a concrete URL ("/orders/42").
    const tpl = routeSegs(lit(m[2].replace(/^https?:\/\/[^/]+/i, "")));
    let hits = tpl
      ? http.filter((e) => e.segs!.length === tpl.length && e.segs!.every((s, i) => s.t === tpl[i].t && (s.t !== "lit" || s.v === (tpl[i] as { v: string }).v)))
      : [];
    if (!hits.length) {
      const info = analyseUrl(lit(m[2]));
      hits = http.filter((e) => {
        if (info.segs.length !== e.segs!.length) return false;
        return e.segs!.every((s, i) => s.t === "rest" || s.t === "param" || (info.segs[i].lit === s.v));
      });
    }
    if (!hits.length) {
      const last = tpl?.filter((s) => s.t === "lit").pop();
      const near = last ? http.filter((e) => e.segs!.some((s) => s.t === "lit" && s.v === (last as { v: string }).v)).slice(0, 10) : [];
      return {
        nodes: [], label: "",
        error: `no route matches ${args.endpoint}.` + (near.length ? ` Routes with "${(last as { v: string }).v}": ${near.map((e) => `${e.display} (${e.file}:${e.line})`).join("; ")}` : "") +
          " Routes are listed by spec_nav_trace_flow with no start.",
      };
    }
    return { nodes: hits.map((ep) => ({ t: "endpoint", ep })), label: `endpoint ${args.endpoint} (${hits.length} route${hits.length > 1 ? "s" : ""}: ${hits.map((h) => `${h.display} in ${h.service}`).join("; ")})` };
  }
  if (args.topic) {
    const key = canonicalTopic(args.topic);
    return { nodes: [{ t: "topic", key }], label: `topic/pattern ${key}` };
  }
  return { nodes: [], label: "" };
}

/** `{ cmd: 'sum' }` and `{"cmd":"sum"}` are the same NestJS pattern: compare as canonical JSON. */
function canonicalTopic(t: string): string {
  const s = t.trim();
  if (!s.startsWith("{")) return s;
  try {
    const o = JSON.parse(s.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'));
    return JSON.stringify(Object.fromEntries(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1))));
  } catch {
    return s;
  }
}

function topicMatches(e: Endpoint, key: string): boolean {
  return e.protocol !== "http" && (e.key === key || (e.pattern?.test(key) ?? false) || e.display.replace(/^(rpc|event) /, "").replace(/ \(kafka\)$/, "") === key);
}

async function traverse(g: Graph, starts: Node[], direction: Step["direction"], args: TraceArgs): Promise<{ steps: Step[]; truncated: boolean; frontier: number; unfollowedCalls: number }> {
  const maxDepth = Math.min(Math.max(args.maxDepth ?? DEFAULT_DEPTH, 1), MAX_DEPTH);
  const followCalls = args.followCalls ?? true;
  const followPartial = args.includePartial ?? true;
  const steps: Step[] = [];
  const visited = new Set<string>();
  let truncated = false;
  let frontier = 0;
  let unfollowedCalls = 0;
  const queue: Array<{ node: Node; depth: number }> = starts.map((n) => ({ node: n, depth: 0 }));
  for (const s of starts) visited.add(nodeKey(s));

  const push = (step: Step, next: Node | undefined, depth: number, follow: boolean) => {
    if (steps.length >= TRAVERSAL_LIMIT) {
      truncated = true;
      return;
    }
    steps.push(step);
    if (!next) return;
    if (!follow) {
      step.stop ??= `not followed: ${step.resolution}`;
      return;
    }
    const k = nodeKey(next);
    if (visited.has(k)) {
      step.stop = "already in this flow (cycle or shared step) — not expanded again";
      return;
    }
    visited.add(k);
    queue.push({ node: next, depth });
  };
  const followable = (r: Resolution) => r === "resolved" || (r === "partial" && followPartial);

  while (queue.length && !truncated) {
    const { node, depth } = queue.shift()!;
    if (depth >= maxDepth) {
      frontier++;
      continue;
    }
    const d = depth + 1;
    if (direction === "downstream") {
      if (node.t === "unit") {
        const u = node.unit;
        for (const e of g.edges.filter((x) => inUnit(g, u, x.site.file, x.site.offset))) {
          if (e.targets.length) {
            for (const t of e.targets) push(commStep(e, t, d, direction), t.handler ? { t: "unit", unit: t.handler } : undefined, d, followable(e.resolution));
          } else {
            push(commStep(e, undefined, d, direction), undefined, d, false);
          }
        }
        if (followCalls) {
          const { edges, unresolved } = await callsFrom(g, u);
          unfollowedCalls += unresolved.length;
          for (const c of edges) {
            push({
              depth: d, direction, kind: "call", from: unitRef(c.from), to: unitRef(c.to), via: `${c.from.label} → ${c.to.label}`,
              at: c.site, resolution: "resolved", confidence: c.confidence, evidence: [c.evidence],
            }, { t: "unit", unit: c.to }, d, true);
          }
        }
      } else if (node.t === "endpoint") {
        const ep = node.ep;
        push({
          depth: d, direction, kind: "handler", from: endpointRef(ep), to: ep.handler ? unitRef(ep.handler) : undefined, via: ep.display,
          at: { file: ep.file, line: ep.line }, resolution: ep.handler ? "resolved" : "unresolved", confidence: ep.handler ? "high" : "none",
          evidence: ep.evidence, ...(ep.handlerNote ? { reason: ep.handlerNote } : {}),
        }, ep.handler ? { t: "unit", unit: ep.handler } : undefined, d, !!ep.handler);
      } else {
        for (const ep of g.endpoints.filter((e) => topicMatches(e, node.key))) {
          push({
            depth: d, direction, kind: ep.protocol === "rpc" ? "rpc" : "event", from: { kind: "topic", label: node.key }, to: ep.handler ? unitRef(ep.handler) : endpointRef(ep),
            via: ep.display, at: { file: ep.file, line: ep.line }, resolution: ep.handler ? "resolved" : "unresolved",
            // Matched on the name alone: which producer, broker or process is not part of the question.
            confidence: !ep.handler ? "none" : ep.key === node.key ? "medium" : "low",
            evidence: [...ep.evidence, "subscribed to this name — producer, broker and transport are not checked from a topic start"],
            ...(ep.handlerNote ? { reason: ep.handlerNote } : {}),
          }, ep.handler ? { t: "unit", unit: ep.handler } : undefined, d, !!ep.handler);
        }
      }
    } else {
      // Upstream: who reaches this.
      if (node.t === "unit") {
        const u = node.unit;
        for (const e of g.edges) {
          for (const t of e.targets) {
            if (t.handler?.key === u.key) push(commStep(e, t, d, direction), { t: "unit", unit: e.source }, d, followable(e.resolution));
          }
          for (const c of e.candidates) {
            if (c.handler?.key === u.key && !e.targets.includes(c)) push(commStep(e, c, d, direction), { t: "unit", unit: e.source }, d, false);
          }
        }
        if (followCalls) {
          for (const c of await callsInto(g, u)) {
            push({
              depth: d, direction, kind: "call", from: unitRef(c.from), to: unitRef(c.to), via: `${c.from.label} → ${c.to.label}`,
              at: c.site, resolution: "resolved", confidence: c.confidence, evidence: [c.evidence],
            }, { t: "unit", unit: c.from }, d, true);
          }
        }
      } else if (node.t === "endpoint") {
        for (const e of g.edges) {
          if (e.targets.some((t) => t.uid === node.ep.uid)) push(commStep(e, node.ep, d, direction), { t: "unit", unit: e.source }, d, followable(e.resolution));
          else if (e.candidates.some((t) => t.uid === node.ep.uid)) push(commStep(e, node.ep, d, direction), { t: "unit", unit: e.source }, d, false);
        }
      } else {
        for (const e of g.edges) {
          if (e.kind === "http" || e.key !== node.key) continue;
          push(commStep(e, undefined, d, direction), { t: "unit", unit: e.source }, d, true);
        }
      }
    }
  }
  return { steps, truncated, frontier, unfollowedCalls };
}

// ---------------------------------------------------------------------------
// Rendering.

function where(n: NodeRef | undefined): string {
  if (!n) return "?";
  const loc = n.file ? `${n.file}:${n.line}` : "";
  return `${loc}${loc ? "  " : ""}${n.label}${n.service ? `  (service ${n.service})` : ""}${n.id ? `\n          id: ${n.id}` : ""}`;
}

function renderStep(s: Step, i: number): string {
  const kind = s.kind === "call" ? "call " : s.kind.toUpperCase().padEnd(5);
  const lines = [
    `#${i + 1}  d${s.depth} ${s.direction === "upstream" ? "↑" : "↓"} ${kind} ${s.via ?? ""}   [${s.resolution}${s.confidence !== "none" ? ` · ${s.confidence}` : ""}]`,
    `    from  ${where(s.from)}`,
    `    at    ${s.at.file}:${s.at.line}${s.at.text ? `  ${s.at.text}` : ""}`,
  ];
  if (s.to) lines.push(`    to    ${where(s.to)}`);
  if (s.reason) lines.push(`    why not: ${s.reason}`);
  if (s.candidates?.length) {
    lines.push(`    candidates (${s.candidates.length}, none chosen):`);
    for (const c of s.candidates.slice(0, 8)) lines.push(`      - ${where(c).replace(/\n\s+/g, "  ")}`);
  }
  lines.push(`    evidence: ${s.evidence.join("; ")}`);
  if (s.stop) lines.push(`    stop: ${s.stop}`);
  return lines.join("\n");
}

function coverageLines(c: FlowCoverage): string[] {
  const out: string[] = [];
  const adapters = [...c.adapters].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, a]) =>
    `${name} (${[a.routes && `${a.routes} routes`, a.clients && `${a.clients} client calls`, a.handlers && `${a.handlers} handlers`, a.sends && `${a.sends} sends`].filter(Boolean).join(", ")})`);
  out.push(`coverage: ${c.filesAnalysed.ts} TypeScript/JavaScript and ${c.filesAnalysed.python} Python files analysed (those importing a supported library or making HTTP-looking calls).`);
  out.push(`adapters with findings: ${adapters.length ? adapters.join("; ") : "none"}.`);
  if (c.composeFiles.length) out.push(`hosts mapped through: ${c.composeFiles.join(", ")}`);
  const gaps: string[] = [];
  if (c.noAdapter.size) gaps.push(`no adapter for ${[...c.noAdapter].map(([l, n]) => `${l} (${n} file${n > 1 ? "s" : ""} with HTTP/RPC/queue-looking code)`).join(", ")} — not traced`);
  if (c.unproven.count) gaps.push(`${c.unproven.count} HTTP-looking call(s) on objects no adapter identified, not traced (e.g. ${c.unproven.samples.slice(0, 2).join(" | ")})`);
  if (c.droppedRoutes.count) gaps.push(`${c.droppedRoutes.count} route(s) registered on something not identified as a router (e.g. ${c.droppedRoutes.samples.slice(0, 2).join(" | ")})`);
  if (c.unmounted.length) gaps.push(`${c.unmounted.length} router(s) whose mount point is unknown, their routes matched by path tail only (e.g. ${c.unmounted.slice(0, 2).join(" | ")})`);
  if (c.dynamicRoutes.length) gaps.push(`${c.dynamicRoutes.length} route(s) with a computed path, not matchable (e.g. ${c.dynamicRoutes.slice(0, 2).join(" | ")})`);
  const um = c.unmatchedClients;
  if (um.count >= 3 && um.count >= um.total * 0.3) {
    gaps.push(`${um.count} of ${um.total} HTTP client calls match no route in the repo — their servers may be outside the repo, ` +
      `built into a framework, or use routing no adapter reads (see Supported)`);
  }
  if (c.parseErrors.length) gaps.push(`${c.parseErrors.length} analysed file(s) with syntax errors (e.g. ${c.parseErrors.slice(0, 2).join(" | ")})`);
  out.push(gaps.length ? `gaps: ${gaps.join("; ")}.` : "gaps: none found among the supported adapters.");
  for (const n of c.notes.slice(0, 5)) out.push(`note: ${n}`);
  return out;
}

const SUPPORTED =
  "Supported: HTTP — Express, Fastify, koa-router, NestJS controllers, file-based routes (Next.js app/pages, Medusa src/api, " +
  "SvelteKit +server), FastAPI, Flask (servers); fetch, axios, NestJS HttpService, medusa-js, " +
  "requests, httpx, aiohttp (clients). RPC — NestJS microservices @MessagePattern/ClientProxy.send. Events — NestJS @EventPattern/" +
  "ClientProxy.emit, @nestjs/event-emitter @OnEvent/EventEmitter2.emit (same service only), kafkajs producer/consumer. Nothing else " +
  "(gRPC, GraphQL, BullMQ, RabbitMQ, Hono, Go, Java…) is traced.";

function counts(steps: Step[]): string {
  const c: Record<string, number> = {};
  for (const s of steps) c[s.resolution] = (c[s.resolution] ?? 0) + 1;
  return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ");
}

export async function traceFlow(args: TraceArgs): Promise<{ text: string; isError?: boolean }> {
  const scan = scanRepo();
  const g = await buildGraph(scan);
  const direction = args.direction ?? "downstream";
  const start = await startNodes(g, args);
  if (start.error) return { text: start.error, isError: true };

  let steps: Step[];
  let header: string[];
  let truncated = false;
  let frontier = 0;
  let unfollowedCalls = 0;
  if (!start.nodes.length) {
    // No start: the inventory of communication edges.
    steps = [...g.edges]
      .sort((a, b) => (a.site.file < b.site.file ? -1 : a.site.file > b.site.file ? 1 : a.site.line - b.site.line))
      .flatMap((e) => (e.targets.length ? e.targets.map((t) => commStep(e, t, 0, "downstream")) : [commStep(e, undefined, 0, "downstream")]));
    const http = g.endpoints.filter((e) => e.protocol === "http").length;
    header = [
      `INVENTORY of communication between code (no start given): ${steps.length} link(s) from ${g.edges.length} call/send site(s); ` +
        `${http} HTTP route(s) and ${g.endpoints.length - http} RPC/event handler(s) found.`,
      `Pass id, file+name, endpoint or topic to trace a flow from one point.`,
    ];
  } else {
    const dirs: Array<Step["direction"]> = direction === "both" ? ["upstream", "downstream"] : [direction];
    steps = [];
    for (const d of dirs) {
      const r = await traverse(g, start.nodes, d, args);
      steps.push(...r.steps);
      truncated ||= r.truncated;
      frontier += r.frontier;
      unfollowedCalls += r.unfollowedCalls;
    }
    header = [
      `FLOW from ${start.label} — ${direction}, maxDepth ${Math.min(Math.max(args.maxDepth ?? DEFAULT_DEPTH, 1), MAX_DEPTH)}, ` +
        `direct calls ${args.followCalls === false ? "not followed" : "followed"}, partial links ${args.includePartial === false ? "not followed" : "followed"}.`,
      ...(truncated ? [`TRUNCATED: traversal stopped at ${TRAVERSAL_LIMIT} steps — narrow with maxDepth or followCalls:false.`] : []),
      ...(frontier ? [`depth limit reached: ${frontier} node(s) at depth ${args.maxDepth ?? DEFAULT_DEPTH} not expanded — raise maxDepth to go further.`] : []),
      ...(unfollowedCalls ? [`${unfollowedCalls} direct call(s) not followed (library, built-in, or no declaration/type to bind them to).`] : []),
    ];
  }

  const qHash = paramsHash({ ...args, cursor: undefined, format: undefined, limit: undefined });
  const cur = decodeCursor(args.cursor, "trace", qHash, g.fingerprint);
  const from = typeof cur.position === "number" ? cur.position : 0;
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 200);
  const page = takePage(steps, from, limit, CHAR_BUDGET - 5000, (s, i) => renderStep(s, i));
  const complete = page.end >= steps.length;
  const nextCursor = complete ? undefined : encodeCursor({ t: "trace", q: qHash, p: page.end, f: cur.fingerprint });

  if (args.format === "json") {
    return {
      text: JSON.stringify({
        mode: start.nodes.length ? "flow" : "inventory",
        start: start.label || undefined,
        direction: start.nodes.length ? direction : undefined,
        static: true,
        totalSteps: steps.length,
        byResolution: Object.fromEntries(["resolved", "partial", "ambiguous", "unresolved", "unmatched"].map((r) => [r, steps.filter((s) => s.resolution === r).length])),
        returned: page.end - from,
        complete,
        nextCursor,
        changedSinceFirstPage: cur.changedSinceFirstPage || undefined,
        truncated: truncated || undefined,
        depthLimitReached: frontier || undefined,
        unfollowedCalls: unfollowedCalls || undefined,
        coverage: {
          filesAnalysed: g.coverage.filesAnalysed,
          adapters: Object.fromEntries(g.coverage.adapters),
          noAdapter: Object.fromEntries(g.coverage.noAdapter),
          unproven: g.coverage.unproven,
          droppedRoutes: g.coverage.droppedRoutes,
          unmountedRouters: g.coverage.unmounted,
          dynamicRoutes: g.coverage.dynamicRoutes,
          parseErrors: g.coverage.parseErrors,
          unmatchedClients: g.coverage.unmatchedClients,
          composeFiles: g.coverage.composeFiles,
          notes: g.coverage.notes,
        },
        supported: SUPPORTED,
        steps: steps.slice(from, page.end),
      }),
    };
  }
  return {
    text: [
      ...header,
      `STATIC ANALYSIS of source code, not runtime tracing. Each step: where it is sent (at), what receives it (to), the evidence that ` +
        `joins them, a confidence earned from that evidence, and a status — resolved / partial (part of the key is configuration) / ` +
        `ambiguous (candidates listed, none chosen, not followed) / unresolved (the key is computed) / unmatched (nothing in the repo receives it). ` +
        `"call" steps are direct function calls inside a service, bound by syntax and imports (not spec_nav_callers' type-checked call sites).`,
      `steps: ${steps.length}${steps.length ? ` (${counts(steps)})` : ""}` +
        (steps.length ? ` — this page ${from + 1}-${page.end}` + (complete ? " — COMPLETE" : ` — MORE: call again with the same arguments and cursor="${nextCursor}"`) : ""),
      ...(cur.changedSinceFirstPage ? [CHANGED_WARNING] : []),
      ...coverageLines(g.coverage),
      SUPPORTED,
      "",
      ...(steps.length ? page.rendered : ["(no steps: nothing communicates from or to this point that the adapters can see — see coverage above)"]),
    ].join("\n"),
  };
}

/** Build the flow graph in the background after start, so boundaries can be shown inline. */
export async function prewarmFlow(): Promise<{ edges: number; ms: number }> {
  const t0 = Date.now();
  const scan = scanRepo();
  await prewarmFacts(scan.files);
  const g = await buildGraph(scan);
  return { edges: g.edges.length, ms: Date.now() - t0 };
}

/** A place in code: a hit or a call site, with the function it is in when known. */
export interface Place {
  file: string;
  line: number;
  /** Name and first line of the enclosing function. */
  fnName?: string;
  fnLine?: number;
  /** For a whole function: sends anywhere from `line` to here count. */
  toLine?: number;
}

/**
 * The other side of the service boundaries at these places, from the flow
 * graph when it is already built (it is built in the background after start;
 * this never builds it): who calls an endpoint handled here, and where an HTTP
 * call or message sent here lands. Shown in the result itself — a separate
 * "Next — spec_nav_trace_flow" line was offered often and followed rarely.
 * Undefined when the graph is not ready.
 */
export function boundariesAt(places: Place[], max = 6): string[] | undefined {
  const g = currentGraph(scanRepo());
  if (!g) return undefined;
  const lines: string[] = [];
  const seen = new Set<string>();
  let more = 0;
  const push = (k: string, text: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    if (lines.length < max) lines.push(text);
    else more++;
  };
  const files = new Set(places.map((p) => p.file));
  const handled = g.endpoints.filter((e) => files.has(e.file) || (e.handler && files.has(e.handler.file)));
  for (const p of places) {
    for (const e of handled) {
      const h = e.handler;
      const here = (h && h.file === p.file && (h.line === p.fnLine || h.line === p.line)) ||
        (e.file === p.file && (e.line === p.line || (!!p.fnName && e.method === p.fnName.toUpperCase())));
      if (!here) continue;
      const callers = g.edges.filter((x) => x.targets.includes(e));
      if (!callers.length) {
        push(`in:${e.uid}`, `${e.display} (${p.file}:${p.line}) — called by: nothing in the repo (external clients, or a URL built at runtime)`);
        continue;
      }
      for (const x of callers) {
        push(`in:${e.uid}:${x.site.file}:${x.site.line}`,
          `${e.display} (${p.file}:${p.line}) — called by ${x.source.service}: ${x.site.file}:${x.site.line} ${x.source.label} [${x.resolution}]`);
      }
    }
    for (const x of g.edges) {
      if (x.site.file !== p.file || x.site.line < p.line || x.site.line > (p.toLine ?? p.line)) continue;
      if (!x.targets.length) {
        push(`out:${x.site.file}:${x.site.line}`, `${x.site.file}:${x.site.line} ${x.call} — sends to: no handler in the repo matches [${x.resolution}]`);
        continue;
      }
      for (const t of x.targets) {
        push(`out:${x.site.file}:${x.site.line}:${t.uid}`,
          `${x.site.file}:${x.site.line} ${x.call} — sends to ${t.service}: ${t.handler ? `${t.handler.file}:${t.handler.line} ${t.handler.label}` : `${t.file}:${t.line}`} [${x.resolution}]`);
      }
    }
  }
  if (more) lines.push(`… ${more} more — spec_nav_trace_flow on the handler or call lists them all, with evidence.`);
  return lines;
}

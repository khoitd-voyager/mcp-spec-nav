import { catalogFile, Indexed } from "../catalog.js";
import { calleeKey } from "../search.js";
import { CallFact, FileFacts } from "./model.js";
import { resolveRef, factsOf, familyOf } from "./facts.js";
import { Graph, Unit, Confidence, unitAt, fnUnit } from "./link.js";

/**
 * Direct calls inside a service, followed so a flow can cross from a route
 * handler to the client call three functions further in.
 *
 * Bound on syntax and evidence only — a function declared in the same file
 * or scope, imported by name, a method of the class the call sits in
 * (`this.x()` / `self.x()`), a method of a property's declared type
 * (`this.orders.find()` with `orders: OrdersService`), or of a variable
 * holding `new C()`. Anything else is left unfollowed and counted. These are
 * not the type-checked call sites of spec_nav_callers, and they are reported
 * as `call` steps, apart from the communication between services.
 */

export interface CallEdge {
  from: Unit;
  to: Unit;
  site: { file: string; line: number; text: string };
  evidence: string;
  confidence: Confidence;
}

const METHOD_KINDS = new Set(["method", "constructor", "getter", "setter", "property"]);

/** The class a site sits in: the innermost catalogued method around it, minus the method's name. */
function classAt(fns: Indexed[], offset: number): string | undefined {
  let best: Indexed | undefined;
  for (const f of fns) {
    if (!METHOD_KINDS.has(f.rec.kind)) continue;
    if (f.startOffset <= offset && offset < f.endOffset && (!best || f.endOffset - f.startOffset < best.endOffset - best.startOffset)) best = f;
  }
  if (!best) return undefined;
  const segs = best.rec.name.split(".");
  return segs.length > 1 ? segs[segs.length - 2] : undefined;
}

/** Named functions around a site, innermost first. */
function scopesAt(fns: Indexed[], offset: number): string[] {
  return fns
    .filter((f) => f.startOffset <= offset && offset < f.endOffset)
    .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset))
    .map((f) => f.rec.name);
}

async function classMethod(g: Graph, f: FileFacts, fns: Indexed[], cls: string, method: string): Promise<Indexed | undefined> {
  const own = fns.find((x) => x.rec.name === `${cls}.${method}`);
  if (own) return own;
  if (!f.imports.has(cls)) return undefined;
  const found = await resolveRef(g.repo, f, { local: cls, path: [method] });
  return found?.kind === "function" ? found.fn : undefined;
}

export async function resolveCall(
  g: Graph,
  f: FileFacts,
  call: CallFact,
): Promise<{ fn: Indexed; evidence: string; confidence: Confidence } | { reason: string }> {
  const fns = (await catalogFile(g.repo.entry(f.rel)!)).functions;
  const name = call.name;
  switch (call.form) {
    case "bare": {
      for (const scope of scopesAt(fns, call.offset)) {
        const nested = fns.find((x) => x.rec.name === `${scope}.${name}`);
        if (nested) return { fn: nested, evidence: `nested function in ${scope}`, confidence: "high" };
      }
      if (f.imports.has(name)) {
        const found = await resolveRef(g.repo, f, { local: name, path: [] });
        if (found?.kind === "function") return { fn: found.fn, evidence: `imported from "${f.imports.get(name)!.spec}"`, confidence: "high" };
        return { reason: `${name} is imported from "${f.imports.get(name)!.spec}" (library, or not a function the catalog lists)` };
      }
      const top = fns.find((x) => x.rec.name === name);
      if (top) return { fn: top, evidence: "declared in the same file", confidence: "high" };
      return { reason: `${name}: no declaration in this file or its imports (built-in, global or library)` };
    }
    case "this": {
      const cls = classAt(fns, call.offset);
      const m = cls && fns.find((x) => x.rec.name === `${cls}.${name}`);
      if (m) return { fn: m, evidence: `method of the same class ${cls}`, confidence: "high" };
      return { reason: `this.${name}: not declared in ${cls ?? "the enclosing class"} (inherited or assigned at runtime)` };
    }
    case "thisProp": {
      const cls = classAt(fns, call.offset);
      const type = cls ? f.classes.get(cls)?.props.get(call.recv!) : undefined;
      if (!type) return { reason: `this.${call.recv}.${name}: the type of ${call.recv} is not declared` };
      const m = await classMethod(g, f, fns, type, name);
      if (m) return { fn: m, evidence: `${call.recv} is declared as ${type}`, confidence: "medium" };
      return { reason: `this.${call.recv}.${name}: ${type}.${name} not found (an interface, a library type, or inherited)` };
    }
    case "member": {
      const recv = call.recv!;
      const cls = f.newVars.get(recv);
      if (cls) {
        const m = await classMethod(g, f, fns, cls, name);
        if (m) return { fn: m, evidence: `${recv} = new ${cls}()`, confidence: "high" };
      }
      const declared = f.varTypes.get(recv);
      if (declared) {
        const m = await classMethod(g, f, fns, declared, name);
        if (m) return { fn: m, evidence: `${recv} is declared as ${declared}`, confidence: "medium" };
      }
      if (f.imports.has(recv)) {
        const found = await resolveRef(g.repo, f, { local: recv, path: [name] });
        if (found?.kind === "function") return { fn: found.fn, evidence: `${recv} imported from "${f.imports.get(recv)!.spec}"`, confidence: "high" };
        return { reason: `${recv}.${name}: ${recv} comes from "${f.imports.get(recv)!.spec}" (library, or not followed)` };
      }
      const st = fns.find((x) => x.rec.name === `${recv}.${name}`);
      if (st) return { fn: st, evidence: `${recv}.${name} declared in the same file`, confidence: "high" };
      return { reason: `${recv}.${name}: the type of ${recv} is not known` };
    }
  }
}

/** Calls made inside `unit`, not counting those inside an inline handler nested in it. */
export async function callsFrom(g: Graph, unit: Unit): Promise<{ edges: CallEdge[]; unresolved: string[] }> {
  const e = g.repo.entry(unit.file);
  if (!e) return { edges: [], unresolved: [] };
  const f = await factsOf(e);
  if (!f) return { edges: [], unresolved: [] };
  const nestedInline = (g.inline.get(unit.file) ?? []).filter((s) => s.start > unit.start && s.end <= unit.end);
  const edges: CallEdge[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const c of f.calls) {
    if (c.offset < unit.start || c.offset >= unit.end) continue;
    if (nestedInline.some((s) => s.start <= c.offset && c.offset < s.end)) continue;
    const r = await resolveCall(g, f, c);
    if ("reason" in r) {
      if (unresolved.length < 200) unresolved.push(r.reason);
      continue;
    }
    const to = fnUnit(r.fn.rec, r.fn.startOffset, r.fn.endOffset);
    const k = `${to.key}@${c.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ from: unit, to, site: { file: f.rel, line: c.line, text: c.text }, evidence: r.evidence, confidence: r.confidence });
  }
  return { edges, unresolved };
}

const intoCache = new WeakMap<Graph, Map<string, CallEdge[]>>();

/**
 * Calls into `unit` from code in the same language family. Files are
 * shortlisted by the catalog's record of what each function calls, plus every
 * file with communication code (whose inline handlers the catalog does not
 * list as functions).
 */
export async function callsInto(g: Graph, unit: Unit): Promise<CallEdge[]> {
  if (!unit.id) return [];
  let memo = intoCache.get(g);
  if (!memo) intoCache.set(g, (memo = new Map()));
  const hit = memo.get(unit.key);
  if (hit) return hit;
  const short = unit.label.split(".").pop()!;
  const key = calleeKey(short);
  const target = g.repo.entry(unit.file);
  const fam = target && familyOf(target.language);
  const out: CallEdge[] = [];
  if (fam) {
    for (const e of g.repo.scan.files) {
      if (familyOf(e.language) !== fam) continue;
      const fc = await catalogFile(e);
      const mentions = fc.functions.some((x) => x.callees.includes(key)) || g.inline.has(e.rel);
      if (!mentions) continue;
      const f = await factsOf(e);
      if (!f) continue;
      for (const c of f.calls) {
        if (c.name !== short) continue;
        const r = await resolveCall(g, f, c);
        if ("reason" in r || r.fn.rec.id !== unit.id) continue;
        const from = await unitAt(g.repo, g.inline, f.rel, c.offset);
        out.push({ from, to: unit, site: { file: f.rel, line: c.line, text: c.text }, evidence: r.evidence, confidence: r.confidence });
      }
    }
  }
  memo.set(unit.key, out);
  return out;
}

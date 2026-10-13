import { readFileSync } from "node:fs";
import * as path from "node:path";
import { LangSpec, languageById } from "./languages.js";
import { parserFor } from "./treesitter.js";
import { braceSites, BraceLang } from "./bracelang.js";
import { catalogFile, FileCatalog, FnRecord } from "./catalog.js";
import { SourceEntry } from "./project.js";
import { isDynamicCallee, NameAsString } from "./dynamic.js";

/**
 * Call sites in languages without a type checker here: Python, Go, Java,
 * Kotlin, Swift, C#, Ruby, Rust, PHP, C/C++, Scala, Elixir, Bash.
 *
 * Each use of the name is found in the syntax tree (so comments and strings
 * are not mistaken for calls), and then bound to a declaration only on
 * evidence, which is reported with the site:
 *
 *  - same file, or the class it sits in (`self.total()`, a bare call);
 *  - qualified by the declaring class or module (`Order.total`, `Fees::calc`,
 *    `fees.calc` after `from billing import fees`);
 *  - imported by name (`from billing.fees import calc`, `use crate::fees::calc`);
 *  - same Go package (directory), same Kotlin `package`, same Swift module;
 *  - a receiver whose declared type is the declaring class (`order: Order`,
 *    `Order order`, `o := &Order{}`, `$o = new Order()`).
 *
 * Without such evidence a site is `likely` (the name is declared only once
 * in that language family, but nothing proves the binding) or `ambiguous`
 * (several declarations share the name). A string or symbol equal to the
 * name (`getattr(o, "calc")`, `send(:calc)`, `getMethod("calc")`) is listed as
 * a possible dynamic call. Nothing here is type-checked; the output says so.
 */

export interface PolyTarget {
  rec: FnRecord;
  family: string;
  /** Last segment of each enclosing class/module name. */
  containers: string[];
  stem: string;
  dir: string;
  dirAbs: string;
  topLevel: boolean;
  /** Kotlin `package` of the declaring file. */
  pkg?: string;
}

export type PolyResolution = "resolved" | "likely" | "ambiguous" | "dynamic" | "reference";

export interface PolySite {
  file: string;
  line: number;
  language: string;
  enclosing: string;
  enclosingLine: number;
  enclosingParams: string[];
  snippet: string;
  kind: "call" | "reference" | "string";
  resolution: PolyResolution;
  target?: string;
  candidates?: string[];
  reason: string;
}

export function familyOf(language: string): string {
  return languageById(language)?.family ?? language;
}

const SELF = new Set(["self", "this", "Self", "$this", "static", "@", "super", "parent", "cls", "base", "me"]);

function lastSegment(receiver: string): string {
  const parts = receiver.split(/\?\.|&\.|\.|::|->|\\/).map((p) => p.replace(/[$@&*()\s]/g, "").replace(/\[.*\]$/, "")).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function kotlinPackage(text: string): string | undefined {
  return text.match(/^\s*package\s+([\w.]+)/m)?.[1];
}

export function polyTarget(rec: FnRecord, abs: string, text?: string): PolyTarget {
  const segs = rec.name.split(".");
  segs.pop();
  const base = path.basename(rec.file).replace(/\.[^.]+$/, "");
  const dirAbs = path.dirname(abs);
  return {
    rec,
    family: familyOf(rec.language),
    containers: segs.map((s) => s.replace(/<.*>$/, "")),
    stem: base === "__init__" || base === "mod" || base === "index" ? path.basename(dirAbs) : base,
    dir: path.basename(dirAbs),
    dirAbs,
    topLevel: segs.length === 0,
    pkg: rec.language === "kotlin" && text ? kotlinPackage(text) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Finding uses of a name in one file.

interface RawUse {
  offset: number;
  end: number;
  receiver: string;
  kind: "call" | "reference" | "string";
  /** For a string: whether it is passed to a dynamic-dispatch API. */
  dynamic?: boolean;
}

/**
 * A string passed to a dynamic-dispatch API (`getattr(o, "x")`,
 * `send(:x)`, `call_user_func('x')`), or a PHP callable array `[$o, 'x']`.
 */
function dynamicContext(n: any, text: string): boolean {
  let cur = n;
  for (let d = 0; d < 4 && cur.parent; d++) {
    const p = cur.parent;
    if (p.type === "array_creation_expression" && p.namedChildCount === 2) return true;
    if (CALL_TYPES.has(p.type)) {
      const fnNode = p.childForFieldName("function") ?? p.childForFieldName("method") ?? p.childForFieldName("name") ?? p.childForFieldName("target") ?? p.child(0);
      let callee = fnNode ? text.slice(fnNode.startIndex, fnNode.endIndex) : "";
      // Elixir `Kernel.apply(Mod, :fun, args)` and `apply(...)`; Ruby `obj.send(:x)` (method field).
      if (!callee) callee = text.slice(p.startIndex, n.startIndex).replace(/\(.*$/s, "");
      return isDynamicCallee(callee);
    }
    cur = p;
  }
  return false;
}

const CALL_TYPES = new Set([
  "call", "call_expression", "method_invocation", "invocation_expression", "function_call_expression",
  "member_call_expression", "scoped_call_expression", "nullsafe_member_call_expression", "method_call",
  "macro_invocation", "command", "object_creation_expression", "generic_function",
]);

/** Ancestors past which a name is no longer the callee of a call. */
const CALL_BARRIER = /argument|parameter|block|body|statement|assignment|binary|list|array|pair|keyword|declaration|definition|lambda|closure|return|if|for|while/;

const STRINGISH = /string|symbol|atom|char_literal/;

/** Import/use declarations across grammars: Python, Go, Java, Rust, PHP, C#, Scala, C/C++ includes. */
const IMPORT_NODE = /^(import_statement|import_from_statement|future_import_statement|import_declaration|import_spec|import_spec_list|use_declaration|namespace_use_declaration|using_directive|preproc_include|package_clause|package_declaration)$/;

function unquote(s: string): string {
  return s
    .replace(/^[:@]?[rRbBuUfF$@]*("""|'''|"|'|`)/, "")
    .replace(/("""|'''|"|'|`)$/, "")
    .replace(/^:/, "");
}

/** Start offsets of every declared function/container name in a tree-sitter file. */
function declNames(root: any, lang: LangSpec): Set<number> {
  const out = new Set<number>();
  const fn = new Set(lang.functionNodes);
  const cont = new Set(lang.containerNodes);
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (fn.has(n.type) || cont.has(n.type)) {
      const name = n.childForFieldName("name");
      if (name) out.add(name.startIndex);
      if (lang.declaratorNodes?.includes(n.type)) {
        let d = n.childForFieldName("declarator");
        while (d) {
          const inner = d.childForFieldName("declarator");
          if (!inner) {
            for (let i = 0; i < d.childCount; i++) {
              const c = d.child(i);
              if (c && /identifier|operator_name|destructor_name/.test(c.type)) out.add(c.startIndex);
            }
            if (/identifier/.test(d.type)) out.add(d.startIndex);
            break;
          }
          d = inner;
        }
      }
    }
    // Elixir: `def name(…)` is a call to `def` whose first argument names the function.
    if (lang.callDefinition && n.type === lang.callDefinition.node) {
      const target = n.childForFieldName("target") ?? n.child(0);
      if (target && [...lang.callDefinition.functionKeywords, ...lang.callDefinition.containerKeywords].includes(target.text)) {
        const args = n.childForFieldName("arguments") ?? n.child(1);
        const a = args?.namedChild(0);
        const head = a?.type === "call" ? (a.childForFieldName("target") ?? a.child(0)) : a;
        if (head) out.add(head.startIndex);
      }
    }
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
  }
  return out;
}

async function treeSitterUses(text: string, lang: LangSpec, name: string): Promise<RawUse[] | undefined> {
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
    const decls = declNames(tree.rootNode, lang);
    const out: RawUse[] = [];
    const stack = [tree.rootNode];
    while (stack.length) {
      const n = stack.pop();
      if (/comment/.test(n.type)) continue;
      if (STRINGISH.test(n.type) && n.type !== "string_content") {
        if (unquote(n.text) === name) out.push({ offset: n.startIndex, end: n.endIndex, receiver: "", kind: "string", dynamic: dynamicContext(n, text) });
        continue;
      }
      if (IMPORT_NODE.test(n.type)) continue; // import plumbing names the function, it does not use it
      if (n.childCount === 0) {
        if (n.text !== name || decls.has(n.startIndex)) continue;
        const use = classifyLeaf(n, text);
        if (!use) continue;
        // Ruby calls a method with no receiver and no parentheses as a bare
        // word; it is a call unless the name is assigned as a local somewhere.
        if (lang.id === "ruby" && use.kind === "reference" && !use.receiver && n.type === "identifier" &&
            !new RegExp(`(^|[^\\w@$.])${escapeRe(name)}\\s*=(?![=~>])`).test(text)) {
          use.kind = "call";
        }
        out.push(use);
        continue;
      }
      for (let i = n.childCount - 1; i >= 0; i--) stack.push(n.child(i));
    }
    return out;
  } finally {
    tree.delete();
  }
}

function classifyLeaf(leaf: any, text: string): RawUse | undefined {
  // Elixir `alias Billing.Fees` / `import Billing.Fees, only: [calc: 1]`: plumbing, not a use.
  for (let p = leaf.parent, d = 0; p && d < 6; p = p.parent, d++) {
    if (p.type === "call" && /^(alias|import|require|use)\b/.test(p.text)) return undefined;
  }
  let cur = leaf;
  for (let depth = 0; depth < 5; depth++) {
    const p = cur.parent;
    if (!p) break;
    if (CALL_TYPES.has(p.type)) {
      if (p.type === "command") {
        // Bash: only the command name is a call; its arguments are words.
        const nm = p.childForFieldName("name");
        if (!nm || leaf.startIndex < nm.startIndex || leaf.endIndex > nm.endIndex) break;
      } else if (p.type === "object_creation_expression") {
        break;
      } else {
        let args = p.childForFieldName("arguments");
        if (!args) {
          for (let i = 0; i < p.childCount; i++) {
            const c = p.child(i);
            if (c && /argument/.test(c.type)) { args = c; break; }
          }
        }
        if (args && leaf.startIndex >= args.startIndex && leaf.endIndex <= args.endIndex) break;
      }
      const callee = text.slice(p.startIndex, leaf.startIndex);
      return { offset: leaf.startIndex, end: leaf.endIndex, receiver: callee.replace(/\s+/g, ""), kind: "call" };
    }
    if (CALL_BARRIER.test(p.type)) break;
    cur = p;
  }
  // Not called here: a reference, with whatever qualifies it.
  const before = text.slice(Math.max(0, leaf.startIndex - 120), leaf.startIndex);
  const m = before.match(/([\w$@\\]+(?:(?:\?\.|&\.|\.|::|->|\\)[\w$@]+)*)(?:\?\.|&\.|\.|::|->|\\)$/);
  return { offset: leaf.startIndex, end: leaf.endIndex, receiver: m?.[1] ?? "", kind: "reference" };
}

/** The receiver part of a callee text: `order.total` → `order`, `Fees::calc` → `Fees`. */
function receiverOf(calleePrefix: string): string {
  return calleePrefix.replace(/(\?\.|&\.|\.|::|->|\\|!\.)$/, "");
}

// ---------------------------------------------------------------------------
// Binding a use to a declaration.

interface FileFacts {
  entry: SourceEntry;
  text: string;
  imports: string[];
  pkg?: string;
}

function importLines(text: string, lang: LangSpec): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  let inGo = false;
  for (const l of lines) {
    if (lang.id === "go") {
      if (/^\s*import\s*\($/.test(l)) { inGo = true; continue; }
      if (inGo) { if (/^\s*\)/.test(l)) inGo = false; else if (l.trim()) out.push(l.trim()); continue; }
    }
    if (lang.importLine.test(l)) out.push(l.trim());
    // PHP/C#/Elixir aliases and Ruby requires are import lines too.
  }
  return out;
}

const wordsOf = (s: string) => new Set(s.split(/[^\w$]+/).filter(Boolean));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does the file declare `recv` as an instance of `type`? */
function receiverHasType(text: string, recv: string, type: string): boolean {
  if (!recv || !type || !/^[\w$]+$/.test(recv)) return false;
  const r = escapeRe(recv);
  const t = escapeRe(type);
  const patterns = [
    `\\b${r}\\s*:\\s*[?*&]?(?:mut\\s+)?(?:[\\w.]+\\.)?${t}\\b`, //       order: Order, o: &mut Order, val o: com.x.Order
    `\\b${t}(?:<[^>]*>)?\\s*[*&?]?\\s+\\$?${r}\\b`, //                   Order order, Order* o, Order $o
    `\\b${r}\\s+\\*?(?:[\\w.]+\\.)?${t}\\b`, //                          o *Order (Go)
    `\\$?${r}\\s*(?::=|=)\\s*(?:new\\s+|&)?(?:[\\w.]+\\.)?${t}\\s*(?:\\(|\\{|::new|\\.new\\b|\\.init\\b)`, // o = Order(…), o := &Order{}, o = Order.new
    `\\b(?:val|var|let|const)\\s+${r}\\s*=\\s*(?:[\\w.]+\\.)?${t}\\s*\\(`,
  ];
  return patterns.some((p) => new RegExp(p).test(text));
}

export interface PolyCallersResult {
  sites: PolySite[];
  otherSameName: Map<string, number>;
  notAnalyzed: string[];
  nameAsString: NameAsString;
}

export async function polyCallers(
  base: string,
  targets: PolyTarget[],
  entries: SourceEntry[],
  /** Every non-TS declaration named `base` repo-wide (targets or not), to tell "other symbol" from "no declaration". */
  allSameName: PolyTarget[],
): Promise<PolyCallersResult> {
  const wordRe = new RegExp(`(^|[^\\w$])${escapeRe(base)}($|[^\\w$])`);
  const sites: PolySite[] = [];
  const otherSameName = new Map<string, number>();
  const notAnalyzed: string[] = [];
  const nameAsString: NameAsString = { count: 0, samples: [] };
  const targetIds = new Set(targets.map((t) => t.rec.id));
  const bump = (k: string) => otherSameName.set(k, (otherSameName.get(k) ?? 0) + 1);

  for (const entry of entries) {
    const lang = languageById(entry.language);
    if (!lang) continue;
    let text: string;
    try {
      text = readFileSync(entry.abs, "utf8");
    } catch {
      continue;
    }
    if (!wordRe.test(text)) continue;
    const fc: FileCatalog = await catalogFile(entry);
    let uses: RawUse[] | undefined;
    if (lang.engine === "brace") {
      uses = braceSites(text, lang.id as BraceLang, base, fc.declOffsets ?? new Set())
        .filter((s) => !/^\s*(@testable\s+)?import\s/.test(text.slice(text.lastIndexOf("\n", s.offset - 1) + 1, s.offset)))
        .map((s) => ({
        offset: s.offset,
        end: s.offset + base.length,
        receiver: s.receiver ? `${s.receiver}.` : "",
        kind: s.kind,
        dynamic: s.dynamic,
      }));
    } else {
      uses = await treeSitterUses(text, lang, base);
    }
    if (!uses) {
      notAnalyzed.push(entry.rel);
      continue;
    }
    if (!uses.length) continue;
    const facts: FileFacts = { entry, text, imports: importLines(text, lang), pkg: lang.id === "kotlin" ? kotlinPackage(text) : undefined };
    const family = familyOf(entry.language);
    const sameFamily = targets.filter((t) => t.family === family);
    const othersInFamily = allSameName.filter((t) => t.family === family && !targetIds.has(t.rec.id));

    for (const use of uses) {
      const line = text.slice(0, use.offset).split("\n").length;
      const enc = enclosing(fc, use.offset);
      const lineText = text.split("\n")[line - 1]?.trim().replace(/\s+/g, " ") ?? "";
      const site = {
        file: entry.rel,
        line,
        language: entry.language,
        enclosing: enc.name,
        enclosingLine: enc.line,
        enclosingParams: enc.params,
        snippet: lineText.length > 120 ? lineText.slice(0, 119) + "…" : lineText,
        kind: use.kind,
      };
      if (use.kind === "string") {
        if (!sameFamily.length && !targets.length) continue;
        if (use.dynamic) {
          sites.push({ ...site, resolution: "dynamic", reason: "the name passed to a dynamic-dispatch API (getattr, send, call_user_func, getMethod, selector…) — a dynamic call; check by hand" });
        } else {
          nameAsString.count++;
          if (nameAsString.samples.length < 5) nameAsString.samples.push(`${entry.rel}:${line} ${lineText.slice(0, 80)}`);
        }
        continue;
      }
      const recv = receiverOf(use.receiver);
      const bound = bind(base, recv, line, enc.qualified, facts, sameFamily, othersInFamily);
      if (!bound) {
        if (othersInFamily.length) bump(`${base} in ${entry.language} (bound to another declaration of the name)`);
        else if (use.kind === "call") bump(`${base} in ${entry.language} (no declaration in the repo: library or built-in)`);
        continue;
      }
      if (use.kind === "reference" && bound.resolution !== "resolved") {
        // An unqualified name that is not called is often a local variable;
        // only references bound on evidence are worth listing.
        bump(`${base} in ${entry.language} (mentioned, not called; binding unproven)`);
        continue;
      }
      sites.push({
        ...site,
        resolution: use.kind === "reference" ? "reference" : bound.resolution,
        target: bound.target?.rec.name,
        candidates: bound.candidates,
        reason: use.kind === "reference" ? `used as a value, not called here; ${bound.reason}` : bound.reason,
      });
    }
  }
  return { sites, otherSameName, notAnalyzed, nameAsString };
}

function enclosing(fc: FileCatalog, offset: number): { name: string; qualified: string; line: number; params: string[] } {
  let best: FileCatalog["functions"][number] | undefined;
  for (const f of fc.functions) {
    if (f.startOffset <= offset && offset < f.endOffset) {
      if (!best || f.endOffset - f.startOffset < best.endOffset - best.startOffset) best = f;
    }
  }
  if (!best) return { name: "<top-level>", qualified: "", line: 1, params: [] };
  return { name: best.rec.name, qualified: best.rec.name, line: best.rec.start, params: best.rec.params };
}

function bind(
  base: string,
  recv: string,
  line: number,
  enclosingQualified: string,
  f: FileFacts,
  candidates: PolyTarget[],
  others: PolyTarget[],
): { resolution: PolyResolution; target?: PolyTarget; candidates?: string[]; reason: string } | undefined {
  const all = [...candidates, ...others];
  if (!all.length) return undefined;
  const ok = (t: PolyTarget, reason: string) =>
    candidates.includes(t) ? { resolution: "resolved" as const, target: t, reason } : undefined;
  const pick = (ts: PolyTarget[], reason: (t: PolyTarget) => string) => {
    if (ts.length === 1) return ok(ts[0], reason(ts[0])) ?? null;
    if (ts.length > 1 && ts.every((t) => !candidates.includes(t))) return null;
    return undefined;
  };
  const q = lastSegment(recv);
  const selfish = !recv || SELF.has(q) || /^(self|this)$/.test(recv);
  const enclosingContainers = enclosingQualified.split(".").slice(0, -1);

  if (selfish) {
    // Same file; with several, the one in the class the call sits in.
    const sameFile = all.filter((t) => t.rec.file === f.entry.rel);
    if (sameFile.length) {
      const inClass = sameFile.filter((t) => t.containers.length && t.containers.every((c) => enclosingContainers.includes(c)));
      const r = pick(inClass.length ? inClass : sameFile, (t) => (inClass.length ? `same class (${t.containers.join(".")})` : "declared in the same file"));
      if (r !== undefined) return r ?? undefined;
    }
    if (!recv) {
      // Imported by name, or a whole module imported.
      const imported = all.filter((t) => f.imports.some((l) => {
        const w = wordsOf(l);
        const mod = w.has(t.stem) || t.containers.some((c) => w.has(c)) || (t.dir && w.has(t.dir));
        return mod && (w.has(base) || /\*|^\s*(import|use)\s+[\w.]+\s*$/.test(l) || f.entry.language === "elixir");
      }));
      const r = pick(imported, (t) => `imported (${f.imports.find((l) => wordsOf(l).has(t.stem) || t.containers.some((c) => wordsOf(l).has(c)) || wordsOf(l).has(t.dir))})`);
      if (r !== undefined) return r ?? undefined;
      const lang = f.entry.language;
      if (lang === "go") {
        const r2 = pick(all.filter((t) => t.dirAbs === path.dirname(f.entry.abs) && t.topLevel), () => "same Go package (directory)");
        if (r2 !== undefined) return r2 ?? undefined;
      }
      if (lang === "kotlin" && f.pkg) {
        const r2 = pick(all.filter((t) => t.pkg === f.pkg && t.topLevel), () => `same Kotlin package ${f.pkg}`);
        if (r2 !== undefined) return r2 ?? undefined;
      }
      if (lang === "swift") {
        const r2 = pick(all.filter((t) => t.rec.service === f.entry.service && t.topLevel), () => "same Swift module (project)");
        if (r2 !== undefined) return r2 ?? undefined;
      }
      if (lang === "c" || lang === "cpp") {
        const r2 = pick(all.filter((t) => f.imports.some((l) => l.includes(t.stem + "."))), (t) => `declared in an included header/source (${t.stem})`);
        if (r2 !== undefined) return r2 ?? undefined;
      }
    }
  } else {
    // Qualified by the declaring class/module.
    const byContainer = all.filter((t) => t.containers.length && t.containers[t.containers.length - 1].split(".").pop() === q);
    let r = pick(byContainer, (t) => `qualified by ${t.containers[t.containers.length - 1]}`);
    if (r !== undefined) return r ?? undefined;
    // A module: `fees.calc` with fees imported, or an alias for it.
    const byModule = all.filter((t) => {
      if (q === t.stem || q === t.dir) return f.imports.some((l) => wordsOf(l).has(q)) || f.entry.language === "go" || f.entry.language === "rust";
      return f.imports.some((l) => {
        const w = wordsOf(l);
        return w.has(q) && (w.has(t.stem) || w.has(t.dir) || t.containers.some((c) => w.has(c))) && /\bas\b|^\s*(import\s+)?\w+\s+"|alias/.test(l);
      });
    });
    r = pick(byModule, (t) => (q === t.stem || q === t.dir ? `module ${q}` : `alias ${q} for ${t.stem}`));
    if (r !== undefined) return r ?? undefined;
    // A receiver whose declared type is the declaring class.
    const byType = all.filter((t) => t.containers.length && receiverHasType(f.text, q, t.containers[t.containers.length - 1].split(".").pop()!));
    r = pick(byType, (t) => `receiver ${q} is declared as ${t.containers[t.containers.length - 1]}`);
    if (r !== undefined) return r ?? undefined;
  }

  if (candidates.length === 1 && !others.length) {
    return {
      resolution: "likely",
      target: candidates[0],
      reason: `only declaration of ${base} in ${candidates[0].family}${recv ? `; receiver ${recv} not proven to be ${candidates[0].containers.join(".") || "its module"}` : ""} — not type-checked`,
    };
  }
  if (!candidates.length) return undefined;
  return {
    resolution: "ambiguous",
    candidates: all.map((t) => `${t.rec.name} (${t.rec.file}:${t.rec.start})`),
    reason: `${all.length} declarations named ${base} in ${candidates[0].family}${recv ? `; receiver ${recv}` : ""} — could be any of them`,
  };
}

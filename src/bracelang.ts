import type { RawFunction, RawType } from "./treesitter.js";
import { docAbove } from "./treesitter.js";
import { isDynamicCallee } from "./dynamic.js";

/**
 * Kotlin and Swift, read by a structural scanner instead of a tree-sitter
 * grammar.
 *
 * The published Kotlin grammar mis-parses ordinary code under the runtime this
 * server ships (`object Util { … }` becomes an ERROR node that swallows the
 * declarations after it), and no Swift grammar builds for it at all. A wrong
 * tree is worse than none, so these two languages get a scanner that is
 * honest about what it knows: it lexes strings (with interpolation, raw and
 * multi-line forms), comments (nested) and brackets exactly, and recognises
 * declarations by their keywords — `fun`, `func`, `init`, `constructor`,
 * `class`, `object`, `struct`, `extension`, … — which is all a function
 * catalog and a call-site search need.
 */

export type BraceLang = "kotlin" | "swift";

export interface Tok {
  /** id: identifier or keyword; p: punctuation; str: string literal; num: number. */
  t: "id" | "p" | "str" | "num";
  v: string;
  s: number;
  e: number;
  /** A newline separates this token from the previous one. */
  nl: boolean;
}

const MULTI_PUNCT = ["?.", "!.", "::", "->", "?:", "&&", "||", "==", "!=", "<=", ">=", "+=", "-=", "..", "=>"];

/** Tokens of `text`, comments dropped, string interpolations lexed as code. */
export function lex(text: string, lang: BraceLang): { toks: Tok[]; errorAt?: number } {
  const toks: Tok[] = [];
  let i = 0;
  let nl = false;
  let errorAt: number | undefined;
  const n = text.length;

  const isIdStart = (c: string) => /[\p{L}_$]/u.test(c);
  const isId = (c: string) => /[\p{L}\p{N}_$]/u.test(c);

  const push = (t: Tok["t"], v: string, s: number, e: number) => {
    toks.push({ t, v, s, e, nl });
    nl = false;
  };

  /** Lex code until the bracket that closes an interpolation (depth 0). */
  const lexCodeUntil = (closer: ")" | "}") => {
    const opener = closer === ")" ? "(" : "{";
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === closer && depth === 0) {
        i++;
        return;
      }
      if (c === opener) depth++;
      else if (c === closer) depth--;
      if (!lexOne()) i++;
    }
    errorAt ??= n;
  };

  const lexKotlinString = (start: number) => {
    const triple = text.startsWith('"""', i);
    i += triple ? 3 : 1;
    let content = "";
    let plain = true;
    while (i < n) {
      if (triple) {
        if (text.startsWith('"""', i)) {
          i += 3;
          while (text[i] === '"') i++; // `""""` ends with a quote in the content
          break;
        }
      } else {
        if (text[i] === "\\") { content += text.slice(i, i + 2); i += 2; continue; }
        if (text[i] === '"') { i++; break; }
        if (text[i] === "\n") { errorAt ??= i; break; }
      }
      if (text[i] === "$" && text[i + 1] === "{") {
        plain = false;
        i += 2;
        lexCodeUntil("}");
        continue;
      }
      content += text[i];
      i++;
    }
    toks.push({ t: "str", v: plain ? content : "", s: start, e: i, nl: false });
  };

  const lexSwiftString = (start: number) => {
    let hashes = 0;
    while (text[i] === "#") { hashes++; i++; }
    const triple = text.startsWith('"""', i);
    i += triple ? 3 : 1;
    const close = (triple ? '"""' : '"') + "#".repeat(hashes);
    const interp = "\\" + "#".repeat(hashes) + "(";
    let content = "";
    let plain = true;
    while (i < n) {
      if (text.startsWith(close, i)) { i += close.length; break; }
      if (text.startsWith(interp, i)) {
        plain = false;
        i += interp.length;
        lexCodeUntil(")");
        continue;
      }
      if (hashes === 0 && text[i] === "\\") { content += text.slice(i, i + 2); i += 2; continue; }
      if (!triple && text[i] === "\n") { errorAt ??= i; break; }
      content += text[i];
      i++;
    }
    toks.push({ t: "str", v: plain ? content : "", s: start, e: i, nl: false });
  };

  /** One token (or comment/whitespace) at `i`. False when nothing was consumed. */
  function lexOne(): boolean {
    const c = text[i];
    if (c === "\n") { nl = true; i++; return true; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") { i++; return true; }
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
      return true;
    }
    if (c === "/" && text[i + 1] === "*") {
      // Both languages nest block comments.
      let depth = 0;
      while (i < n) {
        if (text.startsWith("/*", i)) { depth++; i += 2; continue; }
        if (text.startsWith("*/", i)) { depth--; i += 2; if (depth === 0) break; continue; }
        if (text[i] === "\n") nl = true;
        i++;
      }
      if (depth > 0) errorAt ??= n;
      return true;
    }
    const start = i;
    if (c === '"') {
      const wasNl = nl;
      nl = false;
      if (lang === "kotlin") lexKotlinString(start);
      else lexSwiftString(start);
      toks[toks.length - 1].nl = wasNl && toks[toks.length - 1].s === start ? true : toks[toks.length - 1].nl;
      return true;
    }
    if (lang === "swift" && c === "#" && /^#+"/.test(text.slice(i, i + 8))) {
      lexSwiftString(start);
      return true;
    }
    if (lang === "kotlin" && c === "'") {
      // Char literal: 'a', '\n', '\u0041'.
      const m = text.slice(i).match(/^'(\\u[0-9a-fA-F]{4}|\\.|[^'\\])'/);
      i += m ? m[0].length : 1;
      push("str", m ? m[1] : "", start, i);
      return true;
    }
    if (c === "`") {
      const e = text.indexOf("`", i + 1);
      if (e > i && !text.slice(i + 1, e).includes("\n")) {
        push("id", text.slice(i + 1, e), start, e + 1);
        i = e + 1;
        return true;
      }
    }
    if (isIdStart(c)) {
      while (i < n && isId(text[i])) i++;
      push("id", text.slice(start, i), start, i);
      return true;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[\w.]/.test(text[i]) && !(text[i] === "." && text[i + 1] === ".")) i++;
      push("num", text.slice(start, i), start, i);
      return true;
    }
    for (const p of MULTI_PUNCT) {
      if (text.startsWith(p, i)) {
        i += p.length;
        push("p", p, start, i);
        return true;
      }
    }
    i++;
    push("p", c, start, i);
    return true;
  }

  while (i < n) lexOne();
  return { toks, errorAt };
}

// ---------------------------------------------------------------------------

const KOTLIN_CONTAINERS = new Set(["class", "interface", "object"]);
const SWIFT_CONTAINERS = new Set(["class", "struct", "enum", "protocol", "extension", "actor"]);

const MODIFIERS = new Set([
  "public", "private", "internal", "protected", "open", "override", "final", "abstract", "static",
  "suspend", "inline", "operator", "infix", "tailrec", "external", "fileprivate", "mutating",
  "nonmutating", "convenience", "required", "lazy", "weak", "unowned", "dynamic", "optional",
  "data", "sealed", "enum", "annotation", "inner", "value", "companion", "actual", "expect", "const",
  "lateinit", "nonisolated", "isolated", "indirect", "noinline", "crossinline", "reified", "package",
  "distributed", "consuming", "borrowing",
]);

/** Keywords that begin a new declaration or statement: a header never runs past one on a new line. */
const DECL_START = new Set([
  "class", "interface", "object", "fun", "val", "var", "func", "struct", "enum", "protocol", "extension",
  "let", "import", "package", "typealias", "init", "constructor", "deinit", "subscript", "actor",
  "return", "if", "for", "while", "when", "switch", "guard", "do", "try", "throw", "else",
  ...MODIFIERS,
]);

const CONTINUATION_END = new Set([".", "?.", "!.", "=", "+", "-", "*", "/", "%", "&&", "||", "?:", ",", "(", "[", "{", "->", "::", ":", "==", "!=", "<", ">", "<=", ">=", "..", "!", "?"]);
const CONTINUATION_START = new Set([".", "?.", "!.", "?:", "&&", "||", ")", "]", "->", "::", "+", "*", "/", "%", "==", "!=", "as", "is", "in", "else", "catch", "finally"]);

interface Frame {
  name: string;
  isFunction: boolean;
  isStatic?: boolean;
}

export interface BraceResult {
  functions: RawFunction[];
  types: RawType[];
  errorLine?: number;
  /** Offsets of each catalogued function's name token, so a call-site search can skip declarations. */
  nameOffsets: Set<number>;
}

function lineAt(text: string, offset: number, lineStarts: number[]): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function extractBraceFunctions(text: string, lang: BraceLang): BraceResult {
  const { toks, errorAt } = lex(text, lang);
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") lineStarts.push(k + 1);
  const line = (off: number) => lineAt(text, off, lineStarts);
  const lines = text.split("\n");

  // Bracket matching, once.
  const match = new Int32Array(toks.length).fill(-1);
  const stack: number[] = [];
  let firstError: number | undefined = errorAt;
  for (let k = 0; k < toks.length; k++) {
    const v = toks[k].t === "p" ? toks[k].v : "";
    if (v === "{" || v === "(" || v === "[") stack.push(k);
    else if (v === "}" || v === ")" || v === "]") {
      const want = v === "}" ? "{" : v === ")" ? "(" : "[";
      if (stack.length && toks[stack[stack.length - 1]].v === want) {
        const o = stack.pop()!;
        match[o] = k;
        match[k] = o;
      } else {
        firstError ??= toks[k].s;
      }
    }
  }
  if (stack.length) firstError ??= toks[stack[0]].s;

  const containers = lang === "kotlin" ? KOTLIN_CONTAINERS : SWIFT_CONTAINERS;
  const functions: RawFunction[] = [];
  const types: RawType[] = [];
  const nameOffsets = new Set<number>();
  const isP = (k: number, v: string) => k < toks.length && toks[k].t === "p" && toks[k].v === v;
  const isId = (k: number, v?: string) => k < toks.length && toks[k].t === "id" && (v === undefined || toks[k].v === v);

  /** Skip a `<…>` generic group starting at k; returns the index after it. */
  const skipAngles = (k: number): number => {
    if (!isP(k, "<")) return k;
    let depth = 0;
    for (; k < toks.length; k++) {
      if (isP(k, "<")) depth++;
      else if (isP(k, ">")) { depth--; if (depth === 0) return k + 1; }
      else if (isP(k, "{") || isP(k, "}") || isP(k, ";")) return k;
      else if (isP(k, "(") && match[k] > k) k = match[k];
    }
    return k;
  };

  /** Modifiers and annotations right before a keyword at k; returns their first index. */
  const prefixStart = (k: number, floor: number): { start: number; mods: Set<string> } => {
    const mods = new Set<string>();
    let j = k - 1;
    while (j >= floor) {
      const tk = toks[j];
      if (tk.t === "id" && (MODIFIERS.has(tk.v) || (lang === "swift" && tk.v === "class"))) {
        mods.add(tk.v);
        j--;
        continue;
      }
      // `@Annotation`, `@Annotation(...)`, `@objc`, `@MainActor` — but not
      // Kotlin's `this@Outer` label, where `@` is glued to the word before it.
      const isAt = (a: number) => isP(a, "@") && !(a > 0 && toks[a - 1].e === toks[a].s && toks[a - 1].t === "id");
      if (tk.t === "p" && tk.v === ")" && match[j] > 0) {
        const o = match[j];
        if (o >= 2 && isId(o - 1) && isAt(o - 2)) { j = o - 3; continue; }
        break;
      }
      if (tk.t === "id" && j >= 1 && isAt(j - 1)) { j -= 2; continue; }
      if (tk.t === "id" && j >= 3 && isP(j - 1, ".") && isId(j - 2) && isAt(j - 3)) { j -= 4; continue; }
      break;
    }
    return { start: j + 1, mods };
  };

  /** Where a statement that does not end in a brace ends (Kotlin `= expr` bodies). */
  const expressionEnd = (k: number, limit: number): number => {
    let last = k;
    for (let j = k; j < limit; j++) {
      const tk = toks[j];
      if (tk.t === "p" && (tk.v === "}" || tk.v === ")" || tk.v === "]") && match[j] < k) break;
      if (j > k && tk.nl) {
        const prev = toks[j - 1];
        const contEnd = prev.t === "p" && CONTINUATION_END.has(prev.v);
        const contStart = (tk.t === "p" && CONTINUATION_START.has(tk.v)) || (tk.t === "id" && CONTINUATION_START.has(tk.v));
        if (!contEnd && !contStart) break;
      }
      if (tk.t === "p" && tk.v === ";") break;
      if (tk.t === "p" && (tk.v === "{" || tk.v === "(" || tk.v === "[") && match[j] > j) {
        j = Math.min(match[j], limit - 1);
      }
      last = j;
    }
    return last;
  };

  const paramsOf = (open: number): string[] => {
    const close = match[open];
    if (close < 0) return [];
    const out: string[] = [];
    let from = toks[open].e;
    for (let j = open + 1; j < close; j++) {
      if ((isP(j, "(") || isP(j, "[") || isP(j, "{")) && match[j] > j) { j = match[j]; continue; }
      if (isP(j, "<")) { const a = skipAngles(j); if (a > j + 1) { j = a - 1; continue; } }
      if (isP(j, ",")) {
        const p = collapse(text.slice(from, toks[j].s));
        if (p) out.push(p);
        from = toks[j].e;
      }
    }
    const p = collapse(text.slice(from, toks[close].s));
    if (p) out.push(p);
    return out;
  };

  const record = (
    scope: Frame[],
    name: string,
    nameTok: number,
    kind: string,
    startTok: number,
    endOffset: number,
    sigEndOffset: number,
    params: string[],
    returnType: string | undefined,
    mods: Set<string>,
    extra: { receiver?: string; isAsync?: boolean } = {},
  ) => {
    const qualifier = scope.map((f) => f.name);
    if (extra.receiver) qualifier.push(extra.receiver);
    const inFunction = scope.length > 0 && scope[scope.length - 1].isFunction;
    const inStaticScope = scope.length > 0 && !!scope[scope.length - 1].isStatic;
    if (inFunction && (kind === "method" || kind === "function")) kind = "nested function";
    const vis =
      mods.has("private") ? "private" : mods.has("fileprivate") ? "fileprivate" : mods.has("protected") ? "protected" :
      mods.has("internal") ? "internal" : mods.has("public") ? "public" : mods.has("open") ? "open" :
      lang === "kotlin" ? "public" : "internal";
    const startOffset = toks[startTok].s;
    const start = line(startOffset);
    let signature = collapse(text.slice(startOffset, sigEndOffset)).replace(/\s*(\{|=)\s*$/, "");
    if (signature.length > 300) signature = signature.slice(0, 299) + "…";
    nameOffsets.add(toks[nameTok].s);
    functions.push({
      name,
      qualifier,
      kind,
      start,
      end: line(Math.max(startOffset, endOffset - 1)),
      startOffset,
      endOffset,
      signature,
      params,
      returnType,
      exported: !inFunction && (vis === "public" || vis === "open"),
      visibility: vis,
      isStatic: mods.has("static") || (lang === "swift" && mods.has("class")) || inStaticScope || undefined,
      isAsync: mods.has("suspend") || extra.isAsync || undefined,
      doc: docAbove(lines, start, /^\s*(\/\/|\/\*|\*)/),
    });
  };

  /** Return type text after `)` at k (Kotlin `: T`, Swift `-> T`), and where the header continues. */
  const returnTypeAt = (k: number, limit: number): { type?: string; next: number; isAsync?: boolean } => {
    let isAsync: boolean | undefined;
    // Swift effects between `)` and `->`.
    while (isId(k, "async") || isId(k, "throws") || isId(k, "rethrows")) {
      if (toks[k].v === "async") isAsync = true;
      k++;
      if (isP(k, "(") && match[k] > k) k = match[k] + 1; // typed throws: throws(MyError)
    }
    const marker = lang === "kotlin" ? ":" : "->";
    if (!isP(k, marker)) return { next: k, isAsync };
    const from = k + 1;
    let j = from;
    for (; j < limit; j++) {
      const tk = toks[j];
      if (j > from && tk.nl && tk.t === "id" && DECL_START.has(tk.v)) break;
      if (tk.t === "p" && (tk.v === "{" || tk.v === "=" || tk.v === "}" || tk.v === ";")) break;
      if (tk.t === "id" && tk.v === "where") break;
      if (tk.t === "p" && (tk.v === "(" || tk.v === "[") && match[j] > j) j = match[j];
      else if (tk.t === "p" && tk.v === "<") { const a = skipAngles(j); if (a > j) j = a - 1; }
    }
    const type = j > from ? collapse(text.slice(toks[from].s, toks[j - 1].e)) : undefined;
    return { type, next: j, isAsync };
  };

  /** Skip a `where` clause. */
  const skipWhere = (k: number, limit: number): number => {
    if (!isId(k, "where")) return k;
    for (k++; k < limit; k++) {
      if (isP(k, "{") || isP(k, "=") || isP(k, "}")) return k;
      if (toks[k].nl && toks[k].t === "id" && DECL_START.has(toks[k].v)) return k;
    }
    return k;
  };

  /**
   * Walk tokens [from, to) at one scope. Declarations recurse into their
   * bodies with the scope extended; any other brace is walked through at the
   * same scope, since a local class or function can sit inside an `if`.
   */
  const walk = (from: number, to: number, scope: Frame[]): void => {
    let k = from;
    while (k < to) {
      const tk = toks[k];
      if (tk.t !== "id") { k++; continue; }
      const prevIsDot = k > 0 && toks[k - 1].t === "p" && (toks[k - 1].v === "." || toks[k - 1].v === "?." || toks[k - 1].v === "::");
      if (prevIsDot) { k++; continue; }
      const v = tk.v;

      // --- containers
      const isSwiftClassModifier = lang === "swift" && v === "class" &&
        isId(k + 1) && ["func", "var", "let", "subscript", "override", "final", "static", "private", "public", "internal", "fileprivate", "open"].includes(toks[k + 1].v);
      const funInterface = lang === "kotlin" && v === "fun" && isId(k + 1, "interface");
      if ((containers.has(v) && !isSwiftClassModifier) || funInterface) {
        const kw = funInterface ? k + 1 : k;
        const { start: declStart, mods } = prefixStart(k, from);
        let j = kw + 1;
        let name: string | undefined;
        if (v === "object" && mods.has("companion")) name = isId(j) && !isP(j + 1, ".") && toks[j].v !== "Companion" ? toks[j++].v : "Companion";
        else if (isId(j)) {
          // `extension Foo.Bar`, `class Outer.Inner` (Swift extension of a nested type).
          name = toks[j++].v;
          while (isP(j, ".") && isId(j + 1)) { name += "." + toks[j + 1].v; j += 2; }
        }
        if (!name) { k = kw + 1; continue; } // `object : Listener { … }` — an anonymous object
        // Header: find the body brace at bracket depth 0, without running into the next declaration.
        let body = -1;
        for (; j < to; j++) {
          const h = toks[j];
          if (h.t === "p" && h.v === "{") { body = j; break; }
          if (h.t === "p" && (h.v === "}" || h.v === ";")) break;
          if (h.nl && h.t === "id" && DECL_START.has(h.v) && h.v !== "constructor") break;
          if (h.t === "p" && (h.v === "(" || h.v === "[") && match[j] > j) j = match[j];
          else if (h.t === "p" && h.v === "<") { const a = skipAngles(j); if (a > j) j = a - 1; }
        }
        // `data class Point(val x: Int)` has no body: its header is all of it.
        const endTok = body >= 0 && match[body] > body ? match[body] : Math.min(j, to) - 1;
        if (endTok > kw) {
          const startOffset = toks[declStart].s;
          const endOffset = toks[endTok].e;
          types.push({
            name,
            qualifier: scope.map((f) => f.name),
            kind: funInterface ? "fun interface" : v === "object" && mods.has("companion") ? "companion object" : v,
            start: line(startOffset),
            end: line(Math.max(startOffset, endOffset - 1)),
            startOffset,
            endOffset,
          });
        }
        if (body >= 0 && match[body] > body) {
          const isStatic = v === "object";
          walk(body + 1, match[body], [...scope, { name, isFunction: false, isStatic }]);
          k = match[body] + 1;
        } else {
          k = Math.max(j, kw + 1);
        }
        continue;
      }

      // --- functions
      const isFun = (lang === "kotlin" && v === "fun") || (lang === "swift" && v === "func");
      const isInit = (lang === "swift" && (v === "init" || v === "deinit" || v === "subscript")) ||
        (lang === "kotlin" && v === "constructor" && scope.length > 0 && !scope[scope.length - 1].isFunction);
      if (isFun || isInit) {
        const { start, mods } = prefixStart(k, from);
        let j = k + 1;
        let name = "";
        let nameTok = k;
        let receiver: string | undefined;
        if (isFun && lang === "swift") {
          if (isId(j)) {
            name = toks[j].v;
            nameTok = j++;
          } else {
            // Operator functions: `func +(`, `static func ==(`.
            nameTok = j;
            while (j < to && toks[j].t === "p" && !isP(j, "(") && !isP(j, "<")) name += toks[j++].v;
          }
          if (!name) { k = j > k ? j : k + 1; continue; }
          j = skipAngles(j);
        } else if (isFun) {
          j = skipAngles(j);
          // The name is the last identifier before `(`; what precedes it is a
          // receiver type: `fun Order.fee()`, `fun <T> List<T>?.second()`.
          const chainStart = j;
          let lastId = -1;
          for (; j < to; j++) {
            if (isP(j, "(")) break;
            if (isP(j, "<")) { const a = skipAngles(j); if (a > j) { j = a - 1; continue; } }
            if (toks[j].t === "id") lastId = j;
            else if (!(isP(j, ".") || isP(j, "?") || isP(j, "?."))) break;
          }
          if (lastId < 0) { k = j > k ? j : k + 1; continue; } // anonymous `fun(x) = …`
          name = toks[lastId].v;
          nameTok = lastId;
          if (lastId > chainStart) {
            receiver = collapse(text.slice(toks[chainStart].s, toks[lastId - 1].s)).replace(/[?.]+$/, "").replace(/<.*>$/, "");
          }
        } else {
          name = v === "constructor" ? "constructor" : v;
          if (lang === "swift" && (isP(j, "?") || isP(j, "!"))) j++;
          if (lang === "swift") j = skipAngles(j);
        }
        // Parameters.
        if (!isP(j, "(") && v !== "deinit") { k = j > k ? j : k + 1; continue; }
        const params = v === "deinit" ? [] : paramsOf(j);
        if (v !== "deinit") j = match[j] > j ? match[j] + 1 : j + 1;
        // Kotlin secondary constructor delegation: `: this(…)` / `: super(…)`.
        if (lang === "kotlin" && v === "constructor" && isP(j, ":")) {
          j++;
          if (isId(j) && isP(j + 1, "(") && match[j + 1] > j) j = match[j + 1] + 1;
        }
        const rt = isInit && v !== "subscript" ? { next: j, type: undefined as string | undefined, isAsync: undefined as boolean | undefined } : returnTypeAt(j, to);
        if (isInit && lang === "swift") {
          // `init() async throws`
          let q = j;
          while (isId(q, "async") || isId(q, "throws") || isId(q, "rethrows")) { if (toks[q].v === "async") rt.isAsync = true; q++; }
          rt.next = q;
        }
        j = skipWhere(rt.next, to);
        const kind = isInit ? (v === "subscript" ? "subscript" : v === "deinit" ? "destructor" : "constructor")
          : scope.length && !scope[scope.length - 1].isFunction ? "method" : receiver ? "extension function" : "function";
        const frame = (n: string): Frame[] => [...scope, ...(receiver ? [{ name: receiver, isFunction: false }] : []), { name: n, isFunction: true }];
        if (isP(j, "{") && match[j] > j) {
          const close = match[j];
          record(scope, name, nameTok, kind, start, toks[close].e, toks[j].s, params, rt.type, mods, { receiver, isAsync: rt.isAsync });
          walk(j + 1, close, frame(name));
          k = close + 1;
        } else if (lang === "kotlin" && isP(j, "=")) {
          const last = expressionEnd(j + 1, to);
          record(scope, name, nameTok, kind, start, toks[last].e, toks[j].s, params, rt.type, mods, { receiver, isAsync: rt.isAsync });
          walk(j + 1, last + 1, frame(name));
          k = last + 1;
        } else {
          k = Math.max(j, k + 1); // a declaration without a body: abstract, interface or protocol requirement
        }
        continue;
      }

      // --- functions stored in a variable, and Swift computed properties
      if (v === "val" || v === "var" || v === "let") {
        const { start, mods } = prefixStart(k, from);
        let j = k + 1;
        if (lang === "kotlin") j = skipAngles(j);
        if (!isId(j) || isP(j + 1, ".")) { k++; continue; }
        const nameTok = j;
        const name = toks[j].v;
        j++;
        let type: string | undefined;
        if (isP(j, ":")) {
          const from2 = j + 1;
          for (j = from2; j < to; j++) {
            const h = toks[j];
            if (h.t === "p" && (h.v === "=" || h.v === "{" || h.v === "}" || h.v === ";")) break;
            if (h.nl && j > from2) break;
            if (h.t === "p" && (h.v === "(" || h.v === "[") && match[j] > j) j = match[j];
            else if (h.t === "p" && h.v === "<") { const a = skipAngles(j); if (a > j) j = a - 1; }
          }
          if (j > from2) type = collapse(text.slice(toks[from2].s, toks[j - 1].e));
        }
        const inFunction = scope.length > 0 && scope[scope.length - 1].isFunction;
        // Swift `var total: Int { … }` — a computed property is a function with no parentheses.
        if (lang === "swift" && type && isP(j, "{") && !toks[j].nl && match[j] > j && v === "var" && !inFunction) {
          const close = match[j];
          record(scope, name, nameTok, "property", start, toks[close].e, toks[j].s, [], type, mods);
          walk(j + 1, close, [...scope, { name, isFunction: true }]);
          k = close + 1;
          continue;
        }
        if (isP(j, "=")) {
          let b = j + 1;
          // Kotlin `= fun(x: Int): Int { … }` anonymous function.
          if (lang === "kotlin" && isId(b, "fun") && isP(b + 1, "(")) {
            const p = b + 1;
            const params = paramsOf(p);
            let q = match[p] > p ? match[p] + 1 : p + 1;
            const rt = returnTypeAt(q, to);
            q = rt.next;
            if (isP(q, "{") && match[q] > q) {
              record(scope, name, nameTok, "function expression", start, toks[match[q]].e, toks[q].s, params, rt.type, mods);
              walk(q + 1, match[q], [...scope, { name, isFunction: true }]);
              k = match[q] + 1;
              continue;
            }
          }
          if (isP(b, "{") && match[b] > b && !isP(match[b] + 1, "(")) {
            const close = match[b];
            // Closure parameters: Kotlin `{ a, b -> …}`, Swift `{ (a: Int) -> Int in …}` / `{ a, b in …}`.
            const params: string[] = [];
            const arrow = lang === "kotlin" ? "->" : "in";
            for (let q = b + 1; q < close && q < b + 40; q++) {
              if ((lang === "kotlin" && isP(q, arrow)) || (lang === "swift" && isId(q, arrow))) {
                const head = collapse(text.slice(toks[b].e, toks[q].s)).replace(/^\(|\)$/g, "");
                params.push(...head.split(",").map((x) => x.trim()).filter(Boolean));
                break;
              }
              if (isP(q, "{") || isP(q, "}") || (toks[q].nl && q > b + 1)) break;
            }
            record(scope, name, nameTok, "closure", start, toks[close].e, toks[b].s, params, type, mods);
            walk(b + 1, close, [...scope, { name, isFunction: true }]);
            k = close + 1;
            continue;
          }
        }
        k = j > k ? j : k + 1;
        continue;
      }
      k++;
    }
  };

  walk(0, toks.length, []);
  functions.sort((a, b) => a.startOffset - b.startOffset);
  return { functions, types, errorLine: firstError !== undefined ? line(firstError) : undefined, nameOffsets };
}

// ---------------------------------------------------------------------------
// Call sites, for spec_nav_callers.

export interface BraceSite {
  /** For a string: passed to a dynamic-dispatch API such as NSSelectorFromString or getMethod. */
  dynamic?: boolean;
  offset: number;
  /** The receiver chain before the name: `order` in `order.total()`, "" for a bare call. */
  receiver: string;
  kind: "call" | "reference" | "string";
}

/** Every use of `name` in a Kotlin/Swift file: calls, references, and string literals equal to it. */
export function braceSites(text: string, lang: BraceLang, name: string, declOffsets: Set<number>): BraceSite[] {
  const { toks } = lex(text, lang);
  const out: BraceSite[] = [];
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === "str") {
      if (tk.v === name) {
        // `NSSelectorFromString("x")`, `Selector("x")`, `cls.getMethod("x")`: the callee is just before `(`.
        const callee = toks[k - 1]?.t === "p" && toks[k - 1].v === "(" ? toks[k - 2] : undefined;
        out.push({ offset: tk.s, receiver: "", kind: "string", dynamic: !!callee && callee.t === "id" && isDynamicCallee(callee.v) });
      }
      continue;
    }
    if (tk.t !== "id" || tk.v !== name || declOffsets.has(tk.s)) continue;
    const prev = toks[k - 1];
    if (prev?.t === "id" && (prev.v === "fun" || prev.v === "func" || prev.v === "class" || prev.v === "val" || prev.v === "var" || prev.v === "let")) continue;
    // Receiver chain: `a.b.name`, `Order::name`, `self.name`.
    let receiver = "";
    let j = k - 1;
    const sep = toks[j];
    if (sep && sep.t === "p" && (sep.v === "." || sep.v === "?." || sep.v === "!." || sep.v === "::")) {
      const parts: string[] = [];
      j--;
      while (j >= 0) {
        const t = toks[j];
        if (t.t === "id") parts.unshift(t.v);
        else if (t.t === "p" && (t.v === ")" || t.v === "]")) { parts.unshift("<expr>"); break; }
        else break;
        if (j >= 1 && toks[j - 1].t === "p" && (toks[j - 1].v === "." || toks[j - 1].v === "?." || toks[j - 1].v === "!.")) j -= 2;
        else break;
      }
      receiver = parts.join(".") || "<expr>";
    }
    const next = toks[k + 1];
    // Labelled arguments (`total: 3`) and named parameters are not uses.
    if (next?.t === "p" && next.v === ":" && !(sep?.v === "::")) continue;
    const isCall = !!next && next.t === "p" && (next.v === "(" || (next.v === "{" && !next.nl)) && sep?.v !== "::";
    out.push({ offset: tk.s, receiver, kind: isCall ? "call" : "reference" });
  }
  return out;
}

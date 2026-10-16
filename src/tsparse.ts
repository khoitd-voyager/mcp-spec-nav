import { ts } from "ts-morph";
import type { RawFunction, RawType } from "./treesitter.js";

/**
 * Functions in a TypeScript or JavaScript file, read with the TypeScript
 * compiler's parser.
 *
 * Only the parser: building a program and a type checker for cataloguing
 * would cost seconds per service for no gain — what a function is called,
 * where it sits and what it takes are all syntax. Symbol resolution is used
 * where it is actually needed, in `spec_nav_callers`.
 */

export interface TsExtract {
  functions: RawFunction[];
  types: RawType[];
  /** Function expressions with nothing naming them (inline callbacks). */
  anonymous: Array<{ start: number; end: number }>;
  errorLine?: number;
  errorMessage?: string;
}

export function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    // JSX in a .js file is common enough in React code that parsing every
    // JS file as JSX is the safer default; plain JS parses the same either way.
    default:
      return ts.ScriptKind.JSX;
  }
}

export function parseSource(fileName: string, text: string, ext: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(ext));
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === kind);
}

function propName(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return `[${collapse(name.expression.getText(sf))}]`;
  return undefined;
}

/** Strip wrappers that do not change what a value is: `(x)`, `x as T`, `x!`. */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) ||
        ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

type FnLike = ts.ArrowFunction | ts.FunctionExpression;

/**
 * Calls whose result is the function passed in, wrapped: `useCallback(fn)`,
 * `memo(fn)`, `asyncHandler(fn)`. Only these — `items.map(x => …)` also takes
 * an arrow first, and its result is an array, not a function.
 */
export const WRAPPERS = /^(useCallback|memo|forwardRef|debounce|throttle|once|memoize\w*|observer|\w*[Hh]andler|catchAsync|wrapAsync|asyncWrap\w*|withSpan|trace\w*)$/;

/**
 * A function value held by an initializer — directly, or as the first argument
 * of a wrapper call such as `useCallback(() => …)` or `memo(function …)`,
 * which is still the function people mean by that name.
 */
function functionValue(init: ts.Expression | undefined): { fn: FnLike; wrapper?: string } | undefined {
  if (!init) return undefined;
  const e = unwrap(init);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { fn: e };
  if (ts.isCallExpression(e) && e.arguments.length) {
    const callee = ts.isPropertyAccessExpression(e.expression) ? e.expression.name.text
      : ts.isIdentifier(e.expression) ? e.expression.text : "";
    if (!WRAPPERS.test(callee)) return undefined;
    const first = unwrap(e.arguments[0]);
    if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) {
      return { fn: first, wrapper: collapse(e.expression.getText()) };
    }
  }
  return undefined;
}

/** The doc comment right above `anchor`: JSDoc preferred, `//` lines accepted. */
function docComment(anchor: ts.Node, sf: ts.SourceFile): string | undefined {
  const text = sf.text;
  const ranges = ts.getLeadingCommentRanges(text, anchor.getFullStart());
  if (!ranges?.length) return undefined;
  // Walk back from the last comment while the comments are contiguous.
  const picked: ts.CommentRange[] = [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    const next = picked[0];
    const gapEnd = next ? next.pos : anchor.getStart(sf);
    const gap = text.slice(r.end, gapEnd);
    // A blank line separates a file header or a commented-out block from the
    // function's own doc.
    if ((gap.match(/\n/g) ?? []).length > 1) break;
    picked.unshift(r);
    if (r.kind === ts.SyntaxKind.MultiLineCommentTrivia) break;
  }
  if (!picked.length) return undefined;
  const raw = picked.map((r) => text.slice(r.pos, r.end)).join("\n");
  const cleaned = raw
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*(?!\/)|\/\/\/?)\s?/, "").replace(/\s*\*\/\s*$/, ""))
    .join("\n")
    .trim();
  return cleaned || undefined;
}

/** `=`, `??=`, `||=`, `&&=`: the operators that can store a function. */
function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  if (!ts.isBinaryExpression(node)) return false;
  const k = node.operatorToken.kind;
  return k === ts.SyntaxKind.EqualsToken || k === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    k === ts.SyntaxKind.BarBarEqualsToken || k === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
}

/** The key of `o.k` or `o["k"]`, if it is written out. */
function memberKey(e: ts.Expression): { obj: ts.Expression; key: string } | undefined {
  if (ts.isPropertyAccessExpression(e)) return { obj: e.expression, key: e.name.text };
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return { obj: e.expression, key: e.argumentExpression.text };
  }
  return undefined;
}

/**
 * The CommonJS export a left-hand side writes: `module.exports`,
 * `module.exports.x`, `exports.x` (or the `["x"]` forms).
 */
function cjsExportPath(left: ts.Expression, sf: ts.SourceFile): string | undefined {
  const e = unwrap(left);
  const t = collapse(e.getText(sf));
  if (t === "module.exports") return t;
  const m = memberKey(e);
  if (!m) return undefined;
  const obj = collapse(m.obj.getText(sf));
  return obj === "module.exports" || obj === "exports" ? `${obj}.${m.key}` : undefined;
}

/**
 * Top-level names exported by something other than their own declaration,
 * each with the names it is exported as: `export { a as b }` (b),
 * `export default a` (default), `module.exports = a`, `module.exports = { a,
 * b: c }`, `exports.x = a`. Presence in the map means exported; the list
 * holds aliases, which may be empty (`export { a }`).
 */
function exportAliases(sf: ts.SourceFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (local: string, as?: string) => {
    const list = out.get(local) ?? [];
    if (as && !list.includes(as)) list.push(as);
    out.set(local, list);
  };
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) add((el.propertyName ?? el.name).text, el.propertyName ? el.name.text : undefined);
    }
    if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) add(st.expression.text, "default");
    if (!ts.isExpressionStatement(st) || !isAssignment(st.expression)) continue;
    const path = cjsExportPath(st.expression.left, sf);
    if (!path) continue;
    const right = unwrap(st.expression.right);
    if (ts.isIdentifier(right)) add(right.text, path);
    else if (path === "module.exports" && ts.isObjectLiteralExpression(right)) {
      for (const p of right.properties) {
        if (ts.isShorthandPropertyAssignment(p)) add(p.name.text, `module.exports.${p.name.text}`);
        else if (ts.isPropertyAssignment(p) && ts.isIdentifier(unwrap(p.initializer))) {
          const key = propName(p.name, sf);
          if (key) add((unwrap(p.initializer) as ts.Identifier).text, `module.exports.${key}`);
        }
      }
    }
  }
  return out;
}

/**
 * A type checker over this one file, with no libraries and no imports — the
 * binder is all it is used for: which declaration an assigned identifier
 * refers to, so `handler = …` inside a function is told apart from a
 * same-named variable elsewhere.
 */
export function fileChecker(sf: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] };
  const host: ts.CompilerHost = {
    getSourceFile: (n) => (n === sf.fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (n) => n === sf.fileName,
    readFile: () => undefined,
  };
  return ts.createProgram({ rootNames: [sf.fileName], options, host }).getTypeChecker();
}

export function extractTsFunctions(fileName: string, text: string, ext: string): TsExtract {
  const sf = parseSource(fileName, text, ext);
  const aliases = exportAliases(sf);
  const functions: RawFunction[] = [];
  const types: RawType[] = [];
  const anonymous: TsExtract["anonymous"] = [];
  const claimed = new Set<ts.Node>();
  let checker: ts.TypeChecker | undefined;

  /** `node` is the function or class the scope stands for, to resolve declarations against. */
  type Scope = { name: string; isFunction: boolean; exported?: boolean; node?: ts.Node };

  /** Export facts for a top-level name exported by an alias or list. */
  const aliasExport = (name: string | undefined, scope: Scope[]): Partial<RawFunction> => {
    if (!name || scope.length || !aliases.has(name)) return {};
    const as = aliases.get(name)!;
    return { exported: true, ...(as.length ? { exportedAs: as } : {}) };
  };

  const add = (
    fn: ts.SignatureDeclaration,
    anchor: ts.Node,
    name: string,
    scope: Scope[],
    kind: string,
    extra: Partial<RawFunction> = {},
  ) => {
    claimed.add(fn);
    const params = fn.parameters.map((p) => collapse(p.getText(sf)));
    const returnType = fn.type ? collapse(fn.type.getText(sf)) : undefined;
    const typeParams = fn.typeParameters?.length
      ? `<${fn.typeParameters.map((t) => collapse(t.getText(sf))).join(", ")}>`
      : "";
    const isAsync = hasModifier(fn, ts.SyntaxKind.AsyncKeyword) || undefined;
    const isStatic = hasModifier(anchor, ts.SyntaxKind.StaticKeyword) || hasModifier(fn, ts.SyntaxKind.StaticKeyword) || undefined;
    const prefix = [
      isStatic ? "static" : "",
      isAsync ? "async" : "",
      kind === "getter" ? "get" : kind === "setter" ? "set" : "",
      ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)
        ? `function${(fn as ts.FunctionDeclaration).asteriskToken ? "*" : ""}`
        : "",
    ].filter(Boolean).join(" ");
    let signature = `${prefix ? prefix + " " : ""}${name}${typeParams}(${params.join(", ")})${returnType ? `: ${returnType}` : ""}`;
    if (signature.length > 300) signature = signature.slice(0, 299) + "…";
    const inFunction = scope.length > 0 && scope[scope.length - 1].isFunction;
    if (inFunction && kind === "function") kind = "nested function";
    const startOffset = anchor.getStart(sf);
    const endOffset = fn.getEnd();
    functions.push({
      name,
      qualifier: scope.map((s) => s.name),
      kind,
      start: lineOf(sf, startOffset),
      end: lineOf(sf, endOffset),
      startOffset,
      endOffset,
      signature,
      params,
      returnType,
      isAsync,
      isStatic,
      doc: docComment(anchor, sf),
      ...extra,
    });
  };

  /** A class, interface, enum, type alias, namespace or named object literal, by its whole extent. */
  const addType = (anchor: ts.Node, name: string, scope: Scope[], kind: string) => {
    const startOffset = anchor.getStart(sf);
    const endOffset = anchor.getEnd();
    types.push({
      name,
      qualifier: scope.map((s) => s.name),
      kind,
      start: lineOf(sf, startOffset),
      end: lineOf(sf, endOffset),
      startOffset,
      endOffset,
    });
  };

  const memberVisibility = (m: ts.Node): string | undefined => {
    if (hasModifier(m, ts.SyntaxKind.PrivateKeyword)) return "private";
    if (hasModifier(m, ts.SyntaxKind.ProtectedKeyword)) return "protected";
    const n = (m as any).name;
    if (n && ts.isPrivateIdentifier(n)) return "#private";
    return "public";
  };

  /** `anchor`: what the class's extent starts at — the statement, for `const X = class {…}`. */
  const visitClass = (cls: ts.ClassLikeDeclaration, name: string, scope: Scope[], exported: boolean, anchor: ts.Node = cls) => {
    addType(anchor, name, scope, "class");
    const inner: Scope[] = [...scope, { name, isFunction: false, exported, node: cls }];
    for (const m of cls.members) {
      const vis = memberVisibility(m);
      const memberExported = exported && vis === "public";
      if (ts.isMethodDeclaration(m) && m.body) {
        const n = propName(m.name, sf) ?? "<computed>";
        add(m, m, n, inner, "method", { visibility: vis, exported: memberExported });
        visit(m.body, [...inner, { name: n, isFunction: true, node: m }]);
      } else if (ts.isConstructorDeclaration(m) && m.body) {
        add(m, m, "constructor", inner, "constructor", { visibility: vis, exported: memberExported });
        visit(m.body, [...inner, { name: "constructor", isFunction: true, node: m }]);
      } else if ((ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.body) {
        const n = propName(m.name, sf) ?? "<computed>";
        add(m, m, n, inner, ts.isGetAccessor(m) ? "getter" : "setter", { visibility: vis, exported: memberExported });
        visit(m.body, [...inner, { name: n, isFunction: true, node: m }]);
      } else if (ts.isPropertyDeclaration(m)) {
        const fv = functionValue(m.initializer);
        const n = propName(m.name, sf) ?? "<computed>";
        if (fv) {
          add(fv.fn, m, n, inner, ts.isArrowFunction(fv.fn) ? "arrow function" : "function expression", {
            visibility: vis,
            exported: memberExported,
          });
          visit(fv.fn.body, [...inner, { name: n, isFunction: true, node: fv.fn }]);
        } else if (m.initializer) {
          visit(m.initializer, inner);
        }
      } else if (ts.isClassStaticBlockDeclaration(m)) {
        visit(m.body, inner);
      }
    }
  };

  /** `exportPath`: the CommonJS export the object is, e.g. `module.exports`. */
  const visitObjectLiteral = (obj: ts.ObjectLiteralExpression, scope: Scope[], exported: boolean, exportPath?: string) => {
    const as = (n: string) => (exportPath ? { exportedAs: [`${exportPath}.${n}`] } : {});
    for (const p of obj.properties) {
      if (ts.isMethodDeclaration(p) && p.body) {
        const n = propName(p.name, sf) ?? "<computed>";
        add(p, p, n, scope, "method", { exported, ...as(n) });
        visit(p.body, [...scope, { name: n, isFunction: true, node: p }]);
      } else if ((ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.body) {
        const n = propName(p.name, sf) ?? "<computed>";
        add(p, p, n, scope, ts.isGetAccessor(p) ? "getter" : "setter", { exported, ...as(n) });
        visit(p.body, [...scope, { name: n, isFunction: true, node: p }]);
      } else if (ts.isPropertyAssignment(p)) {
        const n = propName(p.name, sf) ?? "<computed>";
        const fv = functionValue(p.initializer);
        if (fv) {
          add(fv.fn, p, n, scope, ts.isArrowFunction(fv.fn) ? "arrow function" : "function expression", { exported, ...as(n) });
          visit(fv.fn.body, [...scope, { name: n, isFunction: true, node: fv.fn }]);
        } else {
          const inner = unwrap(p.initializer);
          if (ts.isObjectLiteralExpression(inner)) {
            visitObjectLiteral(inner, [...scope, { name: n, isFunction: false }], exported, exportPath && `${exportPath}.${n}`);
          } else visit(p.initializer, scope);
        }
      } else {
        visit(p, scope);
      }
    }
  };

  const visit = (node: ts.Node, scope: Scope[]): void => {
    if (ts.isFunctionDeclaration(node)) {
      if (!node.body) return; // an overload signature; the implementation follows
      const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
      const name = node.name?.text ?? (isDefault ? "default" : "<anonymous>");
      const topLevel = scope.every((s) => !s.isFunction);
      const alias = aliasExport(node.name?.text, scope);
      const exported =
        (topLevel && hasModifier(node, ts.SyntaxKind.ExportKeyword)) || !!alias.exported ||
        (scope.length > 0 && scope.every((s) => !s.isFunction && s.exported));
      add(node, node, name, scope, "function", {
        ...alias,
        exported,
        ...(node.name ? { bindingKey: `decl:${node.getStart(sf)}`, assignedTo: name } : {}),
      });
      visit(node.body, [...scope, { name, isFunction: true, node }]);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      let name = node.name?.text;
      if (!name && ts.isVariableDeclaration(node.parent)) name = propName(node.parent.name, sf);
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword) || !!aliasExport(name, scope).exported;
      visitClass(node, name ?? "<anonymous class>", scope, exported);
      return;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      addType(node, node.name.text, scope, ts.isInterfaceDeclaration(node) ? "interface" : ts.isEnumDeclaration(node) ? "enum" : "type");
    }
    if (ts.isModuleDeclaration(node) && node.body) {
      const name = propName(node.name as ts.Identifier, sf) ?? "<module>";
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      addType(node, name, scope, "namespace");
      visit(node.body, [...scope, { name, isFunction: false, exported }]);
      return;
    }
    if (ts.isVariableStatement(node)) {
      const stExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      for (const d of node.declarationList.declarations) {
        const name = propName(d.name, sf);
        const alias = aliasExport(name, scope);
        const exported = stExported || !!alias.exported;
        const fv = functionValue(d.initializer);
        // One declaration: anchor on the statement so `export const` and its
        // doc comment are part of the function. Several: on the declaration.
        const anchor = node.declarationList.declarations.length === 1 ? node : d;
        if (fv && name) {
          add(fv.fn, anchor, name, scope, ts.isArrowFunction(fv.fn) ? "arrow function" : "function expression", {
            ...alias,
            exported,
            bindingKey: `decl:${d.getStart(sf)}`,
            assignedTo: name,
          });
          // `const onSave = useCallback(…)`: say what wraps it.
          if (fv.wrapper) {
            const last = functions[functions.length - 1];
            last.signature = `${last.name} = ${fv.wrapper}(${last.signature.replace(/^(async )?(function\*? )?/, "$1")})`;
          }
          visit(fv.fn.body, [...scope, { name, isFunction: true, node: fv.fn }]);
        } else if (d.initializer) {
          const inner = unwrap(d.initializer);
          if (ts.isObjectLiteralExpression(inner) && name) {
            addType(anchor, name, scope, "object");
            visitObjectLiteral(inner, [...scope, { name, isFunction: false, exported }], exported);
          } else if (ts.isClassExpression(inner)) {
            visitClass(inner, inner.name?.text ?? name ?? "<anonymous class>", scope, exported, anchor);
          } else {
            visit(d.initializer, scope);
          }
        }
      }
      return;
    }
    if (isAssignment(node) && visitAssignment(node, scope)) return;
    if (ts.isExportAssignment(node)) {
      const fv = functionValue(node.expression);
      if (fv) {
        add(fv.fn, node, "default", scope, ts.isArrowFunction(fv.fn) ? "arrow function" : "function expression", {
          exported: true,
        });
        visit(fv.fn.body, [...scope, { name: "default", isFunction: true }]);
        return;
      }
    }
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !claimed.has(node)) {
      // A named function expression keeps its own name; anything else is an
      // inline callback, counted but not listed — there is no name to reuse.
      if (ts.isFunctionExpression(node) && node.name) {
        add(node, node, node.name.text, scope, "function expression", { exported: false });
        visit(node.body, [...scope, { name: node.name.text, isFunction: true, node }]);
        return;
      }
      anonymous.push({ start: lineOf(sf, node.getStart(sf)), end: lineOf(sf, node.getEnd()) });
    }
    ts.forEachChild(node, (c) => visit(c, scope));
  };

  /**
   * The scope a declaration belongs to: the stack up to the innermost named
   * function or class containing it. A declaration inside an inline callback
   * belongs to the named function around the callback.
   */
  const declaringScope = (decl: ts.Node, scope: Scope[]): Scope[] => {
    for (let n: ts.Node | undefined = decl.parent; n && n !== sf; n = n.parent) {
      const i = scope.findIndex((s) => s.node === n);
      if (i >= 0) return scope.slice(0, i + 1);
    }
    return [];
  };

  /**
   * A function stored by assignment rather than declared: `x = () => …`,
   * `obj.k = function …`, `this.k = …`, `o["k"] ??= …`, `module.exports = …`,
   * `exports.k = …`. Returns false when the right side is not a function,
   * so the caller walks it like any other expression.
   */
  const visitAssignment = (bin: ts.BinaryExpression, scope: Scope[]): boolean => {
    const left = unwrap(bin.left);
    const value = unwrap(bin.right);
    const anchor = ts.isExpressionStatement(bin.parent) ? bin.parent : bin;
    const path = cjsExportPath(left, sf);
    const fv = functionValue(bin.right);
    const kindOf = (fn: FnLike) => (ts.isArrowFunction(fn) ? "arrow function" : "function expression");

    if (path === "module.exports") {
      if (ts.isObjectLiteralExpression(value)) {
        visitObjectLiteral(value, scope, true, "module.exports");
        return true;
      }
      if (ts.isClassExpression(value)) {
        visitClass(value, value.name?.text ?? "module.exports", scope, true, anchor);
        return true;
      }
      if (!fv) return false;
      // `module.exports = function calculateFee() {}` is calculateFee; an
      // anonymous one is known by the only name it has: module.exports.
      const name = (ts.isFunctionExpression(fv.fn) && fv.fn.name?.text) || "module.exports";
      add(fv.fn, anchor, name, scope, kindOf(fv.fn), {
        exported: true,
        exportedAs: ["module.exports"],
        bindingKey: "cjs:module.exports",
        assignedTo: "module.exports",
      });
      visit(fv.fn.body, [...scope, { name, isFunction: true, node: fv.fn }]);
      return true;
    }
    if (!fv) return false;

    let name: string;
    let qualifier: Scope[];
    let bindingKey: string;
    let extra: Partial<RawFunction> = {};
    let kind = kindOf(fv.fn);
    const target = collapse(left.getText(sf));
    const member = memberKey(left);

    if (path) {
      name = member!.key;
      qualifier = scope;
      bindingKey = `cjs:${path}`;
      extra = { exported: true, exportedAs: [path] };
    } else if (ts.isIdentifier(left)) {
      // Which variable this is depends on scope, so ask the binder.
      checker ??= fileChecker(sf);
      const decl = checker.getSymbolAtLocation(left)?.declarations?.[0];
      name = left.text;
      qualifier = decl ? declaringScope(decl, scope) : [];
      bindingKey = decl ? `decl:${decl.getStart(sf)}` : `global:${name}`;
      if (decl && !qualifier.length) {
        const st = decl.parent?.parent;
        const declExported = !!st && ts.isVariableStatement(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword);
        const alias = aliasExport(name, []);
        if (declExported || alias.exported) extra = { ...alias, exported: true };
        else extra = { exported: false };
      }
    } else if (member) {
      name = member.key;
      const obj = collapse(member.obj.getText(sf));
      if (obj === "this") {
        // `this.k = …` in a constructor or method belongs to the class; in a
        // constructor function, to that function.
        const i = scope.length - 1;
        if (i < 0) return false;
        qualifier = i > 0 && !scope[i - 1].isFunction ? scope.slice(0, i) : scope;
      } else {
        const proto = obj.match(/^([\w$]+)\.prototype$/);
        if (proto) qualifier = [...scope, { name: proto[1], isFunction: false }];
        else if (/^[\w$.]+$/.test(obj)) qualifier = [...scope, ...obj.split(".").map((n) => ({ name: n, isFunction: false }))];
        else return false;
      }
      kind = "method";
      bindingKey = `prop:${[...qualifier.map((s) => s.name), name].join(".")}`;
    } else {
      return false;
    }

    add(fv.fn, anchor, name, qualifier, kind, { ...extra, bindingKey, assignedTo: target });
    visit(fv.fn.body, [...qualifier, { name, isFunction: true, node: fv.fn }]);
    return true;
  };

  ts.forEachChild(sf, (c) => visit(c, []));

  const diags: ts.DiagnosticWithLocation[] = (sf as any).parseDiagnostics ?? [];
  const first = diags[0];
  return {
    functions,
    types,
    anonymous,
    errorLine: first ? lineOf(sf, first.start) : undefined,
    errorMessage: first ? ts.flattenDiagnosticMessageText(first.messageText, " ") : undefined,
  };
}

/**
 * Import declarations a function body uses: those binding a name that occurs
 * in the body. Best-effort — it reads names, not types.
 */
export function tsImportsUsed(sf: ts.SourceFile, bodyText: string): string[] {
  const used = new Set(bodyText.match(/[A-Za-z_$][\w$]*/g) ?? []);
  return tsImports(sf).filter((i) => i.names.some((n) => used.has(n))).map((i) => i.text);
}

/** A top-level import statement: its lines (1-indexed, inclusive), its text on one line, the names it binds. */
export interface ImportStmt {
  start: number;
  end: number;
  text: string;
  names: string[];
}

/** The file's import declarations and `require` statements, in order. */
export function tsImports(sf: ts.SourceFile): ImportStmt[] {
  const out: ImportStmt[] = [];
  const push = (st: ts.Statement, names: string[]) =>
    out.push({ start: lineOf(sf, st.getStart(sf)), end: lineOf(sf, st.getEnd()), text: collapse(st.getText(sf)), names });
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      const names: string[] = [];
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
        else for (const el of clause.namedBindings.elements) names.push(el.name.text);
      }
      push(st, names);
    } else if (ts.isImportEqualsDeclaration(st)) {
      push(st, [st.name.text]);
    } else if (ts.isVariableStatement(st)) {
      // const x = require("y"), const { a, b } = require("y")
      const t = st.getText(sf);
      if (!/\brequire\s*\(/.test(t)) continue;
      const names = (t.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((n) => n !== "require" && n !== "const" && n !== "let" && n !== "var");
      push(st, names);
    }
  }
  return out;
}

import { ts } from "ts-morph";
import type { RawFunction } from "./treesitter.js";

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

/**
 * Names exported from a file by an `export { a, b as c }` list or
 * `export default name`, which do not mark the declaration itself.
 */
function exportListNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) names.add((el.propertyName ?? el.name).text);
    }
    if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) names.add(st.expression.text);
  }
  return names;
}

/** `module.exports.x = …`, `exports.x = …`, `Foo.prototype.x = …` → name and qualifier. */
function assignmentTarget(left: ts.Expression, sf: ts.SourceFile):
  { name: string; qualifier: string[]; exported: boolean } | undefined {
  if (!ts.isPropertyAccessExpression(left)) return undefined;
  const name = left.name.text;
  const obj = collapse(left.expression.getText(sf));
  if (obj === "module.exports" || obj === "exports") return { name, qualifier: [], exported: true };
  const proto = obj.match(/^([\w$]+)\.prototype$/);
  if (proto) return { name, qualifier: [proto[1]], exported: false };
  if (/^[\w$.]+$/.test(obj) && obj !== "this") return { name, qualifier: obj.split("."), exported: false };
  return undefined;
}

export function extractTsFunctions(fileName: string, text: string, ext: string): TsExtract {
  const sf = parseSource(fileName, text, ext);
  const exportedNames = exportListNames(sf);
  const functions: RawFunction[] = [];
  const anonymous: TsExtract["anonymous"] = [];
  const claimed = new Set<ts.Node>();

  type Scope = { name: string; isFunction: boolean; exported?: boolean };

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
    functions.push({
      name,
      qualifier: scope.map((s) => s.name),
      kind,
      start: lineOf(sf, anchor.getStart(sf)),
      end: lineOf(sf, fn.getEnd()),
      signature,
      params,
      returnType,
      isAsync,
      isStatic,
      doc: docComment(anchor, sf),
      ...extra,
    });
  };

  const memberVisibility = (m: ts.Node): string | undefined => {
    if (hasModifier(m, ts.SyntaxKind.PrivateKeyword)) return "private";
    if (hasModifier(m, ts.SyntaxKind.ProtectedKeyword)) return "protected";
    const n = (m as any).name;
    if (n && ts.isPrivateIdentifier(n)) return "#private";
    return "public";
  };

  const visitClass = (cls: ts.ClassLikeDeclaration, name: string, scope: Scope[], exported: boolean) => {
    const inner: Scope[] = [...scope, { name, isFunction: false, exported }];
    for (const m of cls.members) {
      const vis = memberVisibility(m);
      const memberExported = exported && vis === "public";
      if (ts.isMethodDeclaration(m) && m.body) {
        const n = propName(m.name, sf) ?? "<computed>";
        add(m, m, n, inner, "method", { visibility: vis, exported: memberExported });
        visit(m.body, [...inner, { name: n, isFunction: true }]);
      } else if (ts.isConstructorDeclaration(m) && m.body) {
        add(m, m, "constructor", inner, "constructor", { visibility: vis, exported: memberExported });
        visit(m.body, [...inner, { name: "constructor", isFunction: true }]);
      } else if ((ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.body) {
        const n = propName(m.name, sf) ?? "<computed>";
        add(m, m, n, inner, ts.isGetAccessor(m) ? "getter" : "setter", { visibility: vis, exported: memberExported });
        visit(m.body, [...inner, { name: n, isFunction: true }]);
      } else if (ts.isPropertyDeclaration(m)) {
        const fv = functionValue(m.initializer);
        const n = propName(m.name, sf) ?? "<computed>";
        if (fv) {
          add(fv.fn, m, n, inner, ts.isArrowFunction(fv.fn) ? "arrow function" : "function expression", {
            visibility: vis,
            exported: memberExported,
          });
          visit(fv.fn.body, [...inner, { name: n, isFunction: true }]);
        } else if (m.initializer) {
          visit(m.initializer, inner);
        }
      } else if (ts.isClassStaticBlockDeclaration(m)) {
        visit(m.body, inner);
      }
    }
  };

  const visitObjectLiteral = (obj: ts.ObjectLiteralExpression, scope: Scope[], exported: boolean) => {
    for (const p of obj.properties) {
      if (ts.isMethodDeclaration(p) && p.body) {
        const n = propName(p.name, sf) ?? "<computed>";
        add(p, p, n, scope, "method", { exported });
        visit(p.body, [...scope, { name: n, isFunction: true }]);
      } else if ((ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.body) {
        const n = propName(p.name, sf) ?? "<computed>";
        add(p, p, n, scope, ts.isGetAccessor(p) ? "getter" : "setter", { exported });
        visit(p.body, [...scope, { name: n, isFunction: true }]);
      } else if (ts.isPropertyAssignment(p)) {
        const n = propName(p.name, sf) ?? "<computed>";
        const fv = functionValue(p.initializer);
        if (fv) {
          add(fv.fn, p, n, scope, ts.isArrowFunction(fv.fn) ? "arrow function" : "function expression", { exported });
          visit(fv.fn.body, [...scope, { name: n, isFunction: true }]);
        } else {
          const inner = unwrap(p.initializer);
          if (ts.isObjectLiteralExpression(inner)) visitObjectLiteral(inner, [...scope, { name: n, isFunction: false }], exported);
          else visit(p.initializer, scope);
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
      const exported =
        (topLevel && (hasModifier(node, ts.SyntaxKind.ExportKeyword) || exportedNames.has(name))) ||
        (scope.length > 0 && scope.every((s) => !s.isFunction && s.exported));
      add(node, node, name, scope, "function", { exported });
      visit(node.body, [...scope, { name, isFunction: true }]);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      let name = node.name?.text;
      if (!name && ts.isVariableDeclaration(node.parent)) name = propName(node.parent.name, sf);
      const exported =
        hasModifier(node, ts.SyntaxKind.ExportKeyword) || (name ? exportedNames.has(name) : false);
      visitClass(node, name ?? "<anonymous class>", scope, exported);
      return;
    }
    if (ts.isModuleDeclaration(node) && node.body) {
      const name = propName(node.name as ts.Identifier, sf) ?? "<module>";
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      visit(node.body, [...scope, { name, isFunction: false, exported }]);
      return;
    }
    if (ts.isVariableStatement(node)) {
      const stExported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      for (const d of node.declarationList.declarations) {
        const name = propName(d.name, sf);
        const exported = stExported || (name ? exportedNames.has(name) : false);
        const fv = functionValue(d.initializer);
        // One declaration: anchor on the statement so `export const` and its
        // doc comment are part of the function. Several: on the declaration.
        const anchor = node.declarationList.declarations.length === 1 ? node : d;
        if (fv && name) {
          add(fv.fn, anchor, name, scope, ts.isArrowFunction(fv.fn) ? "arrow function" : "function expression", {
            exported,
          });
          // `const onSave = useCallback(…)`: say what wraps it.
          if (fv.wrapper) {
            const last = functions[functions.length - 1];
            last.signature = `${last.name} = ${fv.wrapper}(${last.signature.replace(/^(async )?(function\*? )?/, "$1")})`;
          }
          visit(fv.fn.body, [...scope, { name, isFunction: true }]);
        } else if (d.initializer) {
          const inner = unwrap(d.initializer);
          if (ts.isObjectLiteralExpression(inner) && name) {
            visitObjectLiteral(inner, [...scope, { name, isFunction: false, exported }], exported);
          } else if (ts.isClassExpression(inner)) {
            visitClass(inner, inner.name?.text ?? name ?? "<anonymous class>", scope, exported);
          } else {
            visit(d.initializer, scope);
          }
        }
      }
      return;
    }
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = node.expression;
      const leftText = collapse(left.getText(sf));
      const value = unwrap(right);
      // module.exports = { a() {}, b: () => {} }
      if ((leftText === "module.exports" || leftText === "exports") && ts.isObjectLiteralExpression(value)) {
        visitObjectLiteral(value, scope, true);
        return;
      }
      const fv = functionValue(right);
      const target = assignmentTarget(left, sf);
      if (fv && target) {
        const q = [...scope, ...target.qualifier.map((n) => ({ name: n, isFunction: false }))];
        add(fv.fn, node, target.name, q, target.qualifier.length ? "method" : "function expression", {
          exported: target.exported,
        });
        visit(fv.fn.body, [...q, { name: target.name, isFunction: true }]);
        return;
      }
    }
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
        visit(node.body, [...scope, { name: node.name.text, isFunction: true }]);
        return;
      }
      anonymous.push({ start: lineOf(sf, node.getStart(sf)), end: lineOf(sf, node.getEnd()) });
    }
    ts.forEachChild(node, (c) => visit(c, scope));
  };

  ts.forEachChild(sf, (c) => visit(c, []));

  const diags: ts.DiagnosticWithLocation[] = (sf as any).parseDiagnostics ?? [];
  const first = diags[0];
  return {
    functions,
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
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      const names: string[] = [];
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
        else for (const el of clause.namedBindings.elements) names.push(el.name.text);
      }
      if (names.some((n) => used.has(n))) out.push(collapse(st.getText(sf)));
    } else if (ts.isVariableStatement(st)) {
      // const x = require("y"), const { a, b } = require("y")
      const t = st.getText(sf);
      if (!/\brequire\s*\(/.test(t)) continue;
      const names = t.match(/[A-Za-z_$][\w$]*/g) ?? [];
      if (names.some((n) => n !== "require" && n !== "const" && n !== "let" && n !== "var" && used.has(n))) {
        out.push(collapse(t));
      }
    }
  }
  return out;
}

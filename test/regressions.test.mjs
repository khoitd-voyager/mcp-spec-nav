// Regressions for gaps found in review: CommonJS exports, functions assigned
// after their declaration, exact (column-level) function extents, body-only
// search matches, and Unicode/Vietnamese tokenizing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, removeRepo, startServer, allFunctions } from "./helpers.mjs";

let root, s, fns;
before(async () => {
  root = makeRepo({
    "svc/package.json": "{}",
    // --- 1. CommonJS
    "svc/cjs/named.js": "module.exports = function calculateFee(x) {\n  return x * 2;\n};\n",
    "svc/cjs/arrow.js": "module.exports = (x) => x + 1;\n",
    "svc/cjs/anon.js": "module.exports = function (x) { return x - 1; };\n",
    "svc/cjs/props.js": [
      "module.exports.foo = function () { return 1; };",
      "exports.bar = (y) => y;",
      "",
    ].join("\n"),
    "svc/cjs/aliases.js": [
      "function computeRefund(order) { return order.total; }",
      "const helperFn = () => 0;",
      "function internalOnly() {}",
      "module.exports = { computeRefund, giveBack: computeRefund, helper: helperFn };",
      "module.exports.computeRefund2 = computeRefund;",
      "exports.alsoRefund = computeRefund;",
      "",
    ].join("\n"),
    "svc/cjs/declared.js": "function priceOf(item) { return item.price; }\nmodule.exports = priceOf;\n",
    "svc/cjs/hoisted.js": "module.exports = { lateDecl };\nfunction lateDecl() { return 1; }\n",

    // --- 2. assigned after declaration
    "svc/assign/tax.js": "let calculateTax;\ncalculateTax = (x) => x * 0.1;\n",
    "svc/assign/scopes.js": [
      "let handler;",
      "handler = function () { return 'top'; };",
      "function outer() {",
      "  let handler;",
      "  handler = () => 'inner';",
      "  return handler;",
      "}",
      "function setsTop() {",
      "  handler = () => 'reassigned top';",
      "}",
      "",
    ].join("\n"),
    "svc/assign/multi.js": [
      "let format;",
      "if (process.env.X) {",
      "  format = (n) => `x${n}`;",
      "} else {",
      "  format = (n) => `y${n}`;",
      "}",
      "module.exports = { format };",
      "",
    ].join("\n"),
    "svc/assign/props.js": [
      "const api = {};",
      "api.loadUser = async (id) => id;",
      'api["saveUser"] = function (u) { return u; };',
      "let cache = {};",
      "cache.compute ??= (k) => k;",
      "function Cart() {",
      "  this.total = () => 0;",
      "}",
      "class Box {",
      "  constructor() {",
      "    this.open = () => true;",
      "  }",
      "}",
      "[1, 2].forEach((n) => console.log(n));",
      "",
    ].join("\n"),

    // --- 3. exact extents
    "svc/sameline.ts": "export function first() { return 1; } export function second() { return 2; }\n",
    "svc/sameline-methods.ts": [
      "export class K { a() { return 'a'; } b() { return 'b'; } }",
      "export const p = () => 1, q = () => 2;",
      "export function wrap() { function inner() { return 1; } return inner; }",
      "",
    ].join("\n"),
    "py/pyproject.toml": "",
    "py/same.py": "def first(): return 1\nclass C:\n    def m(self): return 2\n",
    "go/go.mod": "module x\n",
    "go/same.go": "package x\n\nfunc A() int { return 1 }; func B() int { return 2 }\n",

    // --- 4. body-only search
    "svc/search/process.ts": [
      "export function process(x: number) {",
      "  const shippingFee = x * 2;",
      "  return shippingFee;",
      "}",
      "export function shippingFeeFor(weight: number) { return weight * 3; }",
      "export function unrelated(a: number) {",
      "  const total = a + 1;",
      "  return total;",
      "}",
      "export function logAmount(a: number) {",
      "  const shipping = a;",
      "  return shipping;",
      "}",
      "",
    ].join("\n"),

    // --- 5. Vietnamese
    "svc/vi/phi.ts": [
      "/** Tính phí vận chuyển cho đơn hàng. */",
      "export function tinhPhiVanChuyen(don: number) { return don * 2; }",
      "/** Gửi thông báo. */",
      "export function guiThongBao() {}",
      "/** Thu tiền. */",
      "export function thuTien() {}",
      "",
    ].join("\n"),
    "svc/noise/many.ts": Array.from({ length: 60 }, (_, i) =>
      `export function f${i}(a: number) { const total = a + ${i}; return total; }`).join("\n") + "\n",
  });
  s = await startServer(root);
  fns = (await allFunctions(s)).functions;
});
after(async () => {
  await s?.close();
  removeRepo(root);
});

const inFile = (file) => fns.filter((f) => f.file === file);
const one = (file, name) => {
  const hits = inFile(file).filter((f) => f.name === name);
  assert.equal(hits.length, 1, `${file}: expected one ${name}, have: ${inFile(file).map((f) => f.name).join(", ")}`);
  return hits[0];
};

// ---------------------------------------------------------------------------
// 1. CommonJS

test("module.exports = function calculateFee keeps its name and is exported", async () => {
  const fee = one("svc/cjs/named.js", "calculateFee");
  assert.equal(fee.exported, true);
  assert.match(fee.signature, /^function calculateFee\(x\)/);
  assert.deepEqual(fee.exportedAs, ["module.exports"]);
  assert.ok(!inFile("svc/cjs/named.js").some((f) => f.name === "module.exports"));

  const found = await s.json("spec_nav_find_functions", { query: "calculate fee", searchBodies: false });
  assert.equal(found.candidates[0].id, fee.id);
  const read = await s.json("spec_nav_read_function", { id: fee.id });
  assert.equal(read.source, "module.exports = function calculateFee(x) {\n  return x * 2;\n}");
  const byName = await s.json("spec_nav_read_function", { file: "svc/cjs/named.js", name: "calculateFee" });
  assert.equal(byName.id, fee.id);
});

test("anonymous module.exports functions are named module.exports, stably", async () => {
  for (const file of ["svc/cjs/arrow.js", "svc/cjs/anon.js"]) {
    const f = one(file, "module.exports");
    assert.equal(f.exported, true);
    assert.match(f.id, new RegExp(`^${file.replace(/[./]/g, "\\$&")}::module\\.exports@[0-9a-f]{8}$`));
    const read = await s.json("spec_nav_read_function", { file, name: "module.exports" });
    assert.equal(read.id, f.id);
  }
  assert.equal(inFile("svc/cjs/arrow.js").length, 1);
});

test("module.exports.foo, exports.bar, { a, b: c } and exporting a declared function", async () => {
  assert.equal(one("svc/cjs/props.js", "foo").exported, true);
  assert.equal(one("svc/cjs/props.js", "bar").exported, true);

  const refund = one("svc/cjs/aliases.js", "computeRefund");
  assert.equal(refund.exported, true);
  assert.deepEqual(
    [...refund.exportedAs].sort(),
    ["exports.alsoRefund", "module.exports.computeRefund", "module.exports.computeRefund2", "module.exports.giveBack"],
  );
  assert.equal(inFile("svc/cjs/aliases.js").filter((f) => /refund/i.test(f.name)).length, 1, "no record per alias");
  assert.equal(one("svc/cjs/aliases.js", "helperFn").exported, true);
  assert.equal(one("svc/cjs/aliases.js", "internalOnly").exported, false);
  assert.equal(one("svc/cjs/declared.js", "priceOf").exported, true);
  assert.equal(one("svc/cjs/hoisted.js", "lateDecl").exported, true);

  const exp = await s.json("spec_nav_functions", { file: "svc/cjs", exportedOnly: true, limit: 1000 });
  const names = exp.functions.map((f) => `${f.file}:${f.name}`).sort();
  assert.deepEqual(names, [
    "svc/cjs/aliases.js:computeRefund",
    "svc/cjs/aliases.js:helperFn",
    "svc/cjs/anon.js:module.exports",
    "svc/cjs/arrow.js:module.exports",
    "svc/cjs/declared.js:priceOf",
    "svc/cjs/hoisted.js:lateDecl",
    "svc/cjs/named.js:calculateFee",
    "svc/cjs/props.js:bar",
    "svc/cjs/props.js:foo",
  ]);

  // the export name finds and reads it too
  const viaAlias = await s.json("spec_nav_read_function", { file: "svc/cjs/aliases.js", name: "giveBack" });
  assert.equal(viaAlias.id, refund.id);
  const found = await s.json("spec_nav_find_functions", { query: "give back", searchBodies: false });
  assert.ok(found.candidates.some((c) => c.id === refund.id));
});

// ---------------------------------------------------------------------------
// 2. Assigned after declaration

test("a function assigned to a declared variable is catalogued, not counted as a callback", async () => {
  const tax = one("svc/assign/tax.js", "calculateTax");
  assert.equal(tax.kind, "arrow function");
  assert.equal(tax.start, 2);
  assert.equal(tax.startColumn, 1);
  // a line inside it is attributed to it, not to an anonymous callback
  const map = await s.call("spec_nav_map", { pattern: "x \\* 0\\.1", services: ["svc"] });
  assert.match(map, /2 \| calculateTax:2 \|/);
  const read = await s.json("spec_nav_read_function", { id: tax.id });
  assert.equal(read.source, "calculateTax = (x) => x * 0.1");
});

test("assignments are attributed to the variable's own scope", () => {
  const names = inFile("svc/assign/scopes.js").map((f) => f.name).sort();
  // two values of one variable share its name; the ids tell them apart (~2)
  assert.deepEqual(names, ["handler", "handler", "outer", "outer.handler", "setsTop"]);
  assert.deepEqual(
    inFile("svc/assign/scopes.js").filter((f) => f.name === "handler").map((f) => f.id.replace(/@.*/, "")),
    ["svc/assign/scopes.js::handler", "svc/assign/scopes.js::handler~2"],
  );
  const inner = one("svc/assign/scopes.js", "outer.handler");
  assert.equal(inner.start, 5);
  assert.equal(inner.alternatives, undefined, "a same-named variable in another scope is a different variable");
  // the top-level variable is assigned twice: both kept, each points at the other
  const top = inFile("svc/assign/scopes.js").filter((f) => f.name.startsWith("handler"));
  assert.deepEqual(top.map((f) => f.start).sort(), [2, 9]);
  for (const f of top) {
    assert.equal(f.alternatives.length, 1);
    assert.ok(top.some((o) => o.id === f.alternatives[0] && o.id !== f.id));
  }
});

test("several implementations of one variable are all kept and flagged", async () => {
  const fmts = inFile("svc/assign/multi.js");
  assert.deepEqual(fmts.map((f) => f.name), ["format", "format"]);
  assert.match(fmts[1].id, /::format~2@/);
  assert.notEqual(fmts[0].id, fmts[1].id);
  assert.ok(fmts.every((f) => f.exported === true));
  assert.deepEqual(fmts[0].alternatives, [fmts[1].id]);
  const text = await s.call("spec_nav_functions", { file: "svc/assign/multi.js" });
  assert.match(text, /1 of 2 functions assigned to `format`/);
  const read = await s.call("spec_nav_read_function", { id: fmts[1].id });
  assert.match(read, /which one runs is decided at runtime/);
});

test("property, element, logical and this-assignments are named; real callbacks stay anonymous", async () => {
  const names = inFile("svc/assign/props.js").map((f) => f.name).sort();
  assert.deepEqual(names, ["Box.constructor", "Box.open", "Cart", "Cart.total", "api.loadUser", "api.saveUser", "cache.compute"]);
  // coverage counts the whole scope: the forEach callback is the only real
  // callback in this repo, and every assigned function above is named
  const r = await s.json("spec_nav_functions", { file: "svc/assign/props.js" });
  assert.equal(r.coverage.anonymousFunctionsNotListed, 1, "the forEach callback");
  const map = await s.call("spec_nav_map", { pattern: "console\\.log\\(n\\)" });
  assert.match(map, /14 \| <anonymous>:14 \|/);
});

// ---------------------------------------------------------------------------
// 3. Exact extents

test("two functions on one line are read separately", async () => {
  const first = one("svc/sameline.ts", "first");
  const second = one("svc/sameline.ts", "second");
  assert.equal(first.start, 1);
  assert.equal(second.start, 1);
  assert.equal(first.startColumn, 1);
  assert.equal(second.startColumn, 39);
  const a = await s.json("spec_nav_read_function", { id: first.id });
  assert.equal(a.source, "export function first() { return 1; }");
  const b = await s.json("spec_nav_read_function", { id: second.id });
  assert.equal(b.source, "export function second() { return 2; }");
  const text = await s.call("spec_nav_read_function", { id: first.id });
  assert.doesNotMatch(text, /second/);
});

test("methods, arrows and nested functions sharing a line, in TS and tree-sitter languages", async () => {
  const src = async (file, name) => (await s.json("spec_nav_read_function", { file, name })).source;
  assert.equal(await src("svc/sameline-methods.ts", "K.a"), "a() { return 'a'; }");
  assert.equal(await src("svc/sameline-methods.ts", "K.b"), "b() { return 'b'; }");
  assert.equal(await src("svc/sameline-methods.ts", "p"), "p = () => 1");
  assert.equal(await src("svc/sameline-methods.ts", "q"), "q = () => 2");
  assert.equal(await src("svc/sameline-methods.ts", "wrap.inner"), "function inner() { return 1; }");
  assert.equal(await src("py/same.py", "C.m"), "    def m(self): return 2", "indentation before the start is kept");
  assert.equal(await src("go/same.go", "A"), "func A() int { return 1 }");
  assert.equal(await src("go/same.go", "B"), "func B() int { return 2 }");
});

test("editing a function on the same line does not make its neighbour stale", async () => {
  const file = join(root, "svc/sameline.ts");
  const before = one("svc/sameline.ts", "first");
  const second = one("svc/sameline.ts", "second");
  writeFileSync(file, "export function first() { return 1; } export function second() { return 22; }\n");
  const ok = await s.json("spec_nav_read_function", { id: before.id });
  assert.equal(ok.source, "export function first() { return 1; }");
  const stale = await s.client.callTool({ name: "spec_nav_read_function", arguments: { id: second.id } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /STALE ID/);
});

test("continuation reads a long function exactly once and reports a change between parts", async () => {
  const body = Array.from({ length: 900 }, (_, i) => `  x += ${i};`).join("\n");
  const code = `export const pre = 1; export function long(x: number) {\n${body}\n  return x;\n} export const post = 2;\n`;
  writeFileSync(join(root, "svc/long.ts"), code);
  const [fn] = (await s.json("spec_nav_functions", { file: "svc/long.ts", name: "long" })).functions;
  const parts = [];
  let cursor;
  for (;;) {
    const r = await s.json("spec_nav_read_function", { id: fn.id, maxLines: 200, ...(cursor ? { cursor } : {}) });
    parts.push(r.source);
    if (r.complete) break;
    assert.ok(r.nextCursor);
    assert.equal(r.nextFromLine, r.shown.to + 1);
    cursor = r.nextCursor;
  }
  assert.ok(parts.length >= 5);
  const exact = code.slice(code.indexOf("export function long"), code.indexOf(" export const post"));
  assert.equal(parts.join("\n"), exact);

  // fromLine (the older way) still works
  const viaLine = await s.json("spec_nav_read_function", { id: fn.id, fromLine: 3, maxLines: 2 });
  assert.equal(viaLine.source, "  x += 1;\n  x += 2;");

  // the function moves (unchanged) between parts: the cursor follows it
  const r1 = await s.json("spec_nav_read_function", { id: fn.id, maxLines: 100 });
  writeFileSync(join(root, "svc/long.ts"), "// new header\n\n" + code);
  const r2 = await s.json("spec_nav_read_function", { id: fn.id, maxLines: 100, cursor: r1.nextCursor });
  assert.equal(r2.shown.from, r1.shown.to + 3);
  assert.match(r2.source, /^  x \+= 99;/);
  assert.ok(r2.notes.some((n) => /moved/.test(n)));

  // the function itself changes between parts: refused as stale
  writeFileSync(join(root, "svc/long.ts"), code.replace("x += 500;", "x += 5000;"));
  const r3 = await s.client.callTool({ name: "spec_nav_read_function", arguments: { id: fn.id, cursor: r2.nextCursor } });
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /STALE/);
});

// ---------------------------------------------------------------------------
// 4. Body-only matches

test("a match only in the body is returned when searching bodies, ranked last and marked", async () => {
  const r = await s.json("spec_nav_find_functions", { query: "shipping fee", file: "svc/search" });
  const names = r.candidates.map((c) => c.name);
  assert.deepEqual(names, ["shippingFeeFor", "process"]);
  const proc = r.candidates[1];
  assert.equal(proc.bodyOnly, true);
  assert.equal(r.candidates[0].bodyOnly, undefined);
  assert.ok(proc.why.some((w) => /shipping→body/.test(w)));
  assert.ok(!names.includes("unrelated"));
  assert.ok(!names.includes("logAmount"), "a body matching only part of the query is noise");

  const text = await s.call("spec_nav_find_functions", { query: "shipping fee", file: "svc/search" });
  assert.match(text, /\[body only\]/);

  const off = await s.json("spec_nav_find_functions", { query: "shipping fee", file: "svc/search", searchBodies: false });
  assert.deepEqual(off.candidates.map((c) => c.name), ["shippingFeeFor"]);
});

test("common words in bodies do not flood the results", async () => {
  // `return` and `const` sit in nearly every body; a one-word query for a
  // word that is everywhere must not list every function as a body match.
  const r = await s.json("spec_nav_find_functions", { query: "return", file: "svc/search" });
  assert.equal(r.candidates.length, 0, r.candidates.map((c) => c.name).join(", "));
  // a word in many bodies is withheld, and the output says so
  const many = await s.json("spec_nav_find_functions", { query: "total", file: "svc/noise" });
  assert.equal(many.candidates.length, 0);
  assert.equal(many.bodyOnlyWithheld, 60);
  const text = await s.call("spec_nav_find_functions", { query: "total", file: "svc/noise" });
  assert.match(text, /60 body-only match/);
});

// ---------------------------------------------------------------------------
// 5. Unicode / Vietnamese

test("Vietnamese words are kept whole and match with or without diacritics", async () => {
  const r = await s.json("spec_nav_find_functions", { query: "tính phí vận chuyển" });
  assert.deepEqual(r.words, ["tính", "phí", "vận", "chuyển"]);
  assert.equal(r.candidates[0].name, "tinhPhiVanChuyen");
  const plain = await s.json("spec_nav_find_functions", { query: "tinh phi van chuyen" });
  assert.equal(plain.candidates[0].name, "tinhPhiVanChuyen");
  const d = await s.json("spec_nav_find_functions", { query: "đơn hàng" });
  assert.equal(d.candidates[0].name, "tinhPhiVanChuyen");
  const dPlain = await s.json("spec_nav_find_functions", { query: "don hang" });
  assert.equal(dPlain.candidates[0].name, "tinhPhiVanChuyen");
  // `thuế` must not be stemmed into `thu` and match an unrelated word
  const t = await s.json("spec_nav_find_functions", { query: "thuế" });
  assert.equal(t.candidates.length, 0);
});

test("a Vietnamese query says it is not translated", async () => {
  const text = await s.call("spec_nav_find_functions", { query: "tính phí vận chuyển" });
  assert.match(text, /not translated/i);
  assert.match(text, /add English keywords/i);
});

test("camelCase is still split, for Vietnamese and English names alike", async () => {
  const vi = await s.json("spec_nav_find_functions", { query: "gửi thông báo", searchBodies: false });
  assert.equal(vi.candidates[0].name, "guiThongBao");
  const g = await s.json("spec_nav_find_functions", { query: "shipping fee for", searchBodies: false });
  assert.equal(g.candidates[0].name, "shippingFeeFor");
});

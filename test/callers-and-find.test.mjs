import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, removeRepo, startServer } from "./helpers.mjs";

let root, s;
before(async () => {
  root = makeRepo({
    "package.json": JSON.stringify({ private: true, workspaces: ["services/*", "packages/*"] }),
    // --- billing: two classes with a method of the same name
    "services/billing/package.json": JSON.stringify({ name: "@repo/billing", main: "dist/index.js", source: "src/index.ts" }),
    "services/billing/src/index.ts": 'export * from "./order";\n',
    "services/billing/src/order.ts": `export interface Totaler { total(): number }
export class Order implements Totaler {
  total(): number { return 1; }
}
export class Cart {
  total(): number { return 2; }
}
/** Fee charged on each order. */
export function computeOrderFee(order: Order): number { return order.total() * 0.1; }
`,
    // --- shared package, consumed by name, with a re-export alias and a default export
    "packages/shared/package.json": JSON.stringify({ name: "@repo/shared", main: "dist/index.js" }),
    "packages/shared/src/fees.ts": "export function computeFee(x: number) { return x * 2; }\n" +
      "export function calculateShippingFees(weight: number) { return weight * 3; }\n",
    "packages/shared/src/round.ts": "export default function roundYen(n: number) { return Math.round(n); }\n",
    "packages/shared/src/index.ts": 'export { computeFee as shippingFee } from "./fees";\n',
    // --- api: callers through every import shape
    "services/api/package.json": JSON.stringify({ name: "@repo/api" }),
    "services/api/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    "services/api/src/util/math.ts": "export function addTax(n: number) { return n * 1.1; }\n",
    "services/api/src/checkout.ts": `import { Order, Cart, Totaler } from "@repo/billing";
import { computeFee as fee } from "../../../packages/shared/src/fees";
import { addTax } from "@/util/math";
export function checkout(o: Order, c: Cart) {
  return addTax(o.total() + c.total() + fee(1));
}
export function sum(t: Totaler) {
  return t.total();
}
`,
    "services/api/src/other.ts": `import { shippingFee } from "@repo/shared";
export function viaReexport() {
  shippingFee(2);
  return [1, 2].map(shippingFee);
}
`,
    "services/api/src/ns.ts": `import * as fees from "@repo/shared/fees";
import r from "@repo/shared/round";
export function viaNamespace() { return r(fees.computeFee(3)); }
`,
    // --- untyped JS: cannot be resolved, must be reported as such
    "services/web/package.json": "{}",
    "services/web/src/legacy.js": "export function legacyTotal(order) { return order.total(); }\n",
    // --- another language mentioning the name
    "services/py/pyproject.toml": "",
    "services/py/totals.py": "def total():\n    return 1\n",
    // --- unrelated function that matches only one word of the search
    "services/web/src/list.js": "export function renderOrderList(items) { return items; }\n",
  });
  s = await startServer(root);
});
after(async () => {
  await s?.close();
  removeRepo(root);
});

const where = (sites) => sites.map((x) => `${x.file}:${x.line}`).sort();

test("same-named methods on different classes are told apart", async () => {
  const r = await s.json("spec_nav_callers", { symbol: "Order.total" });
  assert.deepEqual(r.targets.map((t) => t.name), ["Order.total"]);
  assert.deepEqual(where(r.sites), ["services/api/src/checkout.ts:5", "services/billing/src/order.ts:9"]);
  assert.ok(Object.keys(r.otherSymbolsSameName).some((k) => k.startsWith("Cart.total")), JSON.stringify(r.otherSymbolsSameName));
  // through the interface Order implements
  assert.deepEqual(where(r.viaInterfaceOrBase), ["services/api/src/checkout.ts:8"]);
  assert.match(r.viaInterfaceOrBase[0].reason, /Totaler\.total \(interface\)/);
  // untyped JS receiver: reported, not guessed
  assert.deepEqual(where(r.unresolved), ["services/web/src/legacy.js:1"]);
  assert.equal(r.exhaustive, false);
  // Python is analysed now: totals.py only declares an unrelated `total`, so it adds no site.
  assert.equal(r.notAnalyzedOtherLanguages.count, 0);
  assert.ok(![...r.sites, ...r.likely, ...r.ambiguous].some((x) => x.file.endsWith(".py")));
  assert.ok(r.notes.some((n) => /NOT a complete list/.test(n)));

  const cart = await s.json("spec_nav_callers", { symbol: "total", className: "Cart" });
  assert.deepEqual(cart.targets.map((t) => t.name), ["Cart.total"]);
  assert.deepEqual(where(cart.sites), ["services/api/src/checkout.ts:5"]);
  assert.equal(cart.sites[0].enclosing, "checkout");
  assert.deepEqual(cart.sites[0].enclosingParams, ["o", "c"]);

  const both = await s.json("spec_nav_callers", { symbol: "total", file: "services/billing/src/order.ts" });
  assert.equal(both.targets.length, 2);
  assert.ok(both.notes.some((n) => /2 declarations match/.test(n)));
});

test("calls through import aliases, re-exports, namespaces and default imports", async () => {
  const r = await s.json("spec_nav_callers", { symbol: "computeFee" });
  assert.deepEqual(r.targets.map((t) => t.file), ["packages/shared/src/fees.ts"]);
  assert.deepEqual(where(r.sites), [
    "services/api/src/checkout.ts:5", // import { computeFee as fee }
    "services/api/src/ns.ts:3", //       fees.computeFee via namespace + workspace subpath
    "services/api/src/other.ts:3", //    shippingFee, re-exported alias from @repo/shared
  ]);
  assert.deepEqual(where(r.references), ["services/api/src/other.ts:4"], "passed as a callback");
  assert.equal(r.totals.unresolved, 0);
  assert.equal(r.exhaustive, true);

  const def = await s.json("spec_nav_callers", { symbol: "roundYen" });
  assert.deepEqual(where(def.sites), ["services/api/src/ns.ts:3"]);
});

test("tsconfig path aliases resolve", async () => {
  const r = await s.json("spec_nav_callers", { symbol: "addTax" });
  assert.deepEqual(where(r.sites), ["services/api/src/checkout.ts:5"]);
  assert.equal(r.sites[0].argCount, 1);
});

test("old call shape still works: service names where to look, symbol declared elsewhere", async () => {
  const r = await s.json("spec_nav_callers", { service: "services/api", symbol: "computeFee" });
  assert.equal(r.total, 3);
  assert.ok(r.notes.some((n) => /not declared in services\/api/.test(n)));
});

test("find_functions finds reusable logic in other services under different words", async () => {
  const r = await s.json("spec_nav_find_functions", { query: "calculate order fees" });
  const names = r.candidates.map((c) => c.name);
  assert.ok(names.includes("computeOrderFee"), names.join(", "));
  assert.ok(names.includes("calculateShippingFees"), names.join(", "));
  assert.ok(!names.includes("renderOrderList"), "one word of three is not a candidate");
  assert.ok(r.servicesWithCandidates.includes("services/billing"));
  assert.ok(r.servicesWithCandidates.includes("packages/shared"));
  assert.equal(r.ranked, true);
  const top = r.candidates.find((c) => c.name === "computeOrderFee");
  assert.ok(top.why.some((w) => /calculate→name\(synonym:compute\)/.test(w)), top.why.join(" "));
  assert.ok(top.why.some((w) => /fees→name\(stem:fee\)/.test(w)), top.why.join(" "));

  const text = await s.call("spec_nav_find_functions", { query: "calculate order fees" });
  assert.match(text, /RANKED LEXICAL CANDIDATES, not a complete answer/);
  assert.match(text, /check that the calling service may depend on/);
});

test("find_functions filters and rejects empty queries", async () => {
  const r = await s.json("spec_nav_find_functions", { query: "fee", services: ["packages/shared"] });
  assert.ok(r.candidates.every((c) => c.service === "packages/shared"));
  await assert.rejects(s.call("spec_nav_find_functions", { query: "the function" }), /no searchable words/);
});

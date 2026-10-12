import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, removeRepo, startServer, allFunctions } from "./helpers.mjs";

const TS = `import { Money } from "./money";

/**
 * Adds the handling fee to an order total.
 * Second line of the doc.
 */
export function addHandlingFee(total: number, fee = 300): number {
  function roundUp(n: number) {
    return Math.ceil(n);
  }
  return roundUp(total + fee);
}

// Converts yen to a display string.
export const formatYen = async (n: number): Promise<string> => \`¥\${n}\`;

const notExported = function named() { return 1; };

export class OrderService {
  constructor(private readonly repo: unknown) {}
  /** Total for one order. */
  calculateTotal(items: number[]): number {
    return items.reduce((a, b) => a + b, 0);
  }
  private static helper(): void {}
  get count(): number { return 0; }
  onSave = (id: string) => { return id; };
}

export const api = {
  fetchOrder(id: string) { return id; },
  cancelOrder: (id: string) => id,
};

export default function () { return "default"; }

declare const items: number[];
declare function useCallback<T>(f: T, deps: unknown[]): T;
declare function asyncHandler<T>(f: T): T;
const doubled = items.map((x) => x * 2);
export const onSave = useCallback(() => {}, []);
export const getUser = asyncHandler(async (req: unknown) => req);
`;

const JS = `
/** CommonJS export. */
module.exports.computeFee = function (order) { return order.total * 0.1; };
exports.other = (x) => x;
function Cart() {}
Cart.prototype.total = function () { return 0; };
module.exports = { listItems() { return []; }, count: () => 0 };
`;

const JSX = `export function Button({ label }) { return <button>{label}</button>; }\n`;
const MJS = `export const esmFn = () => 1;\n`;
const CJS = `function cjsFn() {}\nmodule.exports = { cjsFn };\n`;

let root, s, fns;
before(async () => {
  root = makeRepo({
    "app/package.json": "{}",
    "app/src/orders.ts": TS,
    "app/src/legacy.js": JS,
    "app/src/Button.jsx": JSX,
    "app/src/esm.mjs": MJS,
    "app/src/common.cjs": CJS,
    "app/src/broken.ts": "export function okBefore() { return 1; }\nexport function broken( {\n",
    "py/pyproject.toml": "",
    "py/billing.py": `class Billing:
    def __init__(self, rate):
        self.rate = rate

    @staticmethod
    def compute_fee(amount: int) -> int:
        """Fee for an amount."""
        def inner():
            return 1
        return amount * 2

    def _private(self):
        pass
`,
    "py/broken.py": "def good():\n    return 1\n\ndef bad(:\n    pass\n",
    "go/go.mod": "module x\n",
    "go/order.go": `package order

// Total sums the order.
func (o *Order) Total(tax int) (int, error) {
	return 0, nil
}

func helper() {}
`,
    "java/pom.xml": "<project/>",
    "java/Fee.java": `class FeeService {
  /** Builds it. */
  FeeService(int x) {}
  public static int total(int a, String b) { return 1; }
}`,
    "ruby/Gemfile": "",
    "ruby/invoice.rb": "class Invoice\n  # The total.\n  def total(a, b = 2)\n    1\n  end\n  def self.build\n  end\nend\n",
    "rust/Cargo.toml": "",
    "rust/lib.rs": "struct A;\nimpl A {\n    /// Doc.\n    pub fn total(&self, a: i32) -> i32 { a }\n    fn hidden() {}\n}\n",
    "php/composer.json": "{}",
    "php/Cart.php": "<?php\nclass Cart {\n  /** Total. */\n  private function total(int $a): int { return 1; }\n  public function __construct() {}\n}\n",
    "c/main.c": "/* Sum. */\nstatic int *total(int a, char b) { return 0; }\nint main(void) { return 0; }\n",
    "cpp/order.cpp": "class Order {\n public:\n  int total(int a) { return a; }\n};\n",
    "cs/App.csproj": "<Project/>",
    "cs/Fee.cs": "class FeeAdmin {\n  /// Total.\n  public int Total(int a) { return 1; }\n  public int Count { get; set; }\n}\n",
    "scala/build.sbt": "",
    "scala/Fees.scala": "object Fees {\n  def total(a: Int): Int = a\n}\n",
    "ex/mix.exs": "",
    "ex/billing.ex": "defmodule Billing do\n  @doc \"Totals.\"\n  def total(a, b) do\n    a + b\n  end\n  defp hidden(x), do: x\nend\n",
    "sh/run.sh": "# Deploys.\ndeploy() {\n  echo 1\n}\nfunction cleanup {\n  echo 2\n}\n",
  });
  s = await startServer(root);
  fns = (await allFunctions(s)).functions;
});
after(async () => {
  await s?.close();
  removeRepo(root);
});

const find = (name, file) => {
  const f = fns.find((x) => x.name === name && (!file || x.file.endsWith(file)));
  assert.ok(f, `no function ${name}${file ? " in " + file : ""}; have: ${fns.filter((x) => !file || x.file.endsWith(file)).map((x) => x.name).join(", ")}`);
  return f;
};

test("TypeScript: declarations, arrows, class members, nested, object literals", () => {
  const add = find("addHandlingFee");
  assert.equal(add.kind, "function");
  assert.equal(add.exported, true);
  assert.deepEqual(add.params, ["total: number", "fee = 300"]);
  assert.equal(add.returnType, "number");
  assert.equal(add.start, 7);
  assert.equal(add.end, 12);
  assert.match(add.doc, /Adds the handling fee/);
  assert.match(add.signature, /addHandlingFee\(total: number, fee = 300\): number/);

  const nested = find("addHandlingFee.roundUp");
  assert.equal(nested.kind, "nested function");

  const yen = find("formatYen");
  assert.equal(yen.kind, "arrow function");
  assert.equal(yen.isAsync, true);
  assert.equal(yen.exported, true);
  assert.equal(yen.doc, "Converts yen to a display string.");

  assert.equal(find("notExported").exported, false);
  assert.equal(find("OrderService.constructor").kind, "constructor");
  const calc = find("OrderService.calculateTotal");
  assert.equal(calc.kind, "method");
  assert.equal(calc.exported, true);
  assert.equal(calc.doc, "Total for one order.");
  const helper = find("OrderService.helper");
  assert.equal(helper.visibility, "private");
  assert.equal(helper.isStatic, true);
  assert.equal(find("OrderService.count").kind, "getter");
  assert.equal(find("OrderService.onSave").kind, "arrow function");
  assert.equal(find("api.fetchOrder").kind, "method");
  assert.equal(find("api.cancelOrder").kind, "arrow function");
  assert.equal(find("default", "orders.ts").exported, true);
  // wrapped functions are listed; a mapped array is not a function
  assert.match(find("onSave", "orders.ts").signature, /^onSave = useCallback\(/);
  assert.ok(find("getUser"));
  assert.ok(!fns.some((f) => f.name === "doubled"));
  // ids carry file, qualified name and a content hash
  assert.match(calc.id, /^app\/src\/orders\.ts::OrderService\.calculateTotal@[0-9a-f]{8}$/);
});

test("JavaScript: CommonJS, prototype methods, .jsx, .mjs, .cjs", () => {
  const fee = find("computeFee");
  assert.equal(fee.exported, true);
  assert.equal(fee.doc, "CommonJS export.");
  assert.equal(find("other").exported, true);
  assert.equal(find("Cart.total").kind, "method");
  assert.equal(find("listItems").exported, true);
  assert.equal(find("count", "legacy.js").kind, "arrow function");
  assert.equal(find("Button").language, "javascript");
  assert.ok(find("esmFn"));
  assert.ok(find("cjsFn"));
});

test("tree-sitter languages: qualified names, kinds, params, docs, visibility", () => {
  assert.equal(find("Billing.__init__").kind, "constructor");
  const cf = find("Billing.compute_fee");
  assert.equal(cf.kind, "method");
  assert.equal(cf.returnType, "int");
  assert.equal(cf.doc, "Fee for an amount.");
  assert.equal(cf.start, 5, "a decorator belongs to the function");
  assert.equal(find("Billing.compute_fee.inner").kind, "nested function");
  assert.equal(find("Billing._private").visibility, "private");

  const total = find("Order.Total");
  assert.equal(total.kind, "method");
  assert.equal(total.exported, true);
  assert.equal(total.doc, "Total sums the order.");
  assert.deepEqual(total.params, ["tax int"]);
  assert.equal(find("helper", "order.go").exported, false);

  assert.equal(find("FeeService.FeeService").kind, "constructor");
  assert.equal(find("FeeService.total").visibility, "public");
  assert.equal(find("Invoice.total").doc, "The total.");
  assert.ok(find("Invoice.build"));
  const rs = find("A.total");
  assert.equal(rs.exported, true);
  assert.equal(rs.returnType, "i32");
  assert.equal(find("A.hidden").exported, false);
  assert.equal(find("Cart.total", "Cart.php").visibility, "private");
  assert.equal(find("Cart.__construct").kind, "constructor");
  assert.equal(find("total", "main.c").doc, "Sum.");
  assert.ok(find("main"));
  assert.ok(find("Order.total", "order.cpp"));
  assert.equal(find("FeeAdmin.Total").doc, "Total.");
  assert.equal(find("FeeAdmin.Count").kind, "property");
  assert.ok(find("Fees.total"));
  const ex = find("Billing.total", "billing.ex");
  assert.equal(ex.doc, "Totals.");
  assert.equal(find("Billing.hidden").visibility, "private");
  assert.ok(find("deploy"));
  assert.ok(find("cleanup"));
});

test("files that do not parse are reported, and what parsed is still listed", async () => {
  const r = await s.json("spec_nav_functions", { file: "broken" });
  assert.equal(r.coverage.complete, false);
  const errs = r.coverage.parseErrors.map((e) => e.file).sort();
  assert.deepEqual(errs, ["app/src/broken.ts", "py/broken.py"]);
  const names = r.functions.map((f) => f.name);
  assert.ok(names.includes("okBefore"));
  assert.ok(names.includes("good"));
  const text = await s.call("spec_nav_functions", { file: "broken" });
  assert.match(text, /PARTIAL/);
  assert.match(text, /syntax error: app\/src\/broken\.ts:\d+/);
});

test("filters: name, kind, language, exportedOnly", async () => {
  const byName = await s.json("spec_nav_functions", { name: "total", language: "typescript" });
  assert.deepEqual(byName.functions.map((f) => f.name), ["OrderService.calculateTotal"]);
  const ctors = await s.json("spec_nav_functions", { kind: "constructor" });
  assert.ok(ctors.functions.length >= 4);
  assert.ok(ctors.functions.every((f) => f.kind === "constructor"));
  const exp = await s.json("spec_nav_functions", { file: "orders.ts", exportedOnly: true });
  assert.ok(!exp.functions.some((f) => f.name === "notExported"));
  const re = await s.json("spec_nav_functions", { name: "/^api\\./" });
  assert.deepEqual(re.functions.map((f) => f.name), ["api.fetchOrder", "api.cancelOrder"]);
});

test("long docs are cut and marked in listings", async () => {
  const s2root = makeRepo({ "a.ts": `/** ${"word ".repeat(200)} */\nexport function longDoc() {}\n` });
  const s2 = await startServer(s2root);
  try {
    const r = await s2.json("spec_nav_functions", {});
    assert.equal(r.functions[0].docTruncated, true);
    assert.ok(r.functions[0].doc.length <= 240);
    const full = await s2.json("spec_nav_read_function", { id: r.functions[0].id });
    assert.ok(full.doc.length > 900, "read_function returns the whole doc");
  } finally {
    await s2.close();
    removeRepo(s2root);
  }
});

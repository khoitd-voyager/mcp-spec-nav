import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, removeRepo, startServer, writeFiles } from "./helpers.mjs";

const LONG_LINES = 1500;
const longFn =
  `import { round } from "./math";\nimport { unused } from "./other";\n\n` +
  `/** A very long function. */\nexport function huge(x: number): number {\n` +
  Array.from({ length: LONG_LINES }, (_, i) => `  x = round(x + ${i}); // step ${i} ${"pad ".repeat(10)}`).join("\n") +
  `\n  return x;\n}\n`;

let root, s;
before(async () => {
  root = makeRepo({
    "svc/package.json": "{}",
    "svc/src/huge.ts": longFn,
    "svc/src/fees.ts": "export function calcFee(a: number) {\n  return a * 2;\n}\n",
    "svc/src/dup.ts": "export class A { run() { return 1; } }\nexport class B { run() { return 2; } }\n",
    "svc/src/use.ts": 'import { calcFee } from "./fees";\nexport function useFee() { return calcFee(1); }\n',
    "py/pyproject.toml": "",
    "py/util.py": "import os\nfrom json import dumps, loads\n\ndef dump(x):\n    return dumps(x)\n",
  });
  s = await startServer(root);
});
after(async () => {
  await s?.close();
  removeRepo(root);
});

test("a long function is read completely through continuation", async () => {
  const [fn] = (await s.json("spec_nav_functions", { name: "huge" })).functions;
  const total = fn.end - fn.start + 1;
  const collected = [];
  let fromLine;
  let parts = 0;
  for (;;) {
    const r = await s.json("spec_nav_read_function", { id: fn.id, ...(fromLine ? { fromLine } : {}) });
    collected.push(...r.source.split("\n"));
    parts++;
    if (r.complete) break;
    assert.equal(r.nextFromLine, r.shown.to + 1);
    fromLine = r.nextFromLine;
    assert.ok(parts < 50);
  }
  assert.ok(parts > 1, "a 1500-line function should take several parts");
  assert.equal(collected.length, total, "lines lost or repeated between parts");
  const fileLines = readFileSync(join(root, "svc/src/huge.ts"), "utf8").split("\n");
  assert.deepEqual(collected, fileLines.slice(fn.start - 1, fn.end));

  const text = await s.call("spec_nav_read_function", { id: fn.id });
  assert.match(text, /MORE: call again with the same id and fromLine=\d+/);
  assert.match(text, /function continues at line/);
  assert.match(text, /import \{ round \} from "\.\/math";/);
  assert.doesNotMatch(text, /unused/, "imports the function does not use are left out");
});

test("read by file + name, ambiguity, and non-TS imports", async () => {
  const r = await s.json("spec_nav_read_function", { file: "svc/src/fees.ts", name: "calcFee" });
  assert.equal(r.source, "export function calcFee(a: number) {\n  return a * 2;\n}");
  assert.equal(r.complete, true);
  await assert.rejects(s.call("spec_nav_read_function", { file: "svc/src/dup.ts", name: "run" }), /ambiguous[\s\S]*A\.run[\s\S]*B\.run/);
  const b = await s.json("spec_nav_read_function", { file: "svc/src/dup.ts", name: "B.run" });
  assert.match(b.source, /return 2/);
  const byLine = await s.json("spec_nav_read_function", { file: "svc/src/dup.ts", name: "run", line: 2 });
  assert.equal(byLine.name, "B.run");
  const py = await s.json("spec_nav_read_function", { file: "py/util.py", name: "dump" });
  assert.deepEqual(py.imports, ["from json import dumps, loads"]);
});

test("a stale id is refused with the current id; the new id works", async () => {
  const [fn] = (await s.json("spec_nav_functions", { name: "calcFee" })).functions;
  writeFileSync(join(root, "svc/src/fees.ts"), "// moved down\n\nexport function calcFee(a: number) {\n  return a * 3;\n}\n");
  const stale = await s.client.callTool({ name: "spec_nav_read_function", arguments: { id: fn.id } });
  assert.equal(stale.isError, true);
  const msg = stale.content[0].text;
  assert.match(msg, /STALE ID/);
  const current = msg.match(/Current id: (\S+)/)[1];
  assert.notEqual(current, fn.id);
  const fresh = await s.json("spec_nav_read_function", { id: current });
  assert.equal(fresh.start, 3);
  assert.match(fresh.source, /a \* 3/);
});

test("an unchanged function keeps its id when the file changes elsewhere", async () => {
  const [fn] = (await s.json("spec_nav_functions", { name: "useFee" })).functions;
  writeFileSync(join(root, "svc/src/use.ts"), '// header\nimport { calcFee } from "./fees";\nexport function useFee() { return calcFee(1); }\n');
  const r = await s.json("spec_nav_read_function", { id: fn.id });
  assert.equal(r.start, 3, "same id, new position");
});

test("adding, editing and deleting files while the server runs", async () => {
  // add
  writeFiles(root, { "svc/src/added.ts": 'import { calcFee } from "./fees";\nexport function freshlyAdded() { return calcFee(2); }\n' });
  let names = (await s.json("spec_nav_functions", { file: "svc/src" })).functions.map((f) => f.name);
  assert.ok(names.includes("freshlyAdded"));
  let found = await s.json("spec_nav_find_functions", { query: "freshly added" });
  assert.equal(found.candidates[0].name, "freshlyAdded");
  let map = await s.call("spec_nav_map", { pattern: "freshlyAdded" });
  assert.match(map, /svc\/src\/added\.ts/);
  let callers = await s.json("spec_nav_callers", { symbol: "calcFee" });
  assert.deepEqual(callers.sites.map((x) => x.file).sort(), ["svc/src/added.ts", "svc/src/use.ts"]);

  // edit: rename the function, and add a second call
  writeFiles(root, {
    "svc/src/added.ts": 'import { calcFee } from "./fees";\nexport function renamedFn() { return calcFee(2) + calcFee(3); }\n',
  });
  names = (await s.json("spec_nav_functions", { file: "svc/src" })).functions.map((f) => f.name);
  assert.ok(names.includes("renamedFn"));
  assert.ok(!names.includes("freshlyAdded"));
  callers = await s.json("spec_nav_callers", { symbol: "calcFee" });
  assert.equal(callers.sites.filter((x) => x.file === "svc/src/added.ts").length, 2);
  assert.ok(callers.sites.every((x) => x.enclosing !== "freshlyAdded"));

  // delete
  unlinkSync(join(root, "svc/src/added.ts"));
  names = (await s.json("spec_nav_functions", {})).functions.map((f) => f.name);
  assert.ok(!names.includes("renamedFn"));
  found = await s.json("spec_nav_find_functions", { query: "renamed" });
  assert.ok(!found.candidates.some((c) => c.name === "renamedFn"));
  map = await s.call("spec_nav_map", { pattern: "renamedFn" });
  assert.match(map, /0 hits in 0 files/);
  callers = await s.json("spec_nav_callers", { symbol: "calcFee" });
  assert.deepEqual(callers.sites.map((x) => x.file), ["svc/src/use.ts"]);
});

test("a new project directory appears as a service while running", async () => {
  writeFiles(root, { "late/package.json": "{}", "late/src/late.js": "export function lateFn() {}\n" });
  const r = JSON.parse(await s.call("spec_nav_services"));
  assert.ok(r.services.includes("late"));
  const [fn] = (await s.json("spec_nav_functions", { name: "lateFn" })).functions;
  assert.equal(fn.service, "late");
});

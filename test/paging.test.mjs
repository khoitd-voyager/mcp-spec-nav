import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, removeRepo, startServer, allFunctions } from "./helpers.mjs";

const N = 450;
let root, s;
before(async () => {
  const files = { "package.json": "{}" };
  for (let i = 0; i < N; i++) {
    const p = String(i).padStart(3, "0");
    files[`src/mod${p}/fee${p}.ts`] =
      `export function feeA${p}(x: number) { return x + FEE_${p}; }\n` +
      `export function feeB${p}() { return FEE_${p} * 2; }\n` +
      `const FEE_${p} = ${i};\n`;
  }
  root = makeRepo(files);
  s = await startServer(root);
});
after(async () => {
  await s?.close();
  removeRepo(root);
});

test(`catalog over ${N} files: every function once across pages`, async () => {
  const { functions, pages, last } = await allFunctions(s, { limit: 150 });
  assert.equal(last.total, N * 2);
  assert.ok(pages >= 6, `expected several pages, got ${pages}`);
  const ids = functions.map((f) => f.id);
  assert.equal(ids.length, N * 2, "lost or repeated functions across pages");
  assert.equal(new Set(ids).size, N * 2, "a function appeared on two pages");
  assert.equal(new Set(functions.map((f) => f.file)).size, N);
});

test("text pages say MORE with a cursor until the last says COMPLETE", async () => {
  const first = await s.call("spec_nav_functions", { limit: 500 });
  const m = first.match(/MORE: call again with cursor="([^"]+)"/);
  assert.ok(m, "first page must offer a cursor");
  assert.match(first, /functions: 900 match the filters — this page 1-/);
  let cursor = m[1];
  let last;
  for (let i = 0; i < 20 && cursor; i++) {
    last = await s.call("spec_nav_functions", { limit: 500, cursor });
    cursor = last.match(/cursor="([^"]+)"/)?.[1];
  }
  assert.match(last, /COMPLETE/);
});

test(`map over ${N} files: every hit reachable through pages, none repeated`, async () => {
  const seen = new Set();
  let cursor;
  let pages = 0;
  let firstPage;
  for (;;) {
    const text = await s.call("spec_nav_map", { pattern: "FEE_\\d+ \\*|FEE_\\d+;", ...(cursor ? { cursor } : {}) });
    if (!firstPage) firstPage = text;
    pages++;
    let file;
    for (const line of text.split("\n")) {
      if (/^src\//.test(line)) file = line.split("  ")[0];
      const hit = line.match(/^  (\d+) \| /);
      if (hit && file) {
        const k = `${file}:${hit[1]}`;
        assert.ok(!seen.has(k), `hit ${k} repeated`);
        seen.add(k);
      }
    }
    cursor = text.match(/cursor="([^"]+)"/)?.[1];
    if (!cursor) {
      assert.match(text, /COMPLETE/);
      break;
    }
    assert.ok(pages < 50, "pages never ended");
  }
  assert.match(firstPage, /^900 hits in 450 files/m);
  assert.equal(seen.size, N * 2, `expected ${N * 2} hits, collected ${seen.size} over ${pages} pages`);
  assert.ok(pages > 1);
});

test("map pageSize gives exact pages and a cursor cannot be replayed on another pattern", async () => {
  const p1 = await s.call("spec_nav_map", { pattern: "feeA\\d+\\(", pageSize: 100 });
  assert.match(p1, /this page: hits 1-100 — MORE/);
  const cursor = p1.match(/cursor="([^"]+)"/)[1];
  const p2 = await s.call("spec_nav_map", { pattern: "feeA\\d+\\(", pageSize: 100, cursor });
  assert.match(p2, /this page: hits 101-200/);
  await assert.rejects(s.call("spec_nav_map", { pattern: "other", cursor }), /different query/);
});

test("find_functions pages through all candidates", async () => {
  const ids = new Set();
  let cursor;
  let total;
  for (let i = 0; i < 40; i++) {
    const r = await s.json("spec_nav_find_functions", { query: "fee", limit: 100, ...(cursor ? { cursor } : {}) });
    total = r.totalCandidates;
    for (const c of r.candidates) {
      assert.ok(!ids.has(c.id));
      ids.add(c.id);
    }
    if (r.complete) break;
    cursor = r.nextCursor;
  }
  assert.equal(total, N * 2);
  assert.equal(ids.size, N * 2);
});

// Shared fixtures for the regression tests. Every test talks to the built
// server (dist/index.cjs) over real MCP stdio — the same path a client uses —
// so a passing test means the shipped bundle works, not just the sources.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.cjs");

/** Write a tree of files into a fresh temp directory and return its path. */
export function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "spec-nav-test-"));
  writeFiles(root, files);
  return root;
}

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function removeRepo(root) {
  rmSync(root, { recursive: true, force: true });
}

/** Start the server against `root`. Returns { call, json, text, close }. */
export async function startServer(root) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    env: { ...process.env, SPEC_NAV_ROOT: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "spec-nav-test", version: "0.0.0" });
  await client.connect(transport);

  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text).join("\n");
    if (res.isError) {
      const err = new Error(text);
      err.isToolError = true;
      throw err;
    }
    return text;
  };
  return {
    client,
    call,
    /** Call a tool that supports format:"json" and parse the result. */
    json: async (name, args = {}) => JSON.parse(await call(name, { ...args, format: "json" })),
    close: () => client.close(),
  };
}

/** Collect every function across all pages of spec_nav_functions. */
export async function allFunctions(s, args = {}) {
  const out = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const r = await s.json("spec_nav_functions", { ...args, ...(cursor ? { cursor } : {}) });
    out.push(...r.functions);
    pages++;
    if (r.complete) return { functions: out, pages, last: r };
    assert.ok(r.nextCursor, "an incomplete page must carry a cursor");
    cursor = r.nextCursor;
  }
}


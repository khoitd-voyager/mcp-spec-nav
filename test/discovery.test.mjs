import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, removeRepo, startServer, allFunctions } from "./helpers.mjs";

let root, s;
before(async () => {
  root = makeRepo({
    "package.json": JSON.stringify({ name: "monorepo", private: true }),
    "src/root.ts": "export function rootHelper() { return 1; }\n",
    "services/api/package.json": JSON.stringify({ name: "@repo/api" }),
    "services/api/src/api.ts": "export function apiHandler() { return 2; }\n",
    "packages/shared/package.json": JSON.stringify({ name: "@repo/shared" }),
    "packages/shared/src/money.ts": "export function formatMoney(n: number) { return `${n}`; }\n",
    // Six levels down, under directories that are not projects themselves.
    "platform/backend/domains/billing/workers/invoicer/package.json": "{}",
    "platform/backend/domains/billing/workers/invoicer/src/run.js":
      "export function runInvoicer() { return 3; }\n",
    // A project nested inside another project is its own service.
    "services/api/plugins/audit/package.json": "{}",
    "services/api/plugins/audit/index.ts": "export function auditPlugin() {}\n",
    // Plain source folders whose names used to be skipped by mistake.
    "src/env/index.ts": "export function readEnv() { return process.env; }\n",
    "tools/bin/cli.js": "function cliMain() {}\n",
    // Things that must stay out.
    "node_modules/lib/index.js": "export function libFn() {}\n",
    "services/api/dist/api.js": "export function builtFn() {}\n",
    ".venv/pyvenv.cfg": "home = /usr/bin\n",
    ".venv/lib/site.py": "def venv_fn(): pass\n",
    "pyenv/pyvenv.cfg": "home = /usr/bin\n",
    "pyenv/lib/x.py": "def venv_fn2(): pass\n",
    "dotnet/App.csproj": "<Project/>",
    "dotnet/bin/Debug/Gen.cs": "class Gen { void Built() {} }\n",
    "dotnet/Program.cs": "class Program { static void Main() {} }\n",
    "nuget/packages/Newtonsoft.Json.13.0.1/Newtonsoft.Json.13.0.1.nupkg": "zip",
    "nuget/packages/Newtonsoft.Json.13.0.1/lib/Helper.cs": "class Helper { void Vendored() {} }\n",
    "web/app.min.js": "function minified(){}",
    "web/App.vue": "<script>export default {}</script>\n",
    "web/lib.dart": "void main() {}\n",
  });
  s = await startServer(root);
});
after(async () => {
  await s?.close();
  removeRepo(root);
});

test("services cover the root, nested and deep projects, and packages/", async () => {
  const r = JSON.parse(await s.call("spec_nav_services"));
  for (const svc of [
    ".",
    "services/api",
    "packages/shared",
    "platform/backend/domains/billing/workers/invoicer",
    "services/api/plugins/audit",
  ]) {
    assert.ok(r.services.includes(svc), `missing service ${svc}: ${r.services}`);
  }
});

test("catalog has every function exactly once, and nothing from dependency/build dirs", async () => {
  const { functions } = await allFunctions(s);
  const names = functions.map((f) => f.name).sort();
  assert.deepEqual(names, [
    "Program.Main",
    "apiHandler",
    "auditPlugin",
    "cliMain",
    "formatMoney",
    "readEnv",
    "rootHelper",
    "runInvoicer",
  ]);
  const files = functions.map((f) => f.file);
  assert.equal(new Set(files).size, files.length, "a file was listed twice");
  const byName = Object.fromEntries(functions.map((f) => [f.name, f]));
  assert.equal(byName.rootHelper.service, ".");
  assert.equal(byName.readEnv.service, ".");
  assert.equal(byName.apiHandler.service, "services/api");
  assert.equal(byName.auditPlugin.service, "services/api/plugins/audit");
  assert.equal(byName.formatMoney.service, "packages/shared");
  assert.equal(byName.runInvoicer.language, "javascript");
});

test("service filters: '.' is root-only, a directory includes nested projects", async () => {
  const rootOnly = await allFunctions(s, { services: ["."] });
  assert.deepEqual(rootOnly.functions.map((f) => f.name).sort(), ["cliMain", "readEnv", "rootHelper"]);
  const api = await allFunctions(s, { services: ["services/api"] });
  assert.deepEqual(api.functions.map((f) => f.name).sort(), ["apiHandler", "auditPlugin"]);
});

test("map covers root, packages/ and deep JS without duplicate files", async () => {
  const text = await s.call("spec_nav_map", { pattern: "function" });
  for (const f of [
    "src/root.ts",
    "services/api/src/api.ts",
    "packages/shared/src/money.ts",
    "platform/backend/domains/billing/workers/invoicer/src/run.js",
  ]) {
    assert.equal(text.split("\n").filter((l) => l === f || l.startsWith(f + "  ")).length, 1, `${f} should appear once:\n${text}`);
  }
  assert.ok(!text.includes("node_modules"));
  assert.ok(!text.includes("dist/api.js"));
  assert.match(text, /COMPLETE/);
});

test("coverage reports unsupported and skipped files and does not claim completeness", async () => {
  const r = await s.json("spec_nav_functions", {});
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.unsupportedSourceFiles.byExtension[".dart"], 1);
  assert.equal(r.coverage.unsupportedSourceFiles.byExtension[".vue"], undefined, "Vue components are parsed now");
  assert.equal(r.coverage.byLanguage.vue, 1);
  assert.ok(r.coverage.skippedFiles.some((f) => f.file === "web/app.min.js"));
  assert.match(r.coverage.summary, /PARTIAL/);
  const excluded = r.coverage.excludedDirs.sample.join(" ");
  assert.match(excluded, /pyenv \(python virtualenv\)/);
  assert.match(excluded, /dotnet\/bin \(dotnet build output\)/);
  assert.match(excluded, /nuget\/packages \(nuget packages\)/);
});

// Đóng gói server thành Claude Desktop Extension (.mcpb).
//
// Extension chạy bằng Node có sẵn trong Claude Desktop, không có `npm install`,
// nên mọi thứ server cần lúc chạy phải nằm trong gói. Bundle dist/index.cjs đã
// chứa mọi dependency trừ web-tree-sitter (xem build.mjs); thứ còn thiếu là
// web-tree-sitter và file .wasm của từng grammar. Package grammar kèm cả source
// C và bản build native (tới 65 MB mỗi cái) mà server không dùng, nên chỉ copy
// package.json — để require.resolve tìm ra thư mục — và file .wasm.
//
// Chạy sau `npm run build`: `npm run pack:mcpb`.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const stage = path.join(repo, "build", "mcpb");
const out = path.join(repo, "build", `${pkg.name}-${pkg.version}.mcpb`);

const manifest = {
  manifest_version: "0.3",
  name: pkg.name,
  display_name: "Spec Nav",
  version: pkg.version,
  description:
    "Find existing functions to reuse (by words or by behaviour), read them in full, find callers across languages and survey every match for a pattern across a local repository.",
  long_description: pkg.description,
  author: { name: "khoitd-voyager", url: "https://github.com/khoitd-voyager" },
  repository: { type: "git", url: "https://github.com/khoitd-voyager/mcp-spec-nav" },
  homepage: "https://github.com/khoitd-voyager/mcp-spec-nav",
  license: pkg.license,
  keywords: ["code-navigation", "monorepo", "ast", "tree-sitter", "typescript", "kotlin", "swift", "vue"],
  server: {
    type: "node",
    entry_point: "dist/index.cjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/index.cjs"],
      env: { SPEC_NAV_ROOT: "${user_config.repo_root}" },
    },
  },
  tools: [
    { name: "spec_nav_services", description: "Show the scanned root, its projects, file/function counts and coverage." },
    { name: "spec_nav_find_functions", description: "Rank existing functions that may already do what you need." },
    { name: "spec_nav_read_function", description: "Read one function exactly, with signature, docs and related imports." },
    { name: "spec_nav_functions", description: "Browse the function catalog with filters and paging." },
    { name: "spec_nav_similar_functions", description: "Find functions that behave like a given one or a draft, whatever they are named." },
    { name: "spec_nav_callers", description: "Find callers: type-checked in TS/JS/Vue, evidence-based in 13 other languages; dynamic uses listed." },
    { name: "spec_nav_map", description: "Every line matching a regex, tagged with the function it sits in." },
  ],
  user_config: {
    repo_root: {
      type: "directory",
      title: "Repository to scan",
      description:
        "Absolute path of the local checkout to scan. Pick the monorepo root to cover every service.",
      required: true,
    },
  },
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: pkg.engines.node },
  },
};

/** Đường dẫn .wasm của các grammar (`pkg/file.wasm`), đọc từ bảng ngôn ngữ để hai nơi không lệch nhau. */
function grammarWasms() {
  const src = fs.readFileSync(path.join(repo, "src", "languages.ts"), "utf8");
  const wasms = [...src.matchAll(/wasm:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (wasms.length === 0) throw new Error("no grammar .wasm found in src/languages.ts");
  return wasms;
}

function copy(rel, from = repo) {
  const src = path.join(from, rel);
  if (!fs.existsSync(src)) throw new Error(`missing ${path.relative(repo, src)} — run npm install && npm run build`);
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Copy cả license của package nếu có; không phải grammar nào cũng kèm. */
function copyLicense(dir) {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    if (fs.existsSync(path.join(repo, dir, name))) return copy(path.join(dir, name));
  }
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

copy("dist/index.cjs");
copy("LICENSE");

// web-tree-sitter: bundle require() bản CJS, bản CJS nạp web-tree-sitter.wasm nằm cạnh nó.
for (const f of ["package.json", "web-tree-sitter.cjs", "web-tree-sitter.wasm"]) {
  copy(path.join("node_modules", "web-tree-sitter", f));
}
copyLicense(path.join("node_modules", "web-tree-sitter"));

const grammarPkgs = new Set();
for (const wasm of grammarWasms()) {
  const [name] = wasm.split("/");
  grammarPkgs.add(name);
  copy(path.join("node_modules", wasm));
}
for (const name of grammarPkgs) {
  copy(path.join("node_modules", name, "package.json"));
  copyLicense(path.join("node_modules", name));
}

fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const mcpb = path.join(repo, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb");
execFileSync(mcpb, ["validate", path.join(stage, "manifest.json")], { stdio: "inherit" });
fs.rmSync(out, { force: true });
execFileSync(mcpb, ["pack", stage, out], { stdio: "inherit" });

const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`\n${path.relative(repo, out)}  ${mb} MB`);

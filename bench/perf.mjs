// Hiệu năng spec-nav trên một repo lớn: thời gian index lần đầu (cold), độ trễ
// từng tool khi đã ấm (warm), và RAM của server.
//
// node bench/perf.mjs --repo <path> [--queries "q1;q2"] [--symbols "a;B.c"] [--patterns "p1;p2"]
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { startMcp } from "./run.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const repo = resolve(arg("repo"));
const queries = arg("queries", "parse configuration file;register command;resolve file path").split(";");
const symbols = arg("symbols", "").split(";").filter(Boolean);
const patterns = arg("patterns", "telemetry[_ -]?reporter;max[_ -]?file[_ -]?size").split(";");

const client = await startMcp(repo);
const pid = client.transport?.pid;
const rss = () => {
  if (!pid) return undefined;
  const kb = Number(spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
  return kb ? Math.round(kb / 1024) : undefined;
};
const rows = [];
const time = async (label, name, args) => {
  const t0 = performance.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const ms = Math.round(performance.now() - t0);
  const text = res.content.map((c) => c.text).join("\n");
  rows.push({ label, ms, outChars: text.length, rssMb: rss(), isError: !!res.isError });
  console.error(`${label.padEnd(48)} ${String(ms).padStart(7)} ms  ${String(rss() ?? "?").padStart(5)} MB  ${text.length} chars${res.isError ? "  ERROR " + text.slice(0, 120) : ""}`);
  return text;
};

const services = JSON.parse(await time("cold: spec_nav_services (index whole repo)", "spec_nav_services", {}));
await time("warm: spec_nav_services", "spec_nav_services", {});
for (const q of queries) await time(`find_functions "${q}"`, "spec_nav_find_functions", { query: q, limit: 20 });
const list = JSON.parse(await time("functions (first page, json)", "spec_nav_functions", { limit: 50, format: "json" }));
const someId = list.functions.find((f) => f.end - f.start > 5)?.id;
if (someId) {
  await time("read_function", "spec_nav_read_function", { id: someId });
  await time("similar_functions (by id)", "spec_nav_similar_functions", { id: someId, limit: 10 });
}
for (const p of patterns) await time(`map "${p}"`, "spec_nav_map", { pattern: p });
for (const [i, s] of symbols.entries()) await time(`${i === 0 ? "cold " : ""}callers ${s}`, "spec_nav_callers", { symbol: s, format: "json" });
await client.close();

const files = services.details.reduce((a, d) => a + d.files, 0);
const functions = services.details.reduce((a, d) => a + d.functions, 0);
const name = repo.split("/").pop();
const n = (x) => x.toLocaleString("en-US");
const LOCALES = [
  { heading: "English", title: `Performance on ${name}`, summary: `${n(files)} files read, ${n(functions)} functions in the catalog, ${services.services.length} projects.`,
    columns: "| Operation | Time | Server RAM | Output |", chars: "chars", error: "error" },
  { heading: "Tiếng Việt", title: `Hiệu năng trên ${name}`, summary: `${n(files)} file được đọc, ${n(functions)} hàm trong catalog, ${services.services.length} project.`,
    columns: "| Thao tác | Thời gian | RAM server | Output |", chars: "ký tự", error: "lỗi" },
  { heading: "简体中文", title: `${name} 上的性能`, summary: `读取 ${n(files)} 个文件，目录中 ${n(functions)} 个函数，${services.services.length} 个项目。`,
    columns: "| 操作 | 耗时 | Server 内存 | 输出 |", chars: "字符", error: "错误" },
];
console.log(`\n**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**`);
for (const t of LOCALES) {
  console.log(`\n## ${t.heading}\n\n### ${t.title}\n`);
  console.log(`- ${t.summary}`);
  console.log(`- Coverage: ${services.coverage}\n`);
  console.log(`${t.columns}\n|---|---:|---:|---:|`);
  for (const r of rows) console.log(`| ${r.label} | ${n(r.ms)} ms | ${r.rssMb ?? "?"} MB | ${n(r.outChars)} ${t.chars}${r.isError ? ` (${t.error})` : ""} |`);
}

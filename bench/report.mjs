// Tổng hợp kết quả benchmark thành bảng Markdown.
// node bench/report.mjs bench/results/bench-<stamp>.json
import { readFileSync } from "node:fs";
import { rng } from "./generate.mjs";

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const quantile = (xs, q) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "–");
const num = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "–");
const dec = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const signed = (x, f) => (x > 0 ? "+" : x < 0 ? "−" : "") + f(Math.abs(x));

/** Khoảng tin cậy 95% (bootstrap theo cặp) cho trung bình của hiệu mcp − baseline. */
function bootstrapDiff(rows, get, iters = 4000) {
  const diffs = rows.map((r) => get(r.mcp) - get(r.baseline));
  const r = rng(7);
  const means = [];
  for (let k = 0; k < iters; k++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(r.next() * diffs.length)];
    means.push(s / diffs.length);
  }
  return { lo: quantile(means, 0.025), hi: quantile(means, 0.975) };
}

function table(rows, metrics) {
  const out = ["| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |", "|---|---:|---:|---:|---:|"];
  for (const [label, get, fmt] of metrics) {
    const b = mean(rows.map((r) => get(r.baseline)));
    const m = mean(rows.map((r) => get(r.mcp)));
    const ci = bootstrapDiff(rows, get);
    const rel = Number.isFinite(b) && b && fmt !== pct ? ` (${signed((m - b) / b, (v) => `${(v * 100).toFixed(0)}%`)})` : "";
    out.push(`| ${label} | ${fmt(b)} | ${fmt(m)} | ${signed(m - b, fmt)}${rel} | [${signed(ci.lo, fmt)}, ${signed(ci.hi, fmt)}] |`);
  }
  return out.join("\n");
}

const QUALITY = [
  ["session đúng hoàn toàn", (x) => Number(x.allCorrect), pct],
  ["tái sử dụng được hàm có sẵn", (x) => x.reuse.found, pct],
  ["callers: recall", (x) => x.callers.recall, pct],
  ["callers: precision", (x) => x.callers.precision, pct],
  ["callers: đủ hết, không thừa", (x) => x.callers.ok, pct],
  ["survey: recall", (x) => x.survey.recall, pct],
  ["survey: đủ hết, không thừa", (x) => x.survey.ok, pct],
  ["chỗ sửa nhầm (wrong edits)", (x) => x.wrongEdits, dec],
  ["chỗ cần sửa bị sót (missed edits)", (x) => x.missedEdits, dec],
];
const COST = [
  ["tool calls (= lượt model)", (x) => x.toolCalls, dec],
  ["token context cuối session", (x) => x.contextTokens, num],
  ["  trong đó: pha tìm kiếm", (x) => x.searchContextTokens, num],
  ["  trong đó: pha đọc + sửa", (x) => x.contextTokens - x.searchContextTokens, num],
  ["token input tích lũy (không cache)", (x) => x.cumulativeInputTokens, num],
  ["token input quy đổi (có prompt cache)", (x) => x.cachedEquivalentTokens, num],
  ["token output (tham số tool)", (x) => x.outputTokens, num],
  ["thời gian tool, gồm khởi động MCP (ms)", (x) => x.toolMs + (x.serverStartMs ?? 0), num],
];

function distribution(rows) {
  const out = ["| Token context / session | Không MCP | Có MCP |", "|---|---:|---:|"];
  for (const [label, q] of [["min", 0], ["median", 0.5], ["p90", 0.9], ["max", 1]]) {
    out.push(`| ${label} | ${num(quantile(rows.map((r) => r.baseline.contextTokens), q))} | ${num(quantile(rows.map((r) => r.mcp.contextTokens), q))} |`);
  }
  out.push(`| tổng ${rows.length} session | ${num(sum(rows.map((r) => r.baseline.contextTokens)))} | ${num(sum(rows.map((r) => r.mcp.contextTokens)))} |`);
  out.push(`| tổng input tích lũy (có cache) | ${num(sum(rows.map((r) => r.baseline.cachedEquivalentTokens)))} | ${num(sum(rows.map((r) => r.mcp.cachedEquivalentTokens)))} |`);
  return out.join("\n");
}

function breakdown(rows, keyOf, label, quality) {
  const groups = new Map();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  const [qLabel, q, qf] = quality;
  const out = [`| ${label} | n | ${qLabel}: không MCP | ${qLabel}: có MCP | token tìm kiếm: không MCP | token tìm kiếm: có MCP |`, "|---|---:|---:|---:|---:|---:|"];
  for (const [k, rs] of [...groups].sort()) {
    out.push(`| ${k} | ${rs.length} | ${qf(mean(rs.map((r) => q(r.baseline))))} | ${qf(mean(rs.map((r) => q(r.mcp))))} | ` +
      `${num(mean(rs.map((r) => r.baseline.searchContextTokens)))} | ${num(mean(rs.map((r) => r.mcp.searchContextTokens)))} |`);
  }
  return out.join("\n");
}

function section(title, rows, withBreakdowns) {
  const better = (a, b) => rows.filter((r) => Number(r[a].allCorrect) > Number(r[b].allCorrect)).map((r) => r.id);
  const parts = [
    `## ${title}`,
    ``,
    `### Chất lượng`,
    ``,
    table(rows, QUALITY),
    ``,
    `### Chi phí`,
    ``,
    table(rows, COST),
    ``,
    distribution(rows),
    ``,
  ];
  if (withBreakdowns) {
    parts.push(
      `### Theo độ khó của bước tái sử dụng`,
      ``,
      breakdown(rows, (r) => r.difficulty, "Độ khó", ["tìm thấy", (x) => x.reuse.found, pct]),
      ``,
      `### Theo ngôn ngữ của hàm cần đổi signature`,
      ``,
      breakdown(rows, (r) => r.callersLanguage, "Ngôn ngữ", ["callers đủ & không thừa", (x) => x.callers.ok, pct]),
      ``,
    );
  }
  const failures = (side) => rows.flatMap((r) => (r[side].failures ?? []).map((f) => `${r.id}: ${f}`));
  parts.push(
    `### Session chỉ một bên làm đúng hoàn toàn`,
    ``,
    `- Chỉ MCP đúng (${better("mcp", "baseline").length}): ${better("mcp", "baseline").join(", ") || "không có"}`,
    `- Chỉ không-MCP đúng (${better("baseline", "mcp").length}): ${better("baseline", "mcp").join(", ") || "không có"}`,
    ``,
    `<details><summary>Các việc con thất bại</summary>`,
    ``,
    `Không MCP:`,
    ...failures("baseline").map((f) => `- ${f}`),
    ``,
    `Có MCP:`,
    ...failures("mcp").map((f) => `- ${f}`),
    ``,
    `</details>`,
    ``,
  );
  return parts.join("\n");
}

export function report({ meta, results }) {
  const standard = results.filter((r) => r.size !== "large");
  const large = results.filter((r) => r.size === "large");
  return [
    `# Benchmark spec-nav: có MCP vs không MCP`,
    ``,
    `- Repo: ${meta.repoLabel ?? "giả lập"} — ${meta.files.toLocaleString("en-US")} file, ${meta.lines.toLocaleString("en-US")} dòng${meta.services ? `, ${meta.services} service/package` : ""}${meta.seed !== undefined ? ` (seed ${meta.seed})` : ""}.`,
    `- ${standard.length} session thường (1 feature: tái sử dụng + đổi signature một hàm + đổi một hằng số + đọc và sửa code)` +
      (large.length ? ` và ${large.length} session lớn (gộp ${meta.perLarge ?? 3} feature trong một context).` : "."),
    `- Mỗi session chạy 2 lần: không MCP (Grep = ripgrep với head_limit ${meta.headLimit}, Read = cat -n, Edit) và có MCP (spec-nav, server mới mỗi session = cold start; vẫn có Read/Edit).`,
    `- Token ước lượng ${meta.charsPerToken} ký tự/token cho cả hai bên. Định nghĩa tool MCP ~${num(meta.schemaTokens)} token được cộng vào mỗi lượt của phía có MCP. Base context (system prompt, tool built-in) = ${num(meta.baseContext)} token/lượt cho cả hai.`,
    `- Agent là chính sách tất định, không phải LLM. Xem bench/README.md về giả định và giới hạn.`,
    ``,
    section(`${standard.length} session thường`, standard, true),
    ...(large.length ? [section(`${large.length} session lớn`, large, false)] : []),
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(report(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}

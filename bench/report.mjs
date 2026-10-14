// Tổng hợp kết quả benchmark thành bảng Markdown, một file ba ngôn ngữ (Anh, Việt, Trung).
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

// real.mjs cũ ghi phần mô tả tiếng Việt thẳng vào repoLabel; tách ra để dịch được.
const OLD_REAL_SUFFIX = " (repo thật; đáp án: findReferences của TypeScript, doc comment, ripgrep)";

const T = {
  en: {
    heading: "English",
    metric: "Metric (mean / session)", without: "Without MCP", with: "With MCP", diff: "Difference (MCP − baseline)", ci: "95% CI of difference",
    quality: ["fully correct sessions", "existing function reused", "callers: recall", "callers: precision", "callers: complete and exact",
      "survey: recall", "survey: complete and exact", "wrong edits", "missed edits"],
    cost: ["tool calls (= model turns)", "final session context tokens", "  of which: search phase", "  of which: read + edit",
      "cumulative input tokens (uncached)", "cache-adjusted input tokens (prompt caching)", "output tokens (tool arguments)",
      "tool time including MCP startup (ms)"],
    contextPerSession: "Context tokens / session", total: (n) => `total over ${n} sessions`, totalCached: "total input with caching",
    qualityHeading: "Quality", costHeading: "Cost",
    byDifficulty: "By difficulty of the reuse step", difficulty: "Difficulty", found: "found",
    byLanguage: "By language of the function whose signature changes", language: "Language", callersOk: "callers complete & exact",
    searchTokens: "search tokens", sides: ["without MCP", "with MCP"],
    oneSide: "Sessions only one side got fully correct", onlyMcp: "Only MCP correct", onlyBaseline: "Only no-MCP correct", none: "none",
    failed: "Failed subtasks",
    standard: (n) => `${n} standard sessions`, large: (n) => `${n} large sessions`,
    synthetic: "synthetic", real: "real repository; answers: TypeScript findReferences, doc comments, ripgrep",
    repo: (label, files, lines, services, seed) =>
      `- Repository: ${label} — ${files} files, ${lines} lines${services ? `, ${services} services/packages` : ""}${seed !== undefined ? ` (seed ${seed})` : ""}.`,
    sessions: (s, l, per) => `- ${s} standard sessions (1 feature: reuse + change one function's signature + change one constant + read and edit the code)` +
      (l ? ` and ${l} large sessions (${per} features combined in one context).` : "."),
    runs: (h) => `- Each session runs twice: without MCP (Grep = ripgrep with head_limit ${h}, Read = cat -n, Edit) and with MCP (spec-nav, a fresh server per session = cold start; Read/Edit still available).`,
    tokens: (c, s, b) => `- Tokens estimated at ${c} characters/token on both sides. The MCP tool definitions (~${s} tokens) are added to every turn on the MCP side. Base context (system prompt, built-in tools) = ${b} tokens/turn on both sides.`,
    agents: "- Agents are deterministic policies, not an LLM. See bench/README.md for assumptions and limitations.",
  },
  vi: {
    heading: "Tiếng Việt",
    metric: "Chỉ số (trung bình / session)", without: "Không MCP", with: "Có MCP", diff: "Chênh (MCP − không)", ci: "95% CI của chênh",
    quality: ["session đúng hoàn toàn", "tái sử dụng được hàm có sẵn", "callers: recall", "callers: precision", "callers: đủ hết, không thừa",
      "survey: recall", "survey: đủ hết, không thừa", "chỗ sửa nhầm (wrong edits)", "chỗ cần sửa bị sót (missed edits)"],
    cost: ["tool calls (= lượt model)", "token context cuối session", "  trong đó: pha tìm kiếm", "  trong đó: pha đọc + sửa",
      "token input tích lũy (không cache)", "token input quy đổi (có prompt cache)", "token output (tham số tool)",
      "thời gian tool, gồm khởi động MCP (ms)"],
    contextPerSession: "Token context / session", total: (n) => `tổng ${n} session`, totalCached: "tổng input tích lũy (có cache)",
    qualityHeading: "Chất lượng", costHeading: "Chi phí",
    byDifficulty: "Theo độ khó của bước tái sử dụng", difficulty: "Độ khó", found: "tìm thấy",
    byLanguage: "Theo ngôn ngữ của hàm cần đổi signature", language: "Ngôn ngữ", callersOk: "callers đủ & không thừa",
    searchTokens: "token tìm kiếm", sides: ["không MCP", "có MCP"],
    oneSide: "Session chỉ một bên làm đúng hoàn toàn", onlyMcp: "Chỉ MCP đúng", onlyBaseline: "Chỉ không-MCP đúng", none: "không có",
    failed: "Các việc con thất bại",
    standard: (n) => `${n} session thường`, large: (n) => `${n} session lớn`,
    synthetic: "giả lập", real: "repo thật; đáp án: findReferences của TypeScript, doc comment, ripgrep",
    repo: (label, files, lines, services, seed) =>
      `- Repo: ${label} — ${files} file, ${lines} dòng${services ? `, ${services} service/package` : ""}${seed !== undefined ? ` (seed ${seed})` : ""}.`,
    sessions: (s, l, per) => `- ${s} session thường (1 feature: tái sử dụng + đổi signature một hàm + đổi một hằng số + đọc và sửa code)` +
      (l ? ` và ${l} session lớn (gộp ${per} feature trong một context).` : "."),
    runs: (h) => `- Mỗi session chạy 2 lần: không MCP (Grep = ripgrep với head_limit ${h}, Read = cat -n, Edit) và có MCP (spec-nav, server mới mỗi session = cold start; vẫn có Read/Edit).`,
    tokens: (c, s, b) => `- Token ước lượng ${c} ký tự/token cho cả hai bên. Định nghĩa tool MCP ~${s} token được cộng vào mỗi lượt của phía có MCP. Base context (system prompt, tool built-in) = ${b} token/lượt cho cả hai.`,
    agents: "- Agent là chính sách tất định, không phải LLM. Xem bench/README.md về giả định và giới hạn.",
  },
  zh: {
    heading: "简体中文",
    metric: "指标（每会话平均）", without: "无 MCP", with: "有 MCP", diff: "差值（MCP − 无）", ci: "差值的 95% 置信区间",
    quality: ["完全正确的会话", "复用了已有函数", "调用方：召回率", "调用方：精确率", "调用方：完整且无多余",
      "梳理：召回率", "梳理：完整且无多余", "错误修改数（wrong edits）", "遗漏修改数（missed edits）"],
    cost: ["工具调用数（= 模型轮次）", "会话最终上下文 token", "  其中：搜索阶段", "  其中：阅读 + 修改阶段",
      "累计输入 token（无缓存）", "折算输入 token（启用提示缓存）", "输出 token（工具参数）",
      "工具耗时，含 MCP 启动（ms）"],
    contextPerSession: "每会话上下文 token", total: (n) => `${n} 个会话合计`, totalCached: "累计输入合计（启用缓存）",
    qualityHeading: "质量", costHeading: "成本",
    byDifficulty: "按复用步骤的难度", difficulty: "难度", found: "找到",
    byLanguage: "按需修改签名的函数所用语言", language: "语言", callersOk: "调用方完整且无多余",
    searchTokens: "搜索 token",
    oneSide: "只有一侧完全正确的会话", onlyMcp: "仅 MCP 正确", onlyBaseline: "仅无 MCP 正确", none: "无",
    failed: "失败的子任务",
    standard: (n) => `${n} 个普通会话`, large: (n) => `${n} 个大会话`,
    synthetic: "合成仓库", real: "真实仓库；答案来源：TypeScript findReferences、文档注释、ripgrep",
    repo: (label, files, lines, services, seed) =>
      `- 仓库：${label} — ${files} 个文件，${lines} 行${services ? `，${services} 个服务/包` : ""}${seed !== undefined ? `（seed ${seed}）` : ""}。`,
    sessions: (s, l, per) => `- ${s} 个普通会话（1 个功能：复用 + 修改一个函数的签名 + 修改一个常量 + 阅读并修改代码）` +
      (l ? `，以及 ${l} 个大会话（在同一上下文中合并 ${per} 个功能）。` : "。"),
    runs: (h) => `- 每个会话运行 2 次：无 MCP（Grep = ripgrep，head_limit ${h}；Read = cat -n；Edit）和有 MCP（spec-nav，每个会话一个新 server = 冷启动；仍有 Read/Edit）。`,
    tokens: (c, s, b) => `- 两侧均按 ${c} 字符/token 估算。MCP 工具定义（约 ${s} token）计入有 MCP 一侧的每一轮。基础上下文（system prompt、内置工具）两侧均为 ${b} token/轮。`,
    agents: "- 代理是确定性策略，不是 LLM。假设与局限见 bench/README.md。",
  },
};

function table(rows, metrics, t) {
  const out = [`| ${t.metric} | ${t.without} | ${t.with} | ${t.diff} | ${t.ci} |`, "|---|---:|---:|---:|---:|"];
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
  [(x) => Number(x.allCorrect), pct],
  [(x) => x.reuse.found, pct],
  [(x) => x.callers.recall, pct],
  [(x) => x.callers.precision, pct],
  [(x) => x.callers.ok, pct],
  [(x) => x.survey.recall, pct],
  [(x) => x.survey.ok, pct],
  [(x) => x.wrongEdits, dec],
  [(x) => x.missedEdits, dec],
];
const COST = [
  [(x) => x.toolCalls, dec],
  [(x) => x.contextTokens, num],
  [(x) => x.searchContextTokens, num],
  [(x) => x.contextTokens - x.searchContextTokens, num],
  [(x) => x.cumulativeInputTokens, num],
  [(x) => x.cachedEquivalentTokens, num],
  [(x) => x.outputTokens, num],
  [(x) => x.toolMs + (x.serverStartMs ?? 0), num],
];
const labelled = (metrics, labels) => metrics.map(([get, fmt], i) => [labels[i], get, fmt]);

function distribution(rows, t) {
  const out = [`| ${t.contextPerSession} | ${t.without} | ${t.with} |`, "|---|---:|---:|"];
  for (const [label, q] of [["min", 0], ["median", 0.5], ["p90", 0.9], ["max", 1]]) {
    out.push(`| ${label} | ${num(quantile(rows.map((r) => r.baseline.contextTokens), q))} | ${num(quantile(rows.map((r) => r.mcp.contextTokens), q))} |`);
  }
  out.push(`| ${t.total(rows.length)} | ${num(sum(rows.map((r) => r.baseline.contextTokens)))} | ${num(sum(rows.map((r) => r.mcp.contextTokens)))} |`);
  out.push(`| ${t.totalCached} | ${num(sum(rows.map((r) => r.baseline.cachedEquivalentTokens)))} | ${num(sum(rows.map((r) => r.mcp.cachedEquivalentTokens)))} |`);
  return out.join("\n");
}

function breakdown(rows, keyOf, label, quality, t) {
  const groups = new Map();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  const [qLabel, q, qf] = quality;
  const [no, yes] = t.sides ?? [t.without, t.with];
  const out = [`| ${label} | n | ${qLabel}: ${no} | ${qLabel}: ${yes} | ${t.searchTokens}: ${no} | ${t.searchTokens}: ${yes} |`, "|---|---:|---:|---:|---:|---:|"];
  for (const [k, rs] of [...groups].sort()) {
    out.push(`| ${k} | ${rs.length} | ${qf(mean(rs.map((r) => q(r.baseline))))} | ${qf(mean(rs.map((r) => q(r.mcp))))} | ` +
      `${num(mean(rs.map((r) => r.baseline.searchContextTokens)))} | ${num(mean(rs.map((r) => r.mcp.searchContextTokens)))} |`);
  }
  return out.join("\n");
}

function section(title, rows, withBreakdowns, t) {
  const better = (a, b) => rows.filter((r) => Number(r[a].allCorrect) > Number(r[b].allCorrect)).map((r) => r.id);
  const parts = [
    `### ${title}`,
    ``,
    `#### ${t.qualityHeading}`,
    ``,
    table(rows, labelled(QUALITY, t.quality), t),
    ``,
    `#### ${t.costHeading}`,
    ``,
    table(rows, labelled(COST, t.cost), t),
    ``,
    distribution(rows, t),
    ``,
  ];
  if (withBreakdowns) {
    parts.push(
      `#### ${t.byDifficulty}`,
      ``,
      breakdown(rows, (r) => r.difficulty, t.difficulty, [t.found, (x) => x.reuse.found, pct], t),
      ``,
      `#### ${t.byLanguage}`,
      ``,
      breakdown(rows, (r) => r.callersLanguage, t.language, [t.callersOk, (x) => x.callers.ok, pct], t),
      ``,
    );
  }
  const failures = (side) => rows.flatMap((r) => (r[side].failures ?? []).map((f) => `${r.id}: ${f}`));
  parts.push(
    `#### ${t.oneSide}`,
    ``,
    `- ${t.onlyMcp} (${better("mcp", "baseline").length}): ${better("mcp", "baseline").join(", ") || t.none}`,
    `- ${t.onlyBaseline} (${better("baseline", "mcp").length}): ${better("baseline", "mcp").join(", ") || t.none}`,
    ``,
    `<details><summary>${t.failed}</summary>`,
    ``,
    `${t.without}:`,
    ...failures("baseline").map((f) => `- ${f}`),
    ``,
    `${t.with}:`,
    ...failures("mcp").map((f) => `- ${f}`),
    ``,
    `</details>`,
    ``,
  );
  return parts.join("\n");
}

function localized({ meta, results }, t) {
  const standard = results.filter((r) => r.size !== "large");
  const large = results.filter((r) => r.size === "large");
  const oldReal = meta.repoLabel?.endsWith(OLD_REAL_SUFFIX);
  const base = oldReal ? meta.repoLabel.slice(0, -OLD_REAL_SUFFIX.length) : meta.repoLabel;
  const label = base === undefined ? t.synthetic : meta.realRepo || oldReal ? `${base} (${t.real})` : base;
  return [
    `## ${t.heading}`,
    ``,
    t.repo(label, meta.files.toLocaleString("en-US"), meta.lines.toLocaleString("en-US"), meta.services, meta.seed),
    t.sessions(standard.length, large.length, meta.perLarge ?? 3),
    t.runs(meta.headLimit),
    t.tokens(meta.charsPerToken, num(meta.schemaTokens), num(meta.baseContext)),
    t.agents,
    ``,
    section(t.standard(standard.length), standard, true, t),
    ...(large.length ? [section(t.large(large.length), large, false, t)] : []),
  ].join("\n");
}

export function report(payload) {
  return [
    `# Benchmark spec-nav: with MCP vs without MCP / có MCP vs không MCP / 有 MCP 与无 MCP`,
    ``,
    `**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**`,
    ``,
    localized(payload, T.en),
    localized(payload, T.vi),
    localized(payload, T.zh),
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(report(JSON.parse(readFileSync(process.argv[2], "utf8"))));
}

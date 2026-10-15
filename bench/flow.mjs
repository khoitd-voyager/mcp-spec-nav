// Benchmark của spec_nav_trace_flow: độ chính xác của từng link giao tiếp giữa
// service (precision, recall, link nối sai, link unresolved/ambiguous), so với
// cách nối chỉ theo tên (method + path, topic, pattern — bỏ qua host, broker),
// cộng thời gian và RAM.
//
// Tất định: repo sinh từ seed (bench/flow-generate.mjs), đáp án do bộ sinh ghi.
// Không có LLM nào trong vòng lặp.
//
//   node bench/flow.mjs                          # split "test": seeds 101-105
//   node bench/flow.mjs --split dev              # seeds 1-2, dùng khi phát triển
//   node bench/flow.mjs --scale 120              # thêm một repo 120 service để đo thời gian/RAM
//   node bench/flow.mjs --out bench/results/flow-test.md
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { generateFlowRepo } from "./flow-generate.mjs";
import { startMcp } from "./run.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const split = arg("split", "test");
const seeds = (arg("seeds") ?? (split === "dev" ? "1,2" : "101,102,103,104,105")).split(",").map(Number);
const services = Number(arg("services", 14));
const scale = arg("scale") ? Number(arg("scale")) : undefined;
const out = arg("out");

function writeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "spec-nav-flow-bench-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

async function inventory(client) {
  const steps = [];
  const pageMs = [];
  let cursor;
  let last;
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now();
    const res = await client.callTool({ name: "spec_nav_trace_flow", arguments: { limit: 200, format: "json", ...(cursor ? { cursor } : {}) } }, undefined, { timeout: 600_000 });
    const text = res.content.map((c) => c.text).join("\n");
    if (res.isError) throw new Error(text);
    pageMs.push(performance.now() - t0);
    last = JSON.parse(text);
    steps.push(...last.steps);
    if (last.complete) break;
    cursor = last.nextCursor;
  }
  return { steps, last, pageMs };
}

const LINK = new Set(["resolved", "partial"]);
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

function score(g, steps) {
  const bySite = new Map();
  for (const s of steps) {
    const k = `${s.at.file}:${s.at.line}`;
    bySite.set(k, [...(bySite.get(k) ?? []), s]);
  }
  const rows = [];
  for (const t of g.truth) {
    const at = bySite.get(`${t.file}:${t.line}`) ?? [];
    const reported = at.length ? at[0].resolution : "missing";
    const targets = LINK.has(reported) ? [...new Set(at.filter((s) => s.to).map((s) => `${s.to.file}::${s.to.label}`))] : [];
    // The name-only baseline: link on method+path / topic / pattern alone, first match wins.
    let naive = [];
    if (t.naive?.canon) {
      const m = g.routes.filter((r) => r.method === t.naive.method && r.canon === t.naive.canon);
      if (m.length) naive = [m[0].handler];
    } else if (t.naive?.topic) naive = [...new Set(g.byName.topics[t.naive.topic] ?? [])];
    else if (t.naive?.pattern) naive = (g.byName.patterns[t.naive.pattern] ?? []).slice(0, 1);
    rows.push({ ...t, reported, got: targets, naive });
  }
  return rows;
}

function metrics(rows, pick) {
  const linkExpected = rows.filter((r) => LINK.has(r.expect));
  const reportedLinks = rows.filter((r) => pick(r).linked);
  const correctLinks = reportedLinks.filter((r) => LINK.has(r.expect) && sameSet(pick(r).targets, r.targets));
  const wrong = reportedLinks.filter((r) => !(LINK.has(r.expect) && sameSet(pick(r).targets, r.targets)));
  return {
    sites: rows.length,
    expectedLinks: linkExpected.length,
    reportedLinks: reportedLinks.length,
    correctLinks: correctLinks.length,
    wrongLinks: wrong.length,
    precision: reportedLinks.length ? correctLinks.length / reportedLinks.length : 1,
    recall: linkExpected.length ? correctLinks.length / linkExpected.length : 1,
    wrongSamples: wrong.slice(0, 6).map((r) => `${r.file}:${r.line} [${r.kind} ${r.style}] expected ${r.expect} ${r.targets.join(",") || "-"} got ${pick(r).targets.join(",") || "-"}`),
  };
}

const tool = (r) => ({ linked: LINK.has(r.reported), targets: r.got });
const naive = (r) => ({ linked: r.naive.length > 0, targets: r.naive });

const rss = (client) => {
  const pid = client.transport?.pid;
  if (!pid) return undefined;
  const kb = Number(spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
  return kb ? Math.round(kb / 1024) : undefined;
};

async function runOne(opts) {
  const g = generateFlowRepo(opts);
  const root = writeRepo(g.files);
  const client = await startMcp(root);
  try {
    const cold = await inventory(client);
    const warm = await inventory(client);
    // One call: the first page, which builds the graph when cold. Whole inventory: every page.
    const coldMs = cold.pageMs[0];
    const warmMs = warm.pageMs[0];
    const pages = warm.pageMs.length;
    const allMs = warm.pageMs.reduce((a, b) => a + b, 0);
    // A flow walk from a few client functions, for its latency.
    const first = cold.steps.find((s) => s.resolution === "resolved" && s.from.id);
    let flowMs;
    if (first) {
      const t2 = performance.now();
      await client.callTool({ name: "spec_nav_trace_flow", arguments: { id: first.from.id, format: "json", direction: "both" } }, undefined, { timeout: 600_000 });
      flowMs = performance.now() - t2;
    }
    return { g, rows: score(g, cold.steps), coldMs, warmMs, pages, allMs, flowMs, rssMb: rss(client), files: Object.keys(g.files).length, coverage: cold.last.coverage };
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const results = [];
for (const seed of seeds) {
  const r = await runOne({ seed, services });
  results.push({ seed, ...r });
  const m = metrics(r.rows, tool);
  console.error(`seed ${seed}: ${r.files} files, ${r.rows.length} labelled sites — precision ${(m.precision * 100).toFixed(1)}%, recall ${(m.recall * 100).toFixed(1)}%, wrong ${m.wrongLinks}; first call ${Math.round(r.coldMs)} ms, warm call ${Math.round(r.warmMs)} ms, ${r.rssMb} MB`);
}
let scaled;
if (scale) {
  scaled = await runOne({ seed: 900, services: scale, routesPerService: 10, callsPerService: 8, topics: 20 });
  console.error(`scale ${scale} services: ${scaled.files} files, first call ${Math.round(scaled.coldMs)} ms, warm call ${Math.round(scaled.warmMs)} ms, ${scaled.pages} pages ${Math.round(scaled.allMs)} ms, flow ${Math.round(scaled.flowMs ?? 0)} ms, ${scaled.rssMb} MB`);
}

// --- report --------------------------------------------------------------------
const rows = results.flatMap((r) => r.rows);
const T = metrics(rows, tool);
const N = metrics(rows, naive);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const kinds = ["http", "event", "rpc"];
const statuses = ["resolved", "partial", "ambiguous", "unresolved", "unmatched", "missing"];
const confusion = (kind) => {
  const sub = rows.filter((r) => kind === "all" || r.kind === kind);
  const exp = ["resolved", "partial", "ambiguous", "unresolved", "unmatched"].filter((e) => sub.some((r) => r.expect === e));
  const lines = [`| expected \\ reported | ${statuses.join(" | ")} |`, `|---|${statuses.map(() => "---:").join("|")}|`];
  for (const e of exp) lines.push(`| ${e} | ${statuses.map((s) => sub.filter((r) => r.expect === e && r.reported === s).length || "").join(" | ")} |`);
  return lines.join("\n");
};
const byKind = kinds.map((k) => {
  const sub = rows.filter((r) => r.kind === k);
  if (!sub.length) return undefined;
  const t = metrics(sub, tool);
  const n = metrics(sub, naive);
  return `| ${k} | ${sub.length} | ${t.expectedLinks} | ${pct(t.precision)} | ${pct(t.recall)} | ${t.wrongLinks} | ${pct(n.precision)} | ${pct(n.recall)} | ${n.wrongLinks} |`;
}).filter(Boolean);
const timeRow = (label, r) => `| ${label} | ${r.files} | ${r.rows.length} | ${Math.round(r.coldMs)} ms | ${Math.round(r.warmMs)} ms | ${r.pages} pages, ${Math.round(r.allMs)} ms | ${r.flowMs ? Math.round(r.flowMs) + " ms" : "-"} | ${r.rssMb ?? "?"} MB |`;
const timing = results.map((r) => timeRow(String(r.seed), r));
if (scaled) timing.push(timeRow(`scale (${scale} services)`, scaled));

const L = {
  en: {
    h: "English",
    intro: `Split **${split}** (seeds ${seeds.join(", ")}), ${services} services per repository. Repositories are generated from a seed by \`bench/flow-generate.mjs\`, which records the expected outcome of every call site from its own route table; no LLM is involved. "Name only" links on method + path, topic or pattern alone — the first match, ignoring host and broker.`,
    summary: "Summary", byKind: "By kind", conf: "Expected vs reported status (all kinds)", time: "Time and memory", wrong: "Wrong links (spec-nav)",
    cols: "| Kind | Sites | Expected links | Precision | Recall | Wrong links | Name only: precision | Name only: recall | Name only: wrong |",
    tcols: "| Seed | Files | Sites | First call, cold (builds the index) | One call, warm | Whole inventory, warm | One flow, both directions | Server RSS |",
    limits: "Limits of this benchmark: most generated code uses shapes the adapters support, so it measures linking more than coverage. About 15% of client calls go through a wrapper function (TypeScript) or `urljoin` (Python), which the adapters do not follow; they count against recall and are all of the misses above. Real repositories have more such shapes (generated SDKs, configuration files, service discovery) and other stacks; measure those on your own code. `missing` means the tool reported nothing at that line. Not an LLM experiment: no model is involved, and no paid API was called.",
  },
  vi: {
    h: "Tiếng Việt",
    intro: `Split **${split}** (seed ${seeds.join(", ")}), ${services} service mỗi repo. Repo sinh từ seed bởi \`bench/flow-generate.mjs\`, bộ sinh tự ghi kết quả đúng của từng điểm gọi từ bảng route của nó; không có LLM. "Chỉ theo tên" nối bằng method + path, topic hoặc pattern — lấy kết quả khớp đầu tiên, bỏ qua host và broker.`,
    summary: "Tóm tắt", byKind: "Theo loại", conf: "Trạng thái mong đợi so với trạng thái báo (mọi loại)", time: "Thời gian và bộ nhớ", wrong: "Link nối sai (spec-nav)",
    cols: "| Loại | Điểm gọi | Link mong đợi | Precision | Recall | Nối sai | Chỉ theo tên: precision | Chỉ theo tên: recall | Chỉ theo tên: nối sai |",
    tcols: "| Seed | File | Điểm gọi | Lần gọi đầu (dựng index) | Một lần gọi, đã warm | Toàn bộ inventory, đã warm | Một flow, hai chiều | RSS server |",
    limits: "Giới hạn: phần lớn code sinh ra dùng dạng mà adapter hỗ trợ, nên benchmark đo việc nối nhiều hơn đo độ phủ. Khoảng 15% lời gọi client đi qua hàm wrapper (TypeScript) hoặc `urljoin` (Python) — adapter không lần theo; chúng bị tính vào recall và là toàn bộ phần bỏ sót ở trên. Repo thật có nhiều dạng như vậy hơn (SDK sinh tự động, file cấu hình, service discovery) và các stack khác; hãy đo trên code của bạn. `missing` = tool không báo gì ở dòng đó. Không phải thử nghiệm LLM: không có model nào, không gọi API trả phí.",
  },
  zh: {
    h: "简体中文",
    intro: `拆分 **${split}**（种子 ${seeds.join(", ")}），每个仓库 ${services} 个服务。仓库由 \`bench/flow-generate.mjs\` 按种子生成，生成器根据自己的路由表记录每个调用点的预期结果；不涉及 LLM。"仅按名称"只按 method + path、topic 或 pattern 连接——取第一个匹配，忽略 host 与 broker。`,
    summary: "摘要", byKind: "按类型", conf: "预期状态与报告状态（全部类型）", time: "时间与内存", wrong: "错误连接（spec-nav）",
    cols: "| 类型 | 调用点 | 预期连接 | Precision | Recall | 错误连接 | 仅按名称：precision | 仅按名称：recall | 仅按名称：错误 |",
    tcols: "| 种子 | 文件 | 调用点 | 首次调用（建立索引） | 单次调用（热） | 完整 inventory（热） | 单个 flow（双向） | Server RSS |",
    limits: "局限：生成的代码大多采用适配器支持的写法，因此本基准更多衡量连接而非覆盖。约 15% 的客户端调用经过封装函数（TypeScript）或 `urljoin`（Python），适配器不会跟踪；它们计入 recall，也是上表全部遗漏的来源。真实仓库中这类写法更多（生成的 SDK、配置文件、服务发现），还有其他技术栈；请在自己的代码上测量。`missing` 表示工具在该行未报告任何内容。这不是 LLM 实验：不涉及模型，也未调用任何付费 API。",
  },
};
const md = [`# spec_nav_trace_flow benchmark`, "", "**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**"];
for (const t of Object.values(L)) {
  md.push("", `## ${t.h}`, "", t.intro, "", `### ${t.summary}`, "",
    `| | spec-nav | name only |`, "|---|---:|---:|",
    `| labelled call sites | ${T.sites} | ${N.sites} |`,
    `| links reported | ${T.reportedLinks} | ${N.reportedLinks} |`,
    `| precision | ${pct(T.precision)} | ${pct(N.precision)} |`,
    `| recall (of ${T.expectedLinks} expected links) | ${pct(T.recall)} | ${pct(N.recall)} |`,
    `| wrong links | ${T.wrongLinks} | ${N.wrongLinks} |`,
    `| reported unresolved / ambiguous / unmatched | ${rows.filter((r) => r.reported === "unresolved").length} / ${rows.filter((r) => r.reported === "ambiguous").length} / ${rows.filter((r) => r.reported === "unmatched").length} | – |`,
    "", `### ${t.byKind}`, "", t.cols, "|---|---:|---:|---:|---:|---:|---:|---:|---:|", ...byKind,
    "", `### ${t.conf}`, "", confusion("all"),
    "", `### ${t.time}`, "", t.tcols, "|---|---:|---:|---:|---:|---:|---:|---:|", ...timing,
    ...(T.wrongSamples.length ? ["", `### ${t.wrong}`, "", ...T.wrongSamples.map((s) => `- ${s}`)] : []),
    "", t.limits);
}
const report = md.join("\n") + "\n";
if (out) {
  writeFileSync(out, report);
  writeFileSync(out.replace(/\.md$/, ".json"), JSON.stringify({ split, seeds, services, summary: { specNav: T, nameOnly: N }, perSeed: results.map((r) => ({ seed: r.seed, files: r.files, sites: r.rows.length, firstCallMs: Math.round(r.coldMs), warmCallMs: Math.round(r.warmMs), pages: r.pages, wholeInventoryMs: Math.round(r.allMs), flowMs: r.flowMs && Math.round(r.flowMs), rssMb: r.rssMb })), scale: scaled && { services: scale, files: scaled.files, firstCallMs: Math.round(scaled.coldMs), warmCallMs: Math.round(scaled.warmMs), pages: scaled.pages, wholeInventoryMs: Math.round(scaled.allMs), flowMs: scaled.flowMs && Math.round(scaled.flowMs), rssMb: scaled.rssMb } }, null, 1));
  console.error(`wrote ${out}`);
} else {
  console.log(report);
}

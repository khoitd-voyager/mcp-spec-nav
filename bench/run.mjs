// Benchmark: 100 session giả lập, mỗi session là một feature request trọn vẹn
// (tái sử dụng + đổi signature + đổi hằng số + sửa code), chạy 2 lần — agent KHÔNG có MCP
// (Grep/Read như tool built-in của Claude Code, dùng ripgrep thật) và agent CÓ
// MCP (gọi server spec-nav thật qua stdio, mỗi session một server mới = cold start).
//
// Agent ở đây là chính sách tất định, không phải LLM: cùng một quy tắc "đọc gì,
// tin gì" cho hai bên, để khác biệt đo được là do công cụ. Xem bench/README.md.
//
// node bench/run.mjs [--repo <dir>] [--seed 42] [--files-per-service 90] [--sessions 100]
//                    [--large-sessions 50] [--base-context 0] [--regenerate] [--from N] [--out bench/results]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generate } from "./generate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.SPEC_NAV_DIST ? resolve(process.env.SPEC_NAV_DIST) : resolve(HERE, "../dist/index.cjs");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

// ---------------------------------------------------------------------------
// Đếm token: ước lượng ~3.5 ký tự/token cho code, áp dụng như nhau cho hai bên.

export const CHARS_PER_TOKEN = 3.5;
export const tok = (s) => Math.ceil(String(s).length / CHARS_PER_TOKEN);
/** Vỏ bọc mỗi lượt tool (tên tool, id, định dạng message) — như nhau cho hai bên. */
const PER_CALL_OVERHEAD = 25;

class Session {
  constructor(mode, task, schemaTokens, baseContext = 0) {
    this.mode = mode;
    this.task = task;
    this.schemaTokens = schemaTokens; // định nghĩa tool MCP nằm trong prompt mỗi lượt
    this.baseContext = baseContext; // system prompt + tool built-in + CLAUDE.md: như nhau hai bên
    this.calls = [];
    this.toolMs = 0;
  }
  record(tool, args, output, ms) {
    this.calls.push({ tool, argsTokens: tok(JSON.stringify(args)), outTokens: tok(output) + PER_CALL_OVERHEAD });
    this.toolMs += ms;
    return output;
  }
  /** Token: context cuối, input tích lũy (mỗi lượt gửi lại toàn bộ), và có prompt caching. */
  usage() {
    const prompt = tok(this.task.prompt) + 30;
    let ctx = prompt;
    let cumulative = 0;
    let cached = 0;
    let prevInput = 0;
    const turns = this.calls.length + 1; // mỗi tool call một lượt + lượt trả lời
    for (let k = 0; k < turns; k++) {
      const input = this.baseContext + this.schemaTokens + ctx;
      cumulative += input;
      // Prompt caching: phần đã gửi ở lượt trước đọc từ cache (0.1×), phần mới ghi cache (1.25×).
      cached += 0.1 * prevInput + 1.25 * (input - prevInput);
      prevInput = input;
      if (k < this.calls.length) ctx += this.calls[k].argsTokens + this.calls[k].outTokens;
    }
    return {
      toolCalls: this.calls.length,
      turns,
      contextTokens: ctx,
      toolOutputTokens: this.calls.reduce((a, c) => a + c.outTokens, 0),
      cumulativeInputTokens: Math.round(cumulative),
      cachedEquivalentTokens: Math.round(cached),
      outputTokens: this.calls.reduce((a, c) => a + c.argsTokens, 0),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool built-in mô phỏng (Claude Code): Grep = ripgrep, Read = cat -n.

const ROOT_PREFIX = "/work/shop/"; // đường dẫn tuyệt đối giả, độ dài như repo thật
/** Số dòng tối đa agent không-MCP nhận từ một lần Grep (như head_limit của Claude Code). */
export const HEAD_LIMIT = 250;

function makeBuiltins(repo, sess) {
  const rg = (args) => {
    const t0 = performance.now();
    const p = spawnSync("rg", [...args, "--", "."], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
    return { out: (p.stdout ?? "").replace(/^\.\//gm, ""), ms: performance.now() - t0 };
  };
  const fileCache = new Map();
  const lines = (rel) => {
    if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(join(repo, rel), "utf8").split("\n"));
    return fileCache.get(rel);
  };
  return {
    /** Grep content mode, -n: trả về [{file,line,text}] và ghi output như tool thật. */
    /** Grep content mode, -n, có head_limit: agent chỉ thấy (và chỉ trả token cho) N dòng đầu. */
    grepContent(pattern, { i = true, head = HEAD_LIMIT, glob = [] } = {}) {
      const { out, ms } = rg(["-n", "--no-heading", ...(i ? ["-i"] : []), ...glob.flatMap((g) => ["-g", g]), "-e", pattern]);
      const all = out.split("\n").filter(Boolean).map((l) => {
        const m = l.match(/^(.*?):(\d+):(.*)$/);
        return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null;
      }).filter(Boolean).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      const hits = all.slice(0, head);
      const rendered = hits.map((h) => `${ROOT_PREFIX}${h.file}:${h.line}:${h.text}`).join("\n") +
        (all.length > head ? `\n[Showing results with pagination = limit: ${head}, offset: 0]` : "");
      sess.record("Grep", { pattern, output_mode: "content", "-n": true, "-i": i, head_limit: head }, all.length ? rendered : "No matches found", ms);
      hits.total = all.length;
      return hits;
    },
    grepFiles(pattern, globs = []) {
      const { out, ms } = rg(["-l", "-i", ...globs.flatMap((g) => ["-g", g]), "-e", pattern]);
      const files = out.split("\n").filter(Boolean).sort();
      sess.record("Grep", { pattern, output_mode: "files_with_matches", "-i": true, ...(globs.length ? { glob: globs.join(" ") } : {}) },
        `Found ${files.length} files\n` + files.map((f) => ROOT_PREFIX + f).join("\n"), ms);
      return files;
    },
    grepCount(pattern) {
      const { out, ms } = rg(["-c", "-i", "-e", pattern]);
      const rows = out.split("\n").filter(Boolean).map((l) => {
        const m = l.match(/^(.*):(\d+)$/);
        return { file: m[1], count: Number(m[2]) };
      });
      sess.record("Grep", { pattern, output_mode: "count", "-i": true }, rows.map((r) => `${ROOT_PREFIX}${r.file}:${r.count}`).join("\n"), ms);
      return rows;
    },
    /** Read: mặc định tối đa 2000 dòng, định dạng cat -n. */
    read(rel, offset = 1, limit = 2000) {
      const t0 = performance.now();
      const ls = lines(rel);
      const from = Math.max(1, offset);
      const slice = ls.slice(from - 1, from - 1 + limit);
      const rendered = slice.map((l, k) => `${String(from + k).padStart(6)}\t${l}`).join("\n");
      sess.record("Read", { file_path: ROOT_PREFIX + rel, offset, limit }, rendered, performance.now() - t0);
      return { from, lines: slice };
    },
    fileLines: lines,
  };
}

// ---------------------------------------------------------------------------
// MCP client: một server mới cho mỗi session (cold start như session thật).

export async function startMcp(repo) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    env: { ...process.env, SPEC_NAV_ROOT: repo },
    stderr: "pipe",
  });
  const client = new Client({ name: "spec-nav-bench", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function makeMcp(client, sess) {
  return async (name, args) => {
    const t0 = performance.now();
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text).join("\n");
    sess.record(name, args, text, performance.now() - t0);
    if (res.isError) throw new Error(text);
    return text;
  };
}

// ---------------------------------------------------------------------------
// Tiện ích chấm điểm / suy luận dùng chung cho hai agent

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--)/;
const IMPORT = /^\s*(import\b|from\s+\S+\s+import\b|export\s*\{|use\s|require\(|const\s+\{[^}]*\}\s*=\s*require)/;

/** Nhóm từ khóa nào xuất hiện trong một định danh/đoạn text (so khớp chuỗi con, không phân biệt hoa thường). */
function groupsMatched(text, groups) {
  const t = text.toLowerCase().replace(/_/g, "");
  return groups.filter((g) => g.some((w) => t.includes(w.toLowerCase()))).length;
}

/** "Agent đọc đủ ngữ cảnh để nói receiver có kiểu gì": cùng heuristic cho hai bên. */
function receiverVerdict(windowText, recv, wantCls, otherClasses) {
  if (!recv) return "unknown";
  const r = escapeRe(recv);
  const typed = (cls) => new RegExp(
    `\\b${r}\\s*:\\s*${cls}\\b|\\b${cls}\\s+${r}\\b|\\b${r}\\s*=\\s*(new\\s+)?(\\w+\\.)?${cls}\\s*\\(|\\b${r}\\s*:=\\s*&?${cls}\\b`,
  ).test(windowText);
  if (wantCls && typed(escapeRe(wantCls))) return "target";
  if (otherClasses.some((c) => typed(escapeRe(c)))) return "other";
  return "unknown";
}

// ---------------------------------------------------------------------------
// REUSE

async function reuseBaseline(task, B) {
  const groups = task.llmKeywords; // [verb-synonyms, noun-synonyms...] — như LLM tự nghĩ (đã dịch nếu đề tiếng Việt)
  const spec = task.llmSpecific;
  const others = groups.slice(1).filter((g) => !g.some((w) => spec.includes(w))).flat();
  const alt = (ws) => ws.map(escapeRe).join("|");
  const DEF = "(function|def|func|fun|fn|void|double|int|float|String|Object|static|public|private)\\s+";
  // 1) Định nghĩa có danh từ đặc thù nhất trong tên
  let defs = B.grepContent(`${DEF}\\w*(${alt(spec)})\\w*\\s*\\(`);
  // 2) Quá nhiều (hoặc bị cắt): thu hẹp — tên phải có cả danh từ đặc thù và một danh từ khác của đề
  if (others.length && defs.total > 60) {
    const both = `${DEF}\\w*((${alt(spec)})\\w*(${alt(others)})|(${alt(others)})\\w*(${alt(spec)}))\\w*\\s*\\(`;
    const narrow = B.grepContent(both);
    if (narrow.length) defs = narrow;
  }
  const nounAlt = alt(spec);
  const seen = new Map(); // key file::name -> {score, inContext}
  const defName = (text) => text.match(/(?:function|def|func|fun|fn)\s+(\w+)|(\w+)\s*\(/)?.slice(1).find(Boolean);
  for (const h of defs) {
    const n = defName(h.text);
    if (!n) continue;
    const score = groupsMatched(n, groups);
    const k = `${h.file}::${n}`;
    if (!seen.has(k) || seen.get(k).score < score) seen.set(k, { file: h.file, name: n, line: h.line, score, viaRead: false });
  }
  // 2) Đọc các file tốt nhất (≤ 5 file, ưu tiên định nghĩa khớp nhiều nhóm)
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score);
  const filesToRead = [...new Set(ranked.filter((c) => c.score >= Math.min(2, groups.length)).map((c) => c.file))].slice(0, 5);
  // 3) Không có ứng viên mạnh: đếm file theo danh từ, đọc 3 file nhiều hit nhất
  if (!filesToRead.length) {
    const counts = B.grepCount(nounAlt).sort((a, b) => b.count - a.count);
    filesToRead.push(...counts.slice(0, 3).map((c) => c.file));
  }
  for (const f of filesToRead) {
    const total = B.fileLines(f).length;
    const def = ranked.find((c) => c.file === f);
    // File dài: đọc cửa sổ quanh định nghĩa; ngắn: đọc cả file.
    const { from, lines } = total > 400 && def ? B.read(f, Math.max(1, def.line - 40), 120) : B.read(f);
    lines.forEach((text, k) => {
      const m = text.match(/(?:function|def|func|fun|fn)\s+(\w+)\s*[(<]|^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>\[\],]+\s+(\w+)\s*\(/);
      const n = m && (m[1] || m[2]);
      if (!n) return;
      const body = lines.slice(k, k + 10).join("\n");
      const score = groupsMatched(n, groups) + 0.5 * groupsMatched(body, groups);
      const key = `${f}::${n}`;
      const prev = seen.get(key);
      seen.set(key, { file: f, name: n, line: from + k, score: Math.max(score, prev?.score ?? 0), viaRead: true });
    });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || Number(b.viaRead) - Number(a.viaRead));
}

async function reuseMcp(task, call) {
  const groups = task.llmKeywords;
  const parse = (text) => {
    const out = [];
    const re = /^#\d+\s+(?:score|similarity) ([\d.]+)[^\n]*?\s(\S+?):(\d+)[:\d-]*\s+\(service[^\n]*\n\s+\[[^\]]*\] (\S+)\n\s+sig: [^\n]*\n\s+id:\s+(\S+)/gm;
    for (let m; (m = re.exec(text)); ) out.push({ score: Number(m[1]), file: m[2], line: Number(m[3]), name: m[4], id: m[5], callsOrBody: /\[(via calls|body only)\]/.test(m[0]) });
    return out;
  };
  let results = parse(await call("spec_nav_find_functions", { query: task.description, limit: 10 }));
  const nonAscii = /[^\x00-\x7f]/.test(task.description);
  // "Rõ ràng" = tên khớp mọi nhóm từ khóa của đề.
  const strong = (rs) => rs.slice(0, 3).some((c) => !c.callsOrBody && groupsMatched(c.name, groups) >= groups.length);
  // Như hướng dẫn trong CLAUDE.md: đề tiếng Việt mà kết quả yếu thì thêm truy vấn tiếng Anh.
  if (nonAscii && !strong(results)) results = [...parse(await call("spec_nav_find_functions", { query: task.englishQuery, limit: 10 })), ...results];
  // Như agent không-MCP, LLM biết từ đồng nghĩa: chưa có ứng viên rõ ràng thì hỏi lại bằng cách diễn đạt khác.
  if (!strong(results)) {
    const alt = groups.map((g) => g[1] ?? g[0]).join(" ");
    results = [...parse(await call("spec_nav_find_functions", { query: alt, limit: 10 })), ...results];
  }
  const seen = results.map((c) => ({ ...c, recognised: groupsMatched(c.name, groups) >= 1 }));
  for (const c of results.slice(0, 3)) {
    await call("spec_nav_read_function", { id: c.id });
    const s = seen.find((x) => x.id === c.id);
    s.viaRead = true;
  }
  // Không có ứng viên rõ ràng: viết nháp rồi tìm hàm có hành vi tương tự.
  let similarTop;
  if (!strong(results) && task.draft) {
    const sim = parse(await call("spec_nav_similar_functions", { code: task.draft, limit: 5 }));
    for (const c of sim.slice(0, 2)) {
      await call("spec_nav_read_function", { id: c.id });
      seen.push({ ...c, viaRead: true, recognised: true, similarity: c.score });
    }
    if (sim[0] && sim[0].score >= 0.35) similarTop = seen.find((x) => x.id === sim[0].id);
  }
  const ordered = similarTop ? [similarTop, ...seen.filter((x) => x !== similarTop)] : seen;
  return ordered;
}

function scoreReuse(task, candidates, mode) {
  const is = (c) => task.truth.some((t) => c.file === t.file && c.name.split(".").pop() === t.name.split(".").pop());
  // Hào phóng như nhau: nếu code đúng đã vào context và có ít nhất một dấu hiệu khớp,
  // coi như LLM nhận ra nó.
  const recognised = (c) => (mode === "mcp" ? c.viaRead || c.recognised : c.viaRead ? c.score >= 0.5 : c.score >= 1);
  const idx = candidates.findIndex((c) => is(c) && recognised(c));
  return { found: idx >= 0, top1: candidates.length > 0 && is(candidates[0]), rank: idx >= 0 ? idx + 1 : null };
}

// ---------------------------------------------------------------------------
// CALLERS

const short = (sym) => sym.split(".").pop();

async function callersBaseline(task, B) {
  const name = short(task.symbol);
  const cls = task.symbol.includes(".") ? task.symbol.split(".")[0] : undefined;
  const hits = B.grepContent(`\\b${escapeRe(name)}\\b`, { i: false });
  // Alias: `name as X` trong import/export → grep thêm X
  const aliases = new Set();
  for (const h of hits) {
    const m = h.text.match(new RegExp(`\\b${escapeRe(name)}\\s+as\\s+(\\w+)`));
    if (m) aliases.add(m[1]);
  }
  const all = [...hits];
  for (const a of aliases) all.push(...B.grepContent(`\\b${escapeRe(a)}\\b`, { i: false }).map((h) => ({ ...h, alias: a })));
  // Định nghĩa cùng tên ở file khác (shadow / lớp khác / package khác)
  // Dòng định nghĩa: từ khóa định nghĩa, hoặc `name(params)[: Type] {` (method TS/Java/C#…), như LLM nhìn là biết.
  const defRe = new RegExp(`(function|def|func|fun)\\s+${escapeRe(name)}\\b|\\b${escapeRe(name)}\\s*\\([^)]*\\)\\s*(:\\s*[^={;()]+)?\\{`);
  const localDefs = new Set(hits.filter((h) => defRe.test(h.text) && h.file !== task.declFile && !/^\s+/.test(h.text)).map((h) => h.file));
  const otherClasses = [];
  for (const h of hits) {
    if (!defRe.test(h.text) || (h.file === task.declFile && h.line === task.declLine)) continue;
    // Định nghĩa nằm trong lớp nào: đọc vài dòng phía trên (tính chi phí Read).
    const ctx = B.read(h.file, Math.max(1, h.line - 12), 13).lines.join("\n");
    const m = [...ctx.matchAll(/class\s+(\w+)/g)].pop();
    if (m && m[1] !== cls) otherClasses.push(m[1]);
  }
  const declDir = task.declFile.split("/").slice(-2, -1)[0];
  const declStem = task.declFile.split("/").pop().replace(/\.\w+$/, "");
  const answer = [];
  const windowsRead = new Set();
  for (const h of all) {
    const n = h.alias ?? name;
    const t = h.text;
    if (h.file === task.declFile && h.line === task.declLine) continue;
    if (COMMENT.test(t) || IMPORT.test(t)) continue;
    if (defRe.test(t) && !h.alias) continue;
    const strMention = new RegExp(`["'][^"']*\\b${escapeRe(n)}\\b[^"']*["']`).test(t);
    // Tên ở dạng chuỗi/symbol truyền cho API gọi động: cùng danh sách với phía MCP.
    const exactStr = new RegExp(`\\[\\s*["']${escapeRe(n)}["']\\s*\\]|\\b(getattr|hasattr|setattr|send|public_send|__send__|method|call_user_func|call_user_func_array|method_exists|getMethod|getDeclaredMethod|invokeMethod|GetMethod|MethodByName|apply|NSSelectorFromString|Selector|perform|invoke|Reflect\\.get|Reflect\\.apply)\\s*\\([^)]*(["':])${escapeRe(n)}\\b`).test(t) ||
      new RegExp(`\\[\\s*\\$\\w+\\s*,\\s*["']${escapeRe(n)}["']\\s*\\]`).test(t);
    const callRe = new RegExp(`(^|[^\\w$])(([\\w$]+)\\s*(\\.|->|::)\\s*)?${escapeRe(n)}\\s*(\\(|\\.call\\(|\\.apply\\()`);
    const call = t.match(callRe);
    if (!call && !exactStr) {
      // Tham chiếu (truyền như callback) không nằm trong chuỗi: vẫn phải sửa.
      if (strMention) continue;
      if (new RegExp(`[(,=]\\s*${escapeRe(n)}\\s*[,)]`).test(t)) answer.push(h);
      continue;
    }
    if (exactStr) { answer.push(h); continue; }
    const recv = call[3];
    if (!recv && localDefs.has(h.file)) continue; // gọi hàm cục bộ cùng tên
    if (recv && !cls) {
      // Hàm gọi qua tên module/package: khác module mục tiêu → kiểm tra import ở đầu file.
      if (recv === declDir || recv === declStem) { answer.push(h); continue; }
      const head = B.read(h.file, 1, 30).lines.join("\n");
      if (new RegExp(`${escapeRe(recv)}\\b.*${escapeRe(declDir)}|${escapeRe(declDir)}.*\\b${escapeRe(recv)}\\b|${escapeRe(declStem)}.*\\bas\\s+${escapeRe(recv)}\\b|import\\s+\\*\\s+as\\s+${escapeRe(recv)}\\b.*${escapeRe(declStem)}`).test(head)) answer.push(h);
      continue;
    }
    if (recv && cls && recv !== cls && !["self", "this"].includes(recv)) {
      // Method: cần biết kiểu receiver → đọc cửa sổ quanh lời gọi.
      const key = `${h.file}:${Math.floor(h.line / 50)}`;
      if (!windowsRead.has(key)) windowsRead.add(key);
      const w = B.read(h.file, Math.max(1, h.line - 25), 30).lines.join("\n");
      const v = receiverVerdict(w, recv, cls, otherClasses);
      if (v !== "other") answer.push(h);
      continue;
    }
    if (recv === cls || !recv || ["self", "this"].includes(recv)) {
      if (recv && ["self", "this"].includes(recv) && otherClasses.length) {
        // Lớp bao quanh lời gọi: chỉ xét các dòng phía trên nó.
        const w = B.read(h.file, Math.max(1, h.line - 25), 26).lines.join("\n");
        const enclosing = [...w.matchAll(/class\s+(\w+)/g)].pop()?.[1];
        if (enclosing && enclosing !== cls) continue;
      }
      answer.push(h);
    }
  }
  const seen = new Set();
  return answer.map((h) => ({ file: h.file, line: h.line })).filter((s) => !seen.has(`${s.file}:${s.line}`) && seen.add(`${s.file}:${s.line}`));
}

async function callersMcp(task, call, B) {
  const name = short(task.symbol);
  const cls = task.symbol.includes(".") ? task.symbol.split(".")[0] : undefined;
  const answer = [];
  let cursor;
  const review = [];
  for (;;) {
    const r = JSON.parse(await call("spec_nav_callers", { symbol: task.symbol, file: task.declFile, format: "json", ...(cursor ? { cursor } : {}) }));
    for (const k of ["sites", "viaInterfaceOrBase", "references", "likely", "dynamic"]) answer.push(...r[k]);
    review.push(...r.unresolved, ...r.ambiguous);
    if (r.page.complete) break;
    cursor = r.page.nextCursor;
  }
  // Chưa resolve / mơ hồ: đọc ngữ cảnh như agent không-MCP, cùng quy tắc.
  for (const s of review) {
    const recvM = s.snippet.match(new RegExp(`([\\w$]+)\\s*(\\.|->|::)\\s*${escapeRe(name)}\\s*\\(`));
    const w = B.read(s.file, Math.max(1, s.line - 25), 30).lines.join("\n");
    const v = receiverVerdict(w, recvM?.[1], cls, []);
    if (v !== "other") answer.push(s);
  }
  const seen = new Set();
  return answer.map((s) => ({ file: s.file, line: s.line })).filter((s) => !seen.has(`${s.file}:${s.line}`) && seen.add(`${s.file}:${s.line}`));
}

/**
 * Ghép đáp án với câu trả lời 1-1. Với call site, cùng file và lệch ≤ 3 dòng vẫn
 * là một: lời gọi nhiều dòng (`this.repo\n  .update(`) được báo ở dòng bắt đầu
 * biểu thức hoặc ở dòng có tên hàm, tuỳ công cụ.
 */
function scoreSites(truth, answer) {
  const t = [...new Map(truth.map((x) => [`${x.file}:${x.line}`, x])).values()];
  const a = [...new Map(answer.map((x) => [`${x.file}:${x.line}`, x])).values()];
  const used = new Set();
  const matched = new Set();
  // Khớp đúng dòng trước, rồi mới tới lệch dòng.
  for (const tol of [0, 1, 2, 3]) {
    t.forEach((x, i) => {
      if (matched.has(i)) return;
      const j = a.findIndex((y, k) => !used.has(k) && y.file === x.file && Math.abs(y.line - x.line) === tol);
      if (j >= 0) {
        used.add(j);
        matched.add(i);
      }
    });
  }
  const tp = matched.size;
  const recall = t.length ? tp / t.length : 1;
  const precision = a.length ? tp / a.length : t.length ? 0 : 1;
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  return {
    recall, precision, f1, complete: tp === t.length, tp, truth: t.length, answered: a.length,
    missed: t.filter((_, i) => !matched.has(i)).map((x) => `${x.file}:${x.line}`),
    extra: a.filter((_, k) => !used.has(k)).map((x) => `${x.file}:${x.line}`),
  };
}

function scoreSet(truth, answer, key) {
  const t = new Set(truth.map(key));
  const a = new Set(answer.map(key));
  const tp = [...a].filter((x) => t.has(x)).length;
  const recall = t.size ? tp / t.size : 1;
  const precision = a.size ? tp / a.size : t.size ? 0 : 1;
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  return { recall, precision, f1, complete: tp === t.size, tp, truth: t.size, answered: a.size, missed: [...t].filter((x) => !a.has(x)), extra: [...a].filter((x) => !t.has(x)) };
}

// ---------------------------------------------------------------------------
// SURVEY

const NOT_EDITED = /(\.md|\.lock|package-lock\.json|pnpm-lock\.yaml)$/;

async function surveyBaseline(task, B) {
  const hits = B.grepContent(task.pattern);
  // Lockfile và tài liệu: LLM thật không sửa.
  return [...new Set(hits.filter((h) => !COMMENT.test(h.text) && !NOT_EDITED.test(h.file)).map((h) => h.file))].map((file) => ({ file }));
}

/** Đuôi file spec-nav đọc được: phần còn lại agent MCP phải tự grep (theo hướng dẫn CLAUDE.md). */
const SUPPORTED = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro", "py", "pyi", "go", "java", "kt", "kts",
  "swift", "cs", "rb", "rake", "rs", "php", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "scala", "sc", "ex", "exs", "sh", "bash", "zsh"];

async function surveyMcp(task, call, B) {
  const files = new Set();
  let cursor;
  for (;;) {
    const text = await call("spec_nav_map", { pattern: task.pattern, ...(cursor ? { cursor } : {}) });
    let current;
    for (const l of text.split("\n")) {
      const fm = l.match(/^(\S+\.\w+)(\s+\(\d+ hits\)|\s+\(continued\))?$/);
      if (fm) current = fm[1];
      else if (current && /^\s+\d+ \| /.test(l)) files.add(current);
    }
    const m = text.match(/cursor="([^"]+)"/);
    if (!m || /COMPLETE/.test(text.split("\n").slice(0, 6).join("\n"))) break;
    cursor = m[1];
  }
  // spec_nav_map không đọc loại file khác (SQL, JSON, YAML…): grep riêng phần đó, rồi xem dòng khớp.
  const others = B.grepFiles(task.pattern, SUPPORTED.map((e) => `!*.${e}`)).filter((f) => !/(\.md|\.lock|package-lock\.json|pnpm-lock\.yaml)$/.test(f));
  if (others.length) {
    for (const f of others) {
      const re = new RegExp(task.pattern, "i");
      const hit = B.fileLines(f).some((l) => re.test(l) && !COMMENT.test(l));
      if (hit) files.add(f);
    }
    // Agent xem các dòng khớp của những file đó: tính như một Grep content.
    B.grepContent(task.pattern, { glob: SUPPORTED.map((e) => `!*.${e}`) });
  }
  return [...files].map((file) => ({ file }));
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pha sửa code: như nhau cho hai bên. Claude Code bắt buộc Read file trước khi
// Edit, nên mọi file sẽ sửa đều được đọc trọn; mỗi chỗ sửa là một lệnh Edit.

function editPhase(session, parts, B, sess) {
  const files = new Set(session.featureFiles);
  for (const p of parts) {
    files.add(p.callersTask.declFile);
    for (const x of p.callersAnswer) files.add(x.file);
    for (const x of p.surveyAnswer) files.add(x.file);
  }
  for (const f of files) B.read(f);
  const edit = (file, line, newText) => {
    const ls = B.fileLines(file);
    const old = ls[Math.max(0, line - 1)] ?? "";
    const from = Math.max(1, line - 3);
    const snippet = ls.slice(from - 1, from + 7).map((l, k) => `${String(from + k).padStart(6)}\t${l}`).join("\n");
    sess.record("Edit", { file_path: ROOT_PREFIX + file, old_string: old, new_string: newText },
      `The file ${ROOT_PREFIX}${file} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${snippet}`, 0);
  };
  parts.forEach((p, k) => {
    const { callersTask, surveyTask, reuseTask, reuse } = p;
    // 1) signature mới
    edit(callersTask.declFile, callersTask.declLine, (B.fileLines(callersTask.declFile)[callersTask.declLine - 1] ?? "").replace("(", "(options, "));
    // 2) từng call site agent đã tìm
    for (const x of [...p.callersAnswer].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      edit(x.file, x.line, (B.fileLines(x.file)[x.line - 1] ?? "").replace("(", "(defaultOptions, "));
    }
    // 3) hằng số ở mỗi file
    const conceptRe = new RegExp(surveyTask.pattern, "i");
    for (const x of p.surveyAnswer) {
      const i = B.fileLines(x.file).findIndex((l) => conceptRe.test(l) && !COMMENT.test(l));
      edit(x.file, i + 1, (B.fileLines(x.file)[i] ?? "").replace(/\d+/, "42"));
    }
    // 4) code mới: gọi hàm có sẵn nếu tìm thấy, không thì tự viết lại (trùng lặp)
    const fn = reuseTask.truth[0].name.split(".").pop();
    // Task từ repo thật không có bản nháp: viết lại = một thân hàm cỡ trung bình.
    const draft = reuseTask.draft ??
      `function newImplementation(input) {\n  // ${reuseTask.description}\n${Array.from({ length: 12 }, (_, i) => `  const step${i} = transform(input, ${i});`).join("\n")}\n  return step11;\n}`;
    const body = reuse.found
      ? `import { ${fn} } from "<path>";\n\nexport function handleFeature${k}(input) {\n  return ${fn}(input, defaultOptions);\n}`
      : `${draft}\n\nexport function handleFeature${k}(input) {\n  return ${draft.match(/function\s+(\w+)/)?.[1] ?? "impl"}(input, defaultOptions);\n}`;
    const ff = session.featureFiles[k];
    edit(ff, B.fileLines(ff).length, body);
  });
  return { filesRead: files.size };
}

export async function runSession(mode, session, T, repo, schemaTokens, baseContext) {
  const sess = new Session(mode, { prompt: session.prompt }, schemaTokens, baseContext);
  const B = makeBuiltins(repo, sess);
  const t1 = performance.now();
  let client;
  let startMs = 0;
  let call;
  if (mode === "mcp") {
    client = await startMcp(repo);
    startMs = performance.now() - t1;
    call = makeMcp(client, sess);
  }
  const rssMb = () => {
    const pid = client?.transport?.pid ?? client?._transport?.pid;
    if (!pid) return undefined;
    const p = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    const kb = Number(p.stdout.trim());
    return kb ? Math.round(kb / 1024) : undefined;
  };
  try {
    const parts = [];
    for (let k = 0; k < session.reuse.length; k++) {
      const reuseTask = T[session.reuse[k]];
      const callersTask = T[session.callers[k]];
      const surveyTask = T[session.survey[k]];
      const reuseCands = mode === "mcp" ? await reuseMcp(reuseTask, call) : await reuseBaseline(reuseTask, B);
      const reuse = scoreReuse(reuseTask, reuseCands, mode);
      const callersAnswer = mode === "mcp" ? await callersMcp(callersTask, call, B) : await callersBaseline(callersTask, B);
      const callers = scoreSites(callersTask.truth, callersAnswer);
      const surveyAnswer = mode === "mcp" ? await surveyMcp(surveyTask, call, B) : await surveyBaseline(surveyTask, B);
      const survey = scoreSet(surveyTask.truth, surveyAnswer, (x) => x.file);
      parts.push({ reuseTask, callersTask, surveyTask, reuse, callers, survey, callersAnswer, surveyAnswer });
    }
    const searchTokens = sess.usage().contextTokens;
    const ed = editPhase(session, parts, B, sess);
    const n = parts.length;
    const avg = (f) => parts.reduce((a, p) => a + f(p), 0) / n;
    const callersOk = (p) => p.callers.complete && !p.callers.extra.length;
    const surveyOk = (p) => p.survey.complete && !p.survey.extra.length;
    return {
      parts: n,
      // Tỉ lệ trên các việc con của session (session thường: 0 hoặc 1).
      reuse: { found: avg((p) => Number(p.reuse.found)) },
      callers: { recall: avg((p) => p.callers.recall), precision: avg((p) => p.callers.precision), ok: avg((p) => Number(callersOk(p))) },
      survey: { recall: avg((p) => p.survey.recall), precision: avg((p) => p.survey.precision), ok: avg((p) => Number(surveyOk(p))) },
      allCorrect: parts.every((p) => p.reuse.found && callersOk(p) && surveyOk(p)),
      wrongEdits: parts.reduce((a, p) => a + p.callers.extra.length + p.survey.extra.length, 0),
      missedEdits: parts.reduce((a, p) => a + p.callers.missed.length + p.survey.missed.length, 0),
      failures: parts.flatMap((p) => [
        ...(p.reuse.found ? [] : [`reuse ${p.reuseTask.id} (${p.reuseTask.difficulty})`]),
        ...(callersOk(p) ? [] : [`callers ${p.callersTask.id} missed ${p.callers.missed.join(" ")} extra ${p.callers.extra.join(" ")}`]),
        ...(surveyOk(p) ? [] : [`survey ${p.surveyTask.id} missed ${p.survey.missed.join(" ")} extra ${p.survey.extra.join(" ")}`]),
      ]),
      filesRead: ed.filesRead,
      searchContextTokens: searchTokens,
      ...sess.usage(),
      toolMs: Math.round(sess.toolMs),
      serverStartMs: Math.round(startMs),
      serverRssMb: mode === "mcp" ? rssMb() : undefined,
      wallMs: Math.round(performance.now() - t1),
      calls: sess.calls.map((c) => `${c.tool}:${c.outTokens}`),
    };
  } finally {
    await client?.close();
  }
}

async function main() {
  const seed = Number(arg("seed", 42));
  const fps = Number(arg("files-per-service", 90));
  const nSessions = Number(arg("sessions", 100));
  const nLarge = Number(arg("large-sessions", 50));
  const baseContext = Number(arg("base-context", 0));
  const repo = resolve(arg("repo", join(tmpdir(), `spec-nav-bench-${seed}-${fps}-${nSessions}-${nLarge}`)));
  const outDir = resolve(arg("out", join(HERE, "results")));
  if (!existsSync(DIST)) throw new Error(`Build first: ${DIST} is missing (npm run build).`);

  const t0 = performance.now();
  const data = existsSync(join(repo, ".bench-tasks.json")) && !process.argv.includes("--regenerate")
    ? JSON.parse(readFileSync(join(repo, ".bench-tasks.json"), "utf8"))
    : generate({ out: repo, seed, filesPerService: fps, sessions: nSessions, largeSessions: nLarge });
  const { meta, tasks, sessions } = data;
  console.error(`repo ${repo}: ${meta.files} files, ${meta.lines} lines (${Math.round(performance.now() - t0)} ms)`);
  const T = Object.fromEntries(tasks.map((t) => [t.id, t]));

  // Kích thước định nghĩa tool MCP (có trong prompt mỗi lượt khi MCP bật)
  const probe = await startMcp(repo);
  const { tools } = await probe.listTools();
  await probe.close();
  const schemaTokens = tok(JSON.stringify(tools));
  console.error(`MCP tool definitions: ${tools.length} tools, ~${schemaTokens} tokens per request; base context ${baseContext}`);

  const results = [];
  const from = Number(arg("from", 1)) - 1;
  const pick = arg("pick")?.split(",");
  const todo = pick ? sessions.filter((x) => pick.includes(x.id)) : sessions;
  for (const [i, session] of todo.entries()) {
    if (i < from) continue;
    const row = {
      id: session.id,
      size: session.size,
      difficulty: session.size === "large" ? "mixed" : T[session.reuse[0]].difficulty,
      callersLanguage: session.size === "large" ? "mixed" : T[session.callers[0]].language,
      baseline: await runSession("baseline", session, T, repo, 0, baseContext),
      mcp: await runSession("mcp", session, T, repo, schemaTokens, baseContext),
    };
    results.push(row);
    const fmt = (x) =>
      `reuse ${(x.reuse.found * 100).toFixed(0).padStart(3)}% callers R${(x.callers.recall * 100).toFixed(0)}/P${(x.callers.precision * 100).toFixed(0)} ` +
      `survey R${(x.survey.recall * 100).toFixed(0)}/P${(x.survey.precision * 100).toFixed(0)} ${x.allCorrect ? "OK " : "BAD"} ` +
      `${String(x.contextTokens).padStart(6)} tok ${String(x.toolCalls).padStart(3)} calls`;
    console.error(`[${String(i + 1).padStart(3)}/${todo.length}] ${row.id.padEnd(11)} ${row.difficulty.padEnd(10)} ${row.callersLanguage.padEnd(10)} no-MCP ${fmt(row.baseline)} | MCP ${fmt(row.mcp)}`);
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const payload = { meta: { ...meta, repo, schemaTokens, baseContext, charsPerToken: CHARS_PER_TOKEN, headLimit: HEAD_LIMIT, node: process.version, date: new Date().toISOString() }, results };
  const jsonPath = join(outDir, `bench-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  const { report } = await import("./report.mjs");
  const md = report(payload);
  const mdPath = join(outDir, `bench-${stamp}.md`);
  writeFileSync(mdPath, md);
  console.log(md);
  console.error(`\nwrote ${jsonPath}\nwrote ${mdPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

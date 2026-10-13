// Benchmark trên một repo THẬT (không sinh code). Đáp án lấy từ oracle độc lập
// với spec-nav, rồi chạy cùng hai agent và cùng pha sửa code như bench/run.mjs.
//
//   callers: hàm/method TypeScript thật; đáp án = findReferences của TypeScript
//            Language Service (compiler), bỏ chính khai báo và dòng import/export.
//   reuse:   hàm thật có JSDoc/docstring; đề = câu đầu của doc, đã bỏ định danh code;
//            đáp án = chính hàm đó (và hàm khác có cùng câu doc).
//   survey:  khái niệm hai từ có ít nhất hai kiểu viết trong repo; đáp án = mọi file
//            có dòng code (không phải comment) khớp regex.
//
// node bench/real.mjs --repo <path> [--sessions 30] [--large-sessions 10] [--seed 1]
//                     [--tsconfig server/tsconfig.json,...] [--label "immich@abc123"]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, Node, SyntaxKind } from "ts-morph";
import { rng } from "./generate.mjs";
import { runSession, startMcp, tok, CHARS_PER_TOKEN, HEAD_LIMIT } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const STOP = new Set(("a an the of to for in on by with and or from into that which this it its is are be been as at " +
  "if when then than also only each every all any some return returns returned given new used use uses using get gets " +
  "set sets should will can may must not no do does done via based per one two first last").split(" "));
const GENERIC = new Set(["constructor", "get", "set", "has", "create", "update", "delete", "remove", "find", "list", "handle",
  "init", "run", "start", "stop", "toString", "toJSON", "map", "filter", "load", "save", "execute", "apply", "call", "process"]);

function rgFiles(repo, args) {
  const p = spawnSync("rg", [...args, "--", "."], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
  return (p.stdout ?? "").split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, ""));
}

/** tsconfig.json của các project TS đủ lớn (bỏ node_modules), trừ khi chỉ định. */
function findTsconfigs(repo) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (e.name === "tsconfig.json") out.push(relative(repo, abs));
    }
  };
  walk(repo, 0);
  return out;
}

const COMMENT = /^\s*(\/\/|#|\*|\/\*|--)/;
const isImportish = (n) => !!n.getFirstAncestor((a) => Node.isImportDeclaration(a) || Node.isExportDeclaration(a) || Node.isImportEqualsDeclaration(a));

function mineCallers(repo, tsconfigs, r, want) {
  const tasks = [];
  for (const cfg of tsconfigs) {
    if (tasks.length >= want) break;
    let project;
    try {
      project = new Project({ tsConfigFilePath: join(repo, cfg), skipLoadingLibFiles: false });
    } catch (err) {
      console.error(`skip ${cfg}: ${err.message}`);
      continue;
    }
    const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes("node_modules") && !f.isDeclarationFile() &&
      !/\.(spec|test)\.ts$/.test(f.getFilePath()));
    console.error(`${cfg}: ${files.length} source files`);
    const cands = [];
    for (const sf of files) {
      for (const fn of sf.getFunctions()) if (fn.isExported() && fn.getName()) cands.push(fn);
      for (const cls of sf.getClasses()) {
        if (!cls.getName()) continue;
        for (const m of cls.getMethods()) if (m.getBody() && m.getScope() !== "private") cands.push(m);
      }
    }
    for (const decl of r.shuffle(cands)) {
      if (tasks.length >= want) break;
      const name = decl.getName();
      if (!name || name.length < 6 || GENERIC.has(name)) continue;
      let refs;
      try {
        refs = decl.findReferencesAsNodes();
      } catch {
        continue;
      }
      const sites = new Map();
      for (const ref of refs) {
        const sf = ref.getSourceFile();
        const fp = sf.getFilePath();
        if (fp.includes("node_modules") || sf.isDeclarationFile() || isImportish(ref)) continue;
        if (ref.getParent() === decl || ref === decl.getNameNode()) continue;
        // findReferences trên một method override trả cả khai báo của các override
        // khác trong cùng cây kế thừa: đó là khai báo, không phải nơi gọi.
        const parent = ref.getParent();
        if (parent && typeof parent.getNameNode === "function" && parent.getNameNode() === ref &&
            (Node.isMethodDeclaration(parent) || Node.isMethodSignature(parent) || Node.isPropertyDeclaration(parent) ||
             Node.isPropertySignature(parent) || Node.isFunctionDeclaration(parent) || Node.isPropertyAssignment(parent))) continue;
        const rel = relative(repo, fp);
        const line = ref.getStartLineNumber();
        sites.set(`${rel}:${line}`, { file: rel, line });
      }
      if (sites.size < 3 || sites.size > 30) continue;
      const cls = Node.isMethodDeclaration(decl) ? decl.getParent().getName() : undefined;
      const declFile = relative(repo, decl.getSourceFile().getFilePath());
      tasks.push({
        id: `callers-${String(tasks.length + 1).padStart(3, "0")}`,
        type: "callers",
        language: "typescript",
        symbol: cls ? `${cls}.${name}` : name,
        declFile,
        declLine: decl.getNameNode().getStartLineNumber(),
        truth: [...sites.values()].filter((x) => !(x.file === declFile && x.line === decl.getNameNode().getStartLineNumber())),
        oracle: "TypeScript findReferences",
      });
    }
  }
  return tasks;
}

/** Hàm có doc trong mọi file TS/Python: đề = câu đầu của doc. */
function mineReuse(repo, r, want) {
  const files = rgFiles(repo, ["-l", "--type", "ts", "--type", "py", "-e", "/\\*\\*|\"\"\""]).filter((f) => !/node_modules|\.d\.ts$|\.(spec|test)\.|test_/.test(f));
  const out = [];
  const seenDesc = new Map();
  for (const f of r.shuffle(files)) {
    if (out.length >= want * 3) break;
    const text = readFileSync(join(repo, f), "utf8");
    const re = f.endsWith(".py")
      ? /^\s*def\s+(\w+)\s*\([^)]*\)[^:]*:\s*\n\s*"""\s*([^"\n][^\n"]*)/gm
      : /\/\*\*\s*\n?\s*\*?\s*([^@*\n][^\n]*?)\s*\n[\s\S]{0,400}?\*\/\s*\n\s*(?:export\s+)?(?:public\s+|protected\s+|static\s+|async\s+)*(?:function\s+)?(\w+)\s*\(/g;
    for (let m; (m = re.exec(text)); ) {
      const [name, doc] = f.endsWith(".py") ? [m[1], m[2]] : [m[2], m[1]];
      if (!name || GENERIC.has(name) || name.length < 5 || /^(if|for|while|switch|catch|constructor)$/.test(name)) continue;
      const sentence = doc.split(/(?<=\.)\s/)[0].replace(/`[^`]*`/g, " ").replace(/\{@link[^}]*\}/g, " ");
      // Bỏ định danh code (camelCase, snake_case, có dấu chấm) để đề bài là lời mô tả, không lộ tên.
      const desc = sentence.split(/\s+/).filter((w) => !/[A-Z].*[a-z].*[A-Z]|[a-z][A-Z]|_|\.\w|\(|\)/.test(w)).join(" ")
        .replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      const content = desc.split(" ").filter((w) => w.length > 2 && !STOP.has(w));
      if (content.length < 3 || content.length > 14) continue;
      const line = text.slice(0, m.index + m[0].length).split("\n").length;
      const item = { file: f, name, line, desc, content };
      seenDesc.set(desc, [...(seenDesc.get(desc) ?? []), item]);
      out.push(item);
    }
  }
  // Độ hiếm của từ trong repo (mô phỏng trực giác chọn từ đặc thù của LLM)
  const rarity = new Map();
  const count = (w) => {
    if (!rarity.has(w)) rarity.set(w, rgFiles(repo, ["-l", "-i", "-w", "-e", w]).length);
    return rarity.get(w);
  };
  const tasks = [];
  for (const item of r.shuffle(out)) {
    if (tasks.length >= want) break;
    const words = [...new Set(item.content)].sort((a, b) => count(a) - count(b)).slice(0, 4);
    tasks.push({
      id: `reuse-${String(tasks.length + 1).padStart(3, "0")}`,
      type: "reuse",
      difficulty: "real-doc",
      language: item.file.endsWith(".py") ? "py" : "ts",
      description: item.desc,
      englishQuery: item.desc,
      prompt: `Before implementing "${item.desc}", find an existing function in the repo that already does it.`,
      llmKeywords: words.map((w) => [w]),
      llmSpecific: [words[0]],
      truth: seenDesc.get(item.desc).map((x) => ({ file: x.file, name: x.name, line: x.line })),
    });
  }
  return tasks;
}

/** Khái niệm hai từ viết nhiều kiểu: cặp từ lấy từ tên định danh thật. */
function mineSurvey(repo, r, want) {
  const ids = spawnSync("rg", ["-o", "--no-filename", "-I", "-e", "\\b[a-z]+[A-Z][a-z]+\\b", "--type", "ts", "--type", "py", "--", "."], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 }).stdout.split("\n");
  const pairs = new Map();
  for (const id of ids) {
    const m = id.match(/^([a-z]{4,})([A-Z][a-z]{3,})$/);
    if (m) pairs.set(`${m[1]} ${m[2].toLowerCase()}`, (pairs.get(`${m[1]} ${m[2].toLowerCase()}`) ?? 0) + 1);
  }
  const tasks = [];
  for (const [concept] of r.shuffle([...pairs].filter(([, n]) => n >= 4))) {
    if (tasks.length >= want) break;
    const [a, b] = concept.split(" ");
    const pattern = `${a}[_ -]?${b}`;
    const p = spawnSync("rg", ["-n", "-i", "--no-heading", "-e", pattern, "--", "."], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
    const hits = p.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, "").match(/^(.*?):(\d+):(.*)$/)).filter(Boolean);
    const codeFiles = new Set(hits.filter((h) => !COMMENT.test(h[3])).map((h) => h[1]));
    const spellings = new Set(hits.map((h) => (h[3].match(new RegExp(pattern, "i")) ?? [""])[0]));
    if (codeFiles.size < 3 || codeFiles.size > 25 || spellings.size < 2) continue;
    // Mọi file có dòng code khớp, kể cả loại spec-nav không đọc (.sql, .json…) — chỉ bỏ lockfile và tài liệu.
    const truth = [...codeFiles].filter((f) => !/(\.md|\.lock|package-lock\.json|pnpm-lock\.yaml)$/.test(f));
    if (truth.length < 3) continue;
    tasks.push({ id: `survey-${String(tasks.length + 1).padStart(3, "0")}`, type: "survey", concept, pattern, truth: truth.map((file) => ({ file })) });
  }
  return tasks;
}

async function main() {
  const repo = resolve(arg("repo"));
  if (!existsSync(repo)) throw new Error("--repo <path> is required");
  const seed = Number(arg("seed", 1));
  const nStd = Number(arg("sessions", 30));
  const nLarge = Number(arg("large-sessions", 10));
  const perLarge = 3;
  const need = nStd + nLarge * perLarge;
  const r = rng(seed);
  const outDir = resolve(arg("out", join(HERE, "results")));
  const head = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const label = arg("label", `${repo.split("/").pop()}@${head}`);

  const t0 = performance.now();
  const tsconfigs = arg("tsconfig") ? arg("tsconfig").split(",") : findTsconfigs(repo);
  const callers = mineCallers(repo, tsconfigs, r, need);
  const reuse = mineReuse(repo, r, need);
  const survey = mineSurvey(repo, r, need);
  const n = Math.min(callers.length, reuse.length, survey.length);
  console.error(`mined ${callers.length} callers, ${reuse.length} reuse, ${survey.length} survey tasks in ${Math.round((performance.now() - t0) / 1000)} s`);
  const std = Math.min(nStd, n);
  const large = Math.min(nLarge, Math.floor((n - std) / perLarge));
  const tasks = [...callers, ...reuse, ...survey];
  const T = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const sessions = [];
  for (let t = 0; t < std + large; t++) {
    const big = t >= std;
    const from = big ? std + (t - std) * perLarge : t;
    const k = big ? perLarge : 1;
    const rs = reuse.slice(from, from + k);
    const cs = callers.slice(from, from + k);
    const ss = survey.slice(from, from + k);
    const files = cs.map((c) => c.truth.find((x) => x.file !== c.declFile)?.file ?? c.declFile);
    sessions.push({
      id: `${big ? "large" : "session"}-${String(big ? t - std + 1 : t + 1).padStart(3, "0")}`,
      size: big ? "large" : "standard",
      reuse: rs.map((x) => x.id),
      callers: cs.map((x) => x.id),
      survey: ss.map((x) => x.id),
      featureFiles: files,
      prompt: rs.map((rt, j) =>
        `Feature: in ${files[j]}, add support for "${rt.description}". Reuse existing logic if the repo already has it. ` +
        `The change needs a new parameter on ${cs[j].symbol} (declared in ${cs[j].declFile}): update every caller. ` +
        `The "${ss[j].concept}" value also changes: update it everywhere, in every spelling.`).join("\n"),
    });
  }
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(join(outDir, `real-tasks-${stamp}.json`), JSON.stringify({ label, tasks, sessions }, null, 2));

  const files = rgFiles(repo, ["--files"]);
  let lines = 0;
  for (const f of files) {
    if (!/\.(ts|tsx|js|svelte|vue|py|go|java|kt|swift|dart|rs|rb|php|cs)$/.test(f)) continue;
    try {
      if (statSync(join(repo, f)).size < 2_000_000) lines += readFileSync(join(repo, f), "utf8").split("\n").length;
    } catch {}
  }
  const probe = await startMcp(repo);
  const { tools } = await probe.listTools();
  await probe.close();
  const schemaTokens = tok(JSON.stringify(tools));
  const results = [];
  for (const [i, s] of sessions.entries()) {
    const row = {
      id: s.id, size: s.size,
      difficulty: s.size === "large" ? "mixed" : T[s.reuse[0]].difficulty,
      callersLanguage: s.size === "large" ? "mixed" : T[s.callers[0]].language,
      baseline: await runSession("baseline", s, T, repo, 0, 0),
      mcp: await runSession("mcp", s, T, repo, schemaTokens, 0),
    };
    results.push(row);
    const f = (x) => `reuse ${(x.reuse.found * 100).toFixed(0).padStart(3)}% callers R${(x.callers.recall * 100).toFixed(0)}/P${(x.callers.precision * 100).toFixed(0)} ${x.allCorrect ? "OK " : "BAD"} ${String(x.contextTokens).padStart(6)} tok ${String(x.toolCalls).padStart(3)} calls`;
    console.error(`[${String(i + 1).padStart(3)}/${sessions.length}] ${s.id.padEnd(11)} no-MCP ${f(row.baseline)} | MCP ${f(row.mcp)} ${row.mcp.toolMs} ms ${row.mcp.serverRssMb ?? "?"} MB`);
  }
  const payload = {
    meta: { repoLabel: `${label} (repo thật; đáp án: findReferences của TypeScript, doc comment, ripgrep)`, files: files.length, lines, schemaTokens, baseContext: 0, charsPerToken: CHARS_PER_TOKEN, headLimit: HEAD_LIMIT, perLarge, date: new Date().toISOString() },
    results,
  };
  writeFileSync(join(outDir, `real-${stamp}.json`), JSON.stringify(payload, null, 2));
  const { report } = await import("./report.mjs");
  const md = report(payload);
  writeFileSync(join(outDir, `real-${stamp}.md`), md);
  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

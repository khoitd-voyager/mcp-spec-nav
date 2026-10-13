// Sinh một monorepo đa ngôn ngữ cỡ lớn, có seed (chạy lại ra đúng repo đó),
// cùng N session (mặc định 100), mỗi session là một yêu cầu feature gồm ba việc
// có đáp án đã biết trước (ground truth):
//   - reuse:   tìm hàm có sẵn cho một hành vi, tên hàm khác mô tả ở nhiều mức
//   - callers: tìm mọi nơi gọi một hàm cần đổi signature, qua alias/re-export/namespace/động…
//   - survey:  tìm mọi file định nghĩa một khái niệm viết nhiều kiểu
// rồi sửa code ở những chỗ đó.
// Đáp án do generator ghi lại khi cài code, không suy ra từ agent nào.
//
// node bench/generate.mjs --out <dir> [--seed 42] [--files-per-service 90] [--sessions 100]
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// PRNG có seed

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    chance: (p) => next() < p,
    shuffle: (xs) => {
      const a2 = [...xs];
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
  return r;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const words = (s) => s.split(/[\s_-]+|(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
const camel = (ws) => ws.map((w, i) => (i ? cap(w) : w)).join("");
const pascal = (ws) => ws.map(cap).join("");
const snake = (ws) => ws.join("_");

// ---------------------------------------------------------------------------
// Ngôn ngữ: quy ước đặt tên, đuôi file, cú pháp tối thiểu để sinh code hợp lệ.

const LANGS = {
  ts: { ext: ".ts", name: camel, marker: (svc) => ({ "package.json": JSON.stringify({ name: `@repo/${svc.split("/").pop()}`, private: true }), "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" } }) }) },
  js: { ext: ".js", name: camel, marker: (svc) => ({ "package.json": JSON.stringify({ name: `@repo/${svc.split("/").pop()}`, private: true }) }) },
  py: { ext: ".py", name: snake, marker: () => ({ "pyproject.toml": "[project]\nname = \"svc\"\n" }) },
  go: { ext: ".go", name: (ws) => pascal(ws), marker: (svc) => ({ "go.mod": `module shop/${svc.replace(/\//g, "-")}\n\ngo 1.22\n` }) },
  java: { ext: ".java", name: camel, marker: () => ({ "pom.xml": "<project/>\n" }) },
  kt: { ext: ".kt", name: camel, marker: () => ({ "build.gradle.kts": "" }) },
  swift: { ext: ".swift", name: camel, marker: () => ({ "Package.swift": "// swift-tools-version:5.9\n" }) },
  rb: { ext: ".rb", name: snake, marker: () => ({ Gemfile: "source 'https://rubygems.org'\n" }) },
  php: { ext: ".php", name: camel, marker: () => ({ "composer.json": "{}\n" }) },
};

const ENTITIES = ["user", "account", "order", "invoice", "payment", "product", "cart", "coupon", "shipment", "warehouse",
  "report", "session", "token", "address", "review", "subscription", "refund", "notification", "inventory", "ticket",
  "profile", "catalog", "vendor", "employee", "schedule", "ledger", "quote", "contract", "asset", "device"];
const VERBS = ["get", "list", "create", "update", "delete", "validate", "format", "parse", "sync", "build", "load", "save",
  "compute", "normalize", "export", "resolve", "merge", "filter", "sort", "archive", "approve", "cancel", "publish",
  "render", "check", "apply", "track", "map", "encode", "fetch"];
const QUALS = ["by id", "for user", "batch", "cached", "draft", "summary", "totals", "status", "history", "snapshot",
  "lines", "items", "meta", "range", "fee", "price", "amount", "count"];

// ---------------------------------------------------------------------------
// Một file = danh sách dòng; hàm nào ghi lại dòng của nó để đáp án chính xác.

class FileBuf {
  constructor(lang, rel) {
    this.lang = lang;
    this.rel = rel;
    /** Dòng thường là chuỗi; dòng cần biết số dòng là object {t}, để chèn thêm phía trên không làm sai. */
    this.lines = [];
  }
  push(...ls) {
    for (const l of ls) this.lines.push(...l.split("\n"));
  }
  /** Thêm một dòng; trả về tham chiếu, đổi ra số dòng khi ghi file. */
  line(l) {
    const ref = { t: l, buf: this };
    this.lines.push(ref);
    return ref;
  }
  unshift(l) {
    this.lines.unshift(l);
  }
  insertAt(i, l) {
    this.lines.splice(i, 0, l);
  }
  lineOf(ref) {
    return this.lines.indexOf(ref) + 1;
  }
  text() {
    return this.lines.map((x) => (typeof x === "string" ? x : x.t)).join("\n") + "\n";
  }
}

/** Đáp án: tham chiếu dòng → {file, line}. */
function resolveRef(x) {
  if (x && typeof x.line === "object") return { ...x, file: x.line.buf.rel, line: x.line.buf.lineOf(x.line) };
  return x;
}

// Thân hàm nhiễu theo ngôn ngữ: biến cục bộ, vài phép tính, gọi hàm khác trong cùng file.
function fillerFn(L, r, name, callees, entity) {
  const v = entity;
  const n = r.int(2, 9);
  const c1 = callees[0];
  const c2 = callees[1];
  const s = `"${entity} ${r.pick(["ok", "missing", "stale", "queued", "done"])}"`;
  switch (L) {
    case "ts":
    case "js": {
      const t = L === "ts" ? ": any" : "";
      return [
        `export function ${name}(${v}${t}, limit${L === "ts" ? ": number" : ""} = ${n}) {`,
        `  const ${v}Count = ${c1 ? `${c1}(${v}, limit)` : `limit * ${n}`};`,
        `  if (!${v}) return ${s};`,
        ...(c2 ? [`  const next = ${c2}(${v}, ${v}Count);`] : [`  const next = ${v}Count + 1;`]),
        `  return { ${v}, next, label: ${s} };`,
        `}`,
      ];
    }
    case "py":
      return [
        `def ${name}(${v}, limit=${n}):`,
        `    ${v}_count = ${c1 ? `${c1}(${v}, limit)` : `limit * ${n}`}`,
        `    if not ${v}:`,
        `        return ${s}`,
        ...(c2 ? [`    nxt = ${c2}(${v}, ${v}_count)`] : [`    nxt = ${v}_count`]),
        `    return {"${v}": ${v}, "next": nxt, "label": ${s}}`,
        ``,
      ];
    case "go":
      return [
        `func ${name}(${v} string, limit int) map[string]interface{} {`,
        `\t${v}Count := ${c1 ? `len(${c1}(${v}, limit))` : `limit * ${n}`}`,
        `\tif ${v} == "" {`,
        `\t\treturn nil`,
        `\t}`,
        ...(c2 ? [`\tnext := ${c2}(${v}, ${v}Count)`] : [`\tnext := ${v}Count + 1`]),
        `\treturn map[string]interface{}{"${v}": ${v}, "next": next, "label": ${s}}`,
        `}`,
        ``,
      ];
    case "java":
      return [
        `  public static Object ${name}(Object ${v}, int limit) {`,
        `    Object ${v}Count = ${c1 ? `${c1}(${v}, limit)` : `limit * ${n}`};`,
        `    if (${v} == null) { return ${s}; }`,
        ...(c2 ? [`    Object next = ${c2}(${v}, ${n});`] : [`    Object next = ${v}Count;`]),
        `    return java.util.Map.of("${v}", ${v}, "next", next);`,
        `  }`,
      ];
    case "kt":
      return [
        `    fun ${name}(${v}: Any?, limit: Int = ${n}): Any? {`,
        `        val ${v}Count = ${c1 ? `${c1}(${v}, limit)` : `limit * ${n}`}`,
        `        if (${v} == null) return ${s}`,
        ...(c2 ? [`        val next = ${c2}(${v}, ${n})`] : [`        val next = ${v}Count`]),
        `        return mapOf("${v}" to ${v}, "next" to next)`,
        `    }`,
      ];
    case "swift":
      return [
        `    static func ${name}(_ ${v}: Any?, limit: Int = ${n}) -> Any? {`,
        `        let ${v}Count = ${c1 ? `${c1}(${v}, limit: limit)` : `limit * ${n}`}`,
        `        guard ${v} != nil else { return ${s} }`,
        ...(c2 ? [`        let next = ${c2}(${v}, limit: ${n})`] : [`        let next = ${v}Count`]),
        `        return ["${v}": ${v} as Any, "next": next as Any]`,
        `    }`,
      ];
    case "rb":
      return [
        `  def ${name}(${v}, limit = ${n})`,
        `    ${v}_count = ${c1 ? `${c1}(${v}, limit)` : `limit * ${n}`}`,
        `    return ${s} if ${v}.nil?`,
        ...(c2 ? [`    nxt = ${c2}(${v}, ${v}_count)`] : [`    nxt = ${v}_count`]),
        `    { ${v}: ${v}, next: nxt, label: ${s} }`,
        `  end`,
      ];
    case "php":
      return [
        `    public function ${name}($${v}, $limit = ${n}) {`,
        `        $${v}Count = ${c1 ? `$this->${c1}($${v}, $limit)` : `$limit * ${n}`};`,
        `        if (!$${v}) { return ${s}; }`,
        ...(c2 ? [`        $next = $this->${c2}($${v}, $${v}Count);`] : [`        $next = $${v}Count + 1;`]),
        `        return ['${v}' => $${v}, 'next' => $next];`,
        `    }`,
      ];
  }
}

function fileHeader(L, svc, mod) {
  const cls = pascal(words(mod)) + "Module";
  switch (L) {
    case "go": return { open: [`package ${mod.replace(/[^a-z]/g, "")}`, ""], close: [], cls };
    case "java": return { open: [`package shop.${svc.replace(/[^a-z]/g, "")};`, "", `public class ${cls} {`], close: ["}"], cls };
    case "kt": return { open: [`package shop.${svc.replace(/[^a-z]/g, "")}`, "", `object ${cls} {`], close: ["}"], cls };
    case "swift": return { open: ["import Foundation", "", `enum ${cls} {`], close: ["}"], cls };
    case "rb": return { open: [`class ${cls}`], close: ["end"], cls };
    case "php": return { open: ["<?php", "", `namespace App\\${pascal(words(svc))};`, "", `class ${cls}`, "{"], close: ["}"], cls };
    default: return { open: [], close: [], cls };
  }
}

/** Đường dẫn file nguồn theo ngôn ngữ (Go: mỗi module một package/thư mục). */
function srcPath(L, svc, mod) {
  const base = mod.replace(/[^a-z_]/g, "");
  switch (L) {
    case "go": return `${svc}/${base}/${base}.go`;
    case "java": return `${svc}/src/main/java/shop/${pascal(words(mod))}Module.java`;
    case "kt": return `${svc}/src/main/kotlin/shop/${pascal(words(mod))}Module.kt`;
    case "swift": return `${svc}/Sources/${pascal(words(mod))}Module.swift`;
    case "py": return `${svc}/${svc.split("/").pop().replace(/-/g, "_")}/${base}.py`;
    case "rb": return `${svc}/lib/${base}.rb`;
    case "php": return `${svc}/src/${pascal(words(mod))}Module.php`;
    default: return `${svc}/src/${base}${LANGS[L].ext}`;
  }
}

// ---------------------------------------------------------------------------
// Kế hoạch service

const SERVICE_PLAN = [
  ["services/checkout-api", "ts"], ["services/orders-api", "ts"], ["services/catalog-api", "ts"], ["services/billing-api", "ts"],
  ["services/identity-api", "ts"], ["services/notify-worker", "ts"], ["services/search-api", "ts"], ["services/admin-api", "js"],
  ["services/legacy-gateway", "js"], ["services/pricing-engine", "py"], ["services/fraud-scorer", "py"], ["services/reports", "py"],
  ["services/recommender", "py"], ["services/fulfillment", "go"], ["services/inventory", "go"], ["services/payments-gw", "go"],
  ["services/ledger", "java"], ["services/loyalty", "java"], ["services/android-app", "kt"], ["services/partner-sync", "kt"],
  ["apps/ios", "swift"], ["services/storefront-rails", "rb"], ["services/cms", "php"],
  ["packages/shared", "ts"], ["libs/py_common", "py"], ["libs/go-common", "go"], ["libs/jvm-common", "java"],
];

// ---------------------------------------------------------------------------
// Hành vi cho task reuse. Mỗi task một hành vi riêng (không trùng đáp án).

const FEE_KINDS = ["shipping", "late", "handling", "storage", "cancellation", "processing", "transfer", "setup", "conversion", "service"];

/** Từ đồng nghĩa mà một LLM tự nghĩ ra khi grep (cho agent không-MCP). */
const LLM_SYNONYMS = {
  calculate: ["calculate", "calc", "compute", "get"], fee: ["fee", "charge", "cost", "surcharge"],
  shipping: ["shipping", "shipment", "delivery", "freight"], late: ["late", "overdue", "penalty"],
  handling: ["handling", "processing"], storage: ["storage", "warehouse", "holding"],
  cancellation: ["cancellation", "cancel"], processing: ["processing", "handling"], transfer: ["transfer", "wire"],
  setup: ["setup", "onboarding", "activation"], conversion: ["conversion", "fx", "exchange"], service: ["service"],
  validate: ["validate", "check", "verify", "is"], email: ["email", "mail"], send: ["send", "notify", "deliver", "dispatch"],
  reminder: ["reminder", "remind", "nudge"], mask: ["mask", "redact", "obfuscate", "hide"], card: ["card", "pan", "cc"],
  parse: ["parse", "read", "import", "load"], csv: ["csv"], round: ["round", "rounding"], money: ["money", "amount", "cents", "currency"],
  retry: ["retry", "backoff", "attempt"], webhook: ["webhook", "callback", "hook"],
};

const VI_KIND = { shipping: "vận chuyển", late: "trễ hạn", handling: "xử lý", storage: "lưu kho", cancellation: "hủy",
  processing: "xử lý", transfer: "chuyển khoản", setup: "thiết lập", conversion: "chuyển đổi", service: "dịch vụ" };
const VI_ENTITY = { order: "đơn hàng", invoice: "hóa đơn", shipment: "lô hàng", cart: "giỏ hàng", subscription: "gói đăng ký",
  booking: "đặt chỗ", rental: "hợp đồng thuê", parcel: "bưu kiện", membership: "thẻ thành viên", quote: "báo giá" };
const FEE_ENTITIES = Object.keys(VI_ENTITY);
const VI = {
  "validate a customer email address": "kiểm tra địa chỉ email của khách hàng",
  "send payment reminder email to a customer": "gửi email nhắc thanh toán cho khách hàng",
  "mask a card number for display": "che số thẻ khi hiển thị",
  "parse an uploaded csv of products": "đọc file csv sản phẩm được tải lên",
  "round a money amount to cents": "làm tròn số tiền",
  "retry a failed webhook delivery with backoff": "thử lại gửi webhook bị lỗi",
};

const art = (w) => (/^[aeiou]/.test(w) ? "an" : "a");

/** Phí: mỗi cặp (loại phí, thực thể) là một hành vi riêng. */
function feeBehaviour(kind, entity, n) {
  const adjCamel = cap(kind);
  const description = `calculate ${kind} fee for ${art(entity)} ${entity}`;
  VI[description] = `tính phí ${VI_KIND[kind]} cho ${VI_ENTITY[entity]}`;
  return {
    key: `fee:${kind}:${entity}`,
    description,
    terms: ["calculate", "fee", kind, entity],
    specific: kind,
    names: {
      easy: ["calculate", entity, kind, "fee"],
      synonym: ["compute", entity, LLM_SYNONYMS[kind]?.[1] ?? kind, "charge"],
      abbrev: ["calc", entity, kind, "fee", "amt"],
      behaviour: ["settle", entity, "matrix", String(n)],
    },
    params: [entity, "rateTable"],
    helpers: [`lookup${adjCamel}Rate`, "roundTo", "applyCap"],
    bodyWords: [kind, "rate", "weight", "cap"],
    draft: `function ${camel(["calculate", entity, kind, "fee"])}(${entity}, rates) {\n  const ${kind}Rate = rates[${entity}.zone] || 1;\n  const raw = ${entity}.weight * ${kind}Rate;\n  return Math.round(Math.min(raw, rates.cap) * 100) / 100;\n}`,
    decoys: [["format", entity, kind, "fee"], ["calculate", entity, kind, "eta"]],
  };
}

const VI_PARTY = { customer: "khách hàng", vendor: "nhà cung cấp", employee: "nhân viên", partner: "đối tác", guest: "khách vãng lai",
  supplier: "nhà cung ứng", merchant: "người bán", driver: "tài xế", tenant: "người thuê", student: "học viên" };
const PARTIES = Object.keys(VI_PARTY);

/** Các hành vi khác, mỗi cái nhân theo đối tượng (customer, vendor…). */
function otherBehaviours(p, n) {
  const P = cap(p);
  const list = [
    {
      key: `email:validate:${p}`, specific: "email", description: `validate ${art(p)} ${p} email address`,
      vi: `kiểm tra địa chỉ email của ${VI_PARTY[p]}`, terms: ["validate", "email", p],
      names: { easy: ["validate", p, "email"], synonym: ["check", p, "mail", "address"], abbrev: ["validate", p, "email", "addr"], behaviour: ["accept", p, "contact", String(n)] },
      params: ["candidate"], helpers: ["matchesPattern", "hasMxRecord"], bodyWords: ["email", "pattern", "domain"],
      draft: `function validate${P}Email(value) {\n  const emailPattern = /^[^@\\s]+@[^@\\s]+$/;\n  const domain = value.split('@')[1];\n  return emailPattern.test(value) && !!domain;\n}`,
      decoys: [["format", p, "email"], ["validate", p, "phone"]],
    },
    {
      key: `email:reminder:${p}`, specific: "reminder", description: `send payment reminder email to ${art(p)} ${p}`,
      vi: `gửi email nhắc thanh toán cho ${VI_PARTY[p]}`, terms: ["send", "reminder", "email", p],
      names: { easy: ["send", p, "reminder", "email"], synonym: ["dispatch", p, "payment", "nudge", "mail"], abbrev: ["send", p, "reminder", "msg"], behaviour: ["chase", p, "outstanding", String(n)] },
      params: [p, "invoice"], helpers: ["renderTemplate", "sendMail"], bodyWords: ["reminder", "subject", "template"],
      draft: `function send${P}PaymentReminder(${p}, invoice) {\n  const template = renderTemplate('reminder', { ${p}, invoice });\n  return mailer.sendMail({ to: ${p}.email, subject: 'Payment reminder', body: template });\n}`,
      decoys: [["send", p, "welcome", "email"], ["schedule", p, "reminder"]],
    },
    {
      key: `card:mask:${p}`, specific: "card", description: `mask ${art(p)} ${p} card number for display`,
      vi: `che số thẻ của ${VI_PARTY[p]} khi hiển thị`, terms: ["mask", "card", "number", p],
      names: { easy: ["mask", p, "card", "number"], synonym: ["redact", p, "pan"], abbrev: ["mask", p, "card", "num"], behaviour: ["safe", p, "tail", "digits", String(n)] },
      params: ["value"], helpers: ["lastDigits", "repeatChar"], bodyWords: ["digits", "card", "mask"],
      draft: `function mask${P}CardNumber(card) {\n  const digits = lastDigits(card, 4);\n  return repeatChar('*', card.length - 4) + digits;\n}`,
      decoys: [["validate", p, "card", "number"], ["mask", p, "phone"]],
    },
    {
      key: `csv:parse:${p}`, specific: "csv", description: `parse an uploaded ${p} csv file`,
      vi: `đọc file csv ${VI_PARTY[p]} được tải lên`, terms: ["parse", "csv", p],
      names: { easy: ["parse", p, "csv"], synonym: ["read", p, "sheet"], abbrev: ["parse", p, "csv", "rec"], behaviour: ["ingest", p, "rows", String(n)] },
      params: ["text"], helpers: ["splitLines", "splitColumns"], bodyWords: ["header", "columns", "csv"],
      draft: `function parse${P}Csv(text) {\n  const lines = splitLines(text);\n  const header = splitColumns(lines[0]);\n  return lines.slice(1).map((l) => splitColumns(l));\n}`,
      decoys: [["export", p, "csv"], ["parse", p, "json"]],
    },
    {
      key: `webhook:retry:${p}`, specific: "webhook", description: `retry a failed ${p} webhook delivery with backoff`,
      vi: `thử lại gửi webhook ${VI_PARTY[p]} bị lỗi`, terms: ["retry", "webhook", p],
      names: { easy: ["retry", p, "webhook"], synonym: ["redeliver", p, "callback", "backoff"], abbrev: ["retry", p, "webhook", "req"], behaviour: ["replay", p, "outbox", String(n)] },
      params: ["delivery"], helpers: ["sleepMs", "postJson"], bodyWords: ["attempt", "backoff", "delay"],
      draft: `async function retry${P}Webhook(delivery) {\n  for (let attempt = 0; attempt < 5; attempt++) {\n    if (await postJson(delivery.url, delivery.payload)) return true;\n    await sleepMs(2 ** attempt * 100); // backoff delay\n  }\n  return false;\n}`,
      decoys: [["register", p, "webhook"], ["retry", p, "login"]],
    },
  ];
  for (const b of list) VI[b.description] = b.vi;
  return list;
}

// ---------------------------------------------------------------------------

export function generate({ out, seed = 42, filesPerService = 90, sessions = 100, largeSessions = 50, perLarge = 3 }) {
  const r = rng(seed);
  // Mỗi session thường dùng 1 việc mỗi loại; session lớn gộp perLarge việc mỗi loại.
  const total = sessions + largeSessions * perLarge;
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  const files = new Map(); // rel -> FileBuf | string
  const write = (rel, content) => files.set(rel, content);

  // Root
  write("package.json", JSON.stringify({ name: "shop-monorepo", private: true, workspaces: ["services/*", "packages/*"] }, null, 2));
  write("README.md", "# shop monorepo (synthetic benchmark fixture)\n");

  // --- Filler code: realistic noise. Each service gets files of functions calling each other.
  const svcFiles = new Map(); // svc -> [{rel, buf, lang, fnNames}]
  for (const [svc, L] of SERVICE_PLAN) {
    for (const [f, c] of Object.entries(LANGS[L].marker(svc))) write(`${svc}/${f}`, c);
    const list = [];
    const used = new Set();
    for (let i = 0; i < filesPerService; i++) {
      const entity = r.pick(ENTITIES);
      let mod = `${entity}_${r.pick(["service", "store", "rules", "mapper", "handler", "utils", "jobs", "policy"])}`;
      while (used.has(mod)) mod += "x";
      used.add(mod);
      const rel = srcPath(L, svc, mod);
      const buf = new FileBuf(L, rel);
      const hdr = fileHeader(L, svc, mod);
      buf.push(...hdr.open);
      const n = r.int(6, 14);
      const names = [];
      for (let k = 0; k < n; k++) {
        let nm;
        do {
          const ws = [r.pick(VERBS), ...words(r.pick(ENTITIES)), ...(r.chance(0.6) ? words(r.pick(QUALS)) : [])];
          nm = LANGS[L].name(ws);
        } while (names.includes(nm));
        names.push(nm);
      }
      names.forEach((nm, k) => {
        const callees = r.shuffle(names.filter((x, j) => j !== k)).slice(0, r.int(0, 2));
        if (L === "py" || L === "go") buf.push(...fillerFn(L, r, nm, callees, r.pick(ENTITIES)));
        else buf.push(...fillerFn(L, r, nm, callees, r.pick(ENTITIES)), "");
      });
      list.push({ rel, buf, lang: L, names, hdr, mod });
    }
    svcFiles.set(svc, list);
  }

  const tasks = [];
  const pickFile = (svc) => r.pick(svcFiles.get(svc));
  const svcsOf = (...langs) => SERVICE_PLAN.filter(([, L]) => langs.includes(L)).map(([s]) => s);

  // =========================================================================
  // 1. REUSE — mỗi session một hành vi riêng

  const behaviours = [];
  {
    let n = 0;
    const fees = [];
    for (const k of FEE_KINDS) for (const e of FEE_ENTITIES) fees.push(feeBehaviour(k, e, n++));
    const others = [];
    for (const p of PARTIES) others.push(...otherBehaviours(p, n++));
    // Xen kẽ để các loại hành vi trải đều
    const fr = r.shuffle(fees);
    const or = r.shuffle(others);
    while (fr.length || or.length) {
      if (fr.length) behaviours.push(fr.pop());
      if (fr.length) behaviours.push(fr.pop());
      if (or.length) behaviours.push(or.pop());
    }
  }
  const difficulties = ["easy", "synonym", "abbrev", "behaviour"];
  const reuseLangs = ["ts", "ts", "py", "go", "kt", "java", "swift", "rb", "js", "php"];
  for (let t = 0; t < total; t++) {
    const b = behaviours[t % behaviours.length];
    const round = Math.floor(t / behaviours.length);
    const difficulty = t % 10 === 9 ? "vietnamese" : difficulties[t % 4];
    const L = reuseLangs[t % reuseLangs.length];
    const svc = r.pick(svcsOf(L));
    const f = pickFile(svc);
    const variantWords = round > 0 ? ["v" + (round + 1)] : [];
    const nameWords = difficulty === "vietnamese" ? b.names[t % 2 ? "synonym" : "easy"] : b.names[difficulty];
    const fname = LANGS[L].name([...nameWords, ...variantWords]);
    const doc = difficulty === "easy" || difficulty === "synonym" || difficulty === "vietnamese" ? `${cap(b.description)}.` : undefined;
    const target = plantFunction(f, L, fname, b, doc, r);
    // Mồi nhử: tên giống, hành vi khác
    for (const d of b.decoys) {
      const df = pickFile(r.pick(svcsOf(r.pick(["ts", "py", "go", "java"]))));
      plantDecoy(df, df.lang, LANGS[df.lang].name([...d, ...variantWords, String(t)]), r);
    }
    const description = difficulty === "vietnamese" ? (VI[b.description] ?? b.description) : b.description;
    tasks.push({
      id: `reuse-${String(t + 1).padStart(3, "0")}`,
      type: "reuse",
      difficulty,
      language: L,
      description,
      prompt: `Before implementing "${description}", find an existing function in the repo that already does it.`,
      // Từ khóa mà một LLM tốt sẽ grep (kể cả đồng nghĩa, dịch tiếng Việt): cho agent không-MCP.
      llmKeywords: b.terms.map((w) => LLM_SYNONYMS[w] ?? [w]),
      // Danh từ đặc thù nhất của đề (LLM thường grep cái này trước).
      llmSpecific: LLM_SYNONYMS[b.specific] ?? [b.specific],
      englishQuery: b.description,
      draft: b.draft,
      behaviour: b.key,
      truth: [{ file: target.file, name: target.name, line: target.line }],
    });
  }
  // Cùng một hành vi cài ở nhiều task: mọi bản cài đều là đáp án đúng.
  const reuse = tasks.filter((t) => t.type === "reuse");
  for (const t of reuse) {
    const others = reuse.filter((o) => o !== t && o.behaviour === t.behaviour).map((o) => o.truth[0]);
    t.truth = [t.truth[0], ...others];
  }

  // =========================================================================
  // 2. CALLERS

  const callerLangs = ["ts", "ts", "ts", "ts", "py", "py", "py", "go", "go", "jvm"];
  for (let t = 0; t < total; t++) {
    const kind = callerLangs[t % callerLangs.length];
    const id = `callers-${String(t + 1).padStart(3, "0")}`;
    const ent = ENTITIES[t % ENTITIES.length];
    if (kind === "ts") tasks.push(plantTsCallers(id, t, ent, svcFiles, r, write));
    else if (kind === "py") tasks.push(plantPyCallers(id, t, ent, svcFiles, r));
    else if (kind === "go") tasks.push(plantGoCallers(id, t, ent, svcFiles, r, write));
    else tasks.push(plantJvmCallers(id, t, ent, svcFiles, r));
  }

  // =========================================================================
  // 3. SURVEY — khái niệm hai từ, không đụng từ vựng của code nhiễu

  const FIRST = ["packing", "grace", "loyalty", "tax", "retry", "fraud", "split", "credit", "dunning", "bundle", "pickup",
    "carbon", "gift", "backorder", "fx", "payout", "risk", "surge", "escrow", "layaway"];
  const SECOND = ["period", "tier", "region", "budget", "threshold", "window", "margin", "delay", "cap", "quota",
    "ratio", "floor", "ceiling", "bucket", "horizon"];
  const concepts = r.shuffle(FIRST.flatMap((a) => SECOND.map((b) => `${a} ${b}`))).slice(0, total);
  concepts.forEach((c, t) => tasks.push(plantSurvey(`survey-${String(t + 1).padStart(3, "0")}`, c, svcFiles, r)));

  // =========================================================================
  // 4. SESSION = một yêu cầu feature trọn vẹn: tái sử dụng + đổi signature + đổi hằng số + sửa code

  const sessionsList = [];
  const byType = (ty) => tasks.filter((x) => x.type === ty);
  const [R, C, S] = [byType("reuse"), byType("callers"), byType("survey")];
  const featureFileOf = (c) => c.truth.find((x) => x.file !== c.declFile)?.file ?? c.declFile;
  const promptOf = (n, rs, cs, ss, files) =>
    rs.map((rt, k) =>
      `Feature request #${n}${rs.length > 1 ? `.${k + 1}` : ""}: in ${files[k]}, add support for "${rt.description}". ` +
      `Reuse existing logic if the repo already has it. The change needs a new parameter on ${cs[k].symbol} ` +
      `(declared in ${cs[k].declFile}): update every caller. The "${ss[k].concept}" value also changes: ` +
      `update it everywhere it is defined, in every spelling.`).join("\n");
  for (let t = 0; t < sessions + largeSessions; t++) {
    const large = t >= sessions;
    const from = large ? sessions + (t - sessions) * perLarge : t;
    const n = large ? perLarge : 1;
    const rs = R.slice(from, from + n);
    const cs = C.slice(from, from + n);
    const ss = S.slice(from, from + n);
    const files = cs.map(featureFileOf);
    sessionsList.push({
      id: `${large ? "large" : "session"}-${String(large ? t - sessions + 1 : t + 1).padStart(3, "0")}`,
      size: large ? "large" : "standard",
      reuse: rs.map((x) => x.id),
      callers: cs.map((x) => x.id),
      survey: ss.map((x) => x.id),
      featureFiles: files,
      prompt: promptOf(t + 1, rs, cs, ss, files),
    });
  }

  // Ghi ra đĩa
  for (const list of svcFiles.values()) {
    for (const f of list) {
      f.buf.push(...f.hdr.close);
      write(f.rel, f.buf.text());
    }
  }
  let lines = 0;
  for (const [rel, content] of files) {
    const abs = join(out, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const text = typeof content === "string" ? content : content.text();
    lines += text.split("\n").length;
    writeFileSync(abs, text);
  }
  for (const task of tasks) {
    task.truth = dedupe(task.truth.map(resolveRef));
    if (typeof task.declLine === "object") task.declLine = task.declLine.buf.lineOf(task.declLine);
  }
  const meta = { seed, filesPerService, files: files.size, lines, services: SERVICE_PLAN.length, tasks: tasks.length, sessions: sessions, largeSessions, perLarge };
  writeFileSync(join(out, ".bench-tasks.json"), JSON.stringify({ meta, tasks, sessions: sessionsList }, null, 2));
  return { meta, tasks, sessions: sessionsList };
}

// ---------------------------------------------------------------------------
// Cài hàm mục tiêu cho reuse

function plantFunction(f, L, name, b, doc, r) {
  const buf = f.buf;
  const [h1, h2, h3] = b.helpers;
  const p = b.params;
  const w = b.bodyWords;
  const docLine = (pre) => (doc ? [`${pre} ${doc}`] : []);
  let start;
  const helperName = (h) => (L === "py" || L === "rb" ? snake(words(h)) : L === "go" ? pascal(words(h)) : h);
  const [a, bb, c] = [h1, h2, h3].map((h) => h && helperName(h));
  switch (L) {
    case "ts":
    case "js": {
      buf.push(...docLine("/**").map((l) => l + " */"));
      start = buf.line(`export function ${name}(${p.join(", ")}) {`);
      buf.push(`  const ${w[0]}Rate = ${a}(${p[0]}.zone, ${p[1] ?? "{}"});`, `  const ${w[1] ?? "base"} = ${p[0]}.${w[2] ?? "weight"} * ${w[0]}Rate;`,
        `  return ${bb ?? "Number"}(${c ? `${c}(${w[1] ?? "base"}, ${p[1] ?? 1})` : w[1] ?? "base"}, 2);`, "}", "");
      break;
    }
    case "py":
      start = buf.line(`def ${name}(${p.map((x) => snake(words(x))).join(", ")}):`);
      if (doc) buf.push(`    """${doc}"""`);
      buf.push(`    ${w[0]}_rate = ${a}(${snake(words(p[0]))}.zone, ${snake(words(p[1] ?? "x"))})`, `    ${w[1] ?? "base"} = ${snake(words(p[0]))}.${w[2] ?? "weight"} * ${w[0]}_rate`,
        `    return ${bb ?? "float"}(${c ? `${c}(${w[1] ?? "base"}, 1)` : w[1] ?? "base"}, 2)`, "");
      break;
    case "go":
      buf.push(...docLine("//"));
      start = buf.line(`func ${name}(${p.map((x) => `${x} map[string]float64`).join(", ")}) float64 {`);
      buf.push(`\t${w[0]}Rate := ${a}(${p[0]}["zone"], ${p[1] ?? p[0]})`, `\t${w[1] ?? "base"} := ${p[0]}["${w[2] ?? "weight"}"] * ${w[0]}Rate`,
        `\treturn ${bb ?? "float64"}(${c ? `${c}(${w[1] ?? "base"}, 1)` : w[1] ?? "base"}, 2)`, "}", "");
      break;
    case "java":
      buf.push(...docLine("  /**").map((l) => l + " */"));
      start = buf.line(`  public static double ${name}(${p.map((x) => `java.util.Map<String, Double> ${x}`).join(", ")}) {`);
      buf.push(`    double ${w[0]}Rate = ${a}(${p[0]}.get("zone"), ${p[1] ?? p[0]});`, `    double ${w[1] ?? "base"} = ${p[0]}.get("${w[2] ?? "weight"}") * ${w[0]}Rate;`,
        `    return ${bb ?? "Math.floor"}(${c ? `${c}(${w[1] ?? "base"}, 1)` : w[1] ?? "base"}, 2);`, "  }", "");
      break;
    case "kt":
      buf.push(...docLine("    /**").map((l) => l + " */"));
      start = buf.line(`    fun ${name}(${p.map((x) => `${x}: Map<String, Double>`).join(", ")}): Double {`);
      buf.push(`        val ${w[0]}Rate = ${a}(${p[0]}["zone"], ${p[1] ?? p[0]})`, `        val ${w[1] ?? "base"} = (${p[0]}["${w[2] ?? "weight"}"] ?: 0.0) * ${w[0]}Rate`,
        `        return ${bb ?? "Math.floor"}(${c ? `${c}(${w[1] ?? "base"}, 1.0)` : w[1] ?? "base"}, 2)`, "    }", "");
      break;
    case "swift":
      buf.push(...docLine("    ///"));
      start = buf.line(`    static func ${name}(${p.map((x) => `_ ${x}: [String: Double]`).join(", ")}) -> Double {`);
      buf.push(`        let ${w[0]}Rate = ${a}(${p[0]}["zone"], ${p[1] ?? p[0]})`, `        let ${w[1] ?? "base"} = (${p[0]}["${w[2] ?? "weight"}"] ?? 0) * ${w[0]}Rate`,
        `        return ${bb ?? "Double"}(${c ? `${c}(${w[1] ?? "base"}, 1)` : w[1] ?? "base"}, 2)`, "    }", "");
      break;
    case "rb":
      buf.push(...docLine("  #"));
      start = buf.line(`  def ${name}(${p.map((x) => snake(words(x))).join(", ")})`);
      buf.push(`    ${w[0]}_rate = ${a}(${snake(words(p[0]))}[:zone], ${snake(words(p[1] ?? p[0]))})`, `    ${w[1] ?? "base"} = ${snake(words(p[0]))}[:${w[2] ?? "weight"}] * ${w[0]}_rate`,
        `    ${bb ?? "Float"}(${c ? `${c}(${w[1] ?? "base"}, 1)` : w[1] ?? "base"}, 2)`, "  end", "");
      break;
    case "php":
      buf.push(...docLine("    /**").map((l) => l + " */"));
      start = buf.line(`    public function ${name}(${p.map((x) => `$${x}`).join(", ")}) {`);
      buf.push(`        $${w[0]}Rate = $this->${a}($${p[0]}['zone'], $${p[1] ?? p[0]});`, `        $${w[1] ?? "base"} = $${p[0]}['${w[2] ?? "weight"}'] * $${w[0]}Rate;`,
        `        return $this->${bb ?? "floor"}(${c ? `$this->${c}($${w[1] ?? "base"}, 1)` : `$${w[1] ?? "base"}`}, 2);`, "    }", "");
      break;
  }
  const qual = ["java", "kt", "swift", "rb", "php"].includes(L) ? `${f.hdr.cls}.` : "";
  return { file: f.rel, name: qual + name, line: start };
}

function plantDecoy(f, L, name, r) {
  const filler = fillerFn(L, r, name, [], r.pick(ENTITIES));
  f.buf.push(...filler, "");
}

// ---------------------------------------------------------------------------
// Callers: TypeScript

function plantTsCallers(id, t, ent, svcFiles, r, write) {
  const fname = camel(["apply", ent, "adjustment", "v" + t]);
  const asMethod = t % 3 === 1;
  const cls = pascal([ent, "pricer", "v" + t]);
  const other = pascal([ent, "estimator", "v" + t]);
  const mod = `adjust_${ent}_${t}`;
  const pkgRel = `packages/shared/src/${mod}.ts`;
  const truth = [];
  const decl = new FileBuf("ts", pkgRel);
  decl.push(`/** Applies the ${ent} adjustment. */`);
  let declLine;
  if (asMethod) {
    decl.push(`export class ${cls} {`);
    declLine = decl.line(`  ${fname}(amount: number, pct: number): number {`);
    decl.push(`    return amount * (1 + pct);`, `  }`, `}`, `export class ${other} {`, `  ${fname}(amount: number): number {`, `    return amount;`, `  }`, `}`);
  } else {
    declLine = decl.line(`export function ${fname}(amount: number, pct: number): number {`);
    decl.push(`  return amount * (1 + pct);`, `}`);
  }
  // Callers inside the same package file
  if (!asMethod) {
    decl.push(`export function ${fname}Twice(amount: number) {`);
    truth.push({ file: pkgRel, line: decl.line(`  return ${fname}(${fname}(amount, 0.1), 0.1);`) });
    decl.push(`}`);
  }
  write(pkgRel, decl);
  // Re-export alias through the package index
  const alias = camel(["adjust", ent, "v" + t]);
  write(`packages/shared/src/index_${t}.ts`, `export { ${asMethod ? cls : fname}${asMethod ? "" : ` as ${alias}`} } from "./${mod}";\n`);

  const tsSvcs = SERVICE_PLAN.filter(([s, L]) => L === "ts" && !s.startsWith("packages")).map(([s]) => s);
  const shapes = asMethod
    ? ["typed", "typed", "other", "typed-new", "untyped-js", "comment", "dynamic"]
    : ["named", "alias", "namespace", "reexport", "callback", "dynamic", "comment", "shadow", "string", "vue", "named"];
  const nSites = r.int(5, shapes.length);
  const used = r.shuffle(shapes).slice(0, nSites);
  if (!asMethod && !used.includes("named")) used.push("named");
  const taken = new Set();
  for (const shape of used) {
    const svc = r.pick(tsSvcs);
    let f;
    do f = r.pick(svcFiles.get(svc)); while (taken.has(f.rel));
    taken.add(f.rel);
    const b = f.buf;
    const imp = (line) => b.unshift(line); // imports lên đầu file
    const fn = camel(["use", ent, shape.replace(/-/g, ""), "v" + t]);
    const shiftTruth = () => {};
    switch (shape) {
      case "named":
        shiftTruth(); imp(`import { ${fname} } from "@repo/shared/${mod}";`);
        b.push(`export function ${fn}(x: number) {`); truth.push({ file: f.rel, line: b.line(`  return ${fname}(x, 0.2);`) }); b.push(`}`, "");
        break;
      case "alias":
        shiftTruth(); imp(`import { ${fname} as adj${t} } from "@repo/shared/${mod}";`);
        b.push(`export function ${fn}(x: number) {`); truth.push({ file: f.rel, line: b.line(`  return adj${t}(x, 0.3);`) }); b.push(`}`, "");
        break;
      case "namespace":
        shiftTruth(); imp(`import * as adjNs${t} from "@repo/shared/${mod}";`);
        b.push(`export function ${fn}(x: number) {`); truth.push({ file: f.rel, line: b.line(`  return adjNs${t}.${fname}(x, 0.4);`) }); b.push(`}`, "");
        break;
      case "reexport":
        shiftTruth(); imp(`import { ${alias} } from "@repo/shared/index_${t}";`);
        b.push(`export function ${fn}(x: number) {`); truth.push({ file: f.rel, line: b.line(`  return ${alias}(x, 0.5);`) }); b.push(`}`, "");
        break;
      case "callback":
        shiftTruth(); imp(`import { ${fname} as cb${t} } from "@repo/shared/${mod}";`);
        b.push(`export function ${fn}(xs: number[]) {`); truth.push({ file: f.rel, line: b.line(`  return xs.map((x) => x).reduce(cb${t}, 0);`) }); b.push(`}`, "");
        break;
      case "dynamic":
        shiftTruth(); imp(`import * as dyn${t} from "@repo/shared/${mod}";`);
        b.push(`export function ${fn}(x: number) {`);
        if (asMethod) {
          b.push(`  const p = new dyn${t}.${cls}();`);
          truth.push({ file: f.rel, line: b.line(`  return (p as any)["${fname}"](x, 0.6);`) });
        } else truth.push({ file: f.rel, line: b.line(`  return (dyn${t} as any)["${fname}"](x, 0.6);`) });
        b.push(`}`, "");
        break;
      case "comment":
        b.push(`// TODO: replace with ${fname}(x, pct) once the rule is shared`, "");
        break;
      case "shadow":
        // Một hàm cục bộ trùng tên: gọi nó KHÔNG phải gọi hàm mục tiêu.
        b.push(`function ${fname}(v: number) { return v; }`, `export function ${fn}(x: number) {`, `  return ${fname}(x);`, `}`, "");
        break;
      case "string":
        b.push(`export const ${fn} = "${fname} failed for ${ent}";`, "");
        break;
      case "vue": {
        const vrel = `services/catalog-api/src/components/${pascal([ent, "panel", "v" + t])}.vue`;
        const v = new FileBuf("vue", vrel);
        v.push("<template>");
        truth.push({ file: vrel, line: v.line(`  <span>{{ ${fname}(price, 0.1) }}</span>`) });
        v.push("</template>", "", `<script setup lang="ts">`, `import { ${fname} } from "@repo/shared/${mod}";`, "const price = 10;", "</script>");
        write(vrel, v);
        break;
      }
      case "typed":
        shiftTruth(); imp(`import { ${cls} } from "@repo/shared/${mod}";`);
        b.push(`export function ${fn}(p: ${cls}, x: number) {`); truth.push({ file: f.rel, line: b.line(`  return p.${fname}(x, 0.1);`) }); b.push(`}`, "");
        break;
      case "typed-new":
        shiftTruth(); imp(`import { ${cls} } from "@repo/shared/${mod}";`);
        b.push(`export function ${fn}(x: number) {`, `  const p = new ${cls}();`); truth.push({ file: f.rel, line: b.line(`  return p.${fname}(x, 0.2);`) }); b.push(`}`, "");
        break;
      case "other":
        shiftTruth(); imp(`import { ${other} } from "@repo/shared/${mod}";`);
        b.push(`export function ${fn}(e: ${other}, x: number) {`, `  return e.${fname}(x);`, `}`, "");
        break;
      case "untyped-js": {
        const js = r.pick(svcFiles.get("services/admin-api"));
        // Receiver không có kiểu trong JS: đúng là gọi lớp mục tiêu (đáp án), nhưng không chứng minh được bằng type.
        js.buf.push(`export function ${fn}(pricer, x) {`);
        truth.push({ file: js.rel, line: js.buf.line(`  return pricer.${fname}(x, 0.3);`) });
        js.buf.push(`}`, "");
        break;
      }
    }
  }
  return {
    id,
    type: "callers",
    language: "typescript",
    symbol: asMethod ? `${cls}.${fname}` : fname,
    declFile: pkgRel,
    declLine,
    prompt: `I want to add a parameter to ${asMethod ? `${cls}.${fname}` : fname} (declared in ${pkgRel}). Find every call site and reference that must be updated.`,
    shapes: used,
    truth: dedupe(truth),
  };
}

function dedupe(xs) {
  const seen = new Set();
  return xs.filter((x) => {
    // Chưa resolve thì dùng chính object tham chiếu làm khóa (mỗi dòng một object).
    const k = typeof x.line === "object" ? x.line : `${x.file}:${x.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Callers: Python

function plantPyCallers(id, t, ent, svcFiles, r) {
  const fname = snake(["recalc", ent, "score", "v" + String(t)]);
  const libFile = svcFiles.get("libs/py_common")[t % svcFiles.get("libs/py_common").length];
  const modName = libFile.rel.split("/").pop().replace(/\.py$/, "");
  const pkg = libFile.rel.split("/").slice(-2, -1)[0];
  const b = libFile.buf;
  const cls = pascal([ent, "scorer", "v" + t]);
  const other = pascal([ent, "ranker", "v" + t]);
  const truth = [];
  const asMethod = t % 2 === 1;
  let declLine;
  if (asMethod) {
    b.push(`class ${cls}:`);
    declLine = b.line(`    def ${fname}(self, value):`);
    b.push(`        return value * 2`, ``, `    def refresh(self, value):`);
    truth.push({ file: libFile.rel, line: b.line(`        return self.${fname}(value)`) });
    b.push(``, `class ${other}:`, `    def ${fname}(self, value):`, `        return value`, ``);
  } else {
    declLine = b.line(`def ${fname}(value):`);
    b.push(`    return value * 2`, ``, `def ${fname}_all(values):`);
    truth.push({ file: libFile.rel, line: b.line(`    return [${fname}(v) for v in values]`) });
    b.push(``);
  }
  const pySvcs = SERVICE_PLAN.filter(([s, L]) => L === "py" && s.startsWith("services")).map(([s]) => s);
  const shapes = asMethod ? ["typed", "typed", "ctor", "other", "getattr"] : ["from", "from", "module-alias", "dotted", "getattr", "comment", "shadow"];
  for (const shape of r.shuffle(shapes).slice(0, r.int(3, shapes.length))) {
    const f = r.pick(svcFiles.get(r.pick(pySvcs)));
    const fb = f.buf;
    const top = (l) => fb.unshift(l);
    const fn = snake(["use", ent, shape.replace(/-/g, "_"), "v" + t]);
    switch (shape) {
      case "from":
        top(`from ${pkg}.${modName} import ${fname}`);
        fb.push(`def ${fn}(x):`); truth.push({ file: f.rel, line: fb.line(`    return ${fname}(x)`) }); fb.push("");
        break;
      case "module-alias":
        top(`from ${pkg} import ${modName} as m${t}`);
        fb.push(`def ${fn}(x):`); truth.push({ file: f.rel, line: fb.line(`    return m${t}.${fname}(x)`) }); fb.push("");
        break;
      case "dotted":
        top(`import ${pkg}.${modName}`);
        fb.push(`def ${fn}(x):`); truth.push({ file: f.rel, line: fb.line(`    return ${pkg}.${modName}.${fname}(x)`) }); fb.push("");
        break;
      case "getattr":
        top(`from ${pkg} import ${modName}`);
        fb.push(`def ${fn}(x):`);
        if (asMethod) {
          fb.push(`    s = ${modName}.${cls}()`);
          truth.push({ file: f.rel, line: fb.line(`    return getattr(s, "${fname}")(x)`) });
        } else truth.push({ file: f.rel, line: fb.line(`    return getattr(${modName}, "${fname}")(x)`) });
        fb.push("");
        break;
      case "comment":
        fb.push(`# ${fname}(x) is applied upstream`, "");
        break;
      case "shadow":
        fb.push(`def ${fname}(x):`, `    return x`, ``, `def ${fn}(x):`, `    return ${fname}(x)`, ``);
        break;
      case "typed":
        top(`from ${pkg}.${modName} import ${cls}`);
        fb.push(`def ${fn}(s: ${cls}, x):`); truth.push({ file: f.rel, line: fb.line(`    return s.${fname}(x)`) }); fb.push("");
        break;
      case "ctor":
        top(`from ${pkg}.${modName} import ${cls}`);
        fb.push(`def ${fn}(x):`, `    s = ${cls}()`); truth.push({ file: f.rel, line: fb.line(`    return s.${fname}(x)`) }); fb.push("");
        break;
      case "other":
        top(`from ${pkg}.${modName} import ${other}`);
        fb.push(`def ${fn}(x):`, `    k = ${other}()`, `    return k.${fname}(x)`, "");
        break;
    }
  }
  return {
    id, type: "callers", language: "python",
    symbol: asMethod ? `${cls}.${fname}` : fname, declFile: libFile.rel, declLine,
    prompt: `I want to change the signature of ${asMethod ? `${cls}.${fname}` : fname} (in ${libFile.rel}). Find every call site.`,
    truth: dedupe(truth),
  };
}

// ---------------------------------------------------------------------------
// Callers: Go

function plantGoCallers(id, t, ent, svcFiles, r, write) {
  const fname = pascal(["normalize", ent, "code", "v" + t]);
  const pkgDir = `libs/go-common/codes${t}`;
  const rel = `${pkgDir}/codes${t}.go`;
  const b = new FileBuf("go", rel);
  b.push(`package codes${t}`, "", `// ${fname} normalizes a ${ent} code.`);
  const declLine = b.line(`func ${fname}(code string) string {`);
  b.push(`\treturn code`, `}`, "", `func ${fname}All(codes []string) []string {`, `\tout := []string{}`, `\tfor _, c := range codes {`);
  const truth = [{ file: rel, line: b.line(`\t\tout = append(out, ${fname}(c))`) }];
  b.push(`\t}`, `\treturn out`, `}`);
  write(rel, b);
  // Một package khác có hàm trùng tên (mồi nhử)
  const drel = `libs/go-common/legacy${t}/legacy${t}.go`;
  write(drel, `package legacy${t}\n\nfunc ${fname}(code string) string {\n\treturn code + "!"\n}\n`);
  const goSvcs = SERVICE_PLAN.filter(([s, L]) => L === "go" && s.startsWith("services")).map(([s]) => s);
  for (const shape of r.shuffle(["plain", "alias", "plain", "decoy", "decoy"]).slice(0, r.int(3, 5))) {
    const f = r.pick(svcFiles.get(r.pick(goSvcs)));
    const fb = f.buf;
    // import ngay sau dòng package
    const addImport = (l) => fb.insertAt(1, l);
    const fn = pascal(["use", ent, shape, "v" + t]);
    if (shape === "plain") {
      addImport(`import "shop/common/codes${t}"`);
      fb.push(`func ${fn}(c string) string {`); truth.push({ file: f.rel, line: fb.line(`\treturn codes${t}.${fname}(c)`) }); fb.push(`}`, "");
    } else if (shape === "alias") {
      addImport(`import nc${t} "shop/common/codes${t}"`);
      fb.push(`func ${fn}(c string) string {`); truth.push({ file: f.rel, line: fb.line(`\treturn nc${t}.${fname}(c)`) }); fb.push(`}`, "");
    } else {
      addImport(`import "shop/common/legacy${t}"`);
      fb.push(`func ${fn}(c string) string {`, `\treturn legacy${t}.${fname}(c)`, `}`, "");
    }
  }
  return {
    id, type: "callers", language: "go", symbol: fname, declFile: rel, declLine,
    prompt: `I want to change ${fname} in ${rel}. Find every call site (not the legacy package's function of the same name).`,
    truth: dedupe(truth),
  };
}

// ---------------------------------------------------------------------------
// Callers: Java + Kotlin

function plantJvmCallers(id, t, ent, svcFiles, r) {
  const fname = camel(["convert", ent, "units", "v" + t]);
  const lib = svcFiles.get("libs/jvm-common")[t % svcFiles.get("libs/jvm-common").length];
  const cls = lib.hdr.cls;
  const b = lib.buf;
  const declLine = b.line(`  public static double ${fname}(double v) { return v * 2; }`);
  b.push("");
  const truth = [];
  const otherCls = pascal([ent, "legacy", "v" + t]);
  // Một lớp khác cùng tên method (mồi nhử) trong ledger
  const led = r.pick(svcFiles.get("services/ledger"));
  led.buf.push(`  static class ${otherCls} { double ${fname}(double v) { return v; } }`, "");
  const shapes = ["java-static", "java-static", "kt-static", "kt-static", "decoy"];
  for (const shape of r.shuffle(shapes).slice(0, r.int(3, 5))) {
    if (shape.startsWith("java") || shape === "decoy") {
      const f = r.pick(svcFiles.get(r.pick(["services/ledger", "services/loyalty"])));
      const fn = camel(["use", ent, shape.replace(/-/g, ""), "v" + t]);
      f.buf.push(`  public static double ${fn}(double v) {`);
      if (shape === "decoy") f.buf.push(`    ${otherCls} o = new ${otherCls}();`, `    return o.${fname}(v);`);
      else truth.push({ file: f.rel, line: f.buf.line(`    return shop.${cls}.${fname}(v);`.replace(`shop.${cls}`, cls)) });
      f.buf.push(`  }`, "");
    } else {
      const f = r.pick(svcFiles.get(r.pick(["services/android-app", "services/partner-sync"])));
      const fn = camel(["use", ent, "kt", "v" + t]);
      f.buf.push(`    fun ${fn}(v: Double): Double {`);
      truth.push({ file: f.rel, line: f.buf.line(`        return ${cls}.${fname}(v)`) });
      f.buf.push(`    }`, "");
    }
  }
  return {
    id, type: "callers", language: "java", symbol: `${cls}.${fname}`, declFile: lib.rel, declLine,
    prompt: `I want to change ${cls}.${fname} (in ${lib.rel}). Find every call site in Java and Kotlin.`,
    truth: dedupe(truth),
  };
}

// ---------------------------------------------------------------------------
// Survey

function plantSurvey(id, concept, svcFiles, r) {
  const ws = words(concept);
  const spellings = { snake: snake(ws), camel: camel(ws), upper: snake(ws).toUpperCase(), pascal: pascal(ws) };
  const truthFiles = new Set();
  const all = [...svcFiles.values()].flat();
  const n = r.int(5, 14);
  for (const f of r.shuffle(all).slice(0, n)) {
    const L = f.lang;
    const sp = L === "py" || L === "rb" ? r.pick([spellings.snake, spellings.upper]) : L === "go" ? r.pick([spellings.pascal, spellings.camel]) : r.pick([spellings.camel, spellings.upper]);
    const v = r.int(1, 99);
    const line =
      L === "py" ? `${sp} = ${v}` : L === "rb" ? `  ${sp.toUpperCase()} = ${v}` : L === "go" ? `var ${sp} = ${v}` :
      L === "java" ? `  static final int ${sp} = ${v};` : L === "kt" ? `    val ${sp} = ${v}` : L === "swift" ? `    static let ${sp} = ${v}` :
      L === "php" ? `    const ${sp.toUpperCase()} = ${v};` : `export const ${sp} = ${v};`;
    f.buf.push(line, "");
    truthFiles.add(f.rel);
  }
  // Nhắc trong comment (không phải dùng trong code)
  for (const f of r.shuffle(all).slice(0, 3)) {
    const c = ["py", "rb"].includes(f.lang) ? "#" : "//";
    if (f.lang === "php" || f.lang === "java" || f.lang === "kt" || f.lang === "swift") f.buf.push(`    ${c} see ${concept} rules`, "");
    else f.buf.push(`${c} ${spellings.camel} is configured elsewhere`, "");
  }
  const pattern = `${ws.join("[_ -]?")}`;
  return {
    id, type: "survey", concept,
    prompt: `I want to change the ${concept} rule. Map every constant and usage across the repo, in every spelling.`,
    pattern,
    truth: [...truthFiles].map((file) => ({ file })),
  };
}

// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const out = arg("out");
  if (!out) {
    console.error("usage: node bench/generate.mjs --out <dir> [--seed 42] [--files-per-service 90]");
    process.exit(2);
  }
  const { meta } = generate({
    out, seed: Number(arg("seed", 42)), filesPerService: Number(arg("files-per-service", 90)),
    sessions: Number(arg("sessions", 100)), largeSessions: Number(arg("large-sessions", 50)), perLarge: Number(arg("per-large", 3)),
  });
  console.log(JSON.stringify(meta));
}

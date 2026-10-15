// Sinh một monorepo nhiều service, có seed, để đo spec_nav_trace_flow. Bộ sinh
// tự ghi đáp án cho từng điểm gọi (link tới handler nào, hay phải là
// ambiguous / partial / unresolved / unmatched), tính từ bảng route nó vừa
// sinh — không từ output của tool.
//
// Từ vựng, cách mount/prefix và cách dựng URL ở đây khác với fixture trong
// test/flow-fixtures.mjs: test dùng để phát triển, bộ này để đánh giá.
import { rng } from "./generate.mjs";

const NOUNS = ["invoice", "shipment", "ticket", "profile", "coupon", "warehouse", "lease", "quote", "badge", "tenant",
  "meter", "parcel", "payout", "driver", "voucher", "slot", "review", "plan", "seat", "claim"];
const SUBS = ["history", "status", "items", "notes", "summary", "audit"];
const VERBS = ["issued", "voided", "settled", "assigned", "expired", "approved"];
const METHODS = ["GET", "GET", "POST", "PUT", "DELETE"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export function generateFlowRepo({ seed, services: nServices = 12, routesPerService = 6, callsPerService = 6, topics: nTopics = 6 }) {
  const r = rng(seed);
  const files = new Map(); // rel → string[]
  const add = (rel, lines) => {
    const cur = files.get(rel) ?? [];
    const start = cur.length + 1;
    cur.push(...lines);
    files.set(rel, cur);
    return start;
  };
  const truth = [];
  /** For the name-only baseline: every consumer of a topic name and handler of a pattern, whatever cluster or service. */
  const byName = { topics: {}, patterns: {} };

  // --- services ------------------------------------------------------------
  const used = new Set();
  const services = [];
  for (let i = 0; i < nServices; i++) {
    let noun;
    do noun = r.pick(NOUNS) + (i >= NOUNS.length ? i : ""); while (used.has(noun));
    used.add(noun);
    const lang = r.chance(0.35) ? "py" : "ts";
    const fw = lang === "py" ? r.pick(["fastapi", "flask"]) : r.pick(["express", "express", "nest", "fastify"]);
    const name = `${noun}-svc`;
    services.push({
      i, noun, name, lang, fw, dir: `services/${name}`, port: 8100 + i * 3,
      compose: r.chance(0.7) ? r.pick([name, `${noun}-api`, noun]) : undefined,
      prefix: fw === "nest" ? `/api/${noun}s` : fw === "express" ? r.pick(["/v1", "/api", "/v2"]) : fw === "fastify" ? r.pick(["/public", "/v1"]) : "",
      innerPrefix: fw === "fastapi" ? r.pick(["/api", "/v1"]) : fw === "flask" ? r.pick(["/api", "/svc"]) : "",
      routes: [],
      twins: [],
      cluster: undefined,
    });
  }

  // --- routes --------------------------------------------------------------
  const allRoutes = [];
  const canon = (segs) => "/" + segs.map((s) => (s.p ? ":" : s.v)).join("/");
  for (const s of services) {
    const seen = new Set();
    for (let k = 0; k < routesPerService; k++) {
      const noun = r.pick(NOUNS);
      const shape = r.int(0, 2);
      const segs = [{ v: `${noun}s` }, ...(shape >= 1 ? [{ p: "id" }] : []), ...(shape === 2 ? [{ v: r.pick(SUBS) }] : [])];
      const method = r.pick(METHODS);
      const local = segs;
      const full = [...pathSegs(s.prefix), ...pathSegs(s.innerPrefix), ...local];
      const key = `${method} ${canon(full)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = `${cap(noun)}${cap(method.toLowerCase())}${k}`;
      const handler = s.lang === "py" ? `handle_${snake(base)}` : s.fw === "nest" ? `handle${base}` : `handle${base}`;
      const route = { service: s, method, local, full, canon: canon(full), handler, twin: false };
      s.routes.push(route);
      allRoutes.push(route);
    }
  }
  // Twins: the same method and full path in a second service — a name alone does not tell them apart.
  const twinHosts = services.filter((s) => s.fw !== "nest");
  for (const orig of [...allRoutes]) {
    if (!r.chance(0.18)) continue;
    const host = r.pick(twinHosts.filter((s) => s !== orig.service));
    if (!host || host.routes.some((x) => x.method === orig.method && x.canon === orig.canon)) continue;
    const handler = host.lang === "py" ? `twin_${snake(orig.handler.replace(/^handle_?/, ""))}_${host.i}` : `twin${orig.handler.replace(/^handle/, "")}${host.i}`;
    const t = { service: host, method: orig.method, local: orig.full, full: orig.full, canon: orig.canon, handler, twin: true };
    host.routes.push(t);
    allRoutes.push(t);
  }

  // --- server code -------------------------------------------------------------
  const handlerLoc = new Map(); // route → "file::label"
  for (const s of services) emitServer(s);

  function paramText(seg, fw) {
    if (!seg.p) return seg.v;
    return fw === "fastapi" ? `{${seg.p}}` : fw === "flask" ? `<${seg.p}>` : `:${seg.p}`;
  }
  function pathText(segs, fw) {
    return "/" + segs.map((x) => paramText(x, fw)).join("/");
  }

  function emitServer(s) {
    const d = s.dir;
    if (s.lang === "ts") files.set(`${d}/package.json`, [JSON.stringify({ name: s.name })]);
    else files.set(`${d}/requirements.txt`, [""]);
    const own = s.routes.filter((x) => !x.twin);
    const twins = s.routes.filter((x) => x.twin);
    if (s.fw === "express") {
      const named = r.chance(0.5);
      add(`${d}/src/handlers.ts`, s.routes.flatMap((x) => [`export async function ${x.handler}(req: any, res: any) {`, "  res.json({});", "}"]));
      for (const x of s.routes) handlerLoc.set(x, `${d}/src/handlers.ts::${x.handler}`);
      add(`${d}/src/routes.ts`, [
        'import { Router } from "express";',
        named ? `import { ${own.map((x) => x.handler).join(", ") || "x"} } from "./handlers";` : 'import * as h from "./handlers";',
        "const router = Router();",
        ...own.map((x) => `router.${x.method.toLowerCase()}("${pathText(x.local, "express")}", ${named ? "" : "h."}${x.handler});`),
        "export default router;",
      ]);
      add(`${d}/src/app.ts`, [
        'import express from "express";',
        'import router from "./routes";',
        ...(twins.length ? [`import { ${twins.map((x) => x.handler).join(", ")} } from "./handlers";`] : []),
        "const app = express();",
        `app.use("${s.prefix}", router);`,
        ...twins.map((x) => `app.${x.method.toLowerCase()}("${pathText(x.full, "express")}", ${x.handler});`),
        `app.listen(${s.port});`,
      ]);
    } else if (s.fw === "nest") {
      const ctrl = `${cap(s.noun)}Controller`;
      add(`${d}/src/main.ts`, [
        'import { NestFactory } from "@nestjs/core";',
        'import { AppModule } from "./app.module";',
        "async function bootstrap() {",
        "  const app = await NestFactory.create(AppModule);",
        '  app.setGlobalPrefix("api");',
        `  await app.listen(${s.port});`,
        "}",
        "bootstrap();",
      ]);
      const deco = { GET: "Get", POST: "Post", PUT: "Put", DELETE: "Delete" };
      add(`${d}/src/${s.noun}.controller.ts`, [
        'import { Controller, Get, Post, Put, Delete } from "@nestjs/common";',
        `@Controller("${s.noun}s")`,
        `export class ${ctrl} {`,
        ...own.flatMap((x) => {
          const p = pathText(x.local, "nest").slice(1);
          return [`  @${deco[x.method]}(${p ? `"${p}"` : ""})`, `  ${x.handler}() {`, "    return {};", "  }"];
        }),
        "}",
      ]);
      for (const x of own) handlerLoc.set(x, `${d}/src/${s.noun}.controller.ts::${ctrl}.${x.handler}`);
    } else if (s.fw === "fastify") {
      add(`${d}/src/routes.ts`, [
        'import { FastifyInstance } from "fastify";',
        "export default async function routes(fastify: FastifyInstance) {",
        ...own.map((x) => `  fastify.${x.method.toLowerCase()}("${pathText(x.local, "fastify")}", ${x.handler});`),
        "}",
        ...own.flatMap((x) => [`export async function ${x.handler}() {`, "  return {};", "}"]),
      ]);
      for (const x of own) handlerLoc.set(x, `${d}/src/routes.ts::${x.handler}`);
      add(`${d}/src/app.ts`, [
        'import Fastify from "fastify";',
        'import routes from "./routes";',
        "const app = Fastify();",
        `app.register(routes, { prefix: "${s.prefix}" });`,
        ...twins.map((x) => `app.${x.method.toLowerCase()}("${pathText(x.full, "fastify")}", ${x.handler});`),
        ...twins.flatMap((x) => [`async function ${x.handler}() {`, "  return {};", "}"]),
        `app.listen({ port: ${s.port} });`,
      ]);
      for (const x of twins) handlerLoc.set(x, `${d}/src/app.ts::${x.handler}`);
    } else if (s.fw === "fastapi") {
      files.set(`${d}/app/__init__.py`, [""]);
      add(`${d}/app/routes.py`, [
        "from fastapi import APIRouter",
        `router = APIRouter(prefix="${s.innerPrefix}")`,
        "",
        ...own.flatMap((x) => [`@router.${x.method.toLowerCase()}("${pathText(x.local, "fastapi")}")`, `def ${x.handler}(${x.local.some((g) => g.p) ? "id: str" : ""}):`, "    return {}", ""]),
      ]);
      for (const x of own) handlerLoc.set(x, `${d}/app/routes.py::${x.handler}`);
      add(`${d}/app/main.py`, [
        "import uvicorn",
        "from fastapi import FastAPI",
        "from .routes import router",
        "app = FastAPI()",
        `app.include_router(router${s.prefix ? `, prefix="${s.prefix}"` : ""})`,
        "",
        ...twins.flatMap((x) => [`@app.${x.method.toLowerCase()}("${pathText(x.full, "fastapi")}")`, `def ${x.handler}():`, "    return {}", ""]),
        'if __name__ == "__main__":',
        `    uvicorn.run(app, port=${s.port})`,
      ]);
      for (const x of twins) handlerLoc.set(x, `${d}/app/main.py::${x.handler}`);
    } else {
      const lines = [
        "from flask import Flask, Blueprint",
        "app = Flask(__name__)",
        `bp = Blueprint("${s.noun}", __name__, url_prefix="${s.innerPrefix}")`,
        "",
      ];
      for (const x of own) {
        lines.push(`@bp.route("${pathText(x.local, "flask")}", methods=["${x.method}"])`, `def ${x.handler}(${x.local.some((g) => g.p) ? "id" : ""}):`, "    return {}", "");
      }
      for (const x of twins) {
        lines.push(`@app.route("${pathText(x.full, "flask")}", methods=["${x.method}"])`, `def ${x.handler}(${x.full.some((g) => g.p) ? "id" : ""}):`, "    return {}", "");
      }
      lines.push(`app.register_blueprint(bp)`, `app.run(port=${s.port})`);
      add(`${d}/app.py`, lines);
      for (const x of s.routes) handlerLoc.set(x, `${d}/app.py::${x.handler}`);
    }
  }

  // --- HTTP clients --------------------------------------------------------------
  const compose = ["services:"];
  for (const s of services) {
    if (!s.compose) continue;
    compose.push(`  ${s.compose}:`, `    build: ./${s.dir}`, "    ports:", `      - "${s.port + 1000}:${s.port}"`);
  }
  files.set("docker-compose.yml", compose);

  const routesFor = (method, c) => allRoutes.filter((x) => x.method === method && x.canon === c);
  for (const s of services) {
    const clientFile = s.lang === "ts" ? `${s.dir}/src/clients.ts` : s.fw === "fastapi" ? `${s.dir}/app/clients.py` : `${s.dir}/clients.py`;
    const configFile = s.lang === "ts" ? `${s.dir}/src/config.ts` : s.fw === "fastapi" ? `${s.dir}/app/config.py` : `${s.dir}/config.py`;
    const httpFile = `${s.dir}/src/http.ts`;
    const head = s.lang === "ts" ? ['import axios from "axios";'] : ["import os", "import requests", "import httpx"];
    const imports = new Set();
    const body = [];
    const instances = new Map();
    const configs = new Map();
    const pending = []; // { lineOffset, truth }
    let n = 0;
    let wrapper = false;

    const others = allRoutes.filter((x) => x.service !== s);
    for (let k = 0; k < callsPerService && others.length; k++) {
      const t = r.pick(others);
      const target = t.service;
      const styles = [
        ...(target.compose ? ["compose", "compose"] : []), "port",
        ...(s.lang === "ts" ? ["relative"] : []), "env",
      ];
      const hostStyle = r.pick(styles);
      // "wrapper" (TS) and "urljoin" (Python) are real-world shapes the adapters do not follow: the
      // expected outcome is still the true target, so they count against recall.
      const build = r.chance(0.15) ? (s.lang === "ts" ? "wrapper" : "urljoin") : r.pick(["template", "concat", "constfile", "instance"]);
      const fn = s.lang === "ts" ? `call${cap(target.noun)}${n}` : `call_${target.noun.replace(/\d+$/, "")}_${n}`;
      n++;
      const hasParam = t.full.some((g) => g.p);
      const base = hostStyle === "compose" ? `http://${target.compose}:${target.port}` : hostStyle === "port" ? `http://localhost:${target.port}` : hostStyle === "relative" ? "" : undefined;
      const envName = `${target.noun.toUpperCase()}_URL`;
      const pathParts = t.full.map((g) => (g.p ? null : g.v));
      const m = t.method.toLowerCase();
      let lines;
      if (s.lang === "ts") {
        const baseExpr = base === undefined ? `process.env.${envName}` : JSON.stringify(base);
        const tpl = "/" + pathParts.map((p) => (p === null ? "${id}" : p)).join("/");
        const concatPath = pathParts.map((p) => (p === null ? '"/" + id' : `"/${p}"`)).join(" + ");
        let call;
        if (build === "wrapper") {
          wrapper = true;
          const url = base === "" ? `\`${tpl}\`` : `\`\${${base === undefined ? `process.env.${envName}` : JSON.stringify(base)}}${tpl}\``;
          call = `request("${t.method}", ${url})`;
        } else if (build === "instance" && base !== "") {
          const inst = `${target.noun}${hostStyle === "env" ? "Env" : cap(hostStyle)}Api`;
          if (!instances.has(inst)) instances.set(inst, `export const ${inst} = axios.create({ baseURL: ${baseExpr} });`);
          imports.add(`import { ${inst} } from "./http";`);
          call = `${inst}.${m}(\`${tpl}\`)`;
        } else {
          let baseRef = base === undefined ? `process.env.${envName}` : JSON.stringify(base);
          if (build === "constfile" && base !== "") {
            const cname = `${target.noun.toUpperCase()}_${hostStyle.toUpperCase()}_BASE`;
            configs.set(cname, `export const ${cname} = ${baseExpr};`);
            baseRef = cname;
          }
          const url = build === "concat"
            ? (base === "" ? concatPath : `${baseRef} + ${concatPath}`)
            : base === "" ? `\`${tpl}\`` : `\`\${${baseRef}}${tpl}\``;
          call = r.chance(0.5) || t.method === "GET"
            ? `fetch(${url}${t.method === "GET" ? "" : `, { method: "${t.method}" }`})`
            : `axios.${m}(${url})`;
        }
        lines = [`export async function ${fn}(id: string) {`, `  return ${call};`, "}"];
      } else {
        const fpath = "/" + pathParts.map((p) => (p === null ? "{id}" : p)).join("/");
        const lib = r.pick(["requests", "httpx"]);
        let baseRef;
        if (base === undefined) {
          const cname = `${target.noun.toUpperCase()}_ENV_BASE`;
          configs.set(cname, `${cname} = os.environ["${envName}"]`);
          baseRef = cname;
        } else if (build === "constfile") {
          const cname = `${target.noun.toUpperCase()}_${hostStyle.toUpperCase()}_BASE`;
          configs.set(cname, `${cname} = "${base}"`);
          baseRef = cname;
        }
        let call;
        if (build === "urljoin") {
          imports.add("from urllib.parse import urljoin");
          call = `${lib}.${m}(urljoin(${baseRef ?? JSON.stringify(base)}, f"${fpath}"))`;
        } else if (build === "instance") {
          const inst = `${target.noun}_${hostStyle}_client`;
          const b = baseRef ?? JSON.stringify(base);
          if (!instances.has(inst)) instances.set(inst, `${inst} = httpx.Client(base_url=${b})`);
          call = `${inst}.${m}(f"${fpath}")`;
        } else if (build === "concat") {
          const pieces = pathParts.map((p, i) => (p === null ? `"/" + id` : `"/${p}"`)).join(" + ");
          call = `${lib}.${m}(${baseRef ?? JSON.stringify(base)} + ${pieces})`;
        } else {
          call = baseRef ? `${lib}.${m}(f"{${baseRef}}${fpath}")` : `${lib}.${m}(f"${base}${fpath}")`;
        }
        lines = [`def ${fn}(id):`, `    return ${call}`, ""];
      }
      // Expected outcome, from the route table.
      const cands = routesFor(t.method, t.canon);
      let expect;
      let targets;
      if (hostStyle === "compose" || hostStyle === "port") {
        expect = "resolved";
        targets = [handlerLoc.get(t)];
      } else if (hostStyle === "relative") {
        expect = cands.length === 1 ? "resolved" : "ambiguous";
        targets = cands.length === 1 ? [handlerLoc.get(t)] : [];
      } else {
        expect = cands.length === 1 ? "partial" : "ambiguous";
        targets = cands.length === 1 ? [handlerLoc.get(t)] : [];
      }
      pending.push({
        offset: body.length + 1,
        truth: {
          kind: "http", expect, targets, style: `${hostStyle}/${build}`,
          naive: { method: t.method, canon: t.canon },
        },
      });
      body.push(...lines);
    }
    // Negative cases: a computed URL, an external host, a path the pinned service does not serve.
    if (r.chance(0.6)) {
      pending.push({ offset: body.length + 1, truth: { kind: "http", expect: "unresolved", targets: [], style: "computed" } });
      body.push(...(s.lang === "ts"
        ? ["export async function callAnything(url: string) {", "  return fetch(url);", "}"]
        : ["def call_anything(url):", "    return requests.get(url)", ""]));
    }
    if (r.chance(0.6)) {
      pending.push({ offset: body.length + 1, truth: { kind: "http", expect: "unmatched", targets: [], style: "external" } });
      body.push(...(s.lang === "ts"
        ? ["export async function callVendor() {", '  return fetch("https://vendor.example.net/v3/rates");', "}"]
        : ["def call_vendor():", '    return requests.get("https://vendor.example.net/v3/rates")', ""]));
    }
    const pinned = services.filter((x) => x !== s && x.compose);
    if (pinned.length && r.chance(0.5)) {
      const x = r.pick(pinned);
      pending.push({ offset: body.length + 1, truth: { kind: "http", expect: "unmatched", targets: [], style: "pinned-missing", naive: { method: "GET", canon: "/nowhere/:" } } });
      body.push(...(s.lang === "ts"
        ? ["export async function callMissing(id: string) {", `  return fetch(\`http://${x.compose}:${x.port}/nowhere/\${id}\`);`, "}"]
        : ["def call_missing(id):", `    return requests.get(f"http://${x.compose}:${x.port}/nowhere/{id}")`, ""]));
    }

    if (instances.size && s.lang === "ts") add(httpFile, ['import axios from "axios";', ...instances.values()]);
    if (configs.size) add(configFile, [...(s.lang === "py" ? ["import os"] : []), ...configs.values()]);
    if (configs.size) {
      imports.add(s.lang === "ts"
        ? `import { ${[...configs.keys()].join(", ")} } from "./config";`
        : `from ${s.fw === "fastapi" ? ".config" : "config"} import ${[...configs.keys()].join(", ")}`);
    }
    const headLines = [...head, ...imports, ...(s.lang === "py" ? [...instances.values()] : []),
      ...(wrapper ? ["async function request(method: string, url: string) {", "  return fetch(url, { method });", "}"] : [])];
    const start = add(clientFile, [...headLines, ...body]);
    for (const p of pending) {
      // The call is on the line after the function's first line.
      truth.push({ ...p.truth, file: clientFile, line: start + headLines.length + p.offset });
    }
  }

  // --- kafkajs -------------------------------------------------------------------
  const tsServices = services.filter((s) => s.lang === "ts");
  if (tsServices.length >= 3 && nTopics > 0) {
    files.set("packages/events/package.json", [JSON.stringify({ name: "@bench/events" })]);
    const topics = [];
    for (let k = 0; k < nTopics; k++) {
      const noun = r.pick(NOUNS);
      const verb = r.pick(VERBS);
      const key = `${cap(noun)}${cap(verb)}${k}`;
      topics.push({ key, name: `${noun}.${verb}.${k}` });
    }
    add("packages/events/src/index.ts", [`export const Topics = {`, ...topics.map((t) => `  ${t.key}: "${t.name}",`), "} as const;"]);
    const clusters = r.chance(0.6) ? ["kafka-core", "kafka-insights"] : ["kafka-core"];
    for (const s of tsServices) s.cluster = r.pick(clusters);
    const subscribers = new Map(); // service → topics
    for (const t of topics) {
      for (const s of tsServices) if (r.chance(0.35)) subscribers.set(s, [...(subscribers.get(s) ?? []), t]);
    }
    const producersOf = new Map();
    for (const t of topics) {
      const p = r.pick(tsServices);
      producersOf.set(p, [...(producersOf.get(p) ?? []), t]);
    }
    for (const [svc, ts] of subscribers) {
      for (const t of ts) (byName.topics[t.name] ??= []).push(`${svc.dir}/src/events.ts::onMessage`);
    }
    for (const s of tsServices) {
      const prod = producersOf.get(s) ?? [];
      const subs = subscribers.get(s) ?? [];
      if (!prod.length && !subs.length) continue;
      const rel = `${s.dir}/src/events.ts`;
      const lines = [
        'import { Kafka } from "kafkajs";',
        'import { Topics } from "@bench/events";',
        `const kafka = new Kafka({ clientId: "${s.name}", brokers: ["${s.cluster}:9092"] });`,
        "const producer = kafka.producer();",
        `const consumer = kafka.consumer({ groupId: "${s.name}" });`,
      ];
      const pendingSends = [];
      for (const t of prod) {
        lines.push(`export async function publish${t.key}(payload: unknown) {`);
        pendingSends.push({ line: lines.length + 1, topic: t });
        lines.push(`  await producer.send({ topic: Topics.${t.key}, messages: [{ value: JSON.stringify(payload) }] });`, "}");
      }
      if (subs.length) {
        lines.push(
          "export async function startConsumer() {",
          `  await consumer.subscribe({ topics: [${subs.map((t) => `Topics.${t.key}`).join(", ")}] });`,
          "  await consumer.run({ eachMessage: onMessage });",
          "}",
          "export async function onMessage({ message }: any) {",
          "  return message;",
          "}",
        );
      }
      const start = add(rel, lines);
      for (const p of pendingSends) {
        const consumers = tsServices.filter((c) => c.cluster === s.cluster && (subscribers.get(c) ?? []).includes(p.topic));
        truth.push({
          kind: "event", file: rel, line: start + p.line - 1,
          expect: consumers.length ? "resolved" : "unmatched",
          targets: consumers.map((c) => `${c.dir}/src/events.ts::onMessage`),
          style: clusters.length > 1 ? "two-clusters/pinned" : "one-cluster",
          naive: { topic: p.topic.name },
        });
      }
      // A producer whose Kafka client comes from another module: its cluster is not in the code.
      if (clusters.length > 1 && prod.length && r.chance(0.5)) {
        add(`${s.dir}/src/kafka-shared.ts`, ['import { Kafka } from "kafkajs";', 'export const shared = new Kafka({ brokers: (process.env.KAFKA_BROKERS ?? "").split(",") });']);
        const t = prod[0];
        const l = add(`${s.dir}/src/publish-shared.ts`, [
          'import { shared } from "./kafka-shared";',
          'import { Topics } from "@bench/events";',
          "const producer = shared.producer();",
          "export async function republish() {",
          `  await producer.send({ topic: Topics.${t.key}, messages: [] });`,
          "}",
        ]);
        const any = tsServices.some((c) => (subscribers.get(c) ?? []).includes(t));
        truth.push({
          kind: "event", file: `${s.dir}/src/publish-shared.ts`, line: l + 4, expect: any ? "ambiguous" : "unmatched", targets: [],
          style: "two-clusters/unpinned", naive: { topic: t.name },
        });
      }
    }
  }

  // --- NestJS microservices RPC ------------------------------------------------------
  const nests = services.filter((s) => s.fw === "nest");
  if (nests.length >= 2) {
    const patterns = [];
    for (const s of nests) {
      const own = [0, 1].map((k) => ({ cmd: `${s.noun}.${r.pick(VERBS)}.${k}`, service: s, handler: `on${cap(s.noun)}${k}` }));
      patterns.push(...own);
    }
    // Some patterns are also answered by a second service.
    const dups = [];
    for (const p of [...patterns]) {
      if (!r.chance(0.25)) continue;
      const other = r.pick(nests.filter((x) => x !== p.service));
      dups.push({ cmd: p.cmd, service: other, handler: `dup${cap(other.noun)}${dups.length}` });
    }
    patterns.push(...dups);
    for (const s of nests) {
      const mine = patterns.filter((p) => p.service === s);
      const rel = `${s.dir}/src/rpc.controller.ts`;
      add(rel, [
        'import { Controller } from "@nestjs/common";',
        'import { MessagePattern } from "@nestjs/microservices";',
        "@Controller()",
        "export class RpcController {",
        ...mine.flatMap((p) => [`  @MessagePattern({ cmd: "${p.cmd}" })`, `  ${p.handler}() {`, "    return {};", "  }"]),
        "}",
      ]);
      for (const p of mine) {
        p.loc = `${rel}::RpcController.${p.handler}`;
        (byName.patterns[p.cmd] ??= []).push(p.loc);
      }
    }
    for (const s of nests) {
      const targets = patterns.filter((p) => p.service !== s && !p.cmd.startsWith(`${s.noun}.`));
      if (!targets.length) continue;
      const picks = [r.pick(targets), r.pick(targets)];
      const rel = `${s.dir}/src/gateway.service.ts`;
      const lines = [
        'import { Inject, Injectable } from "@nestjs/common";',
        'import { ClientProxy } from "@nestjs/microservices";',
        "@Injectable()",
        "export class GatewayService {",
        '  constructor(@Inject("BUS") private readonly bus: ClientProxy) {}',
      ];
      const pend = [];
      picks.forEach((p, k) => {
        lines.push(`  call${k}() {`);
        pend.push({ line: lines.length + 1, p });
        lines.push(`    return this.bus.send({ cmd: "${p.cmd}" }, {});`, "  }");
      });
      lines.push("}");
      const start = add(rel, lines);
      for (const { line, p } of pend) {
        const all = patterns.filter((x) => x.cmd === p.cmd);
        truth.push({
          kind: "rpc", file: rel, line: start + line - 1,
          expect: all.length === 1 ? "resolved" : "ambiguous", targets: all.length === 1 ? [all[0].loc] : [],
          style: all.length === 1 ? "unique" : "duplicate", naive: { pattern: p.cmd },
        });
      }
    }
  }

  const out = {};
  for (const [k, v] of files) out[k] = v.join("\n") + "\n";
  return { files: out, truth, byName, routes: allRoutes.map((x) => ({ service: x.service.dir, method: x.method, canon: x.canon, handler: handlerLoc.get(x) })), services: services.length };
}

function pathSegs(p) {
  return p ? p.split("/").filter(Boolean).map((v) => ({ v })) : [];
}

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { REPO_ROOT } from "./project.js";
import { mapPattern, renderMap, listServices } from "./tools.js";
import { listFunctions, findFunctions, readFunction, MAX_BATCH_READS } from "./catalog.js";
import { findCallers } from "./callers.js";
import { similarFunctions } from "./similar.js";
import { traceFlow } from "./flow/trace.js";

/**
 * Sent once, in the client's system prompt. Unlike tool descriptions it is
 * visible even when the client lists the tools by name only (Claude Code
 * defers MCP schemas), so it carries the triggers: when to reach for which
 * tool instead of Grep/Read — and, so the rest is believed, when not to.
 */
const INSTRUCTIONS = `spec-nav indexes every function in every service under the root, from syntax trees rather than text. If its tools are listed by name only (deferred), load them with ToolSearch before calling.

Use spec-nav instead of Grep/Read when:
- About to write a new function or helper → spec_nav_find_functions first, describing the behaviour in words. Existing code is often named differently from the name you would grep for. Nothing fits → spec_nav_similar_functions with your draft as \`code\`.
- Changing a function's signature or behaviour → spec_nav_callers, not a grep for its name: it drops same-named methods on other classes and finds calls through aliases and re-exports.
- A concept spread across files or services (a field, fee, status, flag) → one broad spec_nav_map regex instead of several greps; each hit names its enclosing function.
- Reading functions you will NOT edit (candidates, callers, siblings) → spec_nav_read_function with \`functions\` (up to 10 per call) instead of one Read per file.
- A change touches an endpoint, RPC call or event → spec_nav_trace_flow (upstream: who reaches it; downstream: what it reaches).
- Seeing what a file or service defines → spec_nav_functions. Unsure of the root or service names → spec_nav_services.

Grep/Read remain the right tools for an exact string you already know, non-code files (config, YAML, JSON, Markdown), and a file you are about to Edit (Edit requires a Read).`;

const server = new McpServer({ name: "spec-nav", version: "0.7.0" }, { instructions: INSTRUCTIONS });

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
/** Surface errors as a readable line, not a stack. */
function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return text(`ERROR: ${msg}`, true);
}

const servicesArg = z
  .array(z.string())
  .optional()
  .describe(
    'Limit to these services/directories, relative to SPEC_NAV_ROOT (e.g. "services/api", ' +
      '"packages"). "." is the root project\'s own files. Omit to cover the whole repo — the default.',
  );
const cursorArg = z
  .string()
  .optional()
  .describe("The nextCursor from the previous page. Repeat the other arguments unchanged.");
const formatArg = z
  .enum(["text", "json"])
  .optional()
  .describe('"text" (default, compact) or "json" (structured).');

server.registerTool(
  "spec_nav_map",
  {
    description:
      "Use INSTEAD OF several Grep calls when a concept (a field, fee, status, flag) may appear in many " +
      "files or services. For an exact string in non-code files (config, YAML, JSON, Markdown), use Grep. " +
      "Survey a change: every line matching a regex across EVERY project under the root, in " +
      "TypeScript, JavaScript, Vue/Svelte/Astro, Python, Go, Java, Kotlin, Swift, C#, Ruby, Rust, PHP, C, C++, " +
      "Scala, Elixir and Bash, " +
      "each tagged with the function or method it sits in. One wide pattern beats many narrow " +
      "greps. Large results are paged, not cut: the header says COMPLETE or gives a cursor for " +
      "the next page, and when there are more pages the first one lists every file with its hit " +
      "count (if that list fits). Long source lines are shortened and end with …. Files in other " +
      "languages are not searched. Pass a regex, e.g. \"handl(e|ing)_?fee|HANDLING_FEE\".",
    inputSchema: {
      pattern: z.string().describe('Regex, case-insensitive. E.g. "handl(e|ing)_?fee|handling_charge"'),
      services: servicesArg,
      includeComments: z
        .boolean()
        .optional()
        .describe("Include comment and import lines (skipped by default as noise)"),
      cursor: cursorArg,
      pageSize: z.number().int().positive().optional().describe("Max hits per page (pages are also cut at ~30k characters)."),
    },
  },
  async ({ pattern, services, includeComments, cursor, pageSize }) => {
    try {
      const result = await mapPattern(pattern, services, { includeComments });
      return text(renderMap(result, { cursor, services, includeComments, pageSize }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_find_functions",
  {
    description:
      "BEFORE WRITING NEW LOGIC: search every catalogued function in the repo, across all services, for one " +
      "that already does the job. Use INSTEAD OF grepping for a name you guessed: existing code is often " +
      "named differently. Describe the behaviour in words (\"calculate order fee\"); names " +
      "are split on camelCase/snake_case and matched by word, stem, abbreviation (amt/amount), prefix, " +
      "common verb synonyms (calculate/compute, delete/remove…) and domain concepts (shipping/delivery, " +
      "email/mail…) against name, export aliases, class/module, signature, doc comment, path, the names " +
      "the function CALLS, and (by default) its body. Rare words weigh more than common ones. Returns " +
      "ranked candidates with why each matched, and an id to read with spec_nav_read_function. Matches " +
      "only through calls are marked [via calls], only in the body [body only]; both need every word and " +
      "rank after direct matches. Vietnamese written with diacritics is also matched through a small " +
      "built-in dictionary (phí→fee, vận chuyển→shipping); other words are not translated. Still " +
      "lexical: when nothing fits, run spec_nav_similar_functions on a near candidate or on a draft " +
      "of the code you were about to write.",
    inputSchema: {
      query: z.string().describe('What the function does, in words. E.g. "calculate order fees"'),
      services: servicesArg,
      file: z.string().optional().describe("Only files whose path contains this (or matches it, with * globs)."),
      language: z.string().optional().describe('e.g. "typescript", "javascript", "python", "go"'),
      searchBodies: z
        .boolean()
        .optional()
        .describe("Also match words in function bodies (default true; weighted low; body-only matches need every word). false drops body-only matches."),
      limit: z.number().int().positive().optional().describe("Candidates per page (default 20, max 100)."),
      cursor: cursorArg,
      format: formatArg,
    },
  },
  async (args) => {
    try {
      return text(await findFunctions(args));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_similar_functions",
  {
    description:
      "Use when spec_nav_find_functions found nothing that fits, before adding new code, or before changing " +
      "logic that may be copied elsewhere — Grep cannot match code by behaviour. " +
      "Find functions that BEHAVE like a given one, whatever they are named: compares what each function " +
      "calls and the vocabulary of its body (syntax and its own name removed), with rare calls/words " +
      "weighted up. Use it (1) on a draft before adding it — pass `code` — to catch an existing " +
      "implementation under a different name, (2) on a search candidate to find its siblings and " +
      "duplicates across services, (3) before changing logic, to find copies that need the same change. " +
      "Identify the subject by `id`, `file`+`name`, or `code`. Returns ranked candidates with the calls " +
      "and words they share. Similar code is not necessarily interchangeable: read both.",
    inputSchema: {
      id: z.string().optional().describe("Function id from another spec_nav tool."),
      file: z.string().optional().describe("File of the subject function, relative to the root."),
      name: z.string().optional().describe("Name of the subject function in `file`."),
      line: z.number().int().positive().optional().describe("A line inside the subject, to disambiguate."),
      code: z.string().optional().describe("Source of a draft or external function to compare instead."),
      services: servicesArg,
      inFile: z.string().optional().describe("Only candidates in files whose path contains this (or matches it, with * globs)."),
      language: z.string().optional(),
      minScore: z.number().min(0).max(1).optional().describe("Lowest similarity listed (default 0.2)."),
      limit: z.number().int().positive().optional().describe("Candidates per page (default 10, max 100)."),
      cursor: cursorArg,
      format: formatArg,
    },
  },
  async (args) => {
    try {
      const r = await similarFunctions(args);
      return text(r.text, r.isError);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_functions",
  {
    description:
      "Use INSTEAD OF reading whole files to see what a file, directory or service defines: names, " +
      "signatures and line ranges, without the bodies. " +
      "The function catalog, read from each file's syntax tree: every named function, method, " +
      "constructor, accessor and named arrow/function expression — in JS/TS also functions assigned " +
      "to a variable or property after declaration (`x = () => …`, `obj.k = function …`, " +
      "`this.k = …`) and CommonJS exports (`module.exports = function name…`, `exports.k = …`; an " +
      "anonymous `module.exports = …` is named module.exports). Each has qualified name " +
      "(Class.method, outer.inner), kind, signature, parameters, return type when written, " +
      "export/visibility (exportedAs lists aliases such as module.exports.x), exact line:column " +
      "range, doc comment (shortened, marked when cut) and a stable id. A variable assigned several " +
      "functions lists each, with `alternatives` naming the others. Filter by services, file, name, " +
      "kind, language. Paged: the header gives the total, this page's range, and COMPLETE or a " +
      "cursor. A coverage line says which files were read and which were not (syntax errors, " +
      "unsupported languages, skipped files) — the catalog is only complete when it says so. Inline " +
      "anonymous callbacks are counted, not listed.",
    inputSchema: {
      services: servicesArg,
      file: z.string().optional().describe("Only files whose path contains this (or matches it, with * globs)."),
      name: z.string().optional().describe("Case-insensitive substring of the qualified name, or /regex/."),
      kind: z.string().optional().describe('e.g. "method", "function", "constructor", "arrow"'),
      language: z.string().optional(),
      exportedOnly: z.boolean().optional().describe("Only functions known to be exported/public."),
      limit: z.number().int().positive().optional().describe("Functions per page (default 200, max 1000)."),
      cursor: cursorArg,
      format: formatArg,
    },
  },
  async (args) => {
    try {
      return text(await listFunctions(args));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_read_function",
  {
    description:
      "Use INSTEAD OF Read for functions you will NOT edit — search candidates, callers, siblings — so " +
      "you load the functions, not whole files. To edit a file, Read it (Edit requires that). " +
      "Read functions in full — up to 10 in one call with `functions`, instead of one Read per file: " +
      "signature, whole doc comment, the imports it uses, and its exact " +
      "source with line numbers — from the column it starts at to the column it ends at, so a " +
      "neighbour on the same line is not included. Identify it by `id` (from spec_nav_functions / " +
      "spec_nav_find_functions), or by `file` + `name` (qualified, short, or a name it is exported " +
      "under; + `line` to pick among same-named ones). In a batch the functions share one page; one " +
      "that is not found is reported in its place. Long functions come in parts: the output says " +
      "where it stopped and gives a `cursor` (or `fromLine`) to continue with — nothing is cut " +
      "silently. If the function changed since the id was issued, or between parts, it answers STALE " +
      "instead of showing different code. When a variable is assigned several functions, it says " +
      "which others exist. Does not tell you whether another service may import it — check " +
      "dependencies and service boundaries before reusing.",
    inputSchema: {
      functions: z
        .array(
          z.object({
            id: z.string().optional(),
            file: z.string().optional(),
            name: z.string().optional(),
            line: z.number().int().positive().optional(),
          }),
        )
        .min(1)
        .max(MAX_BATCH_READS)
        .optional()
        .describe(
          `Read up to ${MAX_BATCH_READS} functions at once, each by \`id\` or \`file\`+\`name\` (+ \`line\`). ` +
            "Use instead of the single-function fields below.",
        ),
      id: z.string().optional(),
      file: z.string().optional().describe("Path relative to the repo root."),
      name: z.string().optional().describe('Qualified ("OrderService.calculateFee"), short, or exported name.'),
      line: z.number().int().positive().optional().describe("A line inside the function, to disambiguate."),
      cursor: z
        .string()
        .optional()
        .describe("nextCursor from the previous part: continues there even if the function moved; refuses if it changed."),
      fromLine: z.number().int().positive().optional().describe("Continue a long function from this file line."),
      maxLines: z.number().int().positive().optional().describe("Lines per part (default 400)."),
      format: formatArg,
    },
  },
  async (args) => {
    try {
      const r = await readFunction(args);
      return text(r.text, r.isError);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_services",
  {
    description:
      "The projects under the root (any depth), as `service` values the other tools accept, with " +
      "file and function counts per project and a coverage summary. Call when unsure what to pass, " +
      "or to check SPEC_NAV_ROOT points at the right repo. Not needed before every task: the other " +
      "tools cover the whole repo by default.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(JSON.stringify(await listServices(), null, 2));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_callers",
  {
    description:
      "Call sites of a function or method across the repo, before changing its signature or behaviour. " +
      "Use INSTEAD OF grepping for its name: a grep also hits same-named methods on other classes, " +
      "comments and strings, and misses calls through aliases and re-exports. " +
      "TypeScript/JavaScript (and Vue/Svelte/Astro scripts and templates) are resolved with the TypeScript " +
      "type checker: a same-named method on another class is excluded; calls through import aliases, " +
      "re-exports, default imports, obj[\"name\"](), f.call()/apply() are found. Python, Go, Java, Kotlin, " +
      "Swift, C#, Ruby, Rust, PHP, C/C++, Scala, Elixir and Bash are bound by EVIDENCE, not types — same " +
      "file/class, qualifier, import or alias, package, or a receiver declared with the class's type — " +
      "and each site's `reason` says which; `likely` (only declaration of the name, binding unproven) and " +
      "`ambiguous` (several could match) are listed apart. The name used as a string or symbol " +
      "(getattr, send(:x), reflection, event names) is listed under `dynamic`. Each site has its " +
      "ENCLOSING function, its parameters and the argument count. `exhaustive` is true only for " +
      "type-checked targets with nothing left open. Narrow with \"Class.method\", `className` or `file`.",
    inputSchema: {
      symbol: z.string().describe('Function or method name, e.g. "recordHistory" or "OrderService.recordHistory"'),
      service: z
        .string()
        .optional()
        .describe("Where the function is declared (narrows which declaration is meant). Call sites are searched repo-wide."),
      file: z.string().optional().describe("File declaring the function, relative to the root (narrows the target)."),
      className: z.string().optional().describe("Class (or object/namespace) declaring the method."),
      searchServices: servicesArg,
      limit: z.number().int().positive().optional().describe("Sites per page (default 100)."),
      cursor: cursorArg,
      format: formatArg,
    },
  },
  async (args) => {
    try {
      return text(await findCallers(args));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_trace_flow",
  {
    description:
      "Use INSTEAD OF grepping for a URL path or topic string when a change touches an endpoint, RPC call " +
      "or event: it finds who reaches it from other services and what it reaches. " +
      "Trace a flow ACROSS SERVICES, statically from source: HTTP client → route → handler, RPC call → handler, " +
      "event/topic → consumers, plus direct calls inside each service. Start from a function (`id` or `file`+`name`), " +
      "an `endpoint` or a `topic`; no start lists every link found. Each step gives the sending line, the receiving " +
      "function, evidence (method+path+host, pattern, topic+broker), a confidence and a status: resolved, partial " +
      "(part of the key is configuration), ambiguous (candidates, not followed), unresolved (computed key) or unmatched. " +
      "Adapters: Express, Fastify, koa-router, NestJS, file routes (Next.js, Medusa, SvelteKit), fetch, axios, kafkajs; " +
      "FastAPI, Flask, requests, httpx, aiohttp. " +
      "Other stacks are reported as not traced. Not part of spec_nav_callers.",
    inputSchema: {
      id: z.string().optional().describe("Start function id."),
      file: z.string().optional().describe("Start function's file (with `name`)."),
      name: z.string().optional(),
      line: z.number().int().positive().optional(),
      endpoint: z.string().optional().describe('"GET /api/orders/:id" or "/orders/42".'),
      topic: z.string().optional().describe('Event, topic or RPC pattern: "order.created", "{ cmd: \'sum\' }".'),
      direction: z.enum(["downstream", "upstream", "both"]).optional().describe("Default downstream."),
      maxDepth: z.number().int().positive().optional().describe("Default 6, max 20."),
      followCalls: z.boolean().optional().describe("Follow direct calls inside a service (default true)."),
      includePartial: z.boolean().optional().describe("Follow partial links (default true)."),
      limit: z.number().int().positive().optional().describe("Steps per page (default 30)."),
      cursor: cursorArg,
      format: formatArg,
    },
  },
  async (args) => {
    try {
      const r = await traceFlow(args);
      return text(r.text, r.isError);
    } catch (err) {
      return fail(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, so it does not corrupt the MCP protocol stream on stdout
  console.error(`spec-nav running, repo root = ${REPO_ROOT}`);
}

main().catch((err) => {
  console.error("spec-nav failed to start:", err);
  process.exit(1);
});

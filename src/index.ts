#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { REPO_ROOT } from "./project.js";
import { mapPattern, renderMap, listServices } from "./tools.js";
import { listFunctions, findFunctions, readFunction } from "./catalog.js";
import { findCallers } from "./callers.js";

const server = new McpServer({ name: "spec-nav", version: "0.2.0" });

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
      "Survey a change: every line matching a regex across EVERY project under the root, in " +
      "TypeScript, JavaScript, Python, Go, Java, C#, Ruby, Rust, PHP, C, C++, Scala, Elixir and Bash, " +
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
      "BEFORE WRITING NEW LOGIC: search every function in the repo, across all services, for one " +
      "that already does the job. Describe the behaviour in words (\"calculate order fee\"); names " +
      "are split on camelCase/snake_case and matched by word, stem, prefix and a few common verb " +
      "synonyms (calculate/compute, get/fetch…) against name, class/module, signature, doc comment, " +
      "path and (by default) body. Returns ranked candidates with why each matched, and an id to " +
      "read with spec_nav_read_function. Lexical only: a function doing the same thing under " +
      "different words can be missed — try other wordings, or browse spec_nav_functions.",
    inputSchema: {
      query: z.string().describe('What the function does, in words. E.g. "calculate order fees"'),
      services: servicesArg,
      file: z.string().optional().describe("Only files whose path contains this (or matches it, with * globs)."),
      language: z.string().optional().describe('e.g. "typescript", "javascript", "python", "go"'),
      searchBodies: z.boolean().optional().describe("Also match words in function bodies (default true; weighted low)."),
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
  "spec_nav_functions",
  {
    description:
      "The complete function catalog, read from each file's syntax tree: every named function, " +
      "method, constructor, accessor and named arrow/function expression, with qualified name " +
      "(Class.method, outer.inner), kind, signature, parameters, return type when written, " +
      "export/visibility, line range, doc comment (shortened, marked when cut) and a stable id. " +
      "Filter by services, file, name, kind, language. Paged: the header gives the total, this " +
      "page's range, and COMPLETE or a cursor. A coverage line says which files were read and " +
      "which were not (syntax errors, unsupported languages, skipped files) — the catalog is only " +
      "complete when it says so. Inline anonymous callbacks are counted, not listed.",
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
      "Read one function in full: signature, whole doc comment, the imports it uses, and its source " +
      "with line numbers. Identify it by `id` (from spec_nav_functions / spec_nav_find_functions), " +
      "or by `file` + `name` (+ `line` to pick among same-named ones). Long functions come in parts: " +
      "the output says where it stopped and the `fromLine` to continue with — nothing is cut " +
      "silently. If the file changed since the id was issued, it answers STALE ID with the current " +
      "id instead of showing different code. Does not tell you whether another service may import " +
      "it — check dependencies and service boundaries before reusing.",
    inputSchema: {
      id: z.string().optional(),
      file: z.string().optional().describe("Path relative to the repo root."),
      name: z.string().optional().describe('Qualified ("OrderService.calculateFee") or short name.'),
      line: z.number().int().positive().optional().describe("A line inside the function, to disambiguate."),
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
      "or to check SPEC_NAV_ROOT points at the right repo.",
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
      "Call sites of a TypeScript/JavaScript function or method across the repo, resolved with the " +
      "TypeScript type checker — a same-named method on another class is excluded, and calls through " +
      "import aliases, re-exports and default imports are found. Each site has its ENCLOSING function " +
      "and that function's parameters, and the argument count: use before changing a signature. Also " +
      "lists uses as a value (passed as a callback), calls bound to an interface/base method, and calls " +
      "it could NOT resolve (untyped receivers) — `exhaustive` is true only when nothing was left " +
      "unresolved. Narrow with \"Class.method\", `className` or `file`. Other languages are not analysed; " +
      "files in them that mention the name are listed.",
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
      return text(findCallers(args));
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

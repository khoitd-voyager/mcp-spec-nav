#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { REPO_ROOT } from "./project.js";
import {
  findCallers,
  mapPattern,
  renderMap,
  listServices,
} from "./tools.js";

const server = new McpServer({ name: "spec-nav", version: "0.1.0" });

/** Wrap a result as a text block; surface errors as a readable line, not a stack. */
function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true };
}

const serviceArg = z
  .string()
  .describe(
    'Service directory, relative to SPEC_NAV_ROOT. E.g. "services/api", ' +
      '"packages/web", or "." when the root is the project itself.',
  );

server.registerTool(
  "spec_nav_map",
  {
    description:
      "START HERE when surveying a change. Scans EVERY project under the root in " +
      "one call — TypeScript, Python, Go, Java, Ruby, Rust, PHP and C# — and " +
      "returns every matching line, each tagged with the function or method it " +
      "sits in. Use this before grep: a change that spans several services, or " +
      "several languages, is how files in the ones you did not think to search " +
      "get missed. Nothing is truncated — see it all once instead of narrowing " +
      "over a dozen searches. Pass a regex, e.g. \"handl(e|ing)_?fee|HANDLING_FEE\".",
    inputSchema: {
      pattern: z
        .string()
        .describe('Regex, case-insensitive. E.g. "handl(e|ing)_?fee|handling_charge"'),
      services: z
        .array(z.string())
        .optional()
        .describe(
          "Limit to these services. Omit to scan every project found — the default, " +
            "and usually what you want.",
        ),
      includeComments: z
        .boolean()
        .optional()
        .describe("Include comment and import lines (skipped by default as noise)"),
    },
  },
  async ({ pattern, services, includeComments }) => {
    try {
      const result = await mapPattern(pattern, services, { includeComments });
      return { content: [{ type: "text" as const, text: renderMap(result) }] };
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_services",
  {
    description:
      "The projects under the root, as `service` values the other tools accept. " +
      "Call when unsure what to pass as `service`.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(listServices());
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_callers",
  {
    description:
      "Every call site of a function or method, each with its ENCLOSING function " +
      "and that function's parameters. Use before changing a signature: tells you " +
      "which sites already have the value you need in scope, and how many arguments " +
      "each one passes. Replaces grepping and then opening every file.",
    inputSchema: {
      service: serviceArg,
      symbol: z.string().describe("Function or method name, e.g. recordHistory"),
    },
  },
  async ({ service, symbol }) => {
    try {
      return ok(findCallers(service, symbol));
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

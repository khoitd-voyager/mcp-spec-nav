#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { REPO_ROOT } from "./project.js";
import {
  findCallers,
  readOutline,
  getSymbol,
  nextEnumValue,
  blastRadius,
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

server.registerTool(
  "spec_nav_outline",
  {
    description:
      "A file's structure: classes, methods, functions, interfaces, enums, each " +
      "with its line range. Use instead of reading a few thousand lines to learn " +
      "what is where, then read only the range you need.",
    inputSchema: {
      service: serviceArg,
      path: z.string().describe("File path, relative to the repo root"),
    },
  },
  async ({ service, path }) => {
    try {
      return ok(readOutline(service, path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_symbol",
  {
    description:
      "A symbol's full signature and file:line, without returning file contents. " +
      "Use to cite an exact location.",
    inputSchema: {
      service: serviceArg,
      name: z.string().describe("Name of a function, class, method or interface"),
    },
  },
  async ({ service, name }) => {
    try {
      return ok(getSymbol(service, name));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_next_enum",
  {
    description:
      "The highest existing enum/const value matching a prefix, plus the next free " +
      'one. E.g. prefix "ERROR2_" in a constants file returns the last code in use ' +
      "and the value to add.",
    inputSchema: {
      service: serviceArg,
      path: z.string().describe("File holding the enum or constants"),
      prefix: z.string().describe('Prefix, e.g. "ERROR2_"'),
    },
  },
  async ({ service, path, prefix }) => {
    try {
      return ok(nextEnumValue(service, path, prefix));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_blast_radius",
  {
    description:
      "Which files import this one and what they pull in — the blast radius of " +
      "changing or removing an export. Use before a signature change or a deletion.",
    inputSchema: {
      service: serviceArg,
      path: z.string().describe("File to check"),
    },
  },
  async ({ service, path }) => {
    try {
      return ok(blastRadius(service, path));
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

# Installation

[English](installation.md) · [Tiếng Việt](installation.vi.md) · [简体中文](installation.zh-CN.md)

← [README](../../README.md) · [Tool reference](tools.md) · [Troubleshooting](troubleshooting.md)

## Choose how to install

| | Option 1: Claude Code (`.mcp.json`) | Option 2: Claude Desktop extension (`.mcpb`) |
|---|---|---|
| Client | Claude Code (and other clients that read `.mcp.json`) | Claude Desktop |
| You need | Node.js 18+, npm/npx, Git | Only Claude Desktop — it runs the extension with its built-in Node.js |
| Repository to scan | `SPEC_NAV_ROOT` in the config file | Folder picker in the extension settings |
| Best for | Coding: Claude reads, plans and edits code in the repo | Asking about code: find, read and check functions in chat |

Both options run the same server and the same tools. You can use both at once.

## Claude Code

**Requirements:** Node.js 18 or newer, npm/npx, Git, and a local checkout of the repository you want to scan. The first installation needs network access.

### 1. Add the MCP configuration

Create `.mcp.json` at the root of your target repository:

```json
{
  "mcpServers": {
    "spec-nav": {
      "command": "npx",
      "args": ["-y", "github:khoitd-voyager/mcp-spec-nav"],
      "env": {
        "SPEC_NAV_ROOT": "/Users/you/code/your-repo"
      }
    }
  }
}
```

**Replace `/Users/you/code/your-repo` with the absolute path to the code you want scanned.** Use the monorepo root to cover multiple services. This is the target repository, not the installation directory of `mcp-spec-nav`.

If `.mcp.json` already exists, add the `spec-nav` entry inside its existing `mcpServers` object. Keep your other MCP configurations.

### 2. Check the connection

Open Claude Code in that repository, restart the session, and run:

```text
/mcp
```

Check that `spec-nav` is connected. Complete any configuration approval requested by your client.

Then send Claude:

```text
Use spec-nav to list the services in this repository.
Show the resolved repository root and any files it could not scan.
```

Check that the root and services match your project before continuing.

### 3. Try it on a real task

You do not call the tools yourself. Copy one of these messages into Claude Code:

**Find reusable code**

```text
Before implementing order fee calculation, use spec-nav to search all services
for existing functions. Read the most relevant candidates and explain whether
any can be reused. Check dependencies and service boundaries before importing.
```

**Check callers before editing**

```text
I want to add a parameter to calculateFee. Use spec-nav to find its declaration,
read the implementation and check its callers before planning the change.
Report any callers you could not resolve.
```

**Survey a change across services**

```text
I want to change the handling fee. Use spec-nav to map the related constants,
functions and usages across the repository. Include alternative spellings.
Check incomplete coverage and remaining pages before claiming the survey is complete.
```

**Follow a request across services**

```text
Before changing the POST /orders endpoint, use spec-nav to trace who calls it
(upstream) and what it reaches downstream, across services. Read both ends of
each link, and list the links reported as partial, ambiguous or unresolved.
```

## Claude Desktop extension

**Requirements:** Claude Desktop and a local checkout of the repository you want to scan. Node.js is not required.

### 1. Get the `.mcpb` file

Download `mcp-spec-nav-<version>.mcpb` from the [Releases](https://github.com/khoitd-voyager/mcp-spec-nav/releases) page, or build it yourself:

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run pack:mcpb
```

The file is written to `build/mcp-spec-nav-<version>.mcpb`.

### 2. Install it

Double-click the `.mcpb` file, or open Claude Desktop → **Settings → Extensions → Advanced settings → Install Extension…** and select it. Review the extension and click **Install**.

### 3. Choose the repository

In the extension settings, set **Repository to scan** to the root of the code you want scanned (the monorepo root to cover every service), then enable the extension.

To scan a different repository later, open **Settings → Extensions → Spec Nav → Configure** and choose another folder. The extension scans one repository at a time.

### 4. Check it

Start a new chat and send:

```text
Use spec-nav to list the services in this repository.
Show the resolved repository root and any files it could not scan.
```

The prompts under [Try it on a real task](#3-try-it-on-a-real-task) also work in Claude Desktop. Claude Desktop reads and explains the code; to have the changes made in the repository, use Claude Code.

## Make Claude use it during normal coding

Installing an MCP makes its tools available; it does not ensure the agent will use them. Add this section to your project's `CLAUDE.md`:

```markdown
## Find existing code with spec-nav

- Before writing a new function: spec_nav_find_functions, describing the behaviour in words.
  Nothing fits → pass your draft to spec_nav_similar_functions.
  Another service's function is not automatically safe to import: check dependencies first.
- Before changing a function's signature or behaviour: spec_nav_callers, not a grep for its name.
  Check sites marked likely, ambiguous, unresolved or dynamic by hand.
- Searching the repo for a name or concept: one broad spec_nav_map regex instead of grep -rn.
  It covers code and config/docs, and takes `file` and `context` like grep.
- A change touching an endpoint, an event or another service: spec_nav_trace_flow.
  Links marked partial, ambiguous or unresolved are leads, not facts: read both ends.
- When a result ends with a ready "Next —" call, send it instead of searching again.

One call per question: there is no need to call every tool. Results are candidates,
not proof that nothing else exists.
```

Each line is a trigger, not a step: an agent told to run a fixed sequence of tools before editing makes more calls, not fewer. For other agents, adapt this section to their project instruction file, such as `AGENTS.md`.

### Load the tools up front (Claude Code)

Claude Code can defer MCP tools behind its tool search: the agent sees only their names and has to call `ToolSearch` before it can use them, which costs a call and often means it reaches for Grep instead. To load spec-nav's tools from the start, set `ENABLE_TOOL_SEARCH=false`, either in the environment that launches `claude` or in `.claude/settings.json`:

```json
{ "env": { "ENABLE_TOOL_SEARCH": "false" } }
```

The tool definitions are then sent with every request (about 5k tokens for spec-nav's eight tools), in exchange for no `ToolSearch` calls.

## Install from a local checkout

Use this when developing the MCP or testing changes before pushing them. `npx github:` always runs the committed package, so local edits do not appear through it.

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run build
```

Configure `.mcp.json` with absolute paths:

```json
{
  "mcpServers": {
    "spec-nav": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-spec-nav/dist/index.cjs"],
      "env": {
        "SPEC_NAV_ROOT": "/absolute/path/to/your-project"
      }
    }
  }
}
```

`args` points to the MCP installation; `SPEC_NAV_ROOT` points to the code being scanned. After changing MCP source, rebuild and restart the client session. See [Development](development.md) for tests and packaging.

## Privacy

The server reads the current local checkout. No search API key is required, and its search does not send code to an external search service. Results are returned to your connected coding agent; that client's model/data handling settings still apply.

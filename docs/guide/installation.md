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
## Use existing code before writing new logic

For new logic or changes that affect other functions:

1. Use spec_nav_find_functions to look for existing implementations across services.
   Use English keywords for English-named code; try another wording if needed.
2. Read the most relevant candidates with spec_nav_read_function, several per call
   (`functions`). Code you will not edit: read the function, or the class (file + class
   name) rather than the whole file; `file` alone reads a whole file in place of `cat`.
   Avoid loading the entire catalog or every function body into context.
   If nothing fits, draft the function and pass it to spec_nav_similar_functions.
3. Check behavior, exports, dependencies and service boundaries before reusing code.
   Another service's function is not automatically safe to import.
4. Use spec_nav_callers before changing a function's signature or behavior.
   Check sites marked likely, ambiguous, unresolved or dynamic by hand.
   Use spec_nav_map with one broad regex for concepts spanning files or services.
5. When a change touches an endpoint, an event or a call to another service, use
   spec_nav_trace_flow (upstream: who reaches it; downstream: what it reaches).
   Links marked partial, ambiguous or unresolved are leads, not facts: read both ends.
6. Inspect coverage and unresolved results. Follow cursors when you need the complete
   result set; use ordinary search/file reads for unsupported or missing areas.
7. After editing, refresh relevant queries and run the project's appropriate checks.

Scale this workflow to the task. Small, isolated edits do not require every tool.
Search results are candidates, not proof that no other implementation exists.
```

For other agents, adapt this section to their project instruction file, such as `AGENTS.md`.

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

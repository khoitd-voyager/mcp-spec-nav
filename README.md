# mcp-spec-nav

An MCP server that reads TypeScript **structurally** instead of textually, so a
coding agent stops grepping and opening whole files to answer questions it asks
on almost every task.

The one that matters most: *"who calls this function, and does each call site
already have the variable I need to pass?"* `grep` gives you line numbers. It
does not tell you which function encloses each hit, or what parameters that
function takes. So the agent opens every file to find out — and on a mature
service that is tens of thousands of lines of context for a question whose
answer is a 20-row table.

Measured on a real task in a ~10k-file repo, finding 16 call sites of one method
plus each enclosing function and its parameters:

| | characters | ≈ tokens |
|---|---|---|
| `grep` + reading the 5 files it points into | 531,765 | 147,713 |
| one `spec_nav_callers` call | 6,378 | 1,772 |

**98.8% less context, 83x smaller, 1.7s.** And the grep path still hasn't
answered the question — the enclosing functions and their parameters have to be
read out of those 14,581 lines by hand.

On that same task, a hand-written analysis had counted 14 call sites. There are
16.

## Install

No clone, no build. Point your MCP client at the GitHub repo:

```json
{
  "mcpServers": {
    "spec-nav": {
      "command": "npx",
      "args": ["-y", "github:khoitd-voyager/mcp-spec-nav"],
      "env": { "SPEC_NAV_ROOT": "/absolute/path/to/your/repo" }
    }
  }
}
```

`SPEC_NAV_ROOT` is the directory your `service` arguments resolve against. For a
monorepo point it at the root; for a single project point it at the project and
pass `service: "."`.

For Claude Code, that block goes in `.mcp.json` at your project root. Restart to
pick it up.

### Local checkout

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav && cd mcp-spec-nav
npm install && npm run build
```

Then use `"command": "node", "args": ["/path/to/mcp-spec-nav/dist/index.cjs"]`.

### Check it loaded

In Claude Code, `/mcp` should list `spec-nav` with 5 tools. If it doesn't, run
the binary by hand — it prints the root it resolved and exits non-zero on a bad
path:

```bash
SPEC_NAV_ROOT=/your/repo npx -y github:khoitd-voyager/mcp-spec-nav
# spec-nav running, repo root = /your/repo
```

## Tools

| Tool | Returns | Replaces |
|---|---|---|
| `spec_nav_callers` | every call site, with its enclosing function, that function's line, its parameter list, and the argument count at the site | grep, then opening each file to find the enclosing function |
| `spec_nav_outline` | classes, methods, functions, interfaces, enums with line ranges | reading a 5,000-line file to learn what's in it |
| `spec_nav_symbol` | full signature and `file:line`, nothing else | grep plus a windowed read |
| `spec_nav_next_enum` | highest existing value for a prefix, and the next one | reading a whole constants file |
| `spec_nav_blast_radius` | which files import this one, and what they import | grepping for import paths |

Every tool takes `service` — a directory relative to `SPEC_NAV_ROOT`.

### `spec_nav_callers`

The argument count and the enclosing parameter list are the point. Adding a
parameter to a method means visiting each call site; this tells you in one call
which sites already have the value in scope and which will need it threaded
through.

```
{ "service": "services/api", "symbol": "recordHistory" }
```

```json
{
  "symbol": "recordHistory",
  "total": 16,
  "sites": [
    {
      "file": "services/api/src/services/order.ts",
      "line": 1421,
      "enclosing": "confirmOrder",
      "enclosingLine": 1249,
      "enclosingParams": ["req", "user", "manager"],
      "argCount": 6,
      "snippet": "this.historyService.recordHistory(items, orderId, …"
    }
  ]
}
```

### `spec_nav_next_enum`

For appending to a coded list — error codes, event names — without reading the
file to find where the numbering stopped.

```
{ "service": "services/api", "path": "src/constants/errors.ts", "prefix": "ERROR2_" }
→ { "lastMatch": { "line": 66, "text": "code: 'ERROR2_124'," }, "suggestedNext": "ERROR2_125" }
```

## Using it

The tools are most useful in the stretch before you write any code — working
out what a change touches. Three patterns cover most of it.

### Adding a parameter to a widely-called function

This is the one the tool was built for. You need to know every call site, and at
each one whether the value you want to thread through is already in scope.

```
spec_nav_callers { service: "services/api", symbol: "recordHistory" }
```

Read `enclosingParams` per site. Sites whose enclosing function already takes
`user` are a one-argument edit; the rest need the value threaded in from their
own caller — so run `spec_nav_callers` again on *those* enclosing functions.
`argCount` tells you whether optional parameters are already being passed, which
decides whether you can append or have to pass `undefined` in a middle slot.

Edit from the bottom of each file upward, since every insertion shifts the line
numbers below it.

### Finding where to insert into a coded list

```
spec_nav_next_enum { service: "services/api", path: "src/constants/errors.ts", prefix: "ERROR2_" }
```

Gives you the highest code in use, the line it's on, and the next free value —
without reading several hundred lines of constants.

### Before changing or removing an export

```
spec_nav_blast_radius { service: "services/api", path: "src/utils/phone.ts" }
```

`importedBy` lists each importing file with what it pulls in, so you can tell a
type-only import from a real call path. Follow up with `spec_nav_callers` on the
symbols that matter for proof.

### Reading a large file

Don't open it. Outline first, then read the range you actually need:

```
spec_nav_outline { service: "services/api", path: "src/services/order.ts" }
→ method OrderService.confirmOrder :1249-1502
```

Then a normal file read with `offset: 1249, limit: 253`.

### Agent instructions

If you keep a `CLAUDE.md` or equivalent, a few lines go a long way, because the
habit being replaced (grep, then open the file) is a strong one:

```markdown
Before editing a function's signature, call `spec_nav_callers` to get every
call site with its enclosing function and parameters. Don't grep and open
files to work this out.

For files over ~200 lines, call `spec_nav_outline` first and read only the
line range you need.
```

### What it won't tell you

The tools report structure, not intent. They say a call site exists and what's
in scope around it; they don't say whether passing the value there is correct,
or whether a guard belongs before or after an existing check. Read the code at
the line numbers they hand you for that.

Line numbers also go stale the moment you start editing. Re-run the tool rather
than trusting numbers from earlier in a session.

## Limits

- **TypeScript and TSX only.** Plain `.js` files are not analysed.
- **Reads the current checkout.** Line numbers follow whatever branch is checked
  out; switch branches before asking if you need another one's numbers.
- **`spec_nav_callers` matches by name, not by resolved type.** Two methods
  called `save` on different classes come back in one list. Read the `file` and
  `enclosing` fields rather than trusting `total` blindly.
- **First call per service costs 1–3 seconds** while the project loads. Later
  calls are fast.
- Uses the service's `tsconfig.json` when present, so path aliases resolve.
  Without one it globs `src/**/*.ts`.

## License

MIT

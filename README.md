# mcp-spec-nav

An MCP server that answers the question a coding agent asks at the start of
every change: **what does this touch?**

In a monorepo the honest answer spans services. An agent searching one service
at a time finds what it thought to look for, writes a plan around that, and the
two services it never searched surface later as bugs. `spec_nav_map` scans every
TypeScript project under the root in a single call and returns every matching
line, each tagged with the function it sits in.

Measured on a fee change across six codebases, against the same change planned
with ordinary grep:

| | calls | tokens | key files found |
|---|---|---|---|
| grep, narrowing search by search | 28 | 24,418 | 7/7 |
| one `spec_nav_map` | **1** | **11,890** | **7/7** |

Running a full `/discuss → /resolve → /create` flow with it came out **2% over**
the grep baseline in total tokens and four turns shorter, while the resulting
spec caught three things the grep-only run had missed — including a `|| 300`
fallback that sits inside `if (fee)` and can never run, next to a different
constant in the same file that does need changing.

## Install

No clone, no build:

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

`SPEC_NAV_ROOT` is the directory to scan. Point it at a monorepo root; the
server finds the TypeScript projects underneath on its own.

For Claude Code that block goes in `.mcp.json` at your project root. Restart to
pick it up, then `/mcp` should list `spec-nav`.

### Local checkout

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav && cd mcp-spec-nav
npm install && npm run build
```

Then `"command": "node", "args": ["/path/to/mcp-spec-nav/dist/index.cjs"]`.

## Tools

| Tool | Returns |
|---|---|
| `spec_nav_map` | every line matching a regex, across every project, with the enclosing function |
| `spec_nav_callers` | every call site of a symbol, with its enclosing function **and that function's parameters** |
| `spec_nav_services` | the projects found under the root |

### `spec_nav_map` — call it once, at the start

```
{ "pattern": "handl(e|ing)_?fee|handling_charge|HANDLING_FEE" }
```

```
pattern: handl(e|ing)_?fee|handling_charge|HANDLING_FEE
scanned: admin, storefront, services/customer, services/order, services/product
492 hits in 83 files

Format:  line | enclosing function | source

services/order/src/utils/calculate-product-fee.ts
  1 | - | export const PRODUCT_HANDLING_FEE_JPY = 300;
  27 | calculateProductFee:17 | total += PRODUCT_HANDLING_FEE_JPY;
  63 | calculateStoreFee:41 | total += PRODUCT_HANDLING_FEE_JPY;
```

**Use one broad pattern, once.** Each call returns a map of the whole repo, so
five narrow calls cost far more than one wide one — more, in practice, than just
using grep. Treat the result as the map for the whole task and narrow down from
it with grep and ordinary file reads. Call it a second time only for a genuinely
different concept the first pattern could not reach.

Past a size budget the output keeps every file but shows only the first few
lines of each, so a broad pattern on a large repo still fits in one reply.

### `spec_nav_callers` — before changing a signature

```
{ "service": "services/order", "symbol": "recordHistory" }
```

```json
{
  "symbol": "recordHistory", "total": 16,
  "sites": [{
    "file": "services/order/src/services/order.ts",
    "line": 1421, "enclosing": "confirmOrder", "enclosingLine": 1249,
    "enclosingParams": ["req", "user", "manager"], "argCount": 6
  }]
}
```

`enclosingParams` is the point. Adding a parameter means visiting every call
site; this says in one call which ones already have the value in scope and which
need it threaded down from their own caller. `argCount` tells you whether you
can append or must pass `undefined` in a middle slot.

Edit each file bottom-up — every insertion shifts the lines below it.

## Limits

- **TypeScript and TSX only.** Plain `.js`, `.mdx`, SQL and config files are not
  scanned; use grep for those.
- **Reads the current checkout.** Line numbers follow the branch you are on.
- **`spec_nav_callers` matches by name, not resolved type.** Two methods called
  `save` on different classes come back in one list; read `file` and `enclosing`
  rather than trusting `total`.
- **Structure, not intent.** These tools say where something is and what
  surrounds it. Whether the change belongs there is still yours to decide.
- Line numbers go stale as soon as you start editing — re-run rather than
  trusting numbers from earlier in a session.

## License

MIT

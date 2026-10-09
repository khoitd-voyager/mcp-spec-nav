# mcp-spec-nav

An MCP server that answers the question a coding agent asks at the start of
every change: **what does this actually touch?**

In a repo of any size the honest answer usually spans more than one place. An
agent that searches where it expects the code to be finds what it expected,
plans around that, and the parts it never searched turn up later as bugs — a
constant left at the old value in another service, a caller it did not know
about, a screen nobody mentioned.

`spec_nav_map` scans every project under the root in a single call and returns
**every** matching line, each tagged with the function it sits in. Not a
sample, not the first twenty — the whole picture, so the plan is built on what
is there rather than on what the agent thought to look for.

It reads thirteen languages, and a repo that mixes them comes back as one list
rather than one search per language. That is the case where searching goes
wrong quietest: the Go service and the Python worker that share a constant are
exactly the two places a per-language habit stops looking.

## What it changes in practice

On a change that moved a fee constant across six codebases, the same work
planned with ordinary searching versus with the map:

- the map found all seven files that mattered in one call; the search-by-search
  approach found them too, but only after twenty-eight separate searches, each
  one a guess about where to look next
- the resulting plan caught three things the search-only plan missed: a
  constant used in a mail template nobody had listed, a hardcoded value in an
  admin screen, and — the one that would have caused a bug — a `|| 300`
  fallback sitting inside `if (fee)` that can never run, two lines away from a
  different constant in the same file that genuinely did need changing

The last one is the kind of thing that separates a plan you can hand to someone
from a plan that looks complete. Telling those two apart needs both of them on
screen at once.

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

`SPEC_NAV_ROOT` is the directory to scan. Point it at a monorepo root and the
server finds the projects underneath on its own — anything with a `package.json`,
`pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`,
a `.csproj` or just a `src/`. Point it at a single project and that is what it
scans.

For Claude Code that block goes in `.mcp.json` at your project root. Restart,
then `/mcp` should list `spec-nav`.

### Local checkout

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav && cd mcp-spec-nav
npm install && npm run build
```

Then `"command": "node", "args": ["/path/to/mcp-spec-nav/dist/index.cjs"]`.

## Telling your agent to use it

Having the tool available is not enough — an agent reaches for the search it has
always used unless something tells it otherwise. Put this in `CLAUDE.md`,
`AGENTS.md`, a cursorrule, or whatever your client reads:

```markdown
## Surveying a change

Before planning any change that might span more than one file, call
`spec_nav_map` **once** with the broadest regex that describes it — fold every
spelling into one pattern:

    spec_nav_map("handl(e|ing)_?fee|handling_charge|HANDLING_FEE")

It scans every project at once, so what gets found no longer depends on
guessing which service to look in. Keep that result as the map for the task.

Do not call it like grep. Each call returns a map of the whole repo, so five
narrow calls cost far more than one wide one. Call it again only for a
genuinely different concept the first pattern could not reach — not to filter
something already in the map.

Then narrow down with ordinary search and file reads.

Before changing a function's signature, call `spec_nav_callers` to get every
call site with its enclosing function and that function's parameters.
```

That wording matters more than it looks. Without the "once" the agent treats the
map as a search engine and calls it ten times; with it, one call per phase is
the norm.

## Languages

| Language | Extensions | Names you get |
|---|---|---|
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | `computeTotal`, and arrow functions by the variable they are assigned to |
| Python | `.py` `.pyi` | `OrderCalculator.compute_total` |
| Go | `.go` | `Order.Total` — the receiver type, not a bare `Total` |
| Java | `.java` | `FeeService.total`, constructors included |
| C# | `.cs` | `FeeAdmin.Total`, properties included |
| Ruby | `.rb` `.rake` | `Invoice.total`, including `self.` methods |
| Rust | `.rs` | `Order.total` from the surrounding `impl` |
| PHP | `.php` | `Cart.total` |
| C | `.c` `.h` | `total`, including pointer-returning declarations |
| C++ | `.cpp` `.cc` `.hpp` … | `Order.total` |
| Scala | `.scala` `.sc` | `Fees.total` from the object or class |
| Elixir | `.ex` `.exs` | `Billing.total`, `def` and `defp` |
| Bash | `.sh` `.bash` `.zsh` | `total`, both declaration forms |

TypeScript goes through ts-morph, which reads `tsconfig.json` and resolves path
aliases. The rest go through tree-sitter, using the grammar's own parse tree —
so a method keeps the name its language gives it rather than one guessed from
indentation. Grammars are read from disk the first time a file needs them: a
TypeScript-only repo loads none of them.

A nested function reads as the chain that contains it (`outer.middle.inner`),
and a line inside a callback is attributed to the named function around it,
which is the answer you actually want when deciding whether a hit matters.

## Tools

| Tool | Returns |
|---|---|
| `spec_nav_map` | every line matching a regex, across every project and every language, with the enclosing function |
| `spec_nav_callers` | every call site of a symbol, with its enclosing function **and that function's parameters** (TypeScript) |
| `spec_nav_services` | the projects found under the root |

### `spec_nav_map`

```
{ "pattern": "handl(e|ing)_?fee|handling_charge|HANDLING_FEE" }
```

```
pattern: handl(e|ing)_?fee|handling_charge|HANDLING_FEE
scanned: admin, storefront, services/customer, services/order, worker
languages: go, python, typescript
492 hits in 83 files

Format:  line | enclosing function | source

services/order/src/utils/calculate-product-fee.ts
  1 | - | export const PRODUCT_HANDLING_FEE_JPY = 300;
  27 | calculateProductFee:17 | total += PRODUCT_HANDLING_FEE_JPY;
  63 | calculateStoreFee:41 | total += PRODUCT_HANDLING_FEE_JPY;

worker/billing.go
  3 | - | const HandlingFee = 300
  6 | Order.Total:5 | return o.Subtotal + HandlingFee
```

The enclosing function is what makes this more than a search result. A line
number tells you where something is; the function name tells you what it is part
of, which is what decides whether it matters.

Past a size budget the output keeps every file but shows only the first few
lines of each — knowing which services are involved is the point, and the detail
can come from reading the files that turn out to matter.

### `spec_nav_callers`

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
site, and this says which ones already have the value in scope and which need it
threaded down from their own caller. `argCount` tells you whether you can append
or must pass `undefined` in a middle slot.

Edit each file bottom-up — every insertion shifts the lines below it.

## Limits

- **Only the languages in the table above.** Swift, Kotlin and Lua are missing
  because they ship no prebuilt grammar; `.js`, `.mdx`, SQL, HTML and config
  files are not scanned at all. A file in an unsupported language does not
  appear in the map even when it contains the pattern, so use ordinary search
  when a change reaches into one. The `languages:` line in the output says what
  was actually read — worth a glance when a service you expected is absent.
- **`spec_nav_callers` is TypeScript only.** It resolves call sites through the
  TypeScript project; the other languages get `spec_nav_map`.
- **Reads the current checkout.** Line numbers follow the branch you are on, so
  switch branches before asking about another one.
- **`spec_nav_callers` matches by name, not resolved type.** Two methods called
  `save` on different classes come back in one list; read `file` and `enclosing`
  rather than trusting `total`.
- **Structure, not intent.** These tools say where something is and what
  surrounds it. Whether the change belongs there is still yours to decide.
- Line numbers go stale as soon as you start editing — re-run rather than
  trusting numbers from earlier in a session.

## License

MIT

# mcp-spec-nav

An MCP server for the two questions a coding agent should ask before it writes
or changes code in a repo with more than one service:

1. **Does this already exist somewhere?** An agent that searches where it
   expects the code to be finds what it expected. The fee calculation that
   already lives in `packages/shared`, or in the billing service under a
   different name, never comes up, so it gets written again, slightly
   differently.
2. **What does this change actually touch?** The callers in other services,
   the constant left at its old value, the screen nobody mentioned.

For the first, the server keeps a **catalog of every function** in the repo,
read from each file's syntax tree, across every project and fourteen
languages. An agent can search it by what the code does, read any candidate in
full, and check its callers before reusing or changing it. For the second,
`spec_nav_map` returns **every** line matching a pattern, each tagged with the
function it sits in, and `spec_nav_callers` resolves call sites through the
TypeScript type checker.

The catalog is complete and paged. Searches are ranked and lexical, and the
output always says which of the two you are looking at. No tool claims to
have covered the whole repo unless it did.

## What the map changes in practice

On a change that moved a fee constant across six codebases, the same work
planned with ordinary searching versus with `spec_nav_map`:

- the map found all seven files that mattered in one call; the search-by-search
  approach found them too, but only after twenty-eight separate searches, each
  one a guess about where to look next
- the resulting plan caught three things the search-only plan missed: a
  constant used in a mail template nobody had listed, a hardcoded value in an
  admin screen, and — the one that would have caused a bug — a `|| 300`
  fallback sitting inside `if (fee)` that can never run, two lines away from a
  different constant in the same file that genuinely did need changing

That comparison predates the function catalog. The catalog, search and read
tools have not yet been measured the same way.

## Install

No clone, no build:

```json
{
  "mcpServers": {
    "spec-nav": {
      "command": "npx",
      "args": ["-y", "github:khoitd-voyager/mcp-spec-nav"],
      "env": { "SPEC_NAV_ROOT": "/Users/you/code/your-repo" }
    }
  }
}
```

**Replace `SPEC_NAV_ROOT` with your own absolute path before starting.** It is
the directory to scan, and the one thing here that cannot be guessed. The
server refuses to scan a path that does not exist rather than reporting zero
matches, which would read exactly like a repo where the pattern is absent.

For Claude Code that block goes in `.mcp.json` at your project root. Restart,
then `/mcp` should list `spec-nav`. Check it with `spec_nav_services`: it prints
the root it resolved, the projects it found and how many files and functions
each holds, so a wrong path shows up before it costs you a plan built on an
empty result.

### Local checkout

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav && cd mcp-spec-nav
npm install && npm run build
```

Then `"command": "node", "args": ["/path/to/mcp-spec-nav/dist/index.cjs"]`.

Use this form while developing the server: `npx github:` installs the committed
`dist/`, so changes you have not pushed are not what runs.

### When a scan comes back empty

`scanned: NOTHING` means no project was searched, which is not the same as the
pattern being absent. In order of likelihood:

1. **`SPEC_NAV_ROOT` is wrong.** Run `spec_nav_services` to see the root it
   actually resolved.
2. **More than one `.mcp.json`.** A config at the directory you opened and
   another at the repo root are different files; the one being read may not be
   the one you edited.
3. **The code is in a language that is not supported.** Every listing has a
   `coverage:` line that counts source files in unsupported languages
   (`.vue`, `.kt`, `.sql`, …). Those files are never searched.

## Telling your agent to use it

Having the tools available is not enough. An agent reaches for the search it
has always used unless something tells it otherwise. Put this in `CLAUDE.md`,
`AGENTS.md`, a cursor rule, or whatever your client reads:

```markdown
## Before writing or changing logic

Scale this to the change. A typo, a rename inside one function or a config
tweak needs none of it. New logic, or a change to a function other code
depends on, does.

1. **Look for what already exists.** Before writing a new function, call
   `spec_nav_find_functions` with what it should do, in words:
   `spec_nav_find_functions({ query: "calculate order fee" })`. It searches
   every service. Results are ranked by matching words, not by meaning, so if
   nothing fits, try one or two other wordings before concluding it does not
   exist.
2. **Read the likely candidates, not everything.** `spec_nav_read_function`
   with a candidate's `id` returns its full source, doc comment and the
   imports it uses. Read the two or three that look right. Do not page
   through the whole catalog or read every match.
3. **Decide whether it can be reused.** A function in another service is not
   automatically importable. Check that the calling service already depends
   on (or may depend on) the owning package, that it is exported, and that it
   handles your case in every branch. If it almost fits, prefer extending it
   (and its callers) over writing a near-copy.
4. **Survey what the change touches.** Before changing a signature or
   behaviour, `spec_nav_callers` lists the call sites (TS/JS), each with its
   enclosing function and parameters. For a constant, string or concept that
   spans services or languages, call `spec_nav_map` **once** with a wide regex
   that folds every spelling into one pattern:
   `spec_nav_map({ pattern: "handl(e|ing)_?fee|HANDLING_FEE" })`.
   If a result says MORE, fetch the next page with its `cursor` before
   concluding you have seen everything. If `exhaustive` is false or coverage
   says PARTIAL, check the listed gaps by other means.
5. **Make the change, then verify.** Re-run the callers or map query for what
   you changed, and run the project's tests. Line numbers and ids from before
   your edit are stale; ask again rather than reusing them.
```

The wording is deliberate. Without "once", agents treat the map as a search
engine and call it ten times. Without "not everything", they read whole
catalogs. And without the reuse check, a search hit gets imported across a
service boundary it should not cross.

## Tools

| Tool | Returns |
|---|---|
| `spec_nav_find_functions` | ranked functions whose name, class, signature, doc, path or body match the words of a query, across all services, with why each matched |
| `spec_nav_read_function` | one function in full: signature, doc, imports it uses, source with line numbers. Long ones come in parts |
| `spec_nav_functions` | the complete catalog of functions, filterable and paged, with a coverage report |
| `spec_nav_callers` | TS/JS call sites resolved by the type checker, each with its enclosing function and parameters; plus unresolved calls, interface calls and uses as a value |
| `spec_nav_map` | every line matching a regex, across every project and language, with the enclosing function; paged |
| `spec_nav_services` | the projects found under the root, with file and function counts |

Every listing tool accepts `services` (a project or any directory under the
root; `"."` is the root's own files) and returns pages. The new tools also take
`format: "json"` for structured output.

### `spec_nav_find_functions`

```json
{ "query": "calculate order fees" }
```

Output on the fixture repo used by the tests (abridged):

```
query: "calculate order fees" → words: calculate, order, fees
RANKED LEXICAL CANDIDATES, not a complete answer: 4 of 14 catalogued functions matched at least half the words (by name, class/module, signature, doc, path, body). …
services with candidates: services/billing, packages/shared, services/api
showing 1-4 — no further candidates
coverage: 12 files read (typescript 9, python 1, javascript 2). Every supported file in scope was parsed without errors.
Reading a candidate does not make it safe to import: check that the calling service may depend on the one that owns it before reusing it.

#1  score 14.7  services/billing/src/order.ts:9-9  (service services/billing, typescript)
    [function, exported] computeOrderFee
    sig: function computeOrderFee(order: Order): number
    id:  services/billing/src/order.ts::computeOrderFee@99639d47
    why: calculate→name(synonym:compute)  order→name  fees→name(stem:fee)
    doc: Fee charged on each order.
#2  score 9.6  packages/shared/src/fees.ts:2-2  (service packages/shared, typescript)
    [function, exported] calculateShippingFees
    sig: function calculateShippingFees(weight: number)
    id:  packages/shared/src/fees.ts::calculateShippingFees@53c1f6b8
    why: calculate→name  fees→name
…
```

Identifiers are split on camelCase and snake_case. Words match exactly, by
stem (`fees`/`fee`), by prefix of four or more letters (`calc`/`calculate`),
or through a short fixed list of verbs code uses interchangeably
(`calculate`/`compute`, `get`/`fetch`/`load`, `delete`/`remove`, …). A
candidate must match at least half the query's words, at least one of them
outside the function body. Nothing is sent to an external service and no API
key is needed. It does not understand meaning: a function that does the job
under unrelated words (`applySurcharge` for "add fee") only shows up if one of
those listed equivalences or its doc comment bridges the gap.

### `spec_nav_read_function`

```json
{ "id": "services/billing/src/order.ts::computeOrderFee@3be01c2a" }
{ "file": "services/billing/src/order.ts", "name": "Order.total" }
{ "file": "src/dup.ts", "name": "run", "line": 42 }
```

Returns the signature, the whole doc comment, the imports the function uses
(for TS/JS, the import declarations whose names appear in the body; for other
languages, best-effort), and the source with line numbers. A function longer
than one part (400 lines or ~26k characters by default) ends with
`MORE: call again with the same id and fromLine=N`. Nothing is cut silently.

An id is `file::QualifiedName@hash`, where the hash is of the function's own
text. Editing elsewhere in the file keeps the id valid (it is read at its new
position). Editing the function itself, or deleting it, makes the id stale, and
the read answers `STALE ID` with the current id rather than showing you
different code from what you were looking at.

### `spec_nav_functions`

```json
{ "services": ["services/api"], "name": "fee", "kind": "method", "limit": 200 }
```

Illustrative output:

```
functions: 37 match the filters — this page 1-37 — COMPLETE (no further pages)
coverage: 812 files read (typescript 500, javascript 12, python 300). PARTIAL: 1 file(s) with syntax errors (their function lists may be incomplete); 14 source file(s) in unsupported languages not read (.vue 10, .sql 4). 41 dependency/build/virtualenv directories excluded by design. 950 inline anonymous function(s) (callbacks) have no name and are not listed.
  syntax error: services/api/src/broken.ts:12 — '}' expected.

services/api/src/fees.ts  (service services/api, typescript)
  12-40 [method, exported] OrderService.calculateFee
      sig: calculateFee(order: Order, rate?: number): number
      id:  services/api/src/fees.ts::OrderService.calculateFee@1a2b3c4d
      doc: Calculates the handling fee for one order.
```

Filters: `file` (substring, or a glob with `*`), `name` (substring of the
qualified name, or `/regex/`), `kind`, `language`, `exportedOnly`. Each entry
has a qualified name (`Class.method`, `module.fn`, `outer.inner`), kind
(function, nested function, method, constructor, getter, setter, property,
arrow function, function expression), signature, parameters, return type when
the source states one, export/visibility when the language makes it
knowable, line range and doc comment (cut at 240 characters and marked when
cut).

Pages use a cursor that resumes after the last item returned, so a page is
never repeated or skipped. A cursor only works with the arguments that
produced it. If files change between pages, the next page says so.

### `spec_nav_callers`

```json
{ "symbol": "Order.total" }
{ "symbol": "total", "className": "Cart" }
{ "symbol": "computeFee", "file": "packages/shared/src/fees.ts" }
```

Output on the test fixture (abridged):

```json
{
  "symbol": "Order.total", "total": 2, "exhaustive": false,
  "totals": { "resolved": 2, "viaInterfaceOrBase": 1, "references": 0, "unresolved": 1, "otherSymbolsSameName": 1 },
  "targets": [{ "name": "Order.total", "file": "services/billing/src/order.ts", "line": 3, "kind": "method" }],
  "sites": [{
    "file": "services/api/src/checkout.ts", "line": 5,
    "enclosing": "checkout", "enclosingLine": 4, "enclosingParams": ["o", "c"],
    "snippet": "o.total()", "argCount": 0, "resolution": "resolved", "target": "Order.total"
  }, …],
  "viaInterfaceOrBase": [{ "file": "services/api/src/checkout.ts", "line": 8, "snippet": "t.total()", "reason": "bound to Totaler.total (interface)", … }],
  "unresolved": [{ "file": "services/web/src/legacy.js", "line": 1, "snippet": "order.total()", "reason": "receiver type unknown (untyped JS, `any`, or unresolved import)", … }],
  "otherSymbolsSameName": { "Cart.total (services/billing/src/order.ts:6)": 1 },
  "notAnalyzedOtherLanguages": { "count": 1, "files": ["services/py/totals.py"] },
  "notes": ["…", "Not counted anywhere: dynamic calls (obj[name]()), calls in unsupported file types, and code outside the repo. So this is NOT a complete list of call sites."]
}
```

Every call by the target's name (or an alias of it) is resolved to the
declaration it binds to. That covers `import { x as y }`, re-exports under
another name, namespace imports, default imports, workspace packages imported
by name (resolved to their source, not their build), and each file's own
`tsconfig.json`/`jsconfig.json` `paths`. Calls that bind to a different
declaration (another class's `total`) are excluded and counted. Calls the
checker cannot resolve are listed as `unresolved`, not counted as callers.
`exhaustive` is true only when nothing was left unresolved and no file in
another language mentions the name.

`enclosingParams` is what you need when adding a parameter: which sites
already have the value in scope, and which need it threaded down from their
own caller. `argCount` tells you whether you can append or must pass
`undefined` in a middle slot. Edit each file bottom-up, since every insertion
shifts the lines below it.

`service` narrows which declaration is meant. Call sites are searched
repo-wide (narrow with `searchServices`). If the symbol is not declared in
that `service`, the declarations elsewhere are used and a note says so.

### `spec_nav_map`

```json
{ "pattern": "handl(e|ing)_?fee|handling_charge|HANDLING_FEE" }
```

Illustrative output:

```
pattern: handl(e|ing)_?fee|handling_charge|HANDLING_FEE
scanned: 2140 files in 6 project(s): ., admin, services/customer, services/order, storefront, worker
languages with hits: go, python, typescript
492 hits in 83 files — this page: hits 1-310 — MORE: call again with the same pattern and cursor="…"

All files with hits (count | file):
    12 | services/order/src/utils/calculate-product-fee.ts
     …

Format:  line | enclosing function:its line | source

services/order/src/utils/calculate-product-fee.ts  (12 hits)
  1 | - | export const PRODUCT_HANDLING_FEE_JPY = 300;
  27 | calculateProductFee:17 | total += PRODUCT_HANDLING_FEE_JPY;
```

The enclosing function is what makes this more than a search result: a line
number tells you where something is, the function name tells you what it is
part of. Pages are cut at about 30k characters (or `pageSize` hits). When there
is more than one page, the first lists every file with its hit count (if that
list fits), so which services are involved is visible at once. Source lines
longer than 160 characters are shortened and end with `…`.

## How the repo is read

- **Projects at any depth.** A directory is a project when it holds a
  manifest for a supported language (`package.json`, `tsconfig.json`,
  `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`,
  `composer.json`, a `.csproj`, …) or a `src/`. The walk has no depth limit
  and continues into projects, so a project nested inside another is its own
  service.
- **Each file belongs to exactly one service:** the innermost project holding
  it. Files at the root outside every sub-project (a root `src/` next to
  `services/`) belong to `"."`. No file is listed twice.
- **Excluded:** `node_modules`, `dist`, `build`, `.next`, `vendor`, `target`,
  `coverage`, hidden directories, Python virtualenvs (recognised by
  `pyvenv.cfg`, not by name), `bin/`/`obj/` only next to a .NET project file,
  and `packages/` only when it is a NuGet folder (`.nupkg` or
  `repositories.config`). A JS monorepo's `packages/` is read. Minified `.js`
  and files over 1.5 MB are skipped and listed in coverage.
- **Always current.** Every call re-walks the tree and checks each file's
  modification stamp; changed files are re-parsed, deleted ones forgotten. A
  file added, edited or removed while the server runs is reflected on the next
  call, in the catalog, the map and the callers alike.

## Languages

| Language | Extensions | Names you get |
|---|---|---|
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | `OrderService.calculateFee`, arrow functions by the variable or property they are assigned to |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | same as TypeScript, plus `module.exports.x =`, `exports.x =` and `Foo.prototype.x =` |
| Python | `.py` `.pyi` | `OrderCalculator.compute_total`, docstrings included |
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

TypeScript and JavaScript are parsed with the TypeScript compiler's own parser
(and type-checked with ts-morph for `spec_nav_callers`). The rest use
tree-sitter grammars, loaded from disk the first time a file needs them, so a
method keeps the name its language gives it rather than one guessed from
indentation.

## Limits

- **Search is lexical.** `spec_nav_find_functions` matches words, stems,
  prefixes and a short synonym list, not meaning. An empty or thin result is
  not proof that nothing reusable exists. Try other wordings, filter
  `spec_nav_functions` by file or name, or use `spec_nav_map`.
- **Reusability is not checked.** Nothing here decides whether service A may
  import from service B. Dependencies, package boundaries and ownership are
  yours to check.
- **`spec_nav_callers` resolves TypeScript and JavaScript only.** Other
  languages are reported as files mentioning the name, not analysed. Plain JS
  with untyped receivers (`order.total()` where `order` is a parameter) cannot
  be resolved and comes back as `unresolved`. Dynamic calls (`obj[name]()`)
  are not found at all.
- **Anonymous functions are not catalogued.** An inline callback has no name to
  reuse. They are counted in coverage, and a line inside one is attributed to
  the named function around it.
- **Unsupported languages** (Vue/Svelte single-file components, Kotlin, Swift,
  SQL, templates, …) are not read. They are counted in coverage so their
  absence is visible.
- **Return types** are reported only when the source states them. Nothing is
  inferred.
- **Cost on large repos.** On a synthetic repo of 5,000 files and about 80,000
  functions, the first catalog call took about 1.5 s and later ones about
  0.05 s, a search about 0.6 s, and the server held about 400 MB. The first
  `spec_nav_callers` call builds a type-checked project of every TS/JS file:
  about 3 s there, about 1.2 s afterwards, and about 1.2 GB resident.
- **Reads the current checkout.** Switch branches before asking about another
  one. Ids and line numbers go stale as soon as you edit, so ask again rather
  than reusing them.

## Development

```bash
npm run typecheck
npm test        # builds dist/, then runs every test against it over MCP stdio
```

The tests start the built `dist/index.cjs` as a real MCP server over stdio and
call it the way a client does, on fixture repos generated per test.

## License

MIT

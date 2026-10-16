# Tool reference

[English](tools.md) · [Tiếng Việt](tools.vi.md) · [简体中文](tools.zh-CN.md)

← [README](../../README.md) · [Installation](installation.md) · [Troubleshooting](troubleshooting.md)

These are MCP tool arguments, not terminal commands. Your agent calls them for you. Replace the example paths and function names with real results from your repository.

| Tool | Use it when you want to… |
|---|---|
| `spec_nav_services` | Check the scan root, discovered projects, counts and coverage. |
| `spec_nav_find_functions` | Find ranked candidates for existing logic across services. |
| `spec_nav_similar_functions` | Find functions that behave like a candidate or a draft, whatever they are named. |
| `spec_nav_read_function` | Read the exact source and context of one candidate, or up to 10 in one call. |
| `spec_nav_functions` | Browse the function catalog with filters and pagination. |
| `spec_nav_callers` | Inspect calls, references, dynamic uses and unresolved usages before a change. |
| `spec_nav_map` | Find regex matches with the enclosing function. |
| `spec_nav_trace_flow` | Follow HTTP, RPC and event links between services, upstream or downstream, with evidence and what is unresolved. |

Common arguments:

- `services` — limit to these services/directories, relative to `SPEC_NAV_ROOT` (for example `"services/api"`, `"packages"`). `"."` selects the root project's own files. Omit it to cover the whole repository (the default).
- `cursor` — the `nextCursor` from the previous page. Repeat the other arguments unchanged.
- `format` — `"text"` (default, compact) or `"json"` (structured).

## `spec_nav_services`

```json
{}
```

Lists the projects under the root (any depth) as `service` values the other tools accept, with file and function counts per project and a coverage summary. Call it when unsure what to pass, or to check that `SPEC_NAV_ROOT` points at the right repository.

## `spec_nav_find_functions`

```json
{ "query": "calculate order fees", "limit": 20 }
```

Results include function IDs and reasons for matching. Names, export aliases, signatures, documentation, paths, the names each function calls and, by default, bodies are searched; rarer words weigh more.

Other arguments: `services`, `file` (path substring or `*` glob), `language`, `searchBodies` (default `true`; `false` drops body-only matches), `limit` (default 20, max 100), `cursor`, `format`.

## `spec_nav_similar_functions`

```json
{ "code": "function shippingCost(order) { const km = distanceKm(order.from, order.to); return round(km * zoneRate(order.zone), 2); }" }
```

Or `{ "id": "<id>" }` (or `file` + `name`, optionally `line`) for an existing function. It compares the calls and body vocabulary of every function, ignoring names.

Other arguments: `services`, `inFile`, `language`, `minScore` (default 0.2), `limit` (default 10, max 100), `cursor`, `format`.

## `spec_nav_read_function`

```json
{ "file": "services/billing/src/fees.ts", "name": "calculateFee" }
```

Use a real path/name from your results, or pass `{ "id": "<id returned by the tool>" }`. `name` can be qualified (`OrderService.calculateFee`), short, or a name the function is exported under; add `line` to pick among same-named functions. The output includes the signature, the whole doc comment, the imports the function uses and its exact source with line numbers.

For long functions, continue with the returned `nextCursor` as `cursor` (or `fromLine`); `maxLines` sets the lines per part (default 400). Nothing is cut silently.

Read up to 10 functions in one call with `functions`:

```json
{ "functions": [
  { "file": "services/billing/src/fees.ts", "name": "calculateFee" },
  { "id": "<id returned by the tool>" }
] }
```

The functions share one page: each gets an even share of what is left, so short ones leave room for longer ones. A function that does not fit ends with its own `nextCursor`, read on with a single-function call (`{ "cursor": "…" }`). One that is not found, is ambiguous or is stale is reported in its place; the others are still read.

## `spec_nav_functions`

```json
{ "services": ["services/api"], "name": "fee", "limit": 100 }
```

Omit `services` to cover all discovered projects. `services: ["."]` selects the root project's own files. Filters include `file`, `name` (case-insensitive substring of the qualified name, or `/regex/`), `kind` (for example `method`, `function`, `constructor`, `arrow`), `language` and `exportedOnly`. `limit` defaults to 200 (max 1000).

## `spec_nav_callers`

```json
{ "symbol": "calculateFee", "file": "services/billing/src/fees.ts", "format": "json" }
```

Use a qualified name such as `OrderService.calculateFee`, `className`, or a declaration `file` to disambiguate targets. `service` narrows the declaration; `searchServices` narrows where callers are searched. `limit` defaults to 100 sites per page.

TypeScript/JavaScript (and Vue/Svelte/Astro scripts and templates) are resolved with the TypeScript type checker. Other supported languages are bound by evidence — same file/class, qualifier, import or alias, package, or a receiver declared with the class's type — and each site's `reason` says which. Every site includes its enclosing function, that function's parameters and the argument count.

The output is always JSON (indented by default; `format: "json"` returns it on one line). Its `notes` state what is not counted: names computed at runtime, calls through HTTP/RPC/queues, unsupported file types and code outside the repository. To follow HTTP, RPC and event links between services, use [`spec_nav_trace_flow`](#spec_nav_trace_flow).

## `spec_nav_map`

```json
{ "pattern": "handl(e|ing)_?fee|handling_charge|HANDLING_FEE" }
```

Matching is case-insensitive. Comment/import lines are skipped by default; set `includeComments: true` to include them. Other arguments: `services`, `cursor`, `pageSize` (pages are also cut at ~30k characters).

## `spec_nav_trace_flow`

```json
{ "file": "web/src/api.ts", "name": "placeOrder" }
```

Follows what the function reaches. `{ "endpoint": "POST /orders", "direction": "upstream" }` lists who reaches a route, `{ "topic": "order.created" }` a topic's consumers, `{}` every link found.

Start from a function (`id`, or `file` + `name`, optionally `line`), an `endpoint` (`"GET /api/orders/:id"` or `"/orders/42"`) or a `topic` (event, topic or RPC pattern). Other arguments: `direction` (`downstream` by default, `upstream` or `both`), `maxDepth` (default 6, max 20), `followCalls` (follow direct calls inside a service, default `true`), `includePartial` (follow `partial` links, default `true`), `limit` (steps per page, default 30), `cursor`, `format`.

Supported frameworks, link statuses, confidence and coverage gaps: [Trace flows across services](flows.md).

## Reading the results

- **Pagination:** `MORE` or `nextCursor` means more results are available. Repeat the same query with that cursor. Completion of pagination is separate from completeness of source coverage.
- **Coverage:** `PARTIAL` means some source files were unsupported, unreadable, skipped or had parse errors. Inspect those gaps with other tools.
- **Search:** Results are ranked lexical matches with labelled evidence, not semantic understanding. Matches only through called names are marked `[via calls]`, body-only matches `[body only]`; both rank lower. Broad body-only matches can be withheld as noise; the output reports that count.
- **Similar:** A high similarity means the code looks alike (same calls, same vocabulary), not that it is interchangeable.
- **Callers:** Each site says how it was bound. Review sites outside `resolved`:
  - `likely` — only one declaration has that name, but the binding is unproven;
  - `ambiguous` — several declarations could match;
  - `dynamic` — the name is used as a string or symbol (`getattr`, `send(:x)`, reflection, event names);
  - `unresolved` — the target could not be determined.

  Do not treat these as confirmed callers. Even `exhaustive: true` (type-checked targets only) does not cover names computed at runtime, calls over HTTP/RPC/queues or external repositories.
- **Flows:** `spec_nav_trace_flow` is static: a link is inferred from code, never observed. `partial` (part of the key is configuration), `ambiguous` (several targets, none chosen) and `unresolved` (the key is computed) are leads to check by hand; the `gaps` line lists what was not analysed. See [link statuses](flows.md#link-status-and-confidence).
- **Freshness:** Added, edited and deleted source files are reflected on subsequent calls. Function IDs depend on their source text; look up a changed function again if a read reports `STALE ID`.

# mcp-spec-nav — MCP Server for AI Code Search and Navigation

[English](README.md) · [Tiếng Việt](README.vi.md) · [简体中文](README.zh-CN.md)

[![mcp-spec-nav — Give your agent a map of your code.](docs/assets/social-preview.png)](https://khoitd-voyager.github.io/mcp-spec-nav/)

`mcp-spec-nav` is a local MCP server for AI coding agents such as Claude Code. It reads the source code of the repository you choose and lets the agent:

- **find existing functions** across services and shared packages — by words, by what they call, or by behavioural similarity to a draft;
- **read a function** exactly: source, signature, documentation and the imports it uses;
- **find callers** before a change — type-checked in TypeScript/JavaScript/Vue, evidence-based in Python, Go, Java, Kotlin, Swift and other languages, with dynamic uses listed;
- **map a pattern** across supported source files, with the enclosing function of each match;
- **trace flows across services** from source code — HTTP client → route → handler, RPC call → handler, event/topic → consumers — with the evidence for each link and what could not be resolved (static analysis, [supported frameworks](docs/guide/flows.md#supported-frameworks)).

**The problem it addresses:** before writing new logic or changing a function, an agent needs to know what already exists and what depends on it. With grep alone it can miss code written under other names, rewrite logic that already exists, or edit same-named calls on another class.

The MCP only reads code. Your coding agent decides what to reuse, edits the files and runs the tests. The MCP does not guarantee that every related function will be found.

## When it helps

| Scenario | Value of the MCP |
|---|---|
| Logic is spread across multiple services | High: searches broadly and helps reduce missed code. |
| You want to reuse functions instead of rewriting them | High, when the query finds the right candidates. |
| You change function parameters and need to find callers | Useful. |
| You follow a request or event from one service to another | Useful for the supported frameworks: static links with evidence; unknowns are reported, not guessed. |
| You make a simple edit within one file | Limited benefit; may add tool calls. |

Every model turn with the MCP installed also carries its tool definitions (~3.8k tokens in the benchmark), so on small, single-concept changes the gain is small.

## Example: change an order fee

[docs/examples/order-fee](docs/examples/order-fee/) is a runnable four-file example. Task: raise the handling fee from 5 to 7 and let every caller waive it. The output below comes from running the tools on [`before/`](docs/examples/order-fee/before/), trimmed.

**1. Find existing logic** — MCP, `spec_nav_find_functions` with `{ "query": "order handling fee total" }`:

```text
#1  score 3.05  billing/fees.ts:35-43  (service ., typescript)
    [function, exported] calculateTotal
    why: handling→body  fee→path(stem:fees)  total→name
```

**2. Read the implementation** — MCP, `spec_nav_read_function` with `{ "file": "billing/fees.ts", "name": "calculateTotal" }`:

```text
35| export function calculateTotal(subtotal) {
39|   const handlingFee = HANDLING_FEE;
42|   return subtotal + handlingFee;
43| }
```

**3. Find every caller** — MCP, `spec_nav_callers` with `{ "symbol": "calculateTotal", "file": "billing/fees.ts" }`:

```text
"total": 3, "exhaustive": true,
"targets": [{ "file": "billing/fees.ts", "line": 35, "resolvedBy": "type checker" }],
"sites": [
  { "file": "billing/previewInvoice.ts", "line": 3, "enclosing": "previewInvoice", "resolution": "resolved" },
  { "file": "checkout/createOrder.ts", "line": 3, "enclosing": "createOrder", "resolution": "resolved" },
  { "file": "orders/updateOrder.ts", "line": 3, "enclosing": "updateOrder", "resolution": "resolved" }
```

**4. Follow it across services** — MCP. `spec_nav_callers` counts direct calls only and says so: calls through HTTP/RPC/queues are not counted. In the multi-service example [docs/examples/order-flow](docs/examples/order-flow/), `spec_nav_trace_flow` with `{ "file": "services/checkout/src/handlers/createOrder.ts", "name": "createOrderHandler", "direction": "both" }` shows who reaches the handler and where the total goes:

```text
steps: 5 (5 resolved) — this page 1-5 — COMPLETE
gaps: none found among the supported adapters.
#1  d1 ↑ HTTP  POST http://checkout:3000/api/orders → POST /api/orders   [resolved · high]
    from  services/storefront/src/checkout-client.ts:3  submitOrder
#2  d1 ↓ call  createOrderHandler → calculateTotal   [resolved · high]
#4  d2 ↓ EVENT event order.created → event order.created (kafka)   [resolved · medium]
    to    services/invoicing/src/consumer.ts:12  handleOrderCreated
```

**5. Edit the code** — coding agent: sets `HANDLING_FEE` to 7, adds an `options` parameter to `calculateTotal`, and forwards `waiveHandlingFee` from the three callers. The result is in [`after/`](docs/examples/order-fee/after/).

**6. Run the tests** — coding agent:

```bash
node --test docs/examples/order-fee/verify.mjs   # 6 tests pass
```

## Quick start (Claude Code)

**Requirements:** Node.js 18+, npm/npx, Git, and a local checkout of the repository to scan. The first installation needs network access.

**1.** Create `.mcp.json` at the root of the target repository. If it already exists, add the `spec-nav` entry to its `mcpServers` and keep the other servers.

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

Replace `/Users/you/code/your-repo` with the **absolute path of the code to scan** (the monorepo root to cover every service) — not the installation directory of `mcp-spec-nav`.

**2.** Open Claude Code in that repository, restart the session, run `/mcp` and check that `spec-nav` is connected. Approve the configuration if your client asks.

**3.** Send Claude:

```text
Use spec-nav to list the services in this repository.
Show the resolved repository root and any files it could not scan.
```

Check that the root and services match your project before continuing.

**4.** Try a real task:

```text
I want to add a parameter to calculateFee. Use spec-nav to find its declaration,
read the implementation and check its callers before planning the change.
Report any callers you could not resolve.
```

Installing an MCP makes its tools available; it does not ensure the agent uses them. Add the [`CLAUDE.md` section](docs/guide/installation.md#make-claude-use-it-during-normal-coding) so Claude uses them during normal coding. More prompts, the Claude Desktop extension (no Node.js needed) and installing from a local checkout: [Installation](docs/guide/installation.md).

## Tools

| Tool | Use it when you want to… |
|---|---|
| `spec_nav_services` | Check the scan root, discovered projects, counts and coverage. |
| `spec_nav_find_functions` | Find ranked candidates for existing logic across services. |
| `spec_nav_similar_functions` | Find functions that behave like a candidate or a draft, whatever they are named. |
| `spec_nav_read_function` | Read one candidate's exact source and context. |
| `spec_nav_functions` | Browse the function catalog with filters and pagination. |
| `spec_nav_callers` | Inspect calls, references, dynamic uses and unresolved usages before a change. |
| `spec_nav_map` | Find regex matches with the enclosing function. |
| `spec_nav_trace_flow` | Follow HTTP, RPC and event links between services, upstream or downstream, with evidence and what is unresolved. |

Arguments, JSON examples, pagination, coverage and result statuses: [Tool reference](docs/guide/tools.md).

## Supported languages

TypeScript, JavaScript, Python, Go, Java, C#, Ruby, Rust, PHP, C, C++, Scala, Elixir, Bash, Kotlin, Swift, and Vue/Svelte/Astro components (script blocks). Callers are **type-checked in TS/JS/Vue/Svelte/Astro** and **evidence-based in every other supported language**. Cross-service flows are traced for TypeScript/JavaScript and Python frameworks only. Extensions and parsing details: [Supported languages](docs/guide/languages.md).

## Benchmark

**No benchmark with a live LLM has been recorded.** All results below come from **simulated agents**: deterministic policies, not an LLM, so the differences come from the tools. One agent has only Grep/Read/Edit (like Claude Code's built-in tools), the other has spec-nav plus Read/Edit. The no-MCP side is given an LLM's synonym knowledge and the same generous scoring. Each session is a whole feature request: reuse existing logic, change a function's signature and update every caller, change a constant everywhere, then read and edit every file. Repositories: a seeded synthetic monorepo (answers planted by the generator) and immich@cc7fd67 (answers from TypeScript `findReferences`, doc comments and ripgrep). Tokens are estimated at 3.5 characters/token.

| | Synthetic, 100 sessions | Synthetic, 50 large sessions | immich (real), 20 sessions | immich (real), 10 large sessions |
|---|---:|---:|---:|---:|
| Context per session, no MCP → MCP | 31k → 24k (−25%) | 92k → 71k (−24%) | 116k → 98k (−16%) | 302k → 227k (−25%) |
| …of which search phase | −57% | −55% | −70% | −69% |
| Input tokens with prompt caching | −18% | −26% | −16% | −38% |
| Tool calls (model turns) | −10% | −9% | −2% | −20% |
| Existing function reused | 97% → 99% | 90% → 95% | 55% → 90% | 40% → 93% |
| Callers complete, nothing extra | 100% → 100% | 100% → 100% | 85% → 90% | 53% → 73% |
| Wrong edits per session | 0 → 0 | 0 → 0 | 0.3 → 0.2 | 14.4 → 2.4 |
| Session fully correct | 97% → 99% | 70% → 86% | 50% → 85% | 0% → 30% |
| Tool time incl. MCP cold start | +4.1 s | +6.1 s | +3.2 s | +6.6 s |

Reading what you will edit costs the same either way; the saving is in the search phase. Quality gains come from finding code under other names (reuse) and from not editing same-named calls on other classes (callers).

**Large repository** — VS Code (14,306 files, ~4.5M lines, 154k catalogued functions), Apple M4: first index 31 s, then `find_functions` 2.6–4.3 s, `map` 0.5–1.8 s, `similar_functions` 0.9 s, `read_function` 0.15 s; `callers` 16 s for an ordinary function, 90 s and 3 GB RAM for a name mentioned in 822 files (`readFile`). Server memory 0.7–0.9 GB outside `callers`.

**Cross-service flows** (no agent, no LLM) — `spec_nav_trace_flow` on generated repositories (14 services each, 5 held-out seeds, 598 labelled call sites): 100% precision with 0 wrong links (linking by name only: 136 wrong links), 84% recall — every miss is a call made through a wrapper function or `urljoin`, which the adapters do not follow. First call ~0.1 s (0.7 s on a 1,000-file repository), then 1–10 ms per call. The generator and the adapters share an author, so this checks the linking rules, not coverage of real code.

Method, assumptions and limitations: [bench/README.md](bench/README.md#english). Reports: [synthetic](bench/results/synthetic-150-sessions.md#english) · [immich](bench/results/real-immich-30-sessions.md#english) · [VS Code timings](bench/results/perf-vscode.md) · [flows](bench/results/flow-test.md#english) · [all results](bench/results/).

## Limits

- **Search is lexical.** Words, called names, abbreviations, synonym and concept lists, IDF. `spec_nav_similar_functions` finds same-behaviour code under unrelated names only when it shares calls or vocabulary; two implementations with nothing in common are missed. Results are candidates, not proof that nothing else exists.
- **Translation.** Vietnamese written with diacritics is matched through a built-in dictionary of ~100 common domain terms; other words are not translated. Use English keywords for English-named code.
- **Reuse.** Check exports, behavior and package/service dependencies yourself.
- **Callers.** Outside TS/JS, binding is by evidence (imports, qualifiers, declared receiver types), not a type checker: inferred types, inheritance and overloads can leave sites `likely`/`ambiguous`. Names built at runtime, HTTP/RPC/queue calls and external repositories are not traced by `spec_nav_callers` (for HTTP/RPC/events between services, see `spec_nav_trace_flow`).
- **Flows.** Static, from source: links are inferred, never observed, and only for the [supported frameworks](docs/guide/flows.md#supported-frameworks). Not traced: gRPC, GraphQL, WebSockets, other queues (BullMQ, RabbitMQ, SQS…), Go, Java and other languages, generated API clients, URLs built inside wrapper functions or with `urljoin`, service discovery and configuration other than docker-compose, and more — see [Not traced](docs/guide/flows.md#not-traced).
- **Function forms.** Inline anonymous callbacks are not individually catalogued (JS/TS counts them in coverage). JS/TS destructuring assignments, dynamic property assignments, factory-created functions, `Object.assign`/`Object.defineProperty` and some chained assignments are not fully covered. Other-language assigned lambdas/closures are not catalogued.
- **Files.** Dart, Lua, Objective-C, SQL and other unsupported source types are not parsed (they are counted in coverage). Dependency/build directories, hidden directories, virtualenvs, declaration files, minified JS and supported files over 1.5 MB are excluded.
- **Types.** Return types are reported when explicitly written; they are not inferred by the catalog.
- **Large repos.** Measured on VS Code (14k files): first index ~31 s, searches seconds. TS/JS callers type-check only files that mention the name, in batches, following imports two steps; for a very common name this takes minutes and ~3 GB, and calls whose receiver type lies further away are reported `unresolved`.
- **Dependencies.** TS/JS type resolution is best with dependencies installed (`node_modules`); without them, library types are unknown and more calls end up `unresolved`.

The server reads the current local checkout. No search API key is required, and its search does not send code to an external search service. Results are returned to your connected coding agent; that client's model/data handling settings still apply.

## Documentation

- [Installation](docs/guide/installation.md) — Claude Code, Claude Desktop extension, `CLAUDE.md` section, local checkout
- [Tool reference](docs/guide/tools.md) — arguments, JSON examples, reading the results
- [Trace flows across services](docs/guide/flows.md) — frameworks, link statuses, confidence, gaps
- [Supported languages](docs/guide/languages.md)
- [Troubleshooting](docs/guide/troubleshooting.md)
- [Development](docs/guide/development.md) — tests, packaging the extension, benchmarks, website
- [Benchmark method](bench/README.md#english) · [Website](https://khoitd-voyager.github.io/mcp-spec-nav/)

## License

MIT. See [LICENSE](LICENSE).

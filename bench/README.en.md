# Benchmark: with MCP vs without MCP

**English · [Tiếng Việt](README.md) · [简体中文](README.zh-CN.md)**

Compares an agent **without MCP** (only Grep/Read/Edit, like Claude Code's built-in tools) with an agent **with MCP** (spec-nav + Read/Edit) on the same tasks, in three settings:

| Script | Repository | Where the answers come from |
|---|---|---|
| `bench/run.mjs` | Synthetic monorepo, ~2,800 files, ~205k lines, 10 languages; 100 regular + 50 large sessions | Recorded by the generator as it plants the code |
| `bench/real.mjs` | Any real repository (run on immich) | Independent oracles: TypeScript's `findReferences`, doc comments, ripgrep |
| `bench/perf.mjs` | A very large repository (run on VS Code) | — measures time and RAM only |

```bash
npm run build
node bench/run.mjs                                   # 100 regular + 50 large sessions, writes bench/results/
node bench/run.mjs --sessions 20 --large-sessions 5  # faster
node bench/real.mjs --repo ~/code/your-repo --sessions 20 --large-sessions 10
node bench/perf.mjs --repo ~/code/huge-repo --symbols "SomeClass.someMethod"
node bench/report.mjs bench/results/<file>.json      # print a report again
```

Options for `run.mjs`: `--seed`, `--files-per-service` (repository size), `--base-context <tokens>` (adds system prompt/built-in tools to every turn, equally on both sides), `--pick <ids>`, `--from <n>`, `--repo <dir>`, `--regenerate`, `--out <dir>`. Requires `rg` (ripgrep) on PATH.

Recorded results: [bench/results/](results/) (reports are written in Vietnamese).

## Synthetic repository

`bench/generate.mjs` generates a seeded monorepo (re-running produces the same repository): 27 services/packages in TypeScript, JavaScript, Vue, Python, Go, Java, Kotlin, Swift, Ruby and PHP. Each service has ~90 files of noise code: functions named with shared business vocabulary (`computeCartFee`, `get_invoice_totals`…) that call each other — so that both grep and search run into noise as they would in a real repository.

On top of that, the generator plants the answers for each session and records their exact locations (`.bench-tasks.json`).

## One session = one feature request

> Feature request #8: in `services/inventory/…/refund_servicex.go`, add support for "calculate processing fee for a shipment". Reuse existing logic if the repo already has it. The change needs a new parameter on `NormalizeCouponCodeV7`: update every caller. The "risk quota" value also changes: update it everywhere it is defined, in every spelling.

A **large session** combines 3 such feature requests in one context (one big batch of changes): 50–120k tokens of context per session on the synthetic repository, 160–430k on the real one.

The agent works through four phases in a single context:

1. **Reuse** — find the function that already does the job. The target function is named at 5 levels: word match (`calculateShipmentProcessingFee`), synonym (`computeShipmentHandlingCharge`), abbreviation (`calcShipmentProcessingFeeAmt`), behaviour only (`settleShipmentMatrix12`, no doc), Vietnamese description. Decoy functions with near-identical names that do something else are present.
2. **Callers** — every place that calls the function whose signature changes: plain imports, aliases, namespaces, re-exports, callbacks, `obj["name"]()`, `getattr`, Vue templates, untyped JS receivers; plus traps: same-named methods on other classes, same-named local functions, other Go packages with a same-named function, the name inside comments/strings.
3. **Survey** — every file that defines a concept spelled several ways (`risk_quota`, `riskQuota`, `RISK_QUOTA`, `RiskQuota`), with mentions in comments as noise.
4. **Read + edit** — Read every file to be edited in full (Claude Code requires Read before Edit), then one Edit per change: the signature, each call site the agent found, each constant, and the new code (calling the existing function, or rewriting it if none was found). An extra edit = a wrong edit; a missing one = a bug.

A session is **fully correct** when it reuses the existing function, updates every caller with no extra sites, and changes every constant with no extra files.

## The two agents

Both are **deterministic policies**, not LLMs — so that measured differences come from the tools, not from model luck. They share the same reasoning rules wherever they do the same thing.

| | Without MCP | With MCP |
|---|---|---|
| Find function | Grep definitions with the distinctive nouns in the name (narrowing if > 60 lines), read the ≤ 5 best files; if none, count hits and read the top 3 files | `spec_nav_find_functions`, read the top 3 with `spec_nav_read_function`; if the request is in Vietnamese and results are weak, ask again in English; with no clear candidate, write a draft and call `spec_nav_similar_functions` |
| Callers | Grep `\bname\b`, follow `name as X` aliases, drop comments/imports/definitions; for a method with an unfamiliar receiver, Read 30 surrounding lines to guess the receiver type; for calls through another package, Read the top of the file for imports | `spec_nav_callers` (all pages); for `unresolved`/`ambiguous` sites, Read 30 surrounding lines with the same type-guessing rules |
| Survey | Grep the regex, drop comment lines, lockfiles and docs | `spec_nav_map` with the same regex, all pages; then Grep separately for file types spec-nav does not read (SQL, JSON, YAML…), as the CLAUDE.md instructions say |
| Edit | Read + Edit | Read + Edit |

**Advantages given to the no-MCP side** to avoid a straw man:
- It is handed synonyms and English translations that a good LLM would come up with itself (`shipping|shipment|delivery|freight`), whereas the MCP side only uses the dictionary built into the server.
- The same generous scoring for both: if the right code entered the context (was read) and shows at least one matching signal, the LLM is assumed to have recognised it.
- Grep has a `head_limit` of 250 lines and narrows its own queries — it does not dump thousands of lines into the context.

## Real repository (`bench/real.mjs`)

There is no generator to plant answers, so they come from sources independent of spec-nav:

- **Callers**: real TypeScript functions/methods with 3–30 references; answer = the TypeScript Language Service's `findReferences`, excluding the declaration itself, import/export lines and declarations of overrides in the same inheritance tree. A call site counts as matched when it is in the same file and within 3 lines (multi-line calls are reported on different lines by the two tools), matched 1-to-1, applied equally to both sides.
- **Reuse**: real functions with JSDoc/docstrings; task = the first sentence of the doc with every code identifier removed; answer = that function. The no-MCP agent is given the 4 rarest words of the task (the intuition of picking distinctive words) and no synonym list; the MCP agent has no code draft either, so it does not use `spec_nav_similar_functions`.
- **Survey**: two-word concepts with at least two spellings in the repository; answer = every file with a non-comment line matching the pattern, **including file types spec-nav does not read** (lockfiles and docs excluded).

Note when reading the immich results: the repository was cloned without installing `node_modules`, so types from external libraries (vitest, generated SDKs) are missing. Both the oracle and spec-nav are affected; most of the remaining "wrong edits" on the MCP side are same-named calls whose receiver type is unknown, which the agent keeps to be safe.

## What is measured

- Tokens: estimated at 3.5 characters/token, equally on both sides; each tool call adds 25 tokens of envelope. The definitions of the 7 MCP tools (~3.7k tokens) are added to **every turn** on the MCP side — the fixed cost of installing the MCP.
  - *final context*: everything that entered the session's context.
  - *cumulative input*: every turn resends the entire context (no cache).
  - *with prompt caching*: previously sent tokens read from cache ×0.1, newly written cache ×1.25.
- Tool time, including startup and first indexing of the MCP server (a fresh server per session — a cold start, as in a real session). Model thinking time is not counted; model turns = tool calls.
- 95% confidence intervals of the differences: paired bootstrap (same session, two modes).

## Limitations — read before quoting the numbers

- **The real repository is still only one repository.** immich is mostly TypeScript; callers on the real repository only measure TypeScript (the oracle is the TS compiler). Multi-language callers are only measured on the synthetic repository.
- **Not a real LLM.** An LLM may be smarter (understanding function bodies, switching strategies) or sloppier (skipping verification steps). The results describe what the *tools* can do under one usage policy, not a particular model.
- **Synthetic repository.** Noise code is more regular than real code; hard patterns (aliases, dynamic calls, same names) occur more densely than in practice. The generator was written by the same person as the MCP — the traps were chosen before running and not tuned to the results, but you should still cross-check with real tasks.
- **Tokens are estimates** based on characters, not the model's tokenizer.
- The no-MCP side's synonym knowledge is a fixed list; a real LLM may think of more or fewer.

To measure with a real model: use the same repository and `.bench-tasks.json`, run `claude -p "<session prompt>"` with and without `--mcp-config`, take `usage` from `--output-format json`, and score against the answers in the task file. That costs money per session; this benchmark is free and repeatable.

# Recorded benchmark summary: immich@cc7fd67

These are recorded deterministic-agent benchmarks, not live LLM sessions. Token counts are character-based estimates (3.5 characters/token). Both sides follow the benchmark policies described in the methodology; the baseline uses Grep/Read/Edit. Tool time includes a fresh MCP server per session and excludes model thinking time.

[Methodology and limitations](../README.en.md) · [Original full report (Vietnamese)](real-immich-30-sessions.md) · [JSON](real-immich-30-sessions.json)

## 20 standard sessions

### Quality

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| fully correct sessions | 50% | 85% | +35% | [+10%, +60%] |
| existing function reused | 55% | 90% | +35% | [+10%, +60%] |
| callers: recall | 100% | 100% | 0% | [0%, 0%] |
| callers: precision | 97% | 98% | +1% | [0%, +2%] |
| callers: complete and exact | 85% | 90% | +5% | [0%, +15%] |
| survey: recall | 100% | 100% | 0% | [0%, 0%] |
| survey: complete and exact | 100% | 100% | 0% | [0%, 0%] |
| wrong edits | 0.3 | 0.2 | −0.1 (−43%) | [−0.4, 0.0] |
| missed edits | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |

### Cost and tool time

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| tool calls (modeled turns) | 45.3 | 44.4 | −0.9 (−2%) | [−4.1, +1.6] |
| final session context tokens | 115,898 | 97,571 | −18,328 (−16%) | [−32,743, −8,145] |
|   of which: search phase | 25,757 | 7,623 | −18,134 (−70%) | [−32,474, −8,092] |
|   of which: read + edit | 90,142 | 89,948 | −194 (−0%) | [−737, +218] |
| cumulative input tokens (uncached) | 4,015,626 | 3,327,531 | −688,096 (−17%) | [−1,212,860, −261,611] |
| cache-adjusted equivalent input tokens | 534,846 | 449,308 | −85,538 (−16%) | [−151,342, −31,579] |
| output tokens (tool arguments) | 2,256 | 2,182 | −74 (−3%) | [−173, +11] |
| tool time including MCP startup (ms) | 123 | 3,289 | +3,166 (+2573%) | [+3,040, +3,309] |

### Context distribution

| Context tokens / session | Without MCP | With MCP |
|---|---:|---:|
| min | 22,426 | 29,632 |
| median | 93,206 | 79,180 |
| p90 | 191,248 | 172,458 |
| max | 213,097 | 180,813 |
| total over 20 sessions | 2,317,964 | 1,951,414 |
| total cache-adjusted input tokens | 10,696,910 | 8,986,151 |

## 10 large sessions

### Quality

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| fully correct sessions | 0% | 30% | +30% | [0%, +60%] |
| existing function reused | 40% | 93% | +53% | [+40%, +67%] |
| callers: recall | 94% | 99% | +5% | [−1%, +14%] |
| callers: precision | 77% | 92% | +16% | [+7%, +26%] |
| callers: complete and exact | 53% | 73% | +20% | [+7%, +33%] |
| survey: recall | 100% | 100% | 0% | [0%, 0%] |
| survey: complete and exact | 100% | 100% | 0% | [0%, 0%] |
| wrong edits | 14.4 | 2.4 | −12.0 (−83%) | [−25.5, −2.1] |
| missed edits | 1.3 | 0.3 | −1.0 (−77%) | [−3.1, +0.6] |

### Cost and tool time

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| tool calls (modeled turns) | 146.9 | 117.7 | −29.2 (−20%) | [−55.6, −7.6] |
| final session context tokens | 302,494 | 226,515 | −75,979 (−25%) | [−107,686, −47,230] |
|   of which: search phase | 67,345 | 21,188 | −46,157 (−69%) | [−60,850, −33,339] |
|   of which: read + edit | 235,149 | 205,327 | −29,822 (−13%) | [−63,501, −1,460] |
| cumulative input tokens (uncached) | 29,156,601 | 17,472,270 | −11,684,331 (−40%) | [−19,310,764, −5,607,984] |
| cache-adjusted equivalent input tokens | 3,263,528 | 2,012,067 | −1,251,461 (−38%) | [−2,050,084, −617,511] |
| output tokens (tool arguments) | 7,144 | 5,635 | −1,509 (−21%) | [−2,757, −542] |
| tool time including MCP startup (ms) | 358 | 6,935 | +6,577 (+1839%) | [+5,164, +8,497] |

### Context distribution

| Context tokens / session | Without MCP | With MCP |
|---|---:|---:|
| min | 238,575 | 156,835 |
| median | 302,305 | 230,502 |
| p90 | 337,446 | 275,078 |
| max | 399,815 | 275,499 |
| total over 10 sessions | 3,024,940 | 2,265,150 |
| total cache-adjusted input tokens | 32,635,283 | 20,120,673 |

The full report includes individual failure details. The real-repository evaluation covers one repository; callers are evaluated with a TypeScript oracle. Results do not establish universal performance.

# Recorded benchmark summary: Synthetic monorepo · seed 42

These are recorded deterministic-agent benchmarks, not live LLM sessions. Token counts are character-based estimates (3.5 characters/token). Both sides follow the benchmark policies described in the methodology; the baseline uses Grep/Read/Edit. Tool time includes a fresh MCP server per session and excludes model thinking time.

[Methodology and limitations](../README.en.md) · [Original full report (Vietnamese)](synthetic-150-sessions.md) · [JSON](synthetic-150-sessions.json)

## 100 standard sessions

### Quality

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| fully correct sessions | 97% | 99% | +2% | [−2%, +6%] |
| existing function reused | 97% | 99% | +2% | [−2%, +6%] |
| callers: recall | 100% | 100% | 0% | [0%, 0%] |
| callers: precision | 100% | 100% | 0% | [0%, 0%] |
| callers: complete and exact | 100% | 100% | 0% | [0%, 0%] |
| survey: recall | 100% | 100% | 0% | [0%, 0%] |
| survey: complete and exact | 100% | 100% | 0% | [0%, 0%] |
| wrong edits | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |
| missed edits | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |

### Cost and tool time

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| tool calls (modeled turns) | 43.5 | 39.3 | −4.2 (−10%) | [−4.6, −3.9] |
| final session context tokens | 31,231 | 23,530 | −7,701 (−25%) | [−8,577, −6,795] |
|   of which: search phase | 13,472 | 5,772 | −7,700 (−57%) | [−8,577, −6,794] |
|   of which: read + edit | 17,758 | 17,758 | −1 (−0%) | [−2, +1] |
| cumulative input tokens (uncached) | 957,779 | 771,528 | −186,251 (−19%) | [−226,994, −145,117] |
| cache-adjusted equivalent input tokens | 131,693 | 108,560 | −23,133 (−18%) | [−28,180, −18,038] |
| output tokens (tool arguments) | 1,716 | 1,586 | −130 (−8%) | [−142, −118] |
| tool time including MCP startup (ms) | 158 | 4,282 | +4,124 (+2603%) | [+3,954, +4,318] |

### Context distribution

| Context tokens / session | Without MCP | With MCP |
|---|---:|---:|
| min | 20,384 | 15,656 |
| median | 30,968 | 23,025 |
| p90 | 39,896 | 28,917 |
| max | 42,503 | 31,174 |
| total over 100 sessions | 3,123,052 | 2,352,966 |
| total cache-adjusted input tokens | 13,169,299 | 10,856,004 |

## 50 large sessions

### Quality

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| fully correct sessions | 70% | 86% | +16% | [+4%, +28%] |
| existing function reused | 90% | 95% | +5% | [+1%, +9%] |
| callers: recall | 100% | 100% | 0% | [0%, 0%] |
| callers: precision | 100% | 100% | 0% | [0%, 0%] |
| callers: complete and exact | 100% | 100% | 0% | [0%, 0%] |
| survey: recall | 100% | 100% | 0% | [0%, 0%] |
| survey: complete and exact | 100% | 100% | 0% | [0%, 0%] |
| wrong edits | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |
| missed edits | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |

### Cost and tool time

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| tool calls (modeled turns) | 130.5 | 118.7 | −11.8 (−9%) | [−12.7, −11.0] |
| final session context tokens | 92,261 | 70,540 | −21,722 (−24%) | [−24,120, −19,308] |
|   of which: search phase | 39,346 | 17,630 | −21,716 (−55%) | [−24,115, −19,301] |
|   of which: read + edit | 52,915 | 52,909 | −6 (−0%) | [−11, −1] |
| cumulative input tokens (uncached) | 8,098,198 | 5,917,303 | −2,180,895 (−27%) | [−2,471,494, −1,888,930] |
| cache-adjusted equivalent input tokens | 915,920 | 677,199 | −238,721 (−26%) | [−270,394, −207,078] |
| output tokens (tool arguments) | 5,179 | 4,812 | −367 (−7%) | [−396, −336] |
| tool time including MCP startup (ms) | 457 | 6,577 | +6,120 (+1340%) | [+5,880, +6,364] |

### Context distribution

| Context tokens / session | Without MCP | With MCP |
|---|---:|---:|
| min | 70,054 | 53,929 |
| median | 91,307 | 70,138 |
| p90 | 104,813 | 82,080 |
| max | 118,965 | 93,256 |
| total over 50 sessions | 4,613,072 | 3,526,994 |
| total cache-adjusted input tokens | 45,796,018 | 33,859,963 |

The full report includes individual failure details. The real-repository evaluation covers one repository; callers are evaluated with a TypeScript oracle. Results do not establish universal performance.

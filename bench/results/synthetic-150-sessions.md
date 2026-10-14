# Benchmark spec-nav: with MCP vs without MCP / có MCP vs không MCP / 有 MCP 与无 MCP

**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**

## English

- Repository: synthetic — 2,820 files, 204,617 lines, 27 services/packages (seed 42).
- 100 standard sessions (1 feature: reuse + change one function's signature + change one constant + read and edit the code) and 50 large sessions (3 features combined in one context).
- Each session runs twice: without MCP (Grep = ripgrep with head_limit 250, Read = cat -n, Edit) and with MCP (spec-nav, a fresh server per session = cold start; Read/Edit still available).
- Tokens estimated at 3.5 characters/token on both sides. The MCP tool definitions (~3,781 tokens) are added to every turn on the MCP side. Base context (system prompt, built-in tools) = 0 tokens/turn on both sides.
- Agents are deterministic policies, not an LLM. See bench/README.md for assumptions and limitations.

### 100 standard sessions

#### Quality

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

#### Cost

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| tool calls (= model turns) | 43.5 | 39.3 | −4.2 (−10%) | [−4.6, −3.9] |
| final session context tokens | 31,231 | 23,530 | −7,701 (−25%) | [−8,577, −6,795] |
|   of which: search phase | 13,472 | 5,772 | −7,700 (−57%) | [−8,577, −6,794] |
|   of which: read + edit | 17,758 | 17,758 | −1 (−0%) | [−2, +1] |
| cumulative input tokens (uncached) | 957,779 | 771,528 | −186,251 (−19%) | [−226,994, −145,117] |
| cache-adjusted input tokens (prompt caching) | 131,693 | 108,560 | −23,133 (−18%) | [−28,180, −18,038] |
| output tokens (tool arguments) | 1,716 | 1,586 | −130 (−8%) | [−142, −118] |
| tool time including MCP startup (ms) | 158 | 4,282 | +4,124 (+2603%) | [+3,954, +4,318] |

| Context tokens / session | Without MCP | With MCP |
|---|---:|---:|
| min | 20,384 | 15,656 |
| median | 30,968 | 23,025 |
| p90 | 39,896 | 28,917 |
| max | 42,503 | 31,174 |
| total over 100 sessions | 3,123,052 | 2,352,966 |
| total input with caching | 13,169,299 | 10,856,004 |

#### By difficulty of the reuse step

| Difficulty | n | found: without MCP | found: with MCP | search tokens: without MCP | search tokens: with MCP |
|---|---:|---:|---:|---:|---:|
| abbrev | 25 | 100% | 100% | 13,483 | 4,853 |
| behaviour | 20 | 95% | 100% | 13,115 | 6,429 |
| easy | 25 | 100% | 100% | 13,251 | 4,830 |
| synonym | 20 | 95% | 95% | 13,170 | 6,711 |
| vietnamese | 10 | 90% | 100% | 15,315 | 7,232 |

#### By language of the function whose signature changes

| Language | n | callers complete & exact: without MCP | callers complete & exact: with MCP | search tokens: without MCP | search tokens: with MCP |
|---|---:|---:|---:|---:|---:|
| go | 20 | 100% | 100% | 13,721 | 5,501 |
| java | 10 | 100% | 100% | 15,315 | 7,232 |
| python | 30 | 100% | 100% | 13,966 | 5,515 |
| typescript | 40 | 100% | 100% | 12,517 | 5,735 |

#### Sessions only one side got fully correct

- Only MCP correct (3): session-030, session-054, session-084
- Only no-MCP correct (1): session-062

<details><summary>Failed subtasks</summary>

Without MCP:
- session-030: reuse reuse-030 (vietnamese)
- session-054: reuse reuse-054 (synonym)
- session-084: reuse reuse-084 (behaviour)

With MCP:
- session-062: reuse reuse-062 (synonym)

</details>

### 50 large sessions

#### Quality

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

#### Cost

| Metric (mean / session) | Without MCP | With MCP | Difference (MCP − baseline) | 95% CI of difference |
|---|---:|---:|---:|---:|
| tool calls (= model turns) | 130.5 | 118.7 | −11.8 (−9%) | [−12.7, −11.0] |
| final session context tokens | 92,261 | 70,540 | −21,722 (−24%) | [−24,120, −19,308] |
|   of which: search phase | 39,346 | 17,630 | −21,716 (−55%) | [−24,115, −19,301] |
|   of which: read + edit | 52,915 | 52,909 | −6 (−0%) | [−11, −1] |
| cumulative input tokens (uncached) | 8,098,198 | 5,917,303 | −2,180,895 (−27%) | [−2,471,494, −1,888,930] |
| cache-adjusted input tokens (prompt caching) | 915,920 | 677,199 | −238,721 (−26%) | [−270,394, −207,078] |
| output tokens (tool arguments) | 5,179 | 4,812 | −367 (−7%) | [−396, −336] |
| tool time including MCP startup (ms) | 457 | 6,577 | +6,120 (+1340%) | [+5,880, +6,364] |

| Context tokens / session | Without MCP | With MCP |
|---|---:|---:|
| min | 70,054 | 53,929 |
| median | 91,307 | 70,138 |
| p90 | 104,813 | 82,080 |
| max | 118,965 | 93,256 |
| total over 50 sessions | 4,613,072 | 3,526,994 |
| total input with caching | 45,796,018 | 33,859,963 |

#### Sessions only one side got fully correct

- Only MCP correct (9): large-003, large-009, large-011, large-013, large-015, large-016, large-027, large-035, large-045
- Only no-MCP correct (1): large-038

<details><summary>Failed subtasks</summary>

Without MCP:
- large-002: reuse reuse-104 (behaviour)
- large-003: reuse reuse-108 (behaviour)
- large-004: reuse reuse-112 (behaviour)
- large-006: reuse reuse-116 (behaviour)
- large-008: reuse reuse-124 (behaviour)
- large-009: reuse reuse-126 (synonym)
- large-010: reuse reuse-128 (behaviour)
- large-011: reuse reuse-132 (behaviour)
- large-012: reuse reuse-136 (behaviour)
- large-013: reuse reuse-138 (synonym)
- large-015: reuse reuse-144 (behaviour)
- large-016: reuse reuse-148 (behaviour)
- large-027: reuse reuse-180 (vietnamese)
- large-035: reuse reuse-204 (behaviour)
- large-045: reuse reuse-234 (synonym)

With MCP:
- large-002: reuse reuse-104 (behaviour)
- large-004: reuse reuse-110 (vietnamese)
- large-006: reuse reuse-116 (behaviour)
- large-008: reuse reuse-124 (behaviour)
- large-010: reuse reuse-128 (behaviour)
- large-012: reuse reuse-136 (behaviour)
- large-038: reuse reuse-212 (behaviour)

</details>

## Tiếng Việt

- Repo: giả lập — 2,820 file, 204,617 dòng, 27 service/package (seed 42).
- 100 session thường (1 feature: tái sử dụng + đổi signature một hàm + đổi một hằng số + đọc và sửa code) và 50 session lớn (gộp 3 feature trong một context).
- Mỗi session chạy 2 lần: không MCP (Grep = ripgrep với head_limit 250, Read = cat -n, Edit) và có MCP (spec-nav, server mới mỗi session = cold start; vẫn có Read/Edit).
- Token ước lượng 3.5 ký tự/token cho cả hai bên. Định nghĩa tool MCP ~3,781 token được cộng vào mỗi lượt của phía có MCP. Base context (system prompt, tool built-in) = 0 token/lượt cho cả hai.
- Agent là chính sách tất định, không phải LLM. Xem bench/README.md về giả định và giới hạn.

### 100 session thường

#### Chất lượng

| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |
|---|---:|---:|---:|---:|
| session đúng hoàn toàn | 97% | 99% | +2% | [−2%, +6%] |
| tái sử dụng được hàm có sẵn | 97% | 99% | +2% | [−2%, +6%] |
| callers: recall | 100% | 100% | 0% | [0%, 0%] |
| callers: precision | 100% | 100% | 0% | [0%, 0%] |
| callers: đủ hết, không thừa | 100% | 100% | 0% | [0%, 0%] |
| survey: recall | 100% | 100% | 0% | [0%, 0%] |
| survey: đủ hết, không thừa | 100% | 100% | 0% | [0%, 0%] |
| chỗ sửa nhầm (wrong edits) | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |
| chỗ cần sửa bị sót (missed edits) | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |

#### Chi phí

| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |
|---|---:|---:|---:|---:|
| tool calls (= lượt model) | 43.5 | 39.3 | −4.2 (−10%) | [−4.6, −3.9] |
| token context cuối session | 31,231 | 23,530 | −7,701 (−25%) | [−8,577, −6,795] |
|   trong đó: pha tìm kiếm | 13,472 | 5,772 | −7,700 (−57%) | [−8,577, −6,794] |
|   trong đó: pha đọc + sửa | 17,758 | 17,758 | −1 (−0%) | [−2, +1] |
| token input tích lũy (không cache) | 957,779 | 771,528 | −186,251 (−19%) | [−226,994, −145,117] |
| token input quy đổi (có prompt cache) | 131,693 | 108,560 | −23,133 (−18%) | [−28,180, −18,038] |
| token output (tham số tool) | 1,716 | 1,586 | −130 (−8%) | [−142, −118] |
| thời gian tool, gồm khởi động MCP (ms) | 158 | 4,282 | +4,124 (+2603%) | [+3,954, +4,318] |

| Token context / session | Không MCP | Có MCP |
|---|---:|---:|
| min | 20,384 | 15,656 |
| median | 30,968 | 23,025 |
| p90 | 39,896 | 28,917 |
| max | 42,503 | 31,174 |
| tổng 100 session | 3,123,052 | 2,352,966 |
| tổng input tích lũy (có cache) | 13,169,299 | 10,856,004 |

#### Theo độ khó của bước tái sử dụng

| Độ khó | n | tìm thấy: không MCP | tìm thấy: có MCP | token tìm kiếm: không MCP | token tìm kiếm: có MCP |
|---|---:|---:|---:|---:|---:|
| abbrev | 25 | 100% | 100% | 13,483 | 4,853 |
| behaviour | 20 | 95% | 100% | 13,115 | 6,429 |
| easy | 25 | 100% | 100% | 13,251 | 4,830 |
| synonym | 20 | 95% | 95% | 13,170 | 6,711 |
| vietnamese | 10 | 90% | 100% | 15,315 | 7,232 |

#### Theo ngôn ngữ của hàm cần đổi signature

| Ngôn ngữ | n | callers đủ & không thừa: không MCP | callers đủ & không thừa: có MCP | token tìm kiếm: không MCP | token tìm kiếm: có MCP |
|---|---:|---:|---:|---:|---:|
| go | 20 | 100% | 100% | 13,721 | 5,501 |
| java | 10 | 100% | 100% | 15,315 | 7,232 |
| python | 30 | 100% | 100% | 13,966 | 5,515 |
| typescript | 40 | 100% | 100% | 12,517 | 5,735 |

#### Session chỉ một bên làm đúng hoàn toàn

- Chỉ MCP đúng (3): session-030, session-054, session-084
- Chỉ không-MCP đúng (1): session-062

<details><summary>Các việc con thất bại</summary>

Không MCP:
- session-030: reuse reuse-030 (vietnamese)
- session-054: reuse reuse-054 (synonym)
- session-084: reuse reuse-084 (behaviour)

Có MCP:
- session-062: reuse reuse-062 (synonym)

</details>

### 50 session lớn

#### Chất lượng

| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |
|---|---:|---:|---:|---:|
| session đúng hoàn toàn | 70% | 86% | +16% | [+4%, +28%] |
| tái sử dụng được hàm có sẵn | 90% | 95% | +5% | [+1%, +9%] |
| callers: recall | 100% | 100% | 0% | [0%, 0%] |
| callers: precision | 100% | 100% | 0% | [0%, 0%] |
| callers: đủ hết, không thừa | 100% | 100% | 0% | [0%, 0%] |
| survey: recall | 100% | 100% | 0% | [0%, 0%] |
| survey: đủ hết, không thừa | 100% | 100% | 0% | [0%, 0%] |
| chỗ sửa nhầm (wrong edits) | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |
| chỗ cần sửa bị sót (missed edits) | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |

#### Chi phí

| Chỉ số (trung bình / session) | Không MCP | Có MCP | Chênh (MCP − không) | 95% CI của chênh |
|---|---:|---:|---:|---:|
| tool calls (= lượt model) | 130.5 | 118.7 | −11.8 (−9%) | [−12.7, −11.0] |
| token context cuối session | 92,261 | 70,540 | −21,722 (−24%) | [−24,120, −19,308] |
|   trong đó: pha tìm kiếm | 39,346 | 17,630 | −21,716 (−55%) | [−24,115, −19,301] |
|   trong đó: pha đọc + sửa | 52,915 | 52,909 | −6 (−0%) | [−11, −1] |
| token input tích lũy (không cache) | 8,098,198 | 5,917,303 | −2,180,895 (−27%) | [−2,471,494, −1,888,930] |
| token input quy đổi (có prompt cache) | 915,920 | 677,199 | −238,721 (−26%) | [−270,394, −207,078] |
| token output (tham số tool) | 5,179 | 4,812 | −367 (−7%) | [−396, −336] |
| thời gian tool, gồm khởi động MCP (ms) | 457 | 6,577 | +6,120 (+1340%) | [+5,880, +6,364] |

| Token context / session | Không MCP | Có MCP |
|---|---:|---:|
| min | 70,054 | 53,929 |
| median | 91,307 | 70,138 |
| p90 | 104,813 | 82,080 |
| max | 118,965 | 93,256 |
| tổng 50 session | 4,613,072 | 3,526,994 |
| tổng input tích lũy (có cache) | 45,796,018 | 33,859,963 |

#### Session chỉ một bên làm đúng hoàn toàn

- Chỉ MCP đúng (9): large-003, large-009, large-011, large-013, large-015, large-016, large-027, large-035, large-045
- Chỉ không-MCP đúng (1): large-038

<details><summary>Các việc con thất bại</summary>

Không MCP:
- large-002: reuse reuse-104 (behaviour)
- large-003: reuse reuse-108 (behaviour)
- large-004: reuse reuse-112 (behaviour)
- large-006: reuse reuse-116 (behaviour)
- large-008: reuse reuse-124 (behaviour)
- large-009: reuse reuse-126 (synonym)
- large-010: reuse reuse-128 (behaviour)
- large-011: reuse reuse-132 (behaviour)
- large-012: reuse reuse-136 (behaviour)
- large-013: reuse reuse-138 (synonym)
- large-015: reuse reuse-144 (behaviour)
- large-016: reuse reuse-148 (behaviour)
- large-027: reuse reuse-180 (vietnamese)
- large-035: reuse reuse-204 (behaviour)
- large-045: reuse reuse-234 (synonym)

Có MCP:
- large-002: reuse reuse-104 (behaviour)
- large-004: reuse reuse-110 (vietnamese)
- large-006: reuse reuse-116 (behaviour)
- large-008: reuse reuse-124 (behaviour)
- large-010: reuse reuse-128 (behaviour)
- large-012: reuse reuse-136 (behaviour)
- large-038: reuse reuse-212 (behaviour)

</details>

## 简体中文

- 仓库：合成仓库 — 2,820 个文件，204,617 行，27 个服务/包（seed 42）。
- 100 个普通会话（1 个功能：复用 + 修改一个函数的签名 + 修改一个常量 + 阅读并修改代码），以及 50 个大会话（在同一上下文中合并 3 个功能）。
- 每个会话运行 2 次：无 MCP（Grep = ripgrep，head_limit 250；Read = cat -n；Edit）和有 MCP（spec-nav，每个会话一个新 server = 冷启动；仍有 Read/Edit）。
- 两侧均按 3.5 字符/token 估算。MCP 工具定义（约 3,781 token）计入有 MCP 一侧的每一轮。基础上下文（system prompt、内置工具）两侧均为 0 token/轮。
- 代理是确定性策略，不是 LLM。假设与局限见 bench/README.md。

### 100 个普通会话

#### 质量

| 指标（每会话平均） | 无 MCP | 有 MCP | 差值（MCP − 无） | 差值的 95% 置信区间 |
|---|---:|---:|---:|---:|
| 完全正确的会话 | 97% | 99% | +2% | [−2%, +6%] |
| 复用了已有函数 | 97% | 99% | +2% | [−2%, +6%] |
| 调用方：召回率 | 100% | 100% | 0% | [0%, 0%] |
| 调用方：精确率 | 100% | 100% | 0% | [0%, 0%] |
| 调用方：完整且无多余 | 100% | 100% | 0% | [0%, 0%] |
| 梳理：召回率 | 100% | 100% | 0% | [0%, 0%] |
| 梳理：完整且无多余 | 100% | 100% | 0% | [0%, 0%] |
| 错误修改数（wrong edits） | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |
| 遗漏修改数（missed edits） | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |

#### 成本

| 指标（每会话平均） | 无 MCP | 有 MCP | 差值（MCP − 无） | 差值的 95% 置信区间 |
|---|---:|---:|---:|---:|
| 工具调用数（= 模型轮次） | 43.5 | 39.3 | −4.2 (−10%) | [−4.6, −3.9] |
| 会话最终上下文 token | 31,231 | 23,530 | −7,701 (−25%) | [−8,577, −6,795] |
|   其中：搜索阶段 | 13,472 | 5,772 | −7,700 (−57%) | [−8,577, −6,794] |
|   其中：阅读 + 修改阶段 | 17,758 | 17,758 | −1 (−0%) | [−2, +1] |
| 累计输入 token（无缓存） | 957,779 | 771,528 | −186,251 (−19%) | [−226,994, −145,117] |
| 折算输入 token（启用提示缓存） | 131,693 | 108,560 | −23,133 (−18%) | [−28,180, −18,038] |
| 输出 token（工具参数） | 1,716 | 1,586 | −130 (−8%) | [−142, −118] |
| 工具耗时，含 MCP 启动（ms） | 158 | 4,282 | +4,124 (+2603%) | [+3,954, +4,318] |

| 每会话上下文 token | 无 MCP | 有 MCP |
|---|---:|---:|
| min | 20,384 | 15,656 |
| median | 30,968 | 23,025 |
| p90 | 39,896 | 28,917 |
| max | 42,503 | 31,174 |
| 100 个会话合计 | 3,123,052 | 2,352,966 |
| 累计输入合计（启用缓存） | 13,169,299 | 10,856,004 |

#### 按复用步骤的难度

| 难度 | n | 找到: 无 MCP | 找到: 有 MCP | 搜索 token: 无 MCP | 搜索 token: 有 MCP |
|---|---:|---:|---:|---:|---:|
| abbrev | 25 | 100% | 100% | 13,483 | 4,853 |
| behaviour | 20 | 95% | 100% | 13,115 | 6,429 |
| easy | 25 | 100% | 100% | 13,251 | 4,830 |
| synonym | 20 | 95% | 95% | 13,170 | 6,711 |
| vietnamese | 10 | 90% | 100% | 15,315 | 7,232 |

#### 按需修改签名的函数所用语言

| 语言 | n | 调用方完整且无多余: 无 MCP | 调用方完整且无多余: 有 MCP | 搜索 token: 无 MCP | 搜索 token: 有 MCP |
|---|---:|---:|---:|---:|---:|
| go | 20 | 100% | 100% | 13,721 | 5,501 |
| java | 10 | 100% | 100% | 15,315 | 7,232 |
| python | 30 | 100% | 100% | 13,966 | 5,515 |
| typescript | 40 | 100% | 100% | 12,517 | 5,735 |

#### 只有一侧完全正确的会话

- 仅 MCP 正确 (3): session-030, session-054, session-084
- 仅无 MCP 正确 (1): session-062

<details><summary>失败的子任务</summary>

无 MCP:
- session-030: reuse reuse-030 (vietnamese)
- session-054: reuse reuse-054 (synonym)
- session-084: reuse reuse-084 (behaviour)

有 MCP:
- session-062: reuse reuse-062 (synonym)

</details>

### 50 个大会话

#### 质量

| 指标（每会话平均） | 无 MCP | 有 MCP | 差值（MCP − 无） | 差值的 95% 置信区间 |
|---|---:|---:|---:|---:|
| 完全正确的会话 | 70% | 86% | +16% | [+4%, +28%] |
| 复用了已有函数 | 90% | 95% | +5% | [+1%, +9%] |
| 调用方：召回率 | 100% | 100% | 0% | [0%, 0%] |
| 调用方：精确率 | 100% | 100% | 0% | [0%, 0%] |
| 调用方：完整且无多余 | 100% | 100% | 0% | [0%, 0%] |
| 梳理：召回率 | 100% | 100% | 0% | [0%, 0%] |
| 梳理：完整且无多余 | 100% | 100% | 0% | [0%, 0%] |
| 错误修改数（wrong edits） | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |
| 遗漏修改数（missed edits） | 0.0 | 0.0 | 0.0 | [0.0, 0.0] |

#### 成本

| 指标（每会话平均） | 无 MCP | 有 MCP | 差值（MCP − 无） | 差值的 95% 置信区间 |
|---|---:|---:|---:|---:|
| 工具调用数（= 模型轮次） | 130.5 | 118.7 | −11.8 (−9%) | [−12.7, −11.0] |
| 会话最终上下文 token | 92,261 | 70,540 | −21,722 (−24%) | [−24,120, −19,308] |
|   其中：搜索阶段 | 39,346 | 17,630 | −21,716 (−55%) | [−24,115, −19,301] |
|   其中：阅读 + 修改阶段 | 52,915 | 52,909 | −6 (−0%) | [−11, −1] |
| 累计输入 token（无缓存） | 8,098,198 | 5,917,303 | −2,180,895 (−27%) | [−2,471,494, −1,888,930] |
| 折算输入 token（启用提示缓存） | 915,920 | 677,199 | −238,721 (−26%) | [−270,394, −207,078] |
| 输出 token（工具参数） | 5,179 | 4,812 | −367 (−7%) | [−396, −336] |
| 工具耗时，含 MCP 启动（ms） | 457 | 6,577 | +6,120 (+1340%) | [+5,880, +6,364] |

| 每会话上下文 token | 无 MCP | 有 MCP |
|---|---:|---:|
| min | 70,054 | 53,929 |
| median | 91,307 | 70,138 |
| p90 | 104,813 | 82,080 |
| max | 118,965 | 93,256 |
| 50 个会话合计 | 4,613,072 | 3,526,994 |
| 累计输入合计（启用缓存） | 45,796,018 | 33,859,963 |

#### 只有一侧完全正确的会话

- 仅 MCP 正确 (9): large-003, large-009, large-011, large-013, large-015, large-016, large-027, large-035, large-045
- 仅无 MCP 正确 (1): large-038

<details><summary>失败的子任务</summary>

无 MCP:
- large-002: reuse reuse-104 (behaviour)
- large-003: reuse reuse-108 (behaviour)
- large-004: reuse reuse-112 (behaviour)
- large-006: reuse reuse-116 (behaviour)
- large-008: reuse reuse-124 (behaviour)
- large-009: reuse reuse-126 (synonym)
- large-010: reuse reuse-128 (behaviour)
- large-011: reuse reuse-132 (behaviour)
- large-012: reuse reuse-136 (behaviour)
- large-013: reuse reuse-138 (synonym)
- large-015: reuse reuse-144 (behaviour)
- large-016: reuse reuse-148 (behaviour)
- large-027: reuse reuse-180 (vietnamese)
- large-035: reuse reuse-204 (behaviour)
- large-045: reuse reuse-234 (synonym)

有 MCP:
- large-002: reuse reuse-104 (behaviour)
- large-004: reuse reuse-110 (vietnamese)
- large-006: reuse reuse-116 (behaviour)
- large-008: reuse reuse-124 (behaviour)
- large-010: reuse reuse-128 (behaviour)
- large-012: reuse reuse-136 (behaviour)
- large-038: reuse reuse-212 (behaviour)

</details>


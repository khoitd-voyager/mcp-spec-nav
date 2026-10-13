# Benchmark spec-nav: có MCP vs không MCP

- Repo: giả lập — 2,820 file, 204,617 dòng, 27 service/package (seed 42).
- 100 session thường (1 feature: tái sử dụng + đổi signature một hàm + đổi một hằng số + đọc và sửa code) và 50 session lớn (gộp 3 feature trong một context).
- Mỗi session chạy 2 lần: không MCP (Grep = ripgrep với head_limit 250, Read = cat -n, Edit) và có MCP (spec-nav, server mới mỗi session = cold start; vẫn có Read/Edit).
- Token ước lượng 3.5 ký tự/token cho cả hai bên. Định nghĩa tool MCP ~3,781 token được cộng vào mỗi lượt của phía có MCP. Base context (system prompt, tool built-in) = 0 token/lượt cho cả hai.
- Agent là chính sách tất định, không phải LLM. Xem bench/README.md về giả định và giới hạn.

## 100 session thường

### Chất lượng

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

### Chi phí

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

### Theo độ khó của bước tái sử dụng

| Độ khó | n | tìm thấy: không MCP | tìm thấy: có MCP | token tìm kiếm: không MCP | token tìm kiếm: có MCP |
|---|---:|---:|---:|---:|---:|
| abbrev | 25 | 100% | 100% | 13,483 | 4,853 |
| behaviour | 20 | 95% | 100% | 13,115 | 6,429 |
| easy | 25 | 100% | 100% | 13,251 | 4,830 |
| synonym | 20 | 95% | 95% | 13,170 | 6,711 |
| vietnamese | 10 | 90% | 100% | 15,315 | 7,232 |

### Theo ngôn ngữ của hàm cần đổi signature

| Ngôn ngữ | n | callers đủ & không thừa: không MCP | callers đủ & không thừa: có MCP | token tìm kiếm: không MCP | token tìm kiếm: có MCP |
|---|---:|---:|---:|---:|---:|
| go | 20 | 100% | 100% | 13,721 | 5,501 |
| java | 10 | 100% | 100% | 15,315 | 7,232 |
| python | 30 | 100% | 100% | 13,966 | 5,515 |
| typescript | 40 | 100% | 100% | 12,517 | 5,735 |

### Session chỉ một bên làm đúng hoàn toàn

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

## 50 session lớn

### Chất lượng

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

### Chi phí

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

### Session chỉ một bên làm đúng hoàn toàn

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


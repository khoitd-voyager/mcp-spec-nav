# spec_nav_trace_flow benchmark

**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**

## English

Split **test** (seeds 101, 102, 103, 104, 105), 14 services per repository. Repositories are generated from a seed by `bench/flow-generate.mjs`, which records the expected outcome of every call site from its own route table; no LLM is involved. "Name only" links on method + path, topic or pattern alone — the first match, ignoring host and broker.

### Summary

| | spec-nav | name only |
|---|---:|---:|
| labelled call sites | 598 | 598 |
| links reported | 321 | 470 |
| precision | 100.0% | 71.1% |
| recall (of 382 expected links) | 84.0% | 87.4% |
| wrong links | 0 | 136 |
| reported unresolved / ambiguous / unmatched | 73 / 72 / 85 | – |

### By kind

| Kind | Sites | Expected links | Precision | Recall | Wrong links | Name only: precision | Name only: recall | Name only: wrong |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| http | 546 | 349 | 100.0% | 82.5% | 0 | 74.5% | 89.7% | 107 |
| event | 36 | 24 | 100.0% | 100.0% | 0 | 35.3% | 50.0% | 22 |
| rpc | 16 | 9 | 100.0% | 100.0% | 0 | 56.3% | 100.0% | 7 |

### Expected vs reported status (all kinds)

| expected \ reported | resolved | partial | ambiguous | unresolved | unmatched | missing |
|---|---:|---:|---:|---:|---:|---:|
| resolved | 266 |  |  | 17 |  | 32 |
| partial |  | 55 |  | 3 |  | 9 |
| ambiguous |  |  | 72 | 5 |  | 6 |
| unresolved |  |  |  | 48 |  |  |
| unmatched |  |  |  |  | 85 |  |

### Time and memory

| Seed | Files | Sites | First call, cold (builds the index) | One call, warm | Whole inventory, warm | One flow, both directions | Server RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| 101 | 99 | 120 | 106 ms | 2 ms | 5 pages, 9 ms | 3 ms | 252 MB |
| 102 | 82 | 114 | 94 ms | 1 ms | 4 pages, 5 ms | 3 ms | 231 MB |
| 103 | 94 | 120 | 105 ms | 1 ms | 5 pages, 7 ms | 4 ms | 241 MB |
| 104 | 101 | 130 | 112 ms | 1 ms | 5 pages, 8 ms | 6 ms | 254 MB |
| 105 | 85 | 114 | 96 ms | 1 ms | 4 pages, 5 ms | 5 ms | 235 MB |
| scale (150 services) | 998 | 1509 | 607 ms | 8 ms | 90 pages, 762 ms | 22 ms | 472 MB |

Limits of this benchmark: most generated code uses shapes the adapters support, so it measures linking more than coverage. About 15% of client calls go through a wrapper function (TypeScript) or `urljoin` (Python), which the adapters do not follow; they count against recall and are all of the misses above. Real repositories have more such shapes (generated SDKs, configuration files, service discovery) and other stacks; measure those on your own code. `missing` means the tool reported nothing at that line. Not an LLM experiment: no model is involved, and no paid API was called.

## Tiếng Việt

Split **test** (seed 101, 102, 103, 104, 105), 14 service mỗi repo. Repo sinh từ seed bởi `bench/flow-generate.mjs`, bộ sinh tự ghi kết quả đúng của từng điểm gọi từ bảng route của nó; không có LLM. "Chỉ theo tên" nối bằng method + path, topic hoặc pattern — lấy kết quả khớp đầu tiên, bỏ qua host và broker.

### Tóm tắt

| | spec-nav | name only |
|---|---:|---:|
| labelled call sites | 598 | 598 |
| links reported | 321 | 470 |
| precision | 100.0% | 71.1% |
| recall (of 382 expected links) | 84.0% | 87.4% |
| wrong links | 0 | 136 |
| reported unresolved / ambiguous / unmatched | 73 / 72 / 85 | – |

### Theo loại

| Loại | Điểm gọi | Link mong đợi | Precision | Recall | Nối sai | Chỉ theo tên: precision | Chỉ theo tên: recall | Chỉ theo tên: nối sai |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| http | 546 | 349 | 100.0% | 82.5% | 0 | 74.5% | 89.7% | 107 |
| event | 36 | 24 | 100.0% | 100.0% | 0 | 35.3% | 50.0% | 22 |
| rpc | 16 | 9 | 100.0% | 100.0% | 0 | 56.3% | 100.0% | 7 |

### Trạng thái mong đợi so với trạng thái báo (mọi loại)

| expected \ reported | resolved | partial | ambiguous | unresolved | unmatched | missing |
|---|---:|---:|---:|---:|---:|---:|
| resolved | 266 |  |  | 17 |  | 32 |
| partial |  | 55 |  | 3 |  | 9 |
| ambiguous |  |  | 72 | 5 |  | 6 |
| unresolved |  |  |  | 48 |  |  |
| unmatched |  |  |  |  | 85 |  |

### Thời gian và bộ nhớ

| Seed | File | Điểm gọi | Lần gọi đầu (dựng index) | Một lần gọi, đã warm | Toàn bộ inventory, đã warm | Một flow, hai chiều | RSS server |
|---|---:|---:|---:|---:|---:|---:|---:|
| 101 | 99 | 120 | 106 ms | 2 ms | 5 pages, 9 ms | 3 ms | 252 MB |
| 102 | 82 | 114 | 94 ms | 1 ms | 4 pages, 5 ms | 3 ms | 231 MB |
| 103 | 94 | 120 | 105 ms | 1 ms | 5 pages, 7 ms | 4 ms | 241 MB |
| 104 | 101 | 130 | 112 ms | 1 ms | 5 pages, 8 ms | 6 ms | 254 MB |
| 105 | 85 | 114 | 96 ms | 1 ms | 4 pages, 5 ms | 5 ms | 235 MB |
| scale (150 services) | 998 | 1509 | 607 ms | 8 ms | 90 pages, 762 ms | 22 ms | 472 MB |

Giới hạn: phần lớn code sinh ra dùng dạng mà adapter hỗ trợ, nên benchmark đo việc nối nhiều hơn đo độ phủ. Khoảng 15% lời gọi client đi qua hàm wrapper (TypeScript) hoặc `urljoin` (Python) — adapter không lần theo; chúng bị tính vào recall và là toàn bộ phần bỏ sót ở trên. Repo thật có nhiều dạng như vậy hơn (SDK sinh tự động, file cấu hình, service discovery) và các stack khác; hãy đo trên code của bạn. `missing` = tool không báo gì ở dòng đó. Không phải thử nghiệm LLM: không có model nào, không gọi API trả phí.

## 简体中文

拆分 **test**（种子 101, 102, 103, 104, 105），每个仓库 14 个服务。仓库由 `bench/flow-generate.mjs` 按种子生成，生成器根据自己的路由表记录每个调用点的预期结果；不涉及 LLM。"仅按名称"只按 method + path、topic 或 pattern 连接——取第一个匹配，忽略 host 与 broker。

### 摘要

| | spec-nav | name only |
|---|---:|---:|
| labelled call sites | 598 | 598 |
| links reported | 321 | 470 |
| precision | 100.0% | 71.1% |
| recall (of 382 expected links) | 84.0% | 87.4% |
| wrong links | 0 | 136 |
| reported unresolved / ambiguous / unmatched | 73 / 72 / 85 | – |

### 按类型

| 类型 | 调用点 | 预期连接 | Precision | Recall | 错误连接 | 仅按名称：precision | 仅按名称：recall | 仅按名称：错误 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| http | 546 | 349 | 100.0% | 82.5% | 0 | 74.5% | 89.7% | 107 |
| event | 36 | 24 | 100.0% | 100.0% | 0 | 35.3% | 50.0% | 22 |
| rpc | 16 | 9 | 100.0% | 100.0% | 0 | 56.3% | 100.0% | 7 |

### 预期状态与报告状态（全部类型）

| expected \ reported | resolved | partial | ambiguous | unresolved | unmatched | missing |
|---|---:|---:|---:|---:|---:|---:|
| resolved | 266 |  |  | 17 |  | 32 |
| partial |  | 55 |  | 3 |  | 9 |
| ambiguous |  |  | 72 | 5 |  | 6 |
| unresolved |  |  |  | 48 |  |  |
| unmatched |  |  |  |  | 85 |  |

### 时间与内存

| 种子 | 文件 | 调用点 | 首次调用（建立索引） | 单次调用（热） | 完整 inventory（热） | 单个 flow（双向） | Server RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| 101 | 99 | 120 | 106 ms | 2 ms | 5 pages, 9 ms | 3 ms | 252 MB |
| 102 | 82 | 114 | 94 ms | 1 ms | 4 pages, 5 ms | 3 ms | 231 MB |
| 103 | 94 | 120 | 105 ms | 1 ms | 5 pages, 7 ms | 4 ms | 241 MB |
| 104 | 101 | 130 | 112 ms | 1 ms | 5 pages, 8 ms | 6 ms | 254 MB |
| 105 | 85 | 114 | 96 ms | 1 ms | 4 pages, 5 ms | 5 ms | 235 MB |
| scale (150 services) | 998 | 1509 | 607 ms | 8 ms | 90 pages, 762 ms | 22 ms | 472 MB |

局限：生成的代码大多采用适配器支持的写法，因此本基准更多衡量连接而非覆盖。约 15% 的客户端调用经过封装函数（TypeScript）或 `urljoin`（Python），适配器不会跟踪；它们计入 recall，也是上表全部遗漏的来源。真实仓库中这类写法更多（生成的 SDK、配置文件、服务发现），还有其他技术栈；请在自己的代码上测量。`missing` 表示工具在该行未报告任何内容。这不是 LLM 实验：不涉及模型，也未调用任何付费 API。

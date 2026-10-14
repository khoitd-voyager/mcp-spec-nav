# Benchmark: with MCP vs without MCP / có MCP vs không MCP / 有 MCP 与无 MCP

**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**

## English

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

Recorded results: [bench/results/](results/) (each report is in English, Vietnamese and Chinese).

### Synthetic repository

`bench/generate.mjs` generates a seeded monorepo (re-running produces the same repository): 27 services/packages in TypeScript, JavaScript, Vue, Python, Go, Java, Kotlin, Swift, Ruby and PHP. Each service has ~90 files of noise code: functions named with shared business vocabulary (`computeCartFee`, `get_invoice_totals`…) that call each other — so that both grep and search run into noise as they would in a real repository.

On top of that, the generator plants the answers for each session and records their exact locations (`.bench-tasks.json`).

### One session = one feature request

> Feature request #8: in `services/inventory/…/refund_servicex.go`, add support for "calculate processing fee for a shipment". Reuse existing logic if the repo already has it. The change needs a new parameter on `NormalizeCouponCodeV7`: update every caller. The "risk quota" value also changes: update it everywhere it is defined, in every spelling.

A **large session** combines 3 such feature requests in one context (one big batch of changes): 50–120k tokens of context per session on the synthetic repository, 160–430k on the real one.

The agent works through four phases in a single context:

1. **Reuse** — find the function that already does the job. The target function is named at 5 levels: word match (`calculateShipmentProcessingFee`), synonym (`computeShipmentHandlingCharge`), abbreviation (`calcShipmentProcessingFeeAmt`), behaviour only (`settleShipmentMatrix12`, no doc), Vietnamese description. Decoy functions with near-identical names that do something else are present.
2. **Callers** — every place that calls the function whose signature changes: plain imports, aliases, namespaces, re-exports, callbacks, `obj["name"]()`, `getattr`, Vue templates, untyped JS receivers; plus traps: same-named methods on other classes, same-named local functions, other Go packages with a same-named function, the name inside comments/strings.
3. **Survey** — every file that defines a concept spelled several ways (`risk_quota`, `riskQuota`, `RISK_QUOTA`, `RiskQuota`), with mentions in comments as noise.
4. **Read + edit** — Read every file to be edited in full (Claude Code requires Read before Edit), then one Edit per change: the signature, each call site the agent found, each constant, and the new code (calling the existing function, or rewriting it if none was found). An extra edit = a wrong edit; a missing one = a bug.

A session is **fully correct** when it reuses the existing function, updates every caller with no extra sites, and changes every constant with no extra files.

### The two agents

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

### Real repository (`bench/real.mjs`)

There is no generator to plant answers, so they come from sources independent of spec-nav:

- **Callers**: real TypeScript functions/methods with 3–30 references; answer = the TypeScript Language Service's `findReferences`, excluding the declaration itself, import/export lines and declarations of overrides in the same inheritance tree. A call site counts as matched when it is in the same file and within 3 lines (multi-line calls are reported on different lines by the two tools), matched 1-to-1, applied equally to both sides.
- **Reuse**: real functions with JSDoc/docstrings; task = the first sentence of the doc with every code identifier removed; answer = that function. The no-MCP agent is given the 4 rarest words of the task (the intuition of picking distinctive words) and no synonym list; the MCP agent has no code draft either, so it does not use `spec_nav_similar_functions`.
- **Survey**: two-word concepts with at least two spellings in the repository; answer = every file with a non-comment line matching the pattern, **including file types spec-nav does not read** (lockfiles and docs excluded).

Note when reading the immich results: the repository was cloned without installing `node_modules`, so types from external libraries (vitest, generated SDKs) are missing. Both the oracle and spec-nav are affected; most of the remaining "wrong edits" on the MCP side are same-named calls whose receiver type is unknown, which the agent keeps to be safe.

### What is measured

- Tokens: estimated at 3.5 characters/token, equally on both sides; each tool call adds 25 tokens of envelope. The definitions of the 7 MCP tools (~3.7k tokens) are added to **every turn** on the MCP side — the fixed cost of installing the MCP.
  - *final context*: everything that entered the session's context.
  - *cumulative input*: every turn resends the entire context (no cache).
  - *with prompt caching*: previously sent tokens read from cache ×0.1, newly written cache ×1.25.
- Tool time, including startup and first indexing of the MCP server (a fresh server per session — a cold start, as in a real session). Model thinking time is not counted; model turns = tool calls.
- 95% confidence intervals of the differences: paired bootstrap (same session, two modes).

### Limitations — read before quoting the numbers

- **The real repository is still only one repository.** immich is mostly TypeScript; callers on the real repository only measure TypeScript (the oracle is the TS compiler). Multi-language callers are only measured on the synthetic repository.
- **Not a real LLM.** An LLM may be smarter (understanding function bodies, switching strategies) or sloppier (skipping verification steps). The results describe what the *tools* can do under one usage policy, not a particular model.
- **Synthetic repository.** Noise code is more regular than real code; hard patterns (aliases, dynamic calls, same names) occur more densely than in practice. The generator was written by the same person as the MCP — the traps were chosen before running and not tuned to the results, but you should still cross-check with real tasks.
- **Tokens are estimates** based on characters, not the model's tokenizer.
- The no-MCP side's synonym knowledge is a fixed list; a real LLM may think of more or fewer.

To measure with a real model: use the same repository and `.bench-tasks.json`, run `claude -p "<session prompt>"` with and without `--mcp-config`, take `usage` from `--output-format json`, and score against the answers in the task file. That costs money per session; this benchmark is free and repeatable.

## Tiếng Việt

So sánh một agent **không có MCP** (chỉ Grep/Read/Edit như tool built-in của Claude Code) với một agent **có MCP** (spec-nav + Read/Edit) trên cùng các task, ở ba chỗ:

| Script | Repo | Đáp án lấy từ đâu |
|---|---|---|
| `bench/run.mjs` | Monorepo giả lập ~2.800 file, ~205k dòng, 10 ngôn ngữ; 100 session thường + 50 session lớn | Generator ghi lại khi cài code |
| `bench/real.mjs` | Repo thật bất kỳ (đã chạy trên immich) | Oracle độc lập: `findReferences` của TypeScript, doc comment, ripgrep |
| `bench/perf.mjs` | Repo rất lớn (đã chạy trên VS Code) | — chỉ đo thời gian và RAM |

```bash
npm run build
node bench/run.mjs                                   # 100 session thường + 50 session lớn, ghi bench/results/
node bench/run.mjs --sessions 20 --large-sessions 5  # nhanh hơn
node bench/real.mjs --repo ~/code/your-repo --sessions 20 --large-sessions 10
node bench/perf.mjs --repo ~/code/huge-repo --symbols "SomeClass.someMethod"
node bench/report.mjs bench/results/<file>.json      # in lại báo cáo
```

Tùy chọn của `run.mjs`: `--seed`, `--files-per-service` (độ lớn repo), `--base-context <token>` (cộng system prompt/tool built-in vào mỗi lượt, như nhau hai bên), `--pick <ids>`, `--from <n>`, `--repo <dir>`, `--regenerate`, `--out <dir>`. Cần `rg` (ripgrep) trong PATH.

Kết quả đã chạy: [bench/results/](results/) (mỗi báo cáo có đủ tiếng Anh, tiếng Việt và tiếng Trung).

### Repo giả lập

`bench/generate.mjs` sinh một monorepo có seed (chạy lại ra đúng repo đó): 27 service/package, TypeScript, JavaScript, Vue, Python, Go, Java, Kotlin, Swift, Ruby, PHP. Mỗi service ~90 file code nhiễu: hàm đặt tên theo từ vựng nghiệp vụ chung (`computeCartFee`, `get_invoice_totals`…), gọi lẫn nhau — để grep và search đều gặp nhiễu như repo thật.

Trên nền đó, generator cài sẵn đáp án cho từng session và ghi lại vị trí chính xác (`.bench-tasks.json`).

### Một session = một feature request

> Feature request #8: in `services/inventory/…/refund_servicex.go`, add support for "calculate processing fee for a shipment". Reuse existing logic if the repo already has it. The change needs a new parameter on `NormalizeCouponCodeV7`: update every caller. The "risk quota" value also changes: update it everywhere it is defined, in every spelling.

**Session lớn** gộp 3 feature request như vậy trong cùng một context (một đợt thay đổi lớn): 50–120k token context mỗi session ở repo giả lập, 160–430k ở repo thật.

Agent làm bốn pha trong cùng một context:

1. **Tái sử dụng** — tìm hàm đã làm việc đó. Hàm đích có tên ở 5 mức: khớp từ (`calculateShipmentProcessingFee`), đồng nghĩa (`computeShipmentHandlingCharge`), viết tắt (`calcShipmentProcessingFeeAmt`), chỉ khớp hành vi (`settleShipmentMatrix12`, không doc), mô tả tiếng Việt. Có hàm mồi nhử tên gần giống nhưng làm việc khác.
2. **Callers** — mọi nơi gọi hàm cần đổi signature: import thường, alias, namespace, re-export, callback, `obj["name"]()`, `getattr`, template Vue, receiver JS không kiểu; kèm bẫy: method cùng tên ở class khác, hàm cục bộ trùng tên, package Go khác có hàm trùng tên, tên trong comment/chuỗi.
3. **Survey** — mọi file định nghĩa một khái niệm viết nhiều kiểu (`risk_quota`, `riskQuota`, `RISK_QUOTA`, `RiskQuota`), có nhắc trong comment làm nhiễu.
4. **Đọc + sửa** — Read trọn mọi file sẽ sửa (Claude Code bắt buộc Read trước Edit), rồi một Edit cho mỗi chỗ: signature, từng call site agent đã tìm, từng hằng số, và code mới (gọi hàm có sẵn, hoặc tự viết lại nếu không tìm thấy). Sửa thừa = sửa nhầm; sót = bug.

Session **đúng hoàn toàn** khi: tái sử dụng được hàm có sẵn, sửa đủ mọi caller không thừa chỗ nào, đổi đủ hằng số không thừa file nào.

### Hai agent

Cả hai là **chính sách tất định**, không phải LLM — để khác biệt đo được là do công cụ, không do may rủi của model. Chúng dùng chung quy tắc suy luận ở những chỗ giống nhau.

| | Không MCP | Có MCP |
|---|---|---|
| Tìm hàm | Grep định nghĩa có danh từ đặc thù trong tên (thu hẹp nếu > 60 dòng), đọc ≤ 5 file tốt nhất; không có thì đếm hit và đọc 3 file nhiều nhất | `spec_nav_find_functions`, đọc top 3 bằng `spec_nav_read_function`; đề tiếng Việt mà kết quả yếu thì hỏi lại bằng tiếng Anh; không có ứng viên rõ ràng thì viết nháp và gọi `spec_nav_similar_functions` |
| Callers | Grep `\bname\b`, lần theo alias `name as X`, bỏ comment/import/định nghĩa; method có receiver lạ thì Read 30 dòng quanh để đoán kiểu receiver; gọi qua package khác thì Read đầu file xem import | `spec_nav_callers` (đủ mọi trang); site `unresolved`/`ambiguous` thì Read 30 dòng quanh, cùng quy tắc đoán kiểu |
| Survey | Grep regex, bỏ dòng comment, lockfile và tài liệu | `spec_nav_map` cùng regex, đủ mọi trang; rồi Grep riêng các loại file spec-nav không đọc (SQL, JSON, YAML…), như hướng dẫn trong CLAUDE.md |
| Sửa | Read + Edit | Read + Edit |

**Ưu ái phía không-MCP** để không dựng người rơm:
- Nó được cho sẵn từ đồng nghĩa và bản dịch tiếng Anh như một LLM tốt tự nghĩ ra (`shipping|shipment|delivery|freight`), còn phía MCP chỉ dùng từ điển cài trong server.
- Chấm hào phóng như nhau: nếu code đúng đã vào context (đọc được) và có ít nhất một dấu hiệu khớp, coi như LLM nhận ra nó.
- Grep có `head_limit` 250 dòng và tự thu hẹp truy vấn — không đổ cả nghìn dòng vào context.

### Repo thật (`bench/real.mjs`)

Không có generator để cài đáp án, nên đáp án lấy từ nguồn độc lập với spec-nav:

- **Callers**: hàm/method TypeScript thật có 3–30 tham chiếu; đáp án = `findReferences` của TypeScript Language Service, bỏ chính khai báo, dòng import/export và khai báo của các override cùng cây kế thừa. Call site được tính khớp nếu cùng file và lệch ≤ 3 dòng (lời gọi nhiều dòng được hai công cụ báo ở dòng khác nhau), ghép 1-1, áp dụng như nhau cho hai bên.
- **Reuse**: hàm thật có JSDoc/docstring; đề bài = câu đầu của doc với mọi định danh code bị bỏ; đáp án = chính hàm đó. Agent không-MCP được cho 4 từ hiếm nhất của đề (trực giác chọn từ đặc thù), không có danh sách đồng nghĩa; agent MCP cũng không có bản nháp code nên không dùng `spec_nav_similar_functions`.
- **Survey**: khái niệm hai từ có ít nhất hai kiểu viết trong repo; đáp án = mọi file có dòng không phải comment khớp mẫu, **kể cả loại file spec-nav không đọc** (bỏ lockfile và tài liệu).

Lưu ý khi đọc kết quả immich: repo được clone không cài `node_modules`, nên kiểu của thư viện ngoài (vitest, SDK sinh ra) không có. Cả oracle lẫn spec-nav đều chịu ảnh hưởng; phần lớn "sửa nhầm" còn lại của phía MCP là lời gọi trùng tên có receiver không rõ kiểu, được agent giữ lại cho chắc.

### Đo gì

- Token: ước lượng 3,5 ký tự/token, như nhau hai bên; mỗi tool call cộng 25 token vỏ bọc. Định nghĩa 7 tool MCP (~3,7k token) được cộng vào **mỗi lượt** của phía có MCP — chi phí cố định của việc cài MCP.
  - *context cuối*: tổng mọi thứ đã vào context của session.
  - *input tích lũy*: mỗi lượt gửi lại toàn bộ context (không cache).
  - *quy đổi có prompt cache*: phần đã gửi đọc từ cache ×0,1, phần mới ghi cache ×1,25.
- Thời gian tool, gồm cả khởi động và index lần đầu của server MCP (mỗi session một server mới — cold start như session thật). Không tính thời gian model suy nghĩ; số lượt model = số tool call.
- Khoảng tin cậy 95% của chênh lệch: bootstrap theo cặp (cùng session, hai chế độ).

### Giới hạn — đọc trước khi trích dẫn số liệu

- **Repo thật cũng chỉ là một repo.** immich là TypeScript là chính; callers ở repo thật chỉ đo phần TypeScript (oracle là compiler TS). Phần callers đa ngôn ngữ chỉ được đo trên repo giả lập.
- **Không phải LLM thật.** LLM có thể khéo hơn (đọc hiểu thân hàm, đổi chiến lược) hoặc vụng hơn (bỏ qua bước kiểm tra). Kết quả nói về khả năng của *công cụ* dưới cùng một chính sách dùng, không phải về một model cụ thể.
- **Repo giả lập.** Code nhiễu đều đặn hơn code thật; các mẫu khó (alias, gọi động, trùng tên) xuất hiện dày hơn thực tế. Generator do cùng người viết MCP viết — các bẫy được chọn trước khi chạy và không chỉnh theo kết quả, nhưng vẫn nên đối chiếu bằng task thật.
- **Token là ước lượng** theo ký tự, không qua tokenizer của model.
- Phía không-MCP được cấp kiến thức đồng nghĩa ở dạng danh sách cố định; LLM thật có thể nghĩ ra nhiều hoặc ít hơn.

Muốn đo bằng model thật: dùng cùng repo và `.bench-tasks.json`, chạy `claude -p "<prompt của session>"` có và không có `--mcp-config`, lấy `usage` từ `--output-format json`, chấm theo đáp án trong file task. Cách đó tốn phí theo số session; benchmark này thì miễn phí và chạy lại được.

## 简体中文

在相同任务上对比 **无 MCP** 的代理（只有 Grep/Read/Edit，类似 Claude Code 的内置工具）与 **有 MCP** 的代理（spec-nav + Read/Edit），共三种场景：

| 脚本 | 仓库 | 标准答案来源 |
|---|---|---|
| `bench/run.mjs` | 合成 monorepo，约 2,800 个文件、约 205k 行、10 种语言；100 个普通会话 + 50 个大会话 | 生成器在植入代码时记录 |
| `bench/real.mjs` | 任意真实仓库（已在 immich 上运行） | 独立 oracle：TypeScript 的 `findReferences`、文档注释、ripgrep |
| `bench/perf.mjs` | 超大仓库（已在 VS Code 上运行） | ——只测量耗时和内存 |

```bash
npm run build
node bench/run.mjs                                   # 100 个普通会话 + 50 个大会话，写入 bench/results/
node bench/run.mjs --sessions 20 --large-sessions 5  # 更快
node bench/real.mjs --repo ~/code/your-repo --sessions 20 --large-sessions 10
node bench/perf.mjs --repo ~/code/huge-repo --symbols "SomeClass.someMethod"
node bench/report.mjs bench/results/<file>.json      # 重新打印报告
```

`run.mjs` 的选项：`--seed`、`--files-per-service`（仓库规模）、`--base-context <token>`（为每一轮加上 system prompt/内置工具的开销，两侧相同）、`--pick <ids>`、`--from <n>`、`--repo <dir>`、`--regenerate`、`--out <dir>`。需要 PATH 中有 `rg`（ripgrep）。

已运行的结果：[bench/results/](results/)（每份报告都包含英文、越南语和中文）。

### 合成仓库

`bench/generate.mjs` 生成一个带种子的 monorepo（重复运行得到完全相同的仓库）：27 个服务/包，涵盖 TypeScript、JavaScript、Vue、Python、Go、Java、Kotlin、Swift、Ruby、PHP。每个服务约有 90 个噪声代码文件：函数用通用业务词汇命名（`computeCartFee`、`get_invoice_totals`…）并互相调用——让 grep 和搜索都像在真实仓库中一样遇到噪声。

在此基础上，生成器为每个会话植入标准答案，并记录其精确位置（`.bench-tasks.json`）。

### 一个会话 = 一个功能需求

> Feature request #8: in `services/inventory/…/refund_servicex.go`, add support for "calculate processing fee for a shipment". Reuse existing logic if the repo already has it. The change needs a new parameter on `NormalizeCouponCodeV7`: update every caller. The "risk quota" value also changes: update it everywhere it is defined, in every spelling.

**大会话** 在同一上下文中合并 3 个这样的功能需求（一次大批量修改）：合成仓库每个会话 50–120k token 上下文，真实仓库 160–430k。

代理在同一上下文中完成四个阶段：

1. **复用** —— 找到已经实现该功能的函数。目标函数的命名分 5 个级别：词语匹配（`calculateShipmentProcessingFee`）、同义词（`computeShipmentHandlingCharge`）、缩写（`calcShipmentProcessingFeeAmt`）、仅行为匹配（`settleShipmentMatrix12`，无文档）、越南语描述。还有名称相近但功能不同的诱饵函数。
2. **调用方** —— 签名要修改的函数的所有调用处：普通 import、别名、命名空间、re-export、回调、`obj["name"]()`、`getattr`、Vue 模板、无类型的 JS 接收者；外加陷阱：其他类上的同名方法、同名局部函数、其他 Go 包中的同名函数、注释/字符串中出现的名称。
3. **梳理** —— 定义了某个多种写法概念（`risk_quota`、`riskQuota`、`RISK_QUOTA`、`RiskQuota`）的所有文件，并有注释中的提及作为噪声。
4. **阅读 + 修改** —— 完整 Read 每个要修改的文件（Claude Code 要求先 Read 再 Edit），然后每处修改一次 Edit：签名、代理找到的每个调用点、每个常量，以及新代码（调用已有函数，找不到则自己重写）。多改 = 改错；漏改 = bug。

会话 **完全正确** 的条件：复用了已有函数，所有调用方都已修改且没有多余位置，所有常量都已修改且没有多余文件。

### 两个代理

两者都是 **确定性策略**，不是 LLM——这样测得的差异来自工具，而不是模型的运气。在做相同事情的地方，它们使用相同的推理规则。

| | 无 MCP | 有 MCP |
|---|---|---|
| 查找函数 | Grep 名称中含特定名词的定义（超过 60 行则收窄），读取最佳的 ≤ 5 个文件；若没有，则统计命中数并读取命中最多的 3 个文件 | `spec_nav_find_functions`，用 `spec_nav_read_function` 读取前 3 个；需求是越南语且结果较弱时用英文再问一次；没有明确候选时写草稿并调用 `spec_nav_similar_functions` |
| 调用方 | Grep `\bname\b`，追踪 `name as X` 别名，去掉注释/import/定义；接收者陌生的方法调用则 Read 周围 30 行推测接收者类型；跨包调用则 Read 文件开头查看 import | `spec_nav_callers`（取完所有分页）；`unresolved`/`ambiguous` 的位置 Read 周围 30 行，采用相同的类型推测规则 |
| 梳理 | Grep 正则，去掉注释行、lockfile 和文档 | 用相同正则调用 `spec_nav_map`，取完所有分页；再按 CLAUDE.md 的指引单独 Grep spec-nav 不读取的文件类型（SQL、JSON、YAML…） |
| 修改 | Read + Edit | Read + Edit |

**对无 MCP 一侧的优待**，避免树立稻草人：
- 它预先获得一个优秀 LLM 自己会想到的同义词和英文翻译（`shipping|shipment|delivery|freight`），而 MCP 一侧只使用 server 内置的词典。
- 两侧采用同样宽松的评分：只要正确的代码进入了上下文（被读取）且至少有一个匹配信号，就视为 LLM 识别出了它。
- Grep 有 250 行的 `head_limit`，并会自动收窄查询——不会把成千上万行倒进上下文。

### 真实仓库（`bench/real.mjs`）

没有生成器来植入答案，因此答案来自独立于 spec-nav 的来源：

- **调用方**：具有 3–30 个引用的真实 TypeScript 函数/方法；答案 = TypeScript Language Service 的 `findReferences`，排除声明本身、import/export 行以及同一继承树中 override 的声明。调用点在同一文件且相差 ≤ 3 行即视为匹配（多行调用会被两个工具报告在不同行上），一对一配对，两侧同等适用。
- **复用**：带 JSDoc/docstring 的真实函数；题目 = 文档第一句并去掉所有代码标识符；答案 = 该函数本身。无 MCP 代理获得题目中最罕见的 4 个词（模拟挑选特征词的直觉），没有同义词列表；MCP 代理也没有代码草稿，因此不使用 `spec_nav_similar_functions`。
- **梳理**：在仓库中至少有两种写法的双词概念；答案 = 所有含有匹配模式的非注释行的文件，**包括 spec-nav 不读取的文件类型**（排除 lockfile 和文档）。

阅读 immich 结果时请注意：仓库克隆后没有安装 `node_modules`，因此缺少外部库（vitest、生成的 SDK）的类型。oracle 和 spec-nav 都受此影响；MCP 一侧剩余的大部分“改错”是接收者类型未知的同名调用，代理为稳妥起见保留了它们。

### 测量内容

- Token：两侧都按 3.5 字符/token 估算；每次工具调用额外加 25 token 的封装开销。7 个 MCP 工具的定义（约 3.7k token）被计入 MCP 一侧的 **每一轮**——这是安装 MCP 的固定成本。
  - *最终上下文*：进入该会话上下文的全部内容。
  - *累计输入*：每一轮都重新发送完整上下文（无缓存）。
  - *启用提示缓存折算*：已发送部分从缓存读取 ×0.1，新写入缓存部分 ×1.25。
- 工具耗时，包括 MCP server 的启动和首次索引（每个会话一个新 server——与真实会话一样是冷启动）。不计模型思考时间；模型轮次 = 工具调用次数。
- 差值的 95% 置信区间：配对 bootstrap（同一会话，两种模式）。

### 局限——引用数据前请先阅读

- **真实仓库也只是一个仓库。** immich 以 TypeScript 为主；真实仓库上的调用方只测了 TypeScript 部分（oracle 是 TS 编译器）。多语言调用方只在合成仓库上测量。
- **不是真实的 LLM。** LLM 可能更聪明（读懂函数体、改变策略），也可能更粗心（跳过检查步骤）。结果描述的是在同一使用策略下 *工具* 的能力，而不是某个具体模型。
- **合成仓库。** 噪声代码比真实代码更规整；困难模式（别名、动态调用、重名）出现得比实际更密集。生成器与 MCP 出自同一作者——陷阱在运行前选定，没有根据结果调整，但仍建议用真实任务对照验证。
- **Token 是估算值**，按字符计算，而非经过模型的分词器。
- 无 MCP 一侧的同义词知识是固定列表；真实 LLM 可能想到更多或更少。

想用真实模型测量：使用同一仓库和 `.bench-tasks.json`，分别带与不带 `--mcp-config` 运行 `claude -p "<会话提示词>"`，从 `--output-format json` 中取 `usage`，并按任务文件中的答案评分。这种方式按会话数量计费；本基准测试免费且可重复运行。

# 工具参考

[English](tools.md) · [Tiếng Việt](tools.vi.md) · [简体中文](tools.zh-CN.md)

← [README](../../README.zh-CN.md) · [安装](installation.zh-CN.md) · [故障排查](troubleshooting.zh-CN.md)

以下是供代理调用工具的参数，不是终端命令。代理会替你调用。请用你仓库中的实际结果替换示例路径和函数名。

| 工具 | 用途 |
|---|---|
| `spec_nav_services` | 检查扫描根目录、发现的项目、文件/函数数量和覆盖率。 |
| `spec_nav_find_functions` | 跨服务查找可能满足需求的函数，排序并说明匹配原因。 |
| `spec_nav_similar_functions` | 查找行为与某个函数或草稿相似的函数，即使名称完全不同。 |
| `spec_nav_read_function` | 读取某个函数的精确源码，以及签名、文档和相关 import。 |
| `spec_nav_functions` | 按条件筛选、分页浏览函数目录。 |
| `spec_nav_callers` | 检查调用、引用、动态调用以及无法解析的用法。 |
| `spec_nav_map` | 查找匹配正则的行，并给出所在函数。 |
| `spec_nav_trace_flow` | 跨服务追踪 HTTP、RPC 和事件连接（upstream 或 downstream），附带证据及未解析部分。 |

通用参数：

- `services` —— 限定在这些服务/目录中，路径相对于 `SPEC_NAV_ROOT`（例如 `"services/api"`、`"packages"`）。`"."` 只选择根项目自身的文件。省略则覆盖整个仓库（默认）。
- `cursor` —— 上一页返回的 `nextCursor`。其他参数保持不变。
- `format` —— `"text"`（默认，紧凑）或 `"json"`（结构化）。

## `spec_nav_services`

```json
{}
```

列出根目录下（任意深度）的项目，作为其他工具可接受的 `service` 值，并给出每个项目的文件数、函数数和覆盖率摘要。不确定该传什么，或需要确认 `SPEC_NAV_ROOT` 是否指向正确仓库时调用。

## `spec_nav_find_functions`

```json
{ "query": "calculate order fees", "limit": 20 }
```

结果包含函数 ID 和匹配原因。搜索范围包括名称、导出别名、签名、文档、路径、函数调用的名称，以及（默认）函数体；越罕见的词权重越高。

其他参数：`services`、`file`（路径子串或 `*` 通配）、`language`、`searchBodies`（默认 `true`；`false` 去掉仅在函数体中匹配的结果）、`limit`（默认 20，最大 100）、`cursor`、`format`。

## `spec_nav_similar_functions`

```json
{ "code": "function shippingCost(order) { const km = distanceKm(order.from, order.to); return round(km * zoneRate(order.zone), 2); }" }
```

对已有函数可传 `{ "id": "<id>" }`（或 `file` + `name`，必要时加 `line`）。它比较每个函数的调用和函数体词汇，忽略名称。

其他参数：`services`、`inFile`、`language`、`minScore`（默认 0.2）、`limit`（默认 10，最大 100）、`cursor`、`format`。

## `spec_nav_read_function`

```json
{ "file": "services/billing/src/fees.ts", "name": "calculateFee" }
```

使用结果中的实际路径/名称，或传入 `{ "id": "<工具返回的 id>" }`。`name` 可以是限定名（`OrderService.calculateFee`）、短名或导出名；同名函数可用 `line` 区分。输出包含签名、完整的文档注释、函数用到的 import，以及带行号的精确源码。

函数较长时会分段返回：把返回的 `nextCursor` 作为 `cursor`（或使用 `fromLine`）继续读取；`maxLines` 设置每段行数（默认 400）。不会静默截断。

## `spec_nav_functions`

```json
{ "services": ["services/api"], "name": "fee", "limit": 100 }
```

省略 `services` 则覆盖所有发现的项目。`services: ["."]` 只选择根项目自身的文件。过滤条件包括 `file`、`name`（限定名的不区分大小写子串，或 `/regex/`）、`kind`（例如 `method`、`function`、`constructor`、`arrow`）、`language` 和 `exportedOnly`。`limit` 默认 200（最大 1000）。

## `spec_nav_callers`

```json
{ "symbol": "calculateFee", "file": "services/billing/src/fees.ts", "format": "json" }
```

可用限定名（如 `OrderService.calculateFee`）、`className` 或声明所在的 `file` 消除歧义。`service` 缩小声明的范围；`searchServices` 缩小查找调用方的范围。`limit` 默认每页 100 个位置。

TypeScript/JavaScript（以及 Vue/Svelte/Astro 的脚本和模板）使用 TypeScript 类型检查器解析。其他受支持语言基于证据绑定——同一文件/类、限定符、import 或别名、包，或声明为该类类型的接收者——每个位置的 `reason` 说明依据。每个位置都包含所在函数、该函数的参数以及实参个数。

输出始终为 JSON（默认带缩进；`format: "json"` 时输出为一行）。其中的 `notes` 说明了哪些内容不计入：运行时计算的名称、经 HTTP/RPC/队列的调用、不受支持的文件类型以及仓库之外的代码。要跟踪服务之间的 HTTP、RPC 和事件连接，请使用 [`spec_nav_trace_flow`](#spec_nav_trace_flow)。

## `spec_nav_map`

```json
{ "pattern": "handl(e|ing)_?fee|handling_charge|HANDLING_FEE" }
```

不区分大小写。默认跳过注释和 import 行；设置 `includeComments: true` 可包含它们。其他参数：`services`、`cursor`、`pageSize`（每页也会在约 30k 字符处截断）。

## `spec_nav_trace_flow`

```json
{ "file": "web/src/api.ts", "name": "placeOrder" }
```

追踪该函数会到达哪里。`{ "endpoint": "POST /orders", "direction": "upstream" }` 列出谁会到达某个路由，`{ "topic": "order.created" }` 列出某个 topic 的消费者，`{}` 列出找到的所有连接。

起点可以是函数（`id`，或 `file` + `name`，必要时加 `line`）、`endpoint`（`"GET /api/orders/:id"` 或 `"/orders/42"`）或 `topic`（事件、topic 或 RPC pattern）。其他参数：`direction`（默认 `downstream`，或 `upstream`、`both`）、`maxDepth`（默认 6，最大 20）、`followCalls`（跟随服务内部的直接调用，默认 `true`）、`includePartial`（继续追踪 `partial` 连接，默认 `true`）、`limit`（每页步骤数，默认 30）、`cursor`、`format`。

受支持的框架、连接状态、置信度和覆盖缺口：[跨服务追踪调用链](flows.zh-CN.md)。

## 理解结果

- **MORE / nextCursor：** 还有更多结果。用同样的查询加上 cursor 再调用。分页取完不等于仓库中所有类型的文件都已受支持。
- **PARTIAL / 覆盖率：** 有部分内容未能读取，例如语言不受支持、文件解析出错或被跳过。请用其他工具进一步检查。
- **搜索：** 结果是按排序的词汇匹配候选，并附带标注的证据，不是语义理解。仅通过调用名称匹配的候选标记为 `[via calls]`，仅在函数体中匹配的标记为 `[body only]`；两者都排在后面。过于宽泛的仅函数体匹配可能被隐藏以减少噪声，工具会报告数量。
- **相似度：** 代码看起来相像（相同的调用、相同的词汇），不代表可以互相替换。
- **调用方：** 每个位置都说明了绑定方式。请检查 `resolved` 以外的位置：
  - `likely` —— 只有一个同名声明，但绑定尚未证实；
  - `ambiguous` —— 可能匹配多个声明；
  - `dynamic` —— 名称以字符串/符号形式出现（`getattr`、`send(:x)`、反射、事件名）；
  - `unresolved` —— 无法确定目标。

  不要把它们视为已确认的调用方。即使 `exhaustive: true`（仅限经类型检查的目标），也不涵盖运行时拼接的名称、HTTP/RPC/队列调用或外部仓库。
- **调用链：** `spec_nav_trace_flow` 是静态分析：连接从代码推断，而非运行时观察。`partial`（键的一部分来自配置）、`ambiguous`（多个目标，未作选择）和 `unresolved`（键在运行时计算）是需要人工检查的线索；`gaps` 行列出未分析的部分。见 [连接状态](flows.zh-CN.md#连接状态与置信度)。
- **时效：** 新增、修改、删除的源文件会在后续调用中反映出来。函数 ID 取决于其源码；读取时若报告 `STALE ID`，请重新查找该函数并使用当前 ID。

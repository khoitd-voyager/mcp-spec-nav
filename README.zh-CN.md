# mcp-spec-nav — 面向 AI 的代码搜索与导航 MCP Server

[English](README.md) · [Tiếng Việt](README.vi.md) · [简体中文](README.zh-CN.md)

[![mcp-spec-nav — Give your agent a map of your code.](docs/assets/social-preview.png)](https://khoitd-voyager.github.io/mcp-spec-nav/zh/)

`mcp-spec-nav` 是供 Claude Code 等编码代理使用的本地 MCP server。它读取你指定仓库中的源代码，让代理能够：

- **查找已有函数**：跨服务和共享包，按关键词、按它调用的函数，或按与草稿代码的行为相似度；
- **精确读取函数**：源码、签名、文档以及它用到的 import；
- **修改前查找调用方**：TypeScript/JavaScript/Vue 经类型检查器确认；Python、Go、Java、Kotlin、Swift 等其他语言基于证据判断；动态调用单独列出；
- **按正则梳理**受支持的源文件，并给出每个匹配所在的函数；
- **跨服务追踪调用链**：从源代码追踪 HTTP 客户端 → 路由 → handler、RPC 调用 → handler、事件/topic → 消费者，并给出每条连接的证据以及无法解析的部分（静态分析，[受支持的框架](docs/guide/flows.zh-CN.md#受支持的框架)）。

**它解决的问题：** 在编写新逻辑或修改函数之前，代理需要知道仓库里已经有什么、哪些代码依赖这个函数。只用 grep 时，代理可能漏掉名称不同的代码、重写已有的逻辑，或误改其他类上的同名调用。

MCP 只负责读取代码。由编码代理决定复用什么、修改文件并运行测试。MCP 不保证能找到所有相关函数。

## 什么时候有帮助

| 场景 | MCP 的价值 |
|---|---|
| 逻辑分散在多个服务中 | 高：搜索范围广，减少遗漏。 |
| 想复用已有函数而不是重写 | 高，前提是查询能找到正确的候选。 |
| 修改函数参数，需要找出调用方 | 有用。 |
| 从一个服务追踪请求或事件到另一个服务 | 对受支持的框架有用：带证据的静态连接；无法确定的部分会明确报告，而不是猜测。 |
| 在单个文件内做简单修改 | 收益有限，可能增加工具调用次数。 |

安装 MCP 后，每个模型轮次还会携带工具定义（基准测试中约 3.8k token），因此对于小型、单一概念的修改收益很小。

## 示例：修改订单费用

[docs/examples/order-fee](docs/examples/order-fee/) 是一个可运行的四文件示例。任务：把处理费从 5 提高到 7，并允许每个调用方免除该费用。下面的输出来自在 [`before/`](docs/examples/order-fee/before/) 上实际运行工具，已删减。

**1. 查找已有逻辑** —— MCP，`spec_nav_find_functions`，参数 `{ "query": "order handling fee total" }`：

```text
#1  score 3.05  billing/fees.ts:35-43  (service ., typescript)
    [function, exported] calculateTotal
    why: handling→body  fee→path(stem:fees)  total→name
```

**2. 阅读实现** —— MCP，`spec_nav_read_function`，参数 `{ "file": "billing/fees.ts", "name": "calculateTotal" }`：

```text
35| export function calculateTotal(subtotal) {
39|   const handlingFee = HANDLING_FEE;
42|   return subtotal + handlingFee;
43| }
```

**3. 找出所有调用方** —— MCP，`spec_nav_callers`，参数 `{ "symbol": "calculateTotal", "file": "billing/fees.ts" }`：

```text
"total": 3, "exhaustive": true,
"targets": [{ "file": "billing/fees.ts", "line": 35, "resolvedBy": "type checker" }],
"sites": [
  { "file": "billing/previewInvoice.ts", "line": 3, "enclosing": "previewInvoice", "resolution": "resolved" },
  { "file": "checkout/createOrder.ts", "line": 3, "enclosing": "createOrder", "resolution": "resolved" },
  { "file": "orders/updateOrder.ts", "line": 3, "enclosing": "updateOrder", "resolution": "resolved" }
```

**4. 跨服务追踪** —— MCP。`spec_nav_callers` 只统计直接调用，并会明确说明：经 HTTP/RPC/队列的调用不计入。在多服务示例 [docs/examples/order-flow](docs/examples/order-flow/) 中，`spec_nav_trace_flow` 使用 `{ "file": "services/checkout/src/handlers/createOrder.ts", "name": "createOrderHandler", "direction": "both" }`，可以看到谁会到达这个 handler，以及总额继续流向哪里：

```text
steps: 5 (5 resolved) — this page 1-5 — COMPLETE
gaps: none found among the supported adapters.
#1  d1 ↑ HTTP  POST http://checkout:3000/api/orders → POST /api/orders   [resolved · high]
    from  services/storefront/src/checkout-client.ts:3  submitOrder
#2  d1 ↓ call  createOrderHandler → calculateTotal   [resolved · high]
#4  d2 ↓ EVENT event order.created → event order.created (kafka)   [resolved · medium]
    to    services/invoicing/src/consumer.ts:12  handleOrderCreated
```

**5. 修改代码** —— 编码代理：把 `HANDLING_FEE` 改为 7，为 `calculateTotal` 增加 `options` 参数，并在三个调用方中传递 `waiveHandlingFee`。结果见 [`after/`](docs/examples/order-fee/after/)。

**6. 运行测试** —— 编码代理：

```bash
node --test docs/examples/order-fee/verify.mjs   # 6 个测试通过
```

## 快速开始（Claude Code）

**需要：** Node.js 18+、npm/npx、Git，以及要扫描的仓库的本地副本。首次安装需要联网。

**1.** 在目标仓库根目录创建 `.mcp.json`。如果已存在，把 `spec-nav` 加到现有的 `mcpServers` 中，保留其他 MCP 配置。

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

把 `/Users/you/code/your-repo` 替换为**要扫描的代码的绝对路径**（指向 monorepo 根目录即可覆盖所有服务）——而不是 `mcp-spec-nav` 的安装目录。

**2.** 在该仓库中打开 Claude Code，重启会话，运行 `/mcp` 并确认 `spec-nav` 已连接。如果客户端要求批准配置，请完成批准。

**3.** 发送给 Claude：

```text
使用 spec-nav 列出这个仓库中的服务。
显示实际扫描的仓库根目录，以及无法扫描的文件。
```

确认根目录和服务列表与项目一致后再继续。

**4.** 试一个真实任务：

```text
我想给 calculateFee 增加一个参数。使用 spec-nav 找到它的声明，
阅读实现并检查所有调用方，然后再规划修改。
报告无法解析的调用方。
```

安装 MCP 只是让工具可用，并不保证代理会去调用。把 [`CLAUDE.md` 说明段落](docs/guide/installation.zh-CN.md#让-claude-在日常编码中使用它) 加入项目，让 Claude 在日常编码中使用这些工具。更多提示词、Claude Desktop 扩展（无需 Node.js）以及从本地源码安装：[安装](docs/guide/installation.zh-CN.md)。

## 工具

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

参数、JSON 示例、分页、覆盖率和结果状态：[工具参考](docs/guide/tools.zh-CN.md)。

## 支持的语言

TypeScript、JavaScript、Python、Go、Java、C#、Ruby、Rust、PHP、C、C++、Scala、Elixir、Bash、Kotlin、Swift，以及 Vue/Svelte/Astro 组件（script 块）。调用方分析在 **TS/JS/Vue/Svelte/Astro 中经类型检查**，在 **其他所有受支持语言中基于证据**。跨服务调用链只追踪 TypeScript/JavaScript 和 Python 框架。文件扩展名与解析方式：[支持的语言](docs/guide/languages.zh-CN.md)。

## 基准测试

**目前没有使用真实 LLM 的基准测试记录。** 以下结果全部来自**模拟代理**：确定性策略，不是 LLM，这样测得的差异来自工具。一个代理只有 Grep/Read/Edit（类似 Claude Code 的内置工具），另一个有 spec-nav 加 Read/Edit。无 MCP 一侧预先获得了 LLM 式的同义词知识，并采用同样宽松的评分规则。每个会话是一个完整的功能需求：复用已有逻辑、修改一个函数的签名并更新所有调用方、在所有位置修改一个常量，然后阅读并修改每个文件。仓库：带种子的合成 monorepo（答案由生成器植入）和 immich@cc7fd67（答案来自 TypeScript `findReferences`、文档注释和 ripgrep）。Token 按 3.5 字符/token 估算。

| | 合成，100 个会话 | 合成，50 个大会话 | immich（真实），20 个会话 | immich（真实），10 个大会话 |
|---|---:|---:|---:|---:|
| 每会话上下文，无 MCP → MCP | 31k → 24k (−25%) | 92k → 71k (−24%) | 116k → 98k (−16%) | 302k → 227k (−25%) |
| …其中搜索阶段 | −57% | −55% | −70% | −69% |
| 启用提示缓存的输入 token | −18% | −26% | −16% | −38% |
| 工具调用（模型轮次） | −10% | −9% | −2% | −20% |
| 复用了已有函数 | 97% → 99% | 90% → 95% | 55% → 90% | 40% → 93% |
| 调用方完整且无多余 | 100% → 100% | 100% → 100% | 85% → 90% | 53% → 73% |
| 每会话改错次数 | 0 → 0 | 0 → 0 | 0.3 → 0.2 | 14.4 → 2.4 |
| 会话完全正确 | 97% → 99% | 70% → 86% | 50% → 85% | 0% → 30% |
| 工具耗时（含 MCP 冷启动） | +4.1 s | +6.1 s | +3.2 s | +6.6 s |

无论哪种方式，读取要修改的文件成本相同；节省来自搜索阶段。质量提升来自于找到名称不同的代码（复用），以及不误改其他类上同名方法的调用（调用方）。

**超大仓库** —— VS Code（14,306 个文件，约 450 万行，154k 个函数入目录），Apple M4：首次索引 31 s，之后 `find_functions` 2.6–4.3 s、`map` 0.5–1.8 s、`similar_functions` 0.9 s、`read_function` 0.15 s；普通函数的 `callers` 16 s，对在 822 个文件中出现的名称（`readFile`）需要 90 s 和 3 GB 内存。`callers` 之外 server 内存为 0.7–0.9 GB。

**跨服务调用链**（不涉及代理和 LLM）—— `spec_nav_trace_flow` 在自动生成的仓库上（每个仓库 14 个服务，5 个保留种子，598 个带答案的调用点）：precision 100%，错误连接为 0（仅按名称连接：136 条错误连接），recall 84%——所有遗漏都来自经过封装函数或 `urljoin` 的调用，适配器不会跟踪。首次调用约 0.1 s（1,000 个文件的仓库约 0.7 s），之后每次 1–10 ms。生成器与适配器出自同一作者，因此这检验的是连接规则，而非对真实代码的覆盖。

方法、假设与局限：[bench/README.md](bench/README.md#简体中文)。报告：[合成](bench/results/synthetic-150-sessions.md#简体中文) · [immich](bench/results/real-immich-30-sessions.md#简体中文) · [VS Code 耗时](bench/results/perf-vscode.md) · [调用链](bench/results/flow-test.md#简体中文) · [全部结果](bench/results/)。

## 局限

- **搜索基于词汇。** 基于词、被调用名称、缩写、同义词和概念列表、IDF。`spec_nav_similar_functions` 只有在代码共享调用或词汇时，才能找到名称无关但行为相同的代码；两段毫无共同点的实现仍会遗漏。结果只是候选，不能证明没有其他实现。
- **翻译。** 带声调的越南语通过内置的约 100 个常用领域术语词典进行匹配；其他词不翻译。中文查询不会被翻译，请使用英文关键词。
- **复用。** 请自行检查导出、行为以及包/服务依赖。
- **调用方。** 在 TS/JS 之外，绑定依据证据（import、限定符、声明的接收者类型），而非类型检查器：推断类型、继承和重载可能使位置停留在 `likely`/`ambiguous`。运行时拼接的名称、HTTP/RPC/队列调用和外部仓库不会被 `spec_nav_callers` 追踪（服务之间的 HTTP/RPC/事件请参见 `spec_nav_trace_flow`）。
- **调用链。** 基于源代码的静态分析：连接是推断出来的，而非观测，并且只针对[受支持的框架](docs/guide/flows.zh-CN.md#受支持的框架)。不追踪：gRPC、GraphQL、WebSocket、其他队列（BullMQ、RabbitMQ、SQS…）、Go、Java 等其他语言、自动生成的 API 客户端、在封装函数中或用 `urljoin` 构建的 URL、docker-compose 之外的服务发现与配置，以及其他情况——见 [不追踪的内容](docs/guide/flows.zh-CN.md#不追踪的内容)。
- **函数形式。** 内联匿名回调不会单独入目录（JS/TS 会在覆盖率中统计它们）。JS/TS 的解构赋值、动态属性赋值、工厂创建的函数、`Object.assign`/`Object.defineProperty` 以及部分链式赋值尚未完全覆盖。其他语言中赋值给变量的 lambda/闭包不会入目录。
- **文件。** Dart、Lua、Objective-C、SQL 等不受支持的源文件类型不会被解析（但计入覆盖率统计）。排除依赖/构建目录、隐藏目录、虚拟环境、声明文件、压缩过的 JS，以及超过 1.5 MB 的受支持文件。
- **类型。** 只报告显式书写的返回类型；目录不做类型推断。
- **大型仓库。** 在 VS Code（14k 个文件）上测得：首次索引约 31 s，搜索数秒。TS/JS 调用方分析只对提及该名称的文件分批做类型检查，沿 import 追踪两层；对于非常常见的名称需要数分钟和约 3 GB 内存，接收者类型位于更远处的调用会报告为 `unresolved`。
- **依赖。** 已安装依赖（`node_modules`）时 TS/JS 类型解析效果最好；未安装时库类型未知，更多调用会变成 `unresolved`。

server 读取当前的本地代码副本。不需要搜索 API 密钥，搜索过程也不会把代码发送到外部搜索服务。结果返回给已连接的编码代理；该客户端对模型和数据的处理仍遵循你的配置。

## 文档

- [安装](docs/guide/installation.zh-CN.md) —— Claude Code、Claude Desktop 扩展、`CLAUDE.md` 段落、从本地源码安装
- [工具参考](docs/guide/tools.zh-CN.md) —— 参数、JSON 示例、理解结果
- [跨服务追踪调用链](docs/guide/flows.zh-CN.md) —— 框架、连接状态、置信度、gaps
- [支持的语言](docs/guide/languages.zh-CN.md)
- [故障排查](docs/guide/troubleshooting.zh-CN.md)
- [开发](docs/guide/development.zh-CN.md) —— 测试、打包扩展、基准测试、网站
- [基准测试方法](bench/README.md#简体中文) · [网站](https://khoitd-voyager.github.io/mcp-spec-nav/zh/)

## 许可证

MIT。见 [LICENSE](LICENSE)。

# 基准测试：有 MCP 与无 MCP

**[English](README.en.md) · [Tiếng Việt](README.md) · 简体中文**

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

已运行的结果：[bench/results/](results/)（报告为越南语）。

## 合成仓库

`bench/generate.mjs` 生成一个带种子的 monorepo（重复运行得到完全相同的仓库）：27 个服务/包，涵盖 TypeScript、JavaScript、Vue、Python、Go、Java、Kotlin、Swift、Ruby、PHP。每个服务约有 90 个噪声代码文件：函数用通用业务词汇命名（`computeCartFee`、`get_invoice_totals`…）并互相调用——让 grep 和搜索都像在真实仓库中一样遇到噪声。

在此基础上，生成器为每个会话植入标准答案，并记录其精确位置（`.bench-tasks.json`）。

## 一个会话 = 一个功能需求

> Feature request #8: in `services/inventory/…/refund_servicex.go`, add support for "calculate processing fee for a shipment". Reuse existing logic if the repo already has it. The change needs a new parameter on `NormalizeCouponCodeV7`: update every caller. The "risk quota" value also changes: update it everywhere it is defined, in every spelling.

**大会话** 在同一上下文中合并 3 个这样的功能需求（一次大批量修改）：合成仓库每个会话 50–120k token 上下文，真实仓库 160–430k。

代理在同一上下文中完成四个阶段：

1. **复用** —— 找到已经实现该功能的函数。目标函数的命名分 5 个级别：词语匹配（`calculateShipmentProcessingFee`）、同义词（`computeShipmentHandlingCharge`）、缩写（`calcShipmentProcessingFeeAmt`）、仅行为匹配（`settleShipmentMatrix12`，无文档）、越南语描述。还有名称相近但功能不同的诱饵函数。
2. **调用方** —— 签名要修改的函数的所有调用处：普通 import、别名、命名空间、re-export、回调、`obj["name"]()`、`getattr`、Vue 模板、无类型的 JS 接收者；外加陷阱：其他类上的同名方法、同名局部函数、其他 Go 包中的同名函数、注释/字符串中出现的名称。
3. **梳理** —— 定义了某个多种写法概念（`risk_quota`、`riskQuota`、`RISK_QUOTA`、`RiskQuota`）的所有文件，并有注释中的提及作为噪声。
4. **阅读 + 修改** —— 完整 Read 每个要修改的文件（Claude Code 要求先 Read 再 Edit），然后每处修改一次 Edit：签名、代理找到的每个调用点、每个常量，以及新代码（调用已有函数，找不到则自己重写）。多改 = 改错；漏改 = bug。

会话 **完全正确** 的条件：复用了已有函数，所有调用方都已修改且没有多余位置，所有常量都已修改且没有多余文件。

## 两个代理

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

## 真实仓库（`bench/real.mjs`）

没有生成器来植入答案，因此答案来自独立于 spec-nav 的来源：

- **调用方**：具有 3–30 个引用的真实 TypeScript 函数/方法；答案 = TypeScript Language Service 的 `findReferences`，排除声明本身、import/export 行以及同一继承树中 override 的声明。调用点在同一文件且相差 ≤ 3 行即视为匹配（多行调用会被两个工具报告在不同行上），一对一配对，两侧同等适用。
- **复用**：带 JSDoc/docstring 的真实函数；题目 = 文档第一句并去掉所有代码标识符；答案 = 该函数本身。无 MCP 代理获得题目中最罕见的 4 个词（模拟挑选特征词的直觉），没有同义词列表；MCP 代理也没有代码草稿，因此不使用 `spec_nav_similar_functions`。
- **梳理**：在仓库中至少有两种写法的双词概念；答案 = 所有含有匹配模式的非注释行的文件，**包括 spec-nav 不读取的文件类型**（排除 lockfile 和文档）。

阅读 immich 结果时请注意：仓库克隆后没有安装 `node_modules`，因此缺少外部库（vitest、生成的 SDK）的类型。oracle 和 spec-nav 都受此影响；MCP 一侧剩余的大部分“改错”是接收者类型未知的同名调用，代理为稳妥起见保留了它们。

## 测量内容

- Token：两侧都按 3.5 字符/token 估算；每次工具调用额外加 25 token 的封装开销。7 个 MCP 工具的定义（约 3.7k token）被计入 MCP 一侧的 **每一轮**——这是安装 MCP 的固定成本。
  - *最终上下文*：进入该会话上下文的全部内容。
  - *累计输入*：每一轮都重新发送完整上下文（无缓存）。
  - *启用提示缓存折算*：已发送部分从缓存读取 ×0.1，新写入缓存部分 ×1.25。
- 工具耗时，包括 MCP server 的启动和首次索引（每个会话一个新 server——与真实会话一样是冷启动）。不计模型思考时间；模型轮次 = 工具调用次数。
- 差值的 95% 置信区间：配对 bootstrap（同一会话，两种模式）。

## 局限——引用数据前请先阅读

- **真实仓库也只是一个仓库。** immich 以 TypeScript 为主；真实仓库上的调用方只测了 TypeScript 部分（oracle 是 TS 编译器）。多语言调用方只在合成仓库上测量。
- **不是真实的 LLM。** LLM 可能更聪明（读懂函数体、改变策略），也可能更粗心（跳过检查步骤）。结果描述的是在同一使用策略下 *工具* 的能力，而不是某个具体模型。
- **合成仓库。** 噪声代码比真实代码更规整；困难模式（别名、动态调用、重名）出现得比实际更密集。生成器与 MCP 出自同一作者——陷阱在运行前选定，没有根据结果调整，但仍建议用真实任务对照验证。
- **Token 是估算值**，按字符计算，而非经过模型的分词器。
- 无 MCP 一侧的同义词知识是固定列表；真实 LLM 可能想到更多或更少。

想用真实模型测量：使用同一仓库和 `.bench-tasks.json`，分别带与不带 `--mcp-config` 运行 `claude -p "<会话提示词>"`，从 `--output-format json` 中取 `usage`，并按任务文件中的答案评分。这种方式按会话数量计费；本基准测试免费且可重复运行。

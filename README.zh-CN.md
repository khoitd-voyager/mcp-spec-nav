# mcp-spec-nav — 用于 AI 代码搜索与导航的 MCP Server

**[English](README.md#english) · [Tiếng Việt](README.md#tiếng-việt) · 简体中文**

`mcp-spec-nav` 是一个本地运行的 MCP server，帮助 AI 编码代理在修改代码之前搜索代码、发现可复用的函数并查找调用方。配合 Claude Code 使用，可以在仓库的多个服务和共享包之间探索业务逻辑。

**示例：** 在新增订单费用计算之前，让代理先查找并阅读已有的费用函数；在修改函数参数之前，让代理先找出所有调用方，并报告无法解析的引用。

**基准测试：** 与 Grep/Read/Edit 基线的对比见 [基准测试方法与局限](bench/README.zh-CN.md) 和 [已记录的结果](bench/results/)。这些基准使用确定性的代理策略，而非真实的 LLM 会话。

**开始使用：** [Claude Code 配置](#方式一用-claude-code-快速开始) · [Claude Desktop 扩展](#方式二安装为-claude-desktop-扩展)

### 它对编码代理有什么帮助？

| 场景 | MCP 的价值 |
|---|---|
| 逻辑分散在多个服务中 | 高：搜索范围广，减少遗漏。 |
| 想复用已有函数而不是重写 | 高，前提是查询能找到正确的候选。 |
| 修改函数参数，需要找出调用方 | 有用。 |
| 在单个文件内做简单修改 | 收益有限，可能增加工具调用次数。 |

## 它做什么？

`mcp-spec-nav` 是供 Claude Code 等编码代理使用的本地 MCP server。它读取你指定仓库中的源代码，并提供以下工具：

- 跨服务和共享包查找已有函数——按关键词、按它调用的函数，或按与草稿代码的行为相似度。
- 读取函数源码、签名、文档以及相关 import。
- 修改函数前查找调用方：TypeScript/JavaScript/Vue 经类型检查器确认；Python、Go、Java、Kotlin、Swift 等其他语言基于证据判断；动态调用单独列出。
- 在受支持的源文件中按模式搜索，并给出每个匹配所在的函数。

**示例：** 你让 Claude 新增订单费用计算。Claude 不会立刻再写一个实现，而是先在 billing 服务和共享包中查找已有的费用函数，阅读之后再判断是否可以复用。

MCP 负责读取代码；由编码代理决定复用什么并完成修改。它不保证能找到所有相关函数。

## 选择安装方式

| | 方式一：`.mcp.json` | 方式二：Claude Desktop 扩展（`.mcpb`） |
|---|---|---|
| 客户端 | Claude Code（以及其他读取 `.mcp.json` 的客户端） | Claude Desktop |
| 需要 | Node.js 18+、npm/npx、Git | 只需 Claude Desktop——扩展使用其内置的 Node.js 运行 |
| 指定要扫描的仓库 | 配置文件中的 `SPEC_NAV_ROOT` | 扩展设置中的文件夹选择器 |
| 适合 | 写代码：Claude 在仓库中阅读、规划并修改代码 | 了解代码：在对话中查找、阅读和检查函数 |

两种方式运行的是同一个 server、同一套工具，可以同时使用。

## 方式一：用 Claude Code 快速开始

**需要：** Node.js 18 或更高版本、npm/npx、Git，以及要扫描的仓库的本地副本。首次安装需要联网。

### 1. 添加 MCP 配置

在目标仓库根目录创建 `.mcp.json`：

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

**把 `/Users/you/code/your-repo` 替换为要扫描的代码的绝对路径。** 想覆盖多个服务时，指向 monorepo 根目录。这里填的是你的目标仓库，而不是 `mcp-spec-nav` 的安装目录。

如果已有 `.mcp.json`，把 `spec-nav` 加到现有的 `mcpServers` 对象里，保留其他 MCP 配置。

### 2. 检查连接

在该仓库中打开 Claude Code，重启会话并运行：

```text
/mcp
```

确认 `spec-nav` 已连接。如果客户端要求批准配置，请完成批准。

然后发送给 Claude：

```text
使用 spec-nav 列出这个仓库中的服务。
显示实际扫描的仓库根目录，以及无法扫描的文件。
```

确认根目录和服务列表与项目一致后再继续。

### 3. 在真实任务上试用

你不需要自己调用工具。把下面任意一段复制到 Claude Code：

**查找可复用的代码**

```text
在实现订单费用计算之前，使用 spec-nav 在所有服务中搜索已有函数。
可同时使用英文关键词，例如 calculate order fees。阅读最相关的候选，
说明是否有可以复用的。导入之前检查依赖关系和服务边界。
```

**修改前检查调用方**

```text
我想给 calculateFee 增加一个参数。使用 spec-nav 找到它的声明，
阅读实现并检查所有调用方，然后再规划修改。
报告无法解析的调用方。
```

**跨服务梳理一项变更**

```text
我想修改 handling fee。使用 spec-nav 梳理整个仓库中相关的常量、函数和用法，
包括不同的拼写方式。在声称梳理完整之前，检查覆盖率是否不完整以及是否还有剩余分页。
```

## 方式二：安装为 Claude Desktop 扩展

**需要：** Claude Desktop，以及要扫描的仓库的本地副本。不需要安装 Node.js。

### 1. 获取 `.mcpb` 文件

从 [Releases](https://github.com/khoitd-voyager/mcp-spec-nav/releases) 页面下载 `mcp-spec-nav-<version>.mcpb`，或自行构建：

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run pack:mcpb
```

文件生成在 `build/mcp-spec-nav-<version>.mcpb`。

### 2. 安装

双击 `.mcpb` 文件，或打开 Claude Desktop → **Settings → Extensions → Advanced settings → Install Extension…** 并选择该文件。查看扩展信息后点击 **Install**。

### 3. 选择仓库

在扩展设置中，把 **Repository to scan** 设为要扫描的代码根目录（指向 monorepo 根目录即可覆盖所有服务），然后启用扩展。

之后想扫描其他仓库，打开 **Settings → Extensions → Spec Nav → Configure** 选择另一个文件夹。扩展一次只扫描一个仓库。

### 4. 检查

新建对话并发送：

```text
使用 spec-nav 列出这个仓库中的服务。
显示实际扫描的仓库根目录，以及无法扫描的文件。
```

[在真实任务上试用](#3-在真实任务上试用) 中的提示词同样适用于 Claude Desktop。Claude Desktop 负责阅读和解释代码；要让 Claude 直接修改仓库中的代码，请使用 Claude Code。

## 让 Claude 在日常编码中使用它

安装 MCP 只是让工具可用，并不保证代理会去调用。把下面这段加入项目的 `CLAUDE.md`：

```markdown
## 编写新逻辑之前先查找已有代码

对于新逻辑，或会影响其他函数的修改：

1. 用 spec_nav_find_functions 在各服务中查找已有实现。
   代码用英文命名时使用英文关键词；必要时换一种说法再试。
2. 用 spec_nav_read_function 阅读最相关的候选。
   避免把整个函数目录或所有函数体加载进上下文。
   找不到合适的函数时，先写草稿，再交给 spec_nav_similar_functions。
3. 复用前检查行为、导出、依赖和服务边界。
   其他服务的函数并不一定可以直接导入。
4. 修改函数签名或行为之前使用 spec_nav_callers。
   手动检查标记为 likely、ambiguous、unresolved 或 dynamic 的位置。
   涉及多个文件或服务的概念，用一个宽泛的正则配合 spec_nav_map。
5. 查看覆盖率和未解析结果。需要完整结果时继续翻页（cursor）；
   对不支持或缺失的部分，使用普通搜索和文件读取。
6. 修改完成后，重新执行相关查询，并运行项目相应的检查。

按任务规模取舍。小而独立的修改不需要用到每个工具。
搜索结果只是候选，找不到并不能证明仓库里没有其他实现。
```

其他代理请把这段改写到各自的项目说明文件中，例如 `AGENTS.md`。

## 工具参考

以下是 MCP 工具参数，不是终端命令。代理会替你调用。

| 工具 | 适用场景 |
|---|---|
| `spec_nav_services` | 检查扫描根目录、发现的项目、数量统计和覆盖率。 |
| `spec_nav_find_functions` | 跨服务查找已有逻辑的候选函数，带排序和匹配原因。 |
| `spec_nav_similar_functions` | 查找行为与某个函数或草稿相似的函数，无论名称如何。 |
| `spec_nav_read_function` | 读取某个候选的精确源码及上下文。 |
| `spec_nav_functions` | 按条件筛选、分页浏览函数目录。 |
| `spec_nav_callers` | 修改前检查调用、引用、动态用法和未解析的用法。 |
| `spec_nav_map` | 查找正则匹配，并给出所在函数。 |

**搜索函数**

```json
{ "query": "calculate order fees", "limit": 20 }
```

传给 `spec_nav_find_functions`。结果包含函数 ID 和匹配原因。搜索范围包括名称、导出别名、签名、文档、路径、函数调用的名称，以及默认情况下的函数体；越罕见的词权重越高。

**查找行为与草稿相似的代码**

```json
{ "code": "function shippingCost(order) { const km = distanceKm(order.from, order.to); return round(km * zoneRate(order.zone), 2); }" }
```

传给 `spec_nav_similar_functions`（对已有函数则传 `{ "id": "<id>" }`）。它忽略名称，比较每个函数的调用和函数体词汇。

**读取函数**

```json
{ "file": "services/billing/src/fees.ts", "name": "calculateFee" }
```

传给 `spec_nav_read_function`，使用结果中真实的路径和名称；也可以传 `{ "id": "<工具返回的 id>" }`。函数较长时，把返回的 `nextCursor` 作为 `cursor` 继续读取。

**浏览某个服务的函数**

```json
{ "services": ["services/api"], "name": "fee", "limit": 100 }
```

传给 `spec_nav_functions`。省略 `services` 则覆盖所有发现的项目；`services: ["."]` 只选择根项目自身的文件。可用过滤条件包括 `file`、`name`、`kind`、`language` 和 `exportedOnly`。

**检查调用方**

```json
{ "symbol": "calculateFee", "file": "services/billing/src/fees.ts", "format": "json" }
```

传给 `spec_nav_callers`。用限定名（如 `OrderService.calculateFee`）或声明所在文件来消除歧义。`service` 缩小声明的查找范围；`searchServices` 缩小调用方的搜索范围。

**梳理一个概念**

```json
{ "pattern": "handl(e|ing)_?fee|handling_charge|HANDLING_FEE" }
```

传给 `spec_nav_map`。匹配不区分大小写。默认跳过注释和 import 行；设置 `includeComments: true` 可包含它们。

## 理解结果

- **分页：** `MORE` 或 `nextCursor` 表示还有更多结果，用同样的查询加上该 cursor 再调用。分页取完不等于源码覆盖完整。
- **覆盖率：** `PARTIAL` 表示有部分源文件不受支持、无法读取、被跳过或存在解析错误。请用其他工具检查这些缺口。
- **搜索：** 结果是带有标注证据的词汇匹配排序，而非语义理解。仅通过被调用名称匹配的标记为 `[via calls]`，仅在函数体中匹配的标记为 `[body only]`，两者排序靠后。过于宽泛的仅函数体匹配可能作为噪声被隐藏，输出会报告其数量。
- **相似度：** 相似度高表示代码看起来相像（相同的调用、相同的词汇），不代表可以互相替换。
- **调用方：** 每个位置都会说明绑定方式。请复查 `likely`（仅有一个同名声明但未证实）、`ambiguous`（可能匹配多个声明）、`unresolved`（无法确定）和 `dynamic`（以字符串/符号形式出现的动态调用）。即使 `exhaustive: true`（仅限经类型检查的目标），也不涵盖运行时拼接的名称、通过 HTTP/RPC/队列的调用或外部仓库。
- **时效性：** 新增、修改和删除的源文件会在后续调用中反映出来。函数 ID 依赖其源码文本；如果读取时报告 `STALE ID`，请重新查找该函数。

## 故障排查

| 问题 | 检查项 |
|---|---|
| `spec-nav` 无法连接 | 客户端能否使用 Node.js/npm/Git；配置是否有效；安装时能否访问 GitHub。 |
| 项目不对或找不到源文件 | 让 Claude 调用 `spec_nav_services`；检查 `SPEC_NAV_ROOT` 以及当前会话使用的 `.mcp.json`。 |
| 缺少某个函数 | 检查支持的语言、覆盖率、目录过滤条件以及下方的限制。 |
| 搜索不到有用的候选 | 换用其他英文关键词、浏览函数目录，或使用普通搜索。 |
| `STALE ID` | 重新查找该函数并使用当前 ID。 |
| 本地修改的 MCP 没有生效 | `npx github:` 使用已提交的包。开发时请使用下方的本地配置。 |
| Claude Desktop 扩展无法启动 | 确认已设置 **Repository to scan** 并启用了扩展。查看 **Settings → Extensions**，以及 **Settings → Developer** 中的 MCP 日志。 |
| Claude Desktop 扫描了错误的仓库 | 在扩展设置中修改 **Repository to scan**，然后新建对话。 |

## 支持的语言

| 语言 | 文件扩展名 |
|---|---|
| TypeScript | `.ts`、`.tsx`、`.mts`、`.cts` |
| JavaScript | `.js`、`.jsx`、`.mjs`、`.cjs` |
| Python | `.py`、`.pyi` |
| Go | `.go` |
| Java | `.java` |
| C# | `.cs` |
| Ruby | `.rb`、`.rake` |
| Rust | `.rs` |
| PHP | `.php` |
| C | `.c`、`.h` |
| C++ | `.cpp`、`.cc`、`.cxx`、`.hpp`、`.hh`、`.hxx` |
| Scala | `.scala`、`.sc` |
| Elixir | `.ex`、`.exs` |
| Bash | `.sh`、`.bash`、`.zsh` |
| Kotlin | `.kt`、`.kts` |
| Swift | `.swift` |
| Vue / Svelte / Astro | `.vue`、`.svelte`、`.astro`（读取 script 块；调用方分析也包括模板） |

TS/JS 支持具名声明、方法、访问器、保存在变量或属性中的箭头函数/函数表达式、受支持的赋值形式以及 CommonJS 导出；Vue/Svelte/Astro 组件按其 `<script>`（及 frontmatter）读取，行号保持不变。Kotlin 和 Swift 使用结构化扫描器读取（精确识别字符串、插值、嵌套注释和括号；识别 class、object、extension、`fun`/`func`、`init`/`constructor`、表达式函数体、闭包和计算属性），因为现有的 tree-sitter 语法在这里无法稳定解析它们。其他语言使用 tree-sitter。

调用方分析在 **TS/JS/Vue/Svelte/Astro 中经类型检查**，在 **其他所有受支持语言中基于证据**（见 `spec_nav_callers`）。

## 基准测试

两个模拟代理执行相同的任务——一个只有 Grep/Read/Edit（类似 Claude Code 的内置工具），另一个有 spec-nav 加 Read/Edit。每个会话是一个完整的功能需求：复用已有逻辑、修改一个函数的签名并更新所有调用方、在所有位置修改一个常量，然后阅读并修改涉及的每个文件。代理是确定性策略，不是 LLM；基线代理被赋予了 LLM 的同义词知识，并采用同样宽松的“读到即视为识别”规则。方法、假设与局限：[bench/README.zh-CN.md](bench/README.zh-CN.md)。完整报告：[bench/results/](bench/results/)。

| | 合成仓库，100 个会话 | 合成仓库，50 个大会话 | immich（真实），20 个会话 | immich（真实），10 个大会话 |
|---|---:|---:|---:|---:|
| 每会话上下文，无 MCP → 有 MCP | 31k → 24k（−25%） | 92k → 71k（−24%） | 116k → 98k（−16%） | 302k → 227k（−25%） |
| …其中搜索阶段 | −57% | −55% | −70% | −69% |
| 启用提示缓存时的输入 token | −18% | −26% | −16% | −38% |
| 工具调用（模型轮次） | −10% | −9% | −2% | −20% |
| 复用了已有函数 | 97% → 99% | 90% → 95% | 55% → 90% | 40% → 93% |
| 调用方完整且无多余 | 100% → 100% | 100% → 100% | 85% → 90% | 53% → 73% |
| 每会话错误修改数 | 0 → 0 | 0 → 0 | 0.3 → 0.2 | 14.4 → 2.4 |
| 会话完全正确 | 97% → 99% | 70% → 86% | 50% → 85% | 0% → 30% |
| 工具耗时（含 MCP 冷启动） | +4.1 s | +6.1 s | +3.2 s | +6.6 s |

无论哪种方式，读取要修改的文件成本相同；节省来自搜索阶段。对于小型、单一概念的修改收益很小——而且每个有 MCP 的轮次都会多带约 3.8k token 的工具定义。质量提升来自于找到名称不同的代码（复用），以及不误改其他类上同名方法的调用（调用方）。

**超大仓库** —— VS Code（14,306 个文件，约 450 万行，154k 个函数入目录），Apple M4：首次索引 31 s，之后 `find_functions` 2.6–4.3 s、`map` 0.5–1.8 s、`similar_functions` 0.9 s、`read_function` 0.15 s；普通函数的 `callers` 16 s，对在 822 个文件中出现的名称（`readFile`）需要 90 s 和 3 GB 内存。`callers` 之外 server 内存为 0.7–0.9 GB。详情：[bench/results/perf-vscode.md](bench/results/perf-vscode.md)。

```bash
npm run bench                                   # 合成仓库：100 个会话 + 50 个大会话
node bench/real.mjs --repo /path/to/your/repo   # 你自己的仓库，由独立 oracle 评分
node bench/perf.mjs --repo /path/to/huge/repo   # 耗时与内存
```

## 局限

| 方面 | 说明 |
|---|---|
| 搜索 | 基于词、被调用名称、缩写、同义词和概念列表、IDF——本质仍是词汇匹配。`spec_nav_similar_functions` 只有在代码共享调用或词汇时，才能找到名称无关但行为相同的代码；两段毫无共同点的实现仍会遗漏。 |
| 翻译 | 带声调的越南语通过内置的约 100 个常用领域术语词典进行匹配；其他词不翻译。中文查询不会被翻译，请使用英文关键词。 |
| 复用 | 请自行检查导出、行为以及包/服务依赖。 |
| 调用方 | 在 TS/JS 之外，绑定依据证据（import、限定符、声明的接收者类型），而非类型检查器：推断类型、继承和重载可能使位置停留在 `likely`/`ambiguous`。运行时拼接的名称、HTTP/RPC/队列调用和外部仓库不会被追踪。 |
| 匿名回调 | 内联匿名回调不会单独入目录；JS/TS 会在覆盖率中统计它们。 |
| 函数形式 | JS/TS 的解构赋值、动态属性赋值、工厂创建的函数、`Object.assign`/`Object.defineProperty` 以及部分链式赋值尚未完全覆盖。其他语言中赋值给变量的 lambda/闭包不会入目录。 |
| 不支持的文件 | Dart、Lua、Objective-C、SQL 等不受支持的源文件类型不会被解析（但计入覆盖率统计）。 |
| 排除项 | 排除依赖/构建目录、隐藏目录、虚拟环境、声明文件、压缩过的 JS，以及超过 1.5 MB 的受支持文件。 |
| 类型 | 只报告显式书写的返回类型；目录不做类型推断。 |
| 大型仓库 | 在 VS Code（14k 个文件）上测得：首次索引约 31 s，搜索数秒。TS/JS 调用方分析只对提及该名称的文件分批做类型检查，沿 import 追踪两层；对于非常常见的名称需要数分钟和约 3 GB 内存，接收者类型位于更远处的调用会报告为 `unresolved`。 |
| 依赖 | 已安装依赖（`node_modules`）时 TS/JS 类型解析效果最好；未安装时库类型未知，更多调用会变成 `unresolved`。 |

server 读取当前的本地代码副本。不需要搜索 API 密钥，搜索过程也不会把代码发送到外部搜索服务。结果返回给已连接的编码代理；该客户端对模型和数据的处理仍遵循你的配置。

## 从源码本地安装

在开发本 MCP 或测试尚未推送的修改时使用。

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run build
```

用绝对路径配置 `.mcp.json`：

```json
{
  "mcpServers": {
    "spec-nav": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-spec-nav/dist/index.cjs"],
      "env": {
        "SPEC_NAV_ROOT": "/absolute/path/to/your-project"
      }
    }
  }
}
```

`args` 指向 MCP 的安装位置；`SPEC_NAV_ROOT` 指向要扫描的代码。修改 MCP 源码后，重新构建并重启客户端会话。

## 开发

```bash
npm run typecheck
npm test
```

`npm test` 会构建 bundle，并在示例仓库上通过 MCP stdio 进行测试。

### 打包 Claude Desktop 扩展

```bash
npm run pack:mcpb
```

该命令构建 `dist/index.cjs`，将其连同 `manifest.json`、`web-tree-sitter` 和语法的 `.wasm` 文件放入 `build/mcpb/`，校验 manifest，并生成 `build/mcp-spec-nav-<version>.mcpb`。manifest 由 [scripts/pack-mcpb.mjs](scripts/pack-mcpb.mjs) 生成，版本号取自 `package.json`。发布时把 `.mcpb` 文件附加到 GitHub release。

针对打包后的扩展（而非 `dist/`）运行测试：

```bash
unzip -q build/mcp-spec-nav-<version>.mcpb -d /tmp/spec-nav-mcpb
SPEC_NAV_DIST=/tmp/spec-nav-mcpb/dist/index.cjs node --test test/*.test.mjs
```

这些检查验证的是已测试的场景，并不能证明代理在每个任务上都会写出更好的代码。有/无 MCP 的对比数据见 [基准测试](#基准测试)，也可以在你自己的仓库上运行 `bench/real.mjs`。

## 许可证

MIT。见 [LICENSE](LICENSE)。

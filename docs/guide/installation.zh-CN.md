# 安装

[English](installation.md) · [Tiếng Việt](installation.vi.md) · [简体中文](installation.zh-CN.md)

← [README](../../README.zh-CN.md) · [工具参考](tools.zh-CN.md) · [故障排查](troubleshooting.zh-CN.md)

## 选择安装方式

| | 方式一：Claude Code（`.mcp.json`） | 方式二：Claude Desktop 扩展（`.mcpb`） |
|---|---|---|
| 客户端 | Claude Code（以及其他读取 `.mcp.json` 的客户端） | Claude Desktop |
| 需要 | Node.js 18+、npm/npx、Git | 只需 Claude Desktop——扩展使用其内置的 Node.js 运行 |
| 指定要扫描的仓库 | 配置文件中的 `SPEC_NAV_ROOT` | 扩展设置中的文件夹选择器 |
| 适合 | 写代码：Claude 在仓库中阅读、规划并修改代码 | 了解代码：在对话中查找、阅读和检查函数 |

两种方式运行的是同一个 server、同一套工具，可以同时使用。

## Claude Code

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
在实现订单费用计算之前，使用 spec-nav 在所有服务和共享包中搜索已有函数。
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

**跨服务追踪一个请求**

```text
修改 POST /orders 接口之前，使用 spec-nav 追踪谁调用了它（upstream）以及它向下游
到达哪里（downstream），跨越各个服务。阅读每条连接的两端，并列出被报告为
partial、ambiguous 或 unresolved 的连接。
```

## Claude Desktop 扩展

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
2. 用 spec_nav_read_function 阅读最相关的候选，每次调用可读多项（`functions`）。
   不打算修改的代码：读函数，或读类（file + 类名）而不是整个文件；只传 `file`
   可代替 `cat` 读取整个文件。
   避免把整个函数目录或所有函数体加载进上下文。
   找不到合适的函数时，先写草稿，再交给 spec_nav_similar_functions。
3. 复用前检查行为、导出、依赖和服务边界。
   其他服务的函数并不一定可以直接导入。
4. 修改函数签名或行为之前使用 spec_nav_callers。
   手动检查标记为 likely、ambiguous、unresolved 或 dynamic 的位置。
   涉及多个文件或服务的概念，用一个宽泛的正则配合 spec_nav_map。
5. 当修改涉及接口、事件或对其他服务的调用时，使用 spec_nav_trace_flow
   （upstream：谁会到达这里；downstream：它会到达哪里）。
   标记为 partial、ambiguous 或 unresolved 的连接只是线索，不是结论：请阅读两端。
6. 查看覆盖率和未解析结果。需要完整结果时继续翻页（cursor）；
   对不支持或缺失的部分，使用普通搜索和文件读取。
7. 修改完成后，重新执行相关查询，并运行项目相应的检查。

按任务规模取舍。小而独立的修改不需要用到每个工具。
搜索结果只是候选，找不到并不能证明仓库里没有其他实现。
```

其他代理请把这段改写到各自的项目说明文件中，例如 `AGENTS.md`。

## 从本地源码安装

在开发本 MCP 或测试尚未推送的修改时使用。`npx github:` 始终运行已提交的包，因此本地修改不会通过它生效。

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

`args` 指向 MCP 的安装位置；`SPEC_NAV_ROOT` 指向要扫描的代码。修改 MCP 源码后，重新构建并重启客户端会话。测试与打包见 [开发](development.zh-CN.md)。

## 隐私

server 读取当前的本地代码副本。不需要搜索 API 密钥，搜索过程也不会把代码发送到外部搜索服务。结果返回给已连接的编码代理；该客户端对模型和数据的处理仍遵循你的配置。

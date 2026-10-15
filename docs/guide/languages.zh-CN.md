# 支持的语言

[English](languages.md) · [Tiếng Việt](languages.vi.md) · [简体中文](languages.zh-CN.md)

← [README](../../README.zh-CN.md) · [工具参考](tools.zh-CN.md)

| 语言 | 文件扩展名 | 调用方分析 |
|---|---|---|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | 类型检查 |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | 类型检查 |
| Vue / Svelte / Astro | `.vue`, `.svelte`, `.astro`（script 块；调用方分析包含模板） | 类型检查 |
| Python | `.py`, `.pyi` | 基于证据 |
| Go | `.go` | 基于证据 |
| Java | `.java` | 基于证据 |
| C# | `.cs` | 基于证据 |
| Ruby | `.rb`, `.rake` | 基于证据 |
| Rust | `.rs` | 基于证据 |
| PHP | `.php` | 基于证据 |
| C | `.c`, `.h` | 基于证据 |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | 基于证据 |
| Scala | `.scala`, `.sc` | 基于证据 |
| Elixir | `.ex`, `.exs` | 基于证据 |
| Bash | `.sh`, `.bash`, `.zsh` | 基于证据 |
| Kotlin | `.kt`, `.kts` | 基于证据 |
| Swift | `.swift` | 基于证据 |

## 各语言的读取方式

- **TS/JS** 支持具名声明、方法、访问器、保存在变量或属性中的箭头函数/函数表达式、受支持的赋值形式以及 CommonJS 导出。
- **Vue/Svelte/Astro** 组件按其 `<script>`（及 frontmatter）读取，行号保持不变。
- **Kotlin 和 Swift** 使用结构化扫描器读取（精确识别字符串、插值、嵌套注释和括号；识别 class、object、extension、`fun`/`func`、`init`/`constructor`、表达式函数体、闭包和计算属性），因为现有的 tree-sitter 语法在这里无法稳定解析它们。
- **其他语言** 使用 tree-sitter。

## 调用方

调用方分析在 **TS/JS/Vue/Svelte/Astro 中经类型检查**，在 **其他所有受支持语言中基于证据**：同一文件/类、限定符、import 或别名、包，或声明为该类类型的接收者。推断类型、继承和重载可能使基于证据的位置停留在 `likely` 或 `ambiguous`。见 [理解结果](tools.zh-CN.md#理解结果)。

## 跨服务调用链

`spec_nav_trace_flow` 只为 TypeScript/JavaScript 和 Python 框架提供适配器；其他语言会被报告为未追踪。见 [受支持的框架](flows.zh-CN.md#受支持的框架)。

## 不解析的文件

Dart、Lua、Objective-C、SQL 等不受支持的源文件类型不会被解析（但计入覆盖率统计）。排除依赖/构建目录、隐藏目录、虚拟环境、声明文件、压缩过的 JS，以及超过 1.5 MB 的受支持文件。

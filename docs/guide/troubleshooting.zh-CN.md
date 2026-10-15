# 故障排查

[English](troubleshooting.md) · [Tiếng Việt](troubleshooting.vi.md) · [简体中文](troubleshooting.zh-CN.md)

← [README](../../README.zh-CN.md) · [安装](installation.zh-CN.md) · [工具参考](tools.zh-CN.md)

| 现象 | 检查方法 |
|---|---|
| MCP 无法连接 | 检查 Node.js/npm/Git、配置是否有效，以及安装时能否访问 GitHub。 |
| 服务不对或找不到源文件 | 让 Claude 调用 `spec_nav_services`，检查 `SPEC_NAV_ROOT` 和当前会话使用的 `.mcp.json`。 |
| 缺少某个函数 | 检查过滤条件、覆盖率、[支持的语言](languages.zh-CN.md) 以及 [局限](../../README.zh-CN.md#局限)。 |
| 搜索不到合适的函数 | 换用其他英文关键词、浏览函数目录，或使用普通搜索。 |
| 读取函数时报告 `STALE ID` | 重新查找该函数并使用当前 ID。 |
| 修改了 MCP 源码但结果不变 | `npx github:` 使用已提交的包；开发时请使用 [从本地源码安装](installation.zh-CN.md#从本地源码安装) 的配置。 |
| TS/JS 中有大量 `unresolved` 调用方 | 安装项目依赖（`node_modules`）；未安装时库类型未知。 |
| Claude Desktop 扩展无法运行 | 确认已设置 **Repository to scan** 并在 **Settings → Extensions** 中启用扩展；在 **Settings → Developer** 查看 MCP 日志。 |
| Claude Desktop 扫描了错误的仓库 | 在扩展设置中修改 **Repository to scan**，然后新建对话。 |

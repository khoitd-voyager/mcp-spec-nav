# 开发

[English](development.md) · [Tiếng Việt](development.vi.md) · [简体中文](development.zh-CN.md)

← [README](../../README.zh-CN.md) · [安装](installation.zh-CN.md)

## 构建与测试

要在客户端中运行本地构建，见 [从本地源码安装](installation.zh-CN.md#从本地源码安装)。

```bash
npm install
npm run typecheck
npm test
```

`npm test` 会构建 bundle，并在示例仓库上通过 MCP stdio 进行测试。

这些检查验证的是已测试的场景，并不能证明代理在每个任务上都会写出更好的代码。有/无 MCP 的对比数据见 [基准测试](../../bench/README.md#简体中文)，也可以在你自己的仓库上运行 `bench/real.mjs`。

## 打包 Claude Desktop 扩展

```bash
npm run pack:mcpb
```

该命令构建 `dist/index.cjs`，将其连同 `manifest.json`、`web-tree-sitter` 和语法的 `.wasm` 文件放入 `build/mcpb/`，校验 manifest，并生成 `build/mcp-spec-nav-<version>.mcpb`。manifest 由 [scripts/pack-mcpb.mjs](../../scripts/pack-mcpb.mjs) 生成，版本号取自 `package.json`。发布时把 `.mcpb` 文件附加到 GitHub release。

针对打包后的扩展（而非 `dist/`）运行测试：

```bash
unzip -q build/mcp-spec-nav-<version>.mcpb -d /tmp/spec-nav-mcpb
SPEC_NAV_DIST=/tmp/spec-nav-mcpb/dist/index.cjs node --test test/*.test.mjs
```

## 基准测试

```bash
npm run bench                                   # 合成仓库：100 + 50 个大会话
node bench/real.mjs --repo /path/to/your/repo   # 你自己的仓库，由 oracle 校验
node bench/perf.mjs --repo /path/to/huge/repo   # 耗时与内存
node bench/flow.mjs                             # 跨服务连接，保留种子
```

选项、方法与局限：[bench/README.md](../../bench/README.md#简体中文)。

## 网站

GitHub Pages 站点位于 `docs/`（`index.html`、`vi/`、`zh/`）。修改 `docs/index.html` 后，运行 `python scripts/build-pages.py` 重新生成各语言页面。见 [GITHUB-PAGES-SETUP.md](../../GITHUB-PAGES-SETUP.md)。

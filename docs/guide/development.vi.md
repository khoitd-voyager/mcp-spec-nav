# Phát triển

[English](development.md) · [Tiếng Việt](development.vi.md) · [简体中文](development.zh-CN.md)

← [README](../../README.vi.md) · [Cài đặt](installation.vi.md)

## Build và test

Muốn chạy bản build local trong client, xem [Cài từ source local](installation.vi.md#cài-từ-source-local).

```bash
npm install
npm run typecheck
npm test
```

`npm test` build bundle rồi kiểm thử qua MCP stdio trên các repo mẫu.

Các kiểm tra xác nhận tình huống đã test, không chứng minh AI sẽ code tốt hơn trong mọi task. Xem [benchmark](../../bench/README.md#tiếng-việt) để biết số đo có/không MCP, và chạy `bench/real.mjs` trên repo của bạn.

## Đóng gói extension cho Claude Desktop

```bash
npm run pack:mcpb
```

Lệnh này build `dist/index.cjs`, gom vào `build/mcpb/` cùng `manifest.json`, `web-tree-sitter` và chỉ các file `.wasm` của grammar, kiểm tra manifest rồi tạo `build/mcp-spec-nav-<version>.mcpb`. Manifest được sinh từ [scripts/pack-mcpb.mjs](../../scripts/pack-mcpb.mjs), version lấy từ `package.json`. Muốn phát hành thì đính kèm file `.mcpb` vào GitHub release.

Chạy test trên bản extension đã đóng gói thay vì `dist/`:

```bash
unzip -q build/mcp-spec-nav-<version>.mcpb -d /tmp/spec-nav-mcpb
SPEC_NAV_DIST=/tmp/spec-nav-mcpb/dist/index.cjs node --test test/*.test.mjs
```

## Benchmark

```bash
npm run bench                                   # repo giả lập: 100 + 50 session lớn
node bench/real.mjs --repo /path/to/your/repo   # repo của bạn, chấm bằng oracle
node bench/perf.mjs --repo /path/to/huge/repo   # thời gian và bộ nhớ
node bench/flow.mjs                             # link giữa các service, seed kiểm tra
```

Tùy chọn, phương pháp và giới hạn: [bench/README.md](../../bench/README.md#tiếng-việt).

## Website

Trang GitHub Pages nằm trong `docs/` (`index.html`, `vi/`, `zh/`). Sửa `docs/index.html`, rồi sinh lại các trang ngôn ngữ bằng `python scripts/build-pages.py`. Xem [GITHUB-PAGES-SETUP.md](../../GITHUB-PAGES-SETUP.md).

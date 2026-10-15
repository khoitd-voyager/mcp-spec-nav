# Khi gặp lỗi

[English](troubleshooting.md) · [Tiếng Việt](troubleshooting.vi.md) · [简体中文](troubleshooting.zh-CN.md)

← [README](../../README.vi.md) · [Cài đặt](installation.vi.md) · [Tham khảo tool](tools.vi.md)

| Hiện tượng | Cách kiểm tra |
|---|---|
| MCP không kết nối | Kiểm tra Node.js/npm/Git, cấu hình và khả năng truy cập GitHub lúc cài. |
| Sai service hoặc không thấy source | Nhờ Claude gọi `spec_nav_services`, kiểm tra `SPEC_NAV_ROOT` và file `.mcp.json` session đang dùng. |
| Thiếu hàm | Kiểm tra bộ lọc, coverage, [ngôn ngữ hỗ trợ](languages.vi.md) và [giới hạn](../../README.vi.md#giới-hạn). |
| Tìm không ra hàm phù hợp | Thử từ khóa tiếng Anh khác, xem danh mục hoặc dùng tìm kiếm thông thường. |
| Đọc hàm báo `STALE ID` | Tìm lại hàm và dùng ID hiện tại. |
| Sửa source MCP nhưng kết quả không đổi | `npx github:` dùng bản package đã commit; dùng [cấu hình cài từ source local](installation.vi.md#cài-từ-source-local) khi phát triển. |
| Nhiều caller `unresolved` ở TS/JS | Cài dependency của dự án (`node_modules`); thiếu thì kiểu của thư viện không có. |
| Extension trên Claude Desktop không chạy | Kiểm tra đã chọn **Repository to scan** và đã bật extension trong **Settings → Extensions**; xem log MCP ở **Settings → Developer**. |
| Claude Desktop quét sai repo | Đổi **Repository to scan** trong cài đặt extension rồi mở chat mới. |

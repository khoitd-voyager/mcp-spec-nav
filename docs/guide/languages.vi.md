# Ngôn ngữ hỗ trợ

[English](languages.md) · [Tiếng Việt](languages.vi.md) · [简体中文](languages.zh-CN.md)

← [README](../../README.vi.md) · [Tham khảo tool](tools.vi.md)

| Ngôn ngữ | Đuôi file | Callers |
|---|---|---|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | Type checker |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | Type checker |
| Vue / Svelte / Astro | `.vue`, `.svelte`, `.astro` (khối script; template cho callers) | Type checker |
| Python | `.py`, `.pyi` | Theo bằng chứng |
| Go | `.go` | Theo bằng chứng |
| Java | `.java` | Theo bằng chứng |
| C# | `.cs` | Theo bằng chứng |
| Ruby | `.rb`, `.rake` | Theo bằng chứng |
| Rust | `.rs` | Theo bằng chứng |
| PHP | `.php` | Theo bằng chứng |
| C | `.c`, `.h` | Theo bằng chứng |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | Theo bằng chứng |
| Scala | `.scala`, `.sc` | Theo bằng chứng |
| Elixir | `.ex`, `.exs` | Theo bằng chứng |
| Bash | `.sh`, `.bash`, `.zsh` | Theo bằng chứng |
| Kotlin | `.kt`, `.kts` | Theo bằng chứng |
| Swift | `.swift` | Theo bằng chứng |

## Cách đọc từng ngôn ngữ

- **TS/JS** hỗ trợ declaration có tên, method, accessor, arrow/function expression lưu trong biến/property, các dạng assignment được hỗ trợ và CommonJS export.
- Component **Vue/Svelte/Astro** được đọc qua `<script>` (và frontmatter), giữ nguyên số dòng.
- **Kotlin và Swift** dùng scanner cấu trúc riêng (đọc chính xác chuỗi, interpolation, comment lồng nhau, ngoặc; nhận diện class, object, extension, `fun`/`func`, `init`/`constructor`, thân dạng biểu thức, closure, computed property) vì grammar tree-sitter hiện có không parse ổn định.
- **Các ngôn ngữ khác** dùng tree-sitter.

## Callers

Callers được **kiểm tra bằng type checker cho TS/JS/Vue/Svelte/Astro** và **theo bằng chứng cho mọi ngôn ngữ còn lại**: cùng file/class, qualifier, import hoặc alias, package, hoặc receiver được khai báo đúng kiểu class. Kiểu suy luận, kế thừa và overload có thể để lại site `likely` hoặc `ambiguous`. Xem [Cách đọc kết quả](tools.vi.md#cách-đọc-kết-quả).

## Luồng giữa các service

`spec_nav_trace_flow` chỉ có adapter cho framework TypeScript/JavaScript và Python; ngôn ngữ khác được báo là chưa lần theo. Xem [Framework được hỗ trợ](flows.vi.md#framework-được-hỗ-trợ).

## Không được parse

Không parse Dart, Lua, Objective-C, SQL và các loại nguồn chưa hỗ trợ (có đếm trong coverage). Bỏ qua thư mục dependency/build, thư mục ẩn, virtualenv, file declaration, JS minified và file hỗ trợ lớn hơn 1,5 MB.

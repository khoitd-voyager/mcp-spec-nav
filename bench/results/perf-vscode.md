# Performance on VS Code / Hiệu năng trên VS Code / VS Code 上的性能 (microsoft/vscode@acf9515d, sparse: src, extensions, build, cli)

**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**

## English

Machine: Apple M4, 24 GB RAM, Node v24.15.0. A fresh (cold) server, then consecutive calls on the same server.

### Performance on vscode

- 14,306 files read, 154,052 functions in the catalog, 170 projects.
- Coverage: 14306 files read (javascript 96, rust 89, typescript 13961, bash 28, python 73, csharp 16, cpp 22, go 4, java 7, ruby 5, php 3, c 1, swift 1). PARTIAL: 48 file(s) with syntax errors (their function lists may be incomplete); 16 source file(s) in unsupported languages not read (.coffee 2, .clj 1, .dart 1, .fs 1, .groovy 1, .hbs 1, .jl 1, .lua 1, .m 1, .mm 1, .pl 2, .r 1, .sql 1, .vb 1); 2 file(s) skipped as minified or oversized. 22 dependency/build/virtualenv directories excluded by design. 189340 inline anonymous function(s) (callbacks) have no name and are not listed.

| Operation | Time | Server RAM | Output |
|---|---:|---:|---:|
| cold: spec_nav_services (index whole repo) | 31,273 ms | 712 MB | 35,635 chars |
| warm: spec_nav_services | 172 ms | 724 MB | 35,635 chars |
| find_functions "parse configuration file" | 3,980 ms | 754 MB | 14,893 chars |
| find_functions "register command" | 2,610 ms | 770 MB | 15,874 chars |
| find_functions "resolve file path" | 4,289 ms | 703 MB | 15,296 chars |
| functions (first page, json) | 243 ms | 749 MB | 33,286 chars |
| read_function | 152 ms | 753 MB | 734 chars |
| similar_functions (by id) | 884 ms | 905 MB | 2,292 chars |
| map "telemetry[_ -]?reporter" | 1,804 ms | 923 MB | 34,332 chars |
| map "max[_ -]?file[_ -]?size" | 512 ms | 935 MB | 13,282 chars |
| cold callers isEqualOrParent | 16,489 ms | 1418 MB | 27,466 chars |
| callers FileService.readFile | 89,749 ms | 3072 MB | 31,026 chars |

## Tiếng Việt

Máy: Apple M4, 24 GB RAM, Node v24.15.0. Server mới (cold), rồi các lệnh nối tiếp trên cùng server.

### Hiệu năng trên vscode

- 14,306 file được đọc, 154,052 hàm trong catalog, 170 project.
- Coverage: 14306 files read (javascript 96, rust 89, typescript 13961, bash 28, python 73, csharp 16, cpp 22, go 4, java 7, ruby 5, php 3, c 1, swift 1). PARTIAL: 48 file(s) with syntax errors (their function lists may be incomplete); 16 source file(s) in unsupported languages not read (.coffee 2, .clj 1, .dart 1, .fs 1, .groovy 1, .hbs 1, .jl 1, .lua 1, .m 1, .mm 1, .pl 2, .r 1, .sql 1, .vb 1); 2 file(s) skipped as minified or oversized. 22 dependency/build/virtualenv directories excluded by design. 189340 inline anonymous function(s) (callbacks) have no name and are not listed.

| Thao tác | Thời gian | RAM server | Output |
|---|---:|---:|---:|
| cold: spec_nav_services (index whole repo) | 31,273 ms | 712 MB | 35,635 ký tự |
| warm: spec_nav_services | 172 ms | 724 MB | 35,635 ký tự |
| find_functions "parse configuration file" | 3,980 ms | 754 MB | 14,893 ký tự |
| find_functions "register command" | 2,610 ms | 770 MB | 15,874 ký tự |
| find_functions "resolve file path" | 4,289 ms | 703 MB | 15,296 ký tự |
| functions (first page, json) | 243 ms | 749 MB | 33,286 ký tự |
| read_function | 152 ms | 753 MB | 734 ký tự |
| similar_functions (by id) | 884 ms | 905 MB | 2,292 ký tự |
| map "telemetry[_ -]?reporter" | 1,804 ms | 923 MB | 34,332 ký tự |
| map "max[_ -]?file[_ -]?size" | 512 ms | 935 MB | 13,282 ký tự |
| cold callers isEqualOrParent | 16,489 ms | 1418 MB | 27,466 ký tự |
| callers FileService.readFile | 89,749 ms | 3072 MB | 31,026 ký tự |

## 简体中文

机器：Apple M4，24 GB 内存，Node v24.15.0。先启动一个全新（冷启动）的 server，然后在同一 server 上连续调用。

### vscode 上的性能

- 读取 14,306 个文件，目录中 154,052 个函数，170 个项目。
- Coverage: 14306 files read (javascript 96, rust 89, typescript 13961, bash 28, python 73, csharp 16, cpp 22, go 4, java 7, ruby 5, php 3, c 1, swift 1). PARTIAL: 48 file(s) with syntax errors (their function lists may be incomplete); 16 source file(s) in unsupported languages not read (.coffee 2, .clj 1, .dart 1, .fs 1, .groovy 1, .hbs 1, .jl 1, .lua 1, .m 1, .mm 1, .pl 2, .r 1, .sql 1, .vb 1); 2 file(s) skipped as minified or oversized. 22 dependency/build/virtualenv directories excluded by design. 189340 inline anonymous function(s) (callbacks) have no name and are not listed.

| 操作 | 耗时 | Server 内存 | 输出 |
|---|---:|---:|---:|
| cold: spec_nav_services (index whole repo) | 31,273 ms | 712 MB | 35,635 字符 |
| warm: spec_nav_services | 172 ms | 724 MB | 35,635 字符 |
| find_functions "parse configuration file" | 3,980 ms | 754 MB | 14,893 字符 |
| find_functions "register command" | 2,610 ms | 770 MB | 15,874 字符 |
| find_functions "resolve file path" | 4,289 ms | 703 MB | 15,296 字符 |
| functions (first page, json) | 243 ms | 749 MB | 33,286 字符 |
| read_function | 152 ms | 753 MB | 734 字符 |
| similar_functions (by id) | 884 ms | 905 MB | 2,292 字符 |
| map "telemetry[_ -]?reporter" | 1,804 ms | 923 MB | 34,332 字符 |
| map "max[_ -]?file[_ -]?size" | 512 ms | 935 MB | 13,282 字符 |
| cold callers isEqualOrParent | 16,489 ms | 1418 MB | 27,466 字符 |
| callers FileService.readFile | 89,749 ms | 3072 MB | 31,026 字符 |

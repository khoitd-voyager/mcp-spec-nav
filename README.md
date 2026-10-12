# mcp-spec-nav

Help your coding agent find existing functions before writing new code, and check what a change affects across your repository.

Giúp AI tìm hàm có sẵn trước khi viết code mới và kiểm tra các phần liên quan khi sửa code trong repo.

**[English](#english) · [Tiếng Việt](#tiếng-việt)**

### How it helps your coding agent

| Scenario | Value of the MCP |
|---|---|
| Logic is spread across multiple services | High: searches broadly and helps reduce missed code. |
| You want to reuse functions instead of rewriting them | High, when the query finds the right candidates. |
| You change function parameters and need to find callers | Useful. |
| You make a simple edit within one file | Limited benefit; may add tool calls. |

### MCP giúp ích gì khi AI code?

| Trường hợp | Giá trị của MCP |
|---|---|
| Logic nằm rải ở nhiều service | Cao: giúp tìm rộng, giảm bỏ sót |
| Muốn tái sử dụng hàm thay vì viết lại | Cao, nếu truy vấn tìm đúng ứng viên. |
| Sửa tham số hàm, cần tìm callers | Hữu ích. |
| Sửa đơn giản trong một file | Lợi ích ít, có thể thêm lượt gọi tool. |

## English

### What does it do?

`mcp-spec-nav` is a local MCP server for coding agents such as Claude Code. It reads source code in the repository you choose and provides tools to:

- Find existing functions across services and shared packages.
- Read a function's source, signature, documentation and relevant imports.
- Find TypeScript/JavaScript callers before changing a function.
- Search a pattern across supported source files, with the enclosing function for each match.

**Example:** You ask Claude to add an order fee calculation. Instead of immediately writing another implementation, Claude can look for existing fee functions in the billing service and shared packages, read them, and decide whether one fits.

The MCP reads code. Your coding agent decides what to reuse and makes the edits. It does not guarantee that every related function will be found.

### Choose how to install

| | Option 1: `.mcp.json` | Option 2: Claude Desktop extension (`.mcpb`) |
|---|---|---|
| Client | Claude Code (and other clients that read `.mcp.json`) | Claude Desktop |
| You need | Node.js 18+, npm/npx, Git | Only Claude Desktop — it runs the extension with its built-in Node.js |
| Repository to scan | `SPEC_NAV_ROOT` in the config file | Folder picker in the extension settings |
| Best for | Coding: Claude reads, plans and edits code in the repo | Asking about code: find, read and check functions in chat |

Both options run the same server and the same tools. You can use both at once.

### Option 1: Quick start with Claude Code

**Requirements:** Node.js 18 or newer, npm/npx, Git, and a local checkout of the repository you want to scan. The first installation needs network access.

#### 1. Add the MCP configuration

Create `.mcp.json` at the root of your target repository:

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

**Replace `/Users/you/code/your-repo` with the absolute path to the code you want scanned.** Use the monorepo root to cover multiple services. This is the target repository, not the installation directory of `mcp-spec-nav`.

If `.mcp.json` already exists, add the `spec-nav` entry inside its existing `mcpServers` object. Keep your other MCP configurations.

#### 2. Check the connection

Open Claude Code in that repository, restart the session, and run:

```text
/mcp
```

Check that `spec-nav` is connected. Complete any configuration approval requested by your client.

Then send Claude:

```text
Use spec-nav to list the services in this repository.
Show the resolved repository root and any files it could not scan.
```

Check that the root and services match your project before continuing.

#### 3. Try it on a real task

Copy one of these messages into Claude Code:

**Find reusable code**

```text
Before implementing order fee calculation, use spec-nav to search all services
for existing functions. Read the most relevant candidates and explain whether
any can be reused. Check dependencies and service boundaries before importing.
```

**Check callers before editing**

```text
I want to add a parameter to calculateFee. Use spec-nav to find its declaration,
read the implementation and check its callers before planning the change.
Report any callers you could not resolve.
```

**Survey a change across services**

```text
I want to change the handling fee. Use spec-nav to map the related constants,
functions and usages across the repository. Include alternative spellings.
Check incomplete coverage and remaining pages before claiming the survey is complete.
```

### Option 2: Install as a Claude Desktop extension

**Requirements:** Claude Desktop and a local checkout of the repository you want to scan. Node.js is not required.

#### 1. Get the `.mcpb` file

Download `mcp-spec-nav-<version>.mcpb` from the [Releases](https://github.com/khoitd-voyager/mcp-spec-nav/releases) page, or build it yourself:

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run pack:mcpb
```

The file is written to `build/mcp-spec-nav-<version>.mcpb`.

#### 2. Install it

Double-click the `.mcpb` file, or open Claude Desktop → **Settings → Extensions → Advanced settings → Install Extension…** and select it. Review the extension and click **Install**.

#### 3. Choose the repository

In the extension settings, set **Repository to scan** to the root of the code you want scanned (the monorepo root to cover every service), then enable the extension.

To scan a different repository later, open **Settings → Extensions → Spec Nav → Configure** and choose another folder. The extension scans one repository at a time.

#### 4. Check it

Start a new chat and send:

```text
Use spec-nav to list the services in this repository.
Show the resolved repository root and any files it could not scan.
```

The prompts under [Try it on a real task](#3-try-it-on-a-real-task) also work in Claude Desktop. Claude Desktop reads and explains the code; to have the changes made in the repository, use Claude Code.

### Make Claude use it during normal coding

Installing an MCP makes its tools available; it does not ensure the agent will use them. Add this section to your project's `CLAUDE.md`:

```markdown
## Use existing code before writing new logic

For new logic or changes that affect other functions:

1. Use spec_nav_find_functions to look for existing implementations across services.
   Use English keywords for English-named code; try another wording if needed.
2. Read the most relevant candidates with spec_nav_read_function.
   Avoid loading the entire catalog or every function body into context.
3. Check behavior, exports, dependencies and service boundaries before reusing code.
   Another service's function is not automatically safe to import.
4. Use spec_nav_callers before changing a TS/JS function's signature or behavior.
   Use spec_nav_map with one broad regex for concepts spanning files or services.
5. Inspect coverage and unresolved results. Follow cursors when you need the complete
   result set; use ordinary search/file reads for unsupported or missing areas.
6. After editing, refresh relevant queries and run the project's appropriate checks.

Scale this workflow to the task. Small, isolated edits do not require every tool.
Search results are candidates, not proof that no other implementation exists.
```

For other agents, adapt this section to their project instruction file, such as `AGENTS.md`.

### Tool reference

These are MCP tool arguments, not terminal commands. Your agent calls them for you.

| Tool | Use it when you want to… |
|---|---|
| `spec_nav_services` | Check the scan root, discovered projects, counts and coverage. |
| `spec_nav_find_functions` | Find ranked candidates for existing logic across services. |
| `spec_nav_read_function` | Read one candidate's exact source and context. |
| `spec_nav_functions` | Browse the function catalog with filters and pagination. |
| `spec_nav_callers` | Inspect TS/JS calls, references and unresolved usages. |
| `spec_nav_map` | Find regex matches with the enclosing function. |

**Search for functions**

```json
{ "query": "calculate order fees", "limit": 20 }
```

Pass this to `spec_nav_find_functions`. Results include function IDs and reasons for matching. Names, export aliases, signatures, documentation, paths and, by default, bodies are searched.

**Read a function**

```json
{ "file": "services/billing/src/fees.ts", "name": "calculateFee" }
```

Pass this to `spec_nav_read_function`, using a real path/name from your results. Alternatively, pass `{ "id": "<id returned by the tool>" }`. For long functions, continue with the returned `nextCursor` as `cursor`.

**Browse a service's functions**

```json
{ "services": ["services/api"], "name": "fee", "limit": 100 }
```

Pass this to `spec_nav_functions`. Omit `services` to cover all discovered projects. `services: ["."]` selects the root project's own files. Filters include `file`, `name`, `kind`, `language` and `exportedOnly`.

**Check callers**

```json
{ "symbol": "calculateFee", "file": "services/billing/src/fees.ts", "format": "json" }
```

Pass this to `spec_nav_callers`. Use a qualified name such as `OrderService.calculateFee`, or a declaration file, to disambiguate targets. `service` narrows the declaration; `searchServices` narrows where callers are searched.

**Map a concept**

```json
{ "pattern": "handl(e|ing)_?fee|handling_charge|HANDLING_FEE" }
```

Pass this to `spec_nav_map`. Matching is case-insensitive. Comment/import lines are skipped by default; set `includeComments: true` to include them.

### Understand the results

- **Pagination:** `MORE` or `nextCursor` means more results are available. Repeat the same query with that cursor. Completion of pagination is separate from completeness of source coverage.
- **Coverage:** `PARTIAL` means some source files were unsupported, unreadable, skipped or had parse errors. Inspect those gaps with other tools.
- **Search:** Results are ranked lexical matches, not semantic understanding. Body-only matches are marked and ranked lower. Broad body-only matches can be withheld as noise; the output reports that count.
- **Callers:** Review unresolved calls, interface/base usages and references. Even `exhaustive: true` does not cover every runtime call, dynamic dispatch or external repository.
- **Freshness:** Added, edited and deleted source files are reflected on subsequent calls. Function IDs depend on their source text; look up a changed function again if a read reports `STALE ID`.

### Troubleshooting

| Problem | What to check |
|---|---|
| `spec-nav` does not connect | Node.js/npm/Git are available to the client; configuration is valid; installation can access GitHub. |
| Wrong projects or no source files | Ask for `spec_nav_services`; check `SPEC_NAV_ROOT` and the `.mcp.json` used by the session. |
| A function is missing | Check supported languages, coverage, catalog filters and the limits below. |
| Search returns no useful candidates | Try alternate English keywords, browse the catalog or use ordinary search. |
| `STALE ID` | Find the function again and read its current ID. |
| Local changes to this MCP do not appear | `npx github:` uses the committed package. Use the local checkout configuration below while developing. |
| Claude Desktop extension does not start | Check that **Repository to scan** is set and the extension is enabled. See **Settings → Extensions** and the MCP logs under **Settings → Developer**. |
| Claude Desktop scans the wrong repository | Change **Repository to scan** in the extension settings and start a new chat. |

## Tiếng Việt

### MCP này làm gì?

`mcp-spec-nav` là MCP server chạy local, giúp coding agent như Claude Code đọc code trong repo bạn chọn để:

- Tìm các hàm có sẵn ở nhiều service và package dùng chung.
- Đọc thân hàm, signature, tài liệu và import liên quan.
- Tìm các nơi gọi hàm TypeScript/JavaScript trước khi sửa.
- Tìm theo regex trong các file nguồn được hỗ trợ, kèm tên hàm chứa mỗi kết quả.

**Ví dụ:** Bạn yêu cầu Claude thêm chức năng tính phí đơn hàng. Claude có thể tìm các hàm tính phí trong service billing và package dùng chung, đọc implementation rồi quyết định có tái sử dụng được không.

MCP đọc và cung cấp thông tin về code. AI đánh giá, chọn cách sửa và thực hiện thay đổi. MCP không bảo đảm tìm được mọi hàm liên quan.

### Chọn cách cài

| | Cách 1: `.mcp.json` | Cách 2: Extension cho Claude Desktop (`.mcpb`) |
|---|---|---|
| Client | Claude Code (và các client đọc `.mcp.json`) | Claude Desktop |
| Cần có | Node.js 18+, npm/npx, Git | Chỉ cần Claude Desktop — extension chạy bằng Node.js có sẵn trong app |
| Chọn repo cần quét | `SPEC_NAV_ROOT` trong file cấu hình | Chọn thư mục trong phần cài đặt extension |
| Phù hợp khi | Code: Claude đọc, lên kế hoạch và sửa code trong repo | Hỏi về code: tìm, đọc và kiểm tra hàm trong khung chat |

Hai cách chạy cùng một server và cùng bộ tool. Có thể dùng cả hai cùng lúc.

### Cách 1: Cài và dùng thử với Claude Code

**Cần có:** Node.js từ phiên bản 18, npm/npx, Git và repo cần quét đã nằm trên máy. Lần cài đầu cần kết nối mạng.

#### 1. Thêm cấu hình MCP

Tạo file `.mcp.json` ở thư mục gốc của repo cần quét:

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

**Thay `/Users/you/code/your-repo` bằng đường dẫn tuyệt đối tới repo cần quét.** Muốn quét nhiều service thì trỏ tới gốc monorepo. Đây là đường dẫn repo dự án của bạn, không phải thư mục cài `mcp-spec-nav`.

Nếu đã có `.mcp.json`, thêm `spec-nav` vào `mcpServers` hiện có và giữ các MCP khác.

#### 2. Kiểm tra kết nối

Mở Claude Code trong repo đó, khởi động lại session và chạy:

```text
/mcp
```

Kiểm tra `spec-nav` đã kết nối. Nếu client yêu cầu duyệt cấu hình, hoàn tất bước đó.

Sau đó gửi Claude:

```text
Dùng spec-nav liệt kê các service trong repo này.
Cho tôi biết đường dẫn repo đang quét và những phần chưa quét được.
```

Kiểm tra đường dẫn và danh sách service đúng với dự án trước khi dùng tiếp.

#### 3. Dùng thử ngay

Bạn không cần tự gọi tool. Copy một câu dưới đây vào Claude Code:

**Tìm hàm có sẵn trước khi viết code mới**

```text
Tôi cần thêm chức năng tính phí đơn hàng. Trước khi viết code, dùng spec-nav
để tìm các hàm có sẵn trên toàn repo, gồm các service và package dùng chung.
Đọc các hàm phù hợp và đánh giá khả năng tái sử dụng. Dùng thêm từ khóa tiếng Anh
như calculate order fees. Kiểm tra dependency và ranh giới service trước khi import.
```

**Kiểm tra trước khi sửa hàm**

```text
Tôi muốn thêm tham số vào calculateFee. Dùng spec-nav tìm declaration,
đọc implementation và kiểm tra các nơi gọi hàm trước khi lên kế hoạch sửa.
Báo rõ những lời gọi chưa resolve được.
```

**Tìm các nơi liên quan trong nhiều service**

```text
Tôi muốn thay đổi handling fee. Dùng spec-nav tìm các constant, hàm và nơi sử dụng
liên quan trên toàn repo, gồm các cách viết tên khác nhau. Kiểm tra coverage
và các trang kết quả còn lại trước khi kết luận đã khảo sát đầy đủ.
```

### Cách 2: Cài thành extension cho Claude Desktop

**Cần có:** Claude Desktop và repo cần quét đã nằm trên máy. Không cần cài Node.js.

#### 1. Lấy file `.mcpb`

Tải `mcp-spec-nav-<version>.mcpb` ở trang [Releases](https://github.com/khoitd-voyager/mcp-spec-nav/releases), hoặc tự đóng gói:

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run pack:mcpb
```

File được tạo ở `build/mcp-spec-nav-<version>.mcpb`.

#### 2. Cài extension

Bấm đúp vào file `.mcpb`, hoặc mở Claude Desktop → **Settings → Extensions → Advanced settings → Install Extension…** rồi chọn file. Xem thông tin extension và bấm **Install**.

#### 3. Chọn repo cần quét

Trong phần cài đặt extension, đặt **Repository to scan** là thư mục gốc của code cần quét (trỏ tới gốc monorepo để quét mọi service), rồi bật extension.

Muốn quét repo khác thì mở **Settings → Extensions → Spec Nav → Configure** và chọn thư mục khác. Mỗi lần extension chỉ quét một repo.

#### 4. Kiểm tra

Mở chat mới và gửi:

```text
Dùng spec-nav liệt kê các service trong repo này.
Cho tôi biết đường dẫn repo đang quét và những phần chưa quét được.
```

Các câu mẫu ở [Dùng thử ngay](#3-dùng-thử-ngay) cũng dùng được trong Claude Desktop. Claude Desktop đọc và giải thích code; muốn Claude sửa trực tiếp trong repo thì dùng Claude Code.

### Hướng dẫn Claude dùng khi code bình thường

Cài MCP chỉ làm cho tool có sẵn. Thêm đoạn sau vào `CLAUDE.md` của dự án để hướng dẫn Claude sử dụng:

```markdown
## Tìm code có sẵn trước khi viết logic mới

Với logic mới hoặc thay đổi ảnh hưởng tới các hàm khác:

1. Dùng spec_nav_find_functions tìm implementation có sẵn trên các service.
   Dùng từ khóa tiếng Anh nếu code đặt tên bằng tiếng Anh; thử cách diễn đạt khác khi cần.
2. Dùng spec_nav_read_function đọc các ứng viên phù hợp.
   Tránh nạp toàn bộ danh mục hoặc mọi thân hàm vào context.
3. Kiểm tra hành vi, export, dependency và ranh giới service trước khi tái sử dụng.
   Hàm ở service khác không mặc nhiên có thể import trực tiếp.
4. Dùng spec_nav_callers trước khi đổi signature hoặc hành vi của hàm TS/JS.
   Dùng spec_nav_map với một regex đủ rộng khi thay đổi liên quan nhiều file/service.
5. Đọc coverage và kết quả unresolved. Lấy trang tiếp theo nếu cần đủ kết quả;
   dùng tìm kiếm và đọc file thông thường cho phần không hỗ trợ hoặc còn thiếu.
6. Sau khi sửa, cập nhật các truy vấn liên quan và chạy kiểm tra phù hợp của dự án.

Áp dụng theo mức độ thay đổi. Sửa nhỏ, độc lập không cần gọi tất cả tool.
Không tìm thấy ứng viên không có nghĩa là repo chắc chắn chưa có implementation.
```

Với agent khác, chuyển hướng dẫn này sang file phù hợp, chẳng hạn `AGENTS.md`.

### Các tool dùng để làm gì?

| Tool | Mục đích |
|---|---|
| `spec_nav_services` | Kiểm tra đường dẫn quét, các project, số lượng file/hàm và coverage. |
| `spec_nav_find_functions` | Tìm các hàm có thể đáp ứng yêu cầu, xếp hạng và giải thích vì sao khớp. |
| `spec_nav_read_function` | Đọc code chính xác của một hàm, kèm signature, tài liệu và import liên quan. |
| `spec_nav_functions` | Xem danh mục hàm, lọc và lấy từng trang. |
| `spec_nav_callers` | Kiểm tra lời gọi TS/JS, references và những trường hợp chưa resolve được. |
| `spec_nav_map` | Tìm dòng khớp regex, kèm tên hàm chứa dòng đó. |

Ví dụ tham số cho agent gọi tool — không phải lệnh terminal:

| Tool | Tham số ví dụ |
|---|---|
| `spec_nav_services` | `{}` |
| `spec_nav_find_functions` | `{ "query": "calculate order fees", "limit": 20 }` |
| `spec_nav_read_function` | `{ "file": "services/billing/src/fees.ts", "name": "calculateFee" }` |
| `spec_nav_functions` | `{ "services": ["services/api"], "name": "fee", "limit": 100 }` |
| `spec_nav_callers` | `{ "symbol": "calculateFee", "file": "services/billing/src/fees.ts", "format": "json" }` |
| `spec_nav_map` | `{ "pattern": "handling_fee|handlingFee|HANDLING_FEE" }` |

Thay đường dẫn và tên hàm ví dụ bằng kết quả thực tế từ repo của bạn. Đọc hàm cũng có thể dùng `id` do tool trả về.

### Cách đọc kết quả

- **MORE / nextCursor:** Còn trang kết quả. Gọi lại với cùng truy vấn và truyền cursor. Lấy hết trang không đồng nghĩa mọi loại file trong repo đều đã được hỗ trợ.
- **PARTIAL / coverage:** Có phần chưa đọc được, chẳng hạn ngôn ngữ không hỗ trợ, file lỗi parse hoặc file bị bỏ qua. Cần kiểm tra thêm bằng công cụ khác.
- **bodyOnly:** Ứng viên chỉ khớp trong thân hàm, được xếp sau các ứng viên khớp ở tên/signature/tài liệu. Kết quả quá rộng có thể bị giữ lại để giảm nhiễu; tool báo số lượng.
- **unresolved:** Chưa xác định được hàm mà lời gọi trỏ tới. Không coi đây là callers đã xác nhận.
- **STALE ID:** Hàm đã thay đổi hoặc không còn ở vị trí định danh cũ. Tìm lại rồi đọc bằng ID hiện tại.

`services: ["."]` chỉ chọn file của project gốc. Bỏ `services` để khảo sát toàn repo. File thêm/sửa/xóa được cập nhật ở các lần gọi tiếp theo.

### Khi gặp lỗi

| Hiện tượng | Cách kiểm tra |
|---|---|
| MCP không kết nối | Kiểm tra Node.js/npm/Git, cấu hình và khả năng truy cập GitHub lúc cài. |
| Sai service hoặc không thấy source | Nhờ Claude gọi `spec_nav_services`, kiểm tra `SPEC_NAV_ROOT` và file cấu hình session đang dùng. |
| Thiếu hàm | Kiểm tra bộ lọc, coverage, ngôn ngữ và dạng function được hỗ trợ. |
| Tìm không ra hàm phù hợp | Thử từ khóa tiếng Anh khác, xem danh mục hoặc dùng tìm kiếm thông thường. |
| Đọc hàm báo stale | Tìm lại hàm và dùng ID hiện tại. |
| Sửa source MCP nhưng kết quả không đổi | `npx github:` dùng bản package đã commit; dùng cấu hình local bên dưới khi phát triển. |
| Extension trên Claude Desktop không chạy | Kiểm tra đã chọn **Repository to scan** và đã bật extension trong **Settings → Extensions**; xem log MCP ở **Settings → Developer**. |
| Claude Desktop quét sai repo | Đổi **Repository to scan** trong cài đặt extension rồi mở chat mới. |

## Supported languages / Ngôn ngữ hỗ trợ

| Language / Ngôn ngữ | Extensions / Đuôi file |
|---|---|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `.py`, `.pyi` |
| Go | `.go` |
| Java | `.java` |
| C# | `.cs` |
| Ruby | `.rb`, `.rake` |
| Rust | `.rs` |
| PHP | `.php` |
| C | `.c`, `.h` |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` |
| Scala | `.scala`, `.sc` |
| Elixir | `.ex`, `.exs` |
| Bash | `.sh`, `.bash`, `.zsh` |

TS/JS support named declarations, methods, accessors, arrows/function expressions stored in variables or properties, supported assignments and CommonJS exports. Other languages use tree-sitter to extract supported declarations. Caller resolution is **TS/JS only**.

TS/JS hỗ trợ declaration có tên, method, accessor, arrow/function expression lưu trong biến/property, các dạng assignment được hỗ trợ và CommonJS export. Các ngôn ngữ khác dùng tree-sitter để lấy declaration được hỗ trợ. Resolve callers **chỉ áp dụng TS/JS**.

## Limits / Giới hạn

| Area / Phần | English | Tiếng Việt |
|---|---|---|
| Search | Lexical matching, not semantic understanding. Similar behavior under unrelated names can be missed. | Tìm theo từ khóa, chưa hiểu ý nghĩa; có thể bỏ sót logic tương đương nhưng tên khác. |
| Translation | Unicode/Vietnamese words and accent folding are supported. Queries are not translated into English. | Hỗ trợ từ Unicode/tiếng Việt và khớp có dấu/không dấu; không tự dịch sang tên hàm tiếng Anh. |
| Reuse | Check exports, behavior and package/service dependencies yourself. | Cần kiểm tra export, hành vi và dependency trước khi tái sử dụng. |
| Callers | Dynamic calls, untyped receivers, unsupported files and external repositories can be missed or unresolved. | Lời gọi động, receiver thiếu kiểu, file không hỗ trợ và repo bên ngoài có thể không xác định được. |
| Anonymous callbacks | Inline anonymous callbacks are not individually catalogued; JS/TS counts them in coverage. | Callback anonymous không có mục riêng; coverage đếm chúng trong JS/TS. |
| Function forms | JS/TS destructuring assignments, dynamic property assignments, factory-created functions, `Object.assign`/`Object.defineProperty` and some chained assignments are not fully covered. Other-language assigned lambdas/closures are not catalogued. | Chưa bao phủ đầy đủ assignment qua destructuring/property động, hàm từ factory, `Object.assign`/`Object.defineProperty` và một số gán nối. Lambda/closure gán biến ở ngôn ngữ khác chưa có trong danh mục. |
| Unsupported files | Vue/Svelte components, Kotlin, Swift, SQL and other unsupported source types are not parsed. | Không parse Vue/Svelte component, Kotlin, Swift, SQL và các loại nguồn chưa hỗ trợ. |
| Exclusions | Dependency/build directories, hidden directories, virtualenvs, declaration files, minified JS and supported files over 1.5 MB are excluded. | Bỏ qua dependency/build, thư mục ẩn, virtualenv, file declaration, JS minified và file hỗ trợ lớn hơn 1,5 MB. |
| Types | Return types are reported when explicitly written; they are not inferred by the catalog. | Danh mục lấy kiểu trả về được khai báo, không suy luận kiểu. |
| Large repos | Initial parsing and TS/JS caller analysis can take more time and memory. | Parse lần đầu và phân tích callers TS/JS có thể tốn thời gian/RAM trên repo lớn. |

The server reads the current local checkout. No search API key is required, and its search does not send code to an external search service. Results are returned to your connected coding agent; that client's model/data handling settings still apply.

Server đọc checkout local hiện tại. Không cần API key tìm kiếm và phần tìm kiếm không gửi code tới dịch vụ search bên ngoài. Kết quả được trả cho coding agent đã kết nối; cách client/model xử lý dữ liệu vẫn theo cấu hình của bạn.

## Local installation / Cài từ source

Use this when developing the MCP or testing changes before pushing them.

Dùng cách này khi phát triển MCP hoặc thử thay đổi chưa push.

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run build
```

Configure `.mcp.json` with absolute paths / Cấu hình `.mcp.json` bằng đường dẫn tuyệt đối:

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

`args` points to the MCP installation; `SPEC_NAV_ROOT` points to the code being scanned. After changing MCP source, rebuild and restart the client session.

`args` trỏ tới bản cài MCP; `SPEC_NAV_ROOT` trỏ tới code cần quét. Sau khi sửa source MCP, build lại và khởi động lại session client.

## Development / Phát triển

```bash
npm run typecheck
npm test
```

`npm test` builds the bundle and tests it through MCP stdio on fixture repositories.

`npm test` build bundle rồi kiểm thử qua MCP stdio trên các repo mẫu.

### Package the Claude Desktop extension / Đóng gói extension cho Claude Desktop

```bash
npm run pack:mcpb
```

This builds `dist/index.cjs`, stages it under `build/mcpb/` with `manifest.json`, `web-tree-sitter` and only the grammar `.wasm` files, validates the manifest and writes `build/mcp-spec-nav-<version>.mcpb`. The manifest is generated by [scripts/pack-mcpb.mjs](scripts/pack-mcpb.mjs); its version comes from `package.json`. To publish, attach the `.mcpb` file to a GitHub release.

Lệnh này build `dist/index.cjs`, gom vào `build/mcpb/` cùng `manifest.json`, `web-tree-sitter` và chỉ các file `.wasm` của grammar, kiểm tra manifest rồi tạo `build/mcp-spec-nav-<version>.mcpb`. Manifest được sinh từ [scripts/pack-mcpb.mjs](scripts/pack-mcpb.mjs), version lấy từ `package.json`. Muốn phát hành thì đính kèm file `.mcpb` vào GitHub release.

To run the tests against the packed extension instead of `dist/` / Chạy test trên bản extension đã đóng gói thay vì `dist/`:

```bash
unzip -q build/mcp-spec-nav-<version>.mcpb -d /tmp/spec-nav-mcpb
SPEC_NAV_DIST=/tmp/spec-nav-mcpb/dist/index.cjs node --test test/*.test.mjs
```

These checks validate the tested scenarios. They do not establish that an agent will produce better code on every task. Compare real tasks with and without the MCP to evaluate missed usages, code reuse, correctness, time and token cost.

Các kiểm tra xác nhận tình huống đã test, không chứng minh AI sẽ code tốt hơn trong mọi task. Hãy so sánh task thật có/không MCP theo số nơi bỏ sót, mức tái sử dụng code, độ đúng, thời gian và token.

## License / Giấy phép

MIT. See [LICENSE](LICENSE).
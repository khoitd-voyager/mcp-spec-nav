# mcp-spec-nav — MCP Server for AI Code Search and Navigation

`mcp-spec-nav` is a local MCP server for AI coding agents to search code, discover reusable functions, and find callers before making changes. Use it with Claude Code to explore logic across services and shared packages in your repository.

Giúp AI tìm hàm có sẵn trước khi viết code mới, đọc implementation và tìm các nơi gọi hàm trước khi sửa code trong repo.

帮助 AI 在编写新代码之前查找已有函数，阅读实现，并在修改代码之前找出仓库中的调用方。

**Example:** Before adding an order fee calculation, ask your agent to find and read existing fee functions. Before changing a function's parameters, ask it to find callers and report any unresolved references.

**Benchmarks:** See the [benchmark methodology and limitations](bench/README.md#english) ([Tiếng Việt](bench/README.md#tiếng-việt) · [简体中文](bench/README.md#简体中文)) and [recorded results](bench/results/) for comparisons with a Grep/Read/Edit baseline. These benchmarks use deterministic agent policies, not live LLM sessions.

**Get started:** [Claude Code setup](#option-1-quick-start-with-claude-code) · [Claude Desktop extension](#option-2-install-as-a-claude-desktop-extension)

**[English](#english) · [Tiếng Việt](#tiếng-việt) · [简体中文](#简体中文)**

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

### MCP 对编码代理有什么帮助？

| 场景 | MCP 的价值 |
|---|---|
| 逻辑分散在多个服务中 | 高：搜索范围广，减少遗漏。 |
| 想复用已有函数而不是重写 | 高，前提是查询能找到正确的候选。 |
| 修改函数参数，需要找出调用方 | 有用。 |
| 在单个文件内做简单修改 | 收益有限，可能增加工具调用次数。 |

## English

### What does it do?

`mcp-spec-nav` is a local MCP server for coding agents such as Claude Code. It reads source code in the repository you choose and provides tools to:

- Find existing functions across services and shared packages — by words, by what they call, or by behavioural similarity to a draft.
- Read a function's source, signature, documentation and relevant imports.
- Find callers before changing a function: type-checked in TypeScript/JavaScript/Vue, evidence-based in Python, Go, Java, Kotlin, Swift and other languages, with dynamic uses listed.
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
   If nothing fits, draft the function and pass it to spec_nav_similar_functions.
3. Check behavior, exports, dependencies and service boundaries before reusing code.
   Another service's function is not automatically safe to import.
4. Use spec_nav_callers before changing a function's signature or behavior.
   Check sites marked likely, ambiguous, unresolved or dynamic by hand.
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
| `spec_nav_similar_functions` | Find functions that behave like a candidate or a draft, whatever they are named. |
| `spec_nav_read_function` | Read one candidate's exact source and context. |
| `spec_nav_functions` | Browse the function catalog with filters and pagination. |
| `spec_nav_callers` | Inspect calls, references, dynamic uses and unresolved usages before a change. |
| `spec_nav_map` | Find regex matches with the enclosing function. |

**Search for functions**

```json
{ "query": "calculate order fees", "limit": 20 }
```

Pass this to `spec_nav_find_functions`. Results include function IDs and reasons for matching. Names, export aliases, signatures, documentation, paths, the names each function calls and, by default, bodies are searched; rarer words weigh more.

**Find code that behaves like a draft**

```json
{ "code": "function shippingCost(order) { const km = distanceKm(order.from, order.to); return round(km * zoneRate(order.zone), 2); }" }
```

Pass this to `spec_nav_similar_functions` (or `{ "id": "<id>" }` for an existing function). It compares the calls and body vocabulary of every function, ignoring names.

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
- **Search:** Results are ranked lexical matches with labelled evidence, not semantic understanding. Matches only through called names are marked `[via calls]`, body-only matches `[body only]`; both rank lower. Broad body-only matches can be withheld as noise; the output reports that count.
- **Similar:** A high similarity means the code looks alike (same calls, same vocabulary), not that it is interchangeable.
- **Callers:** Each site says how it was bound. Review `likely`, `ambiguous`, `unresolved` and `dynamic` sites. Even `exhaustive: true` (type-checked targets only) does not cover names computed at runtime, calls over HTTP/RPC/queues or external repositories.
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

- Tìm các hàm có sẵn ở nhiều service và package dùng chung — theo từ khóa, theo các hàm nó gọi, hoặc theo hành vi giống một bản nháp.
- Đọc thân hàm, signature, tài liệu và import liên quan.
- Tìm nơi gọi hàm trước khi sửa: kiểm tra bằng type checker cho TypeScript/JavaScript/Vue, theo bằng chứng (import, qualifier, kiểu receiver…) cho Python, Go, Java, Kotlin, Swift và các ngôn ngữ khác; liệt kê riêng các lời gọi động.
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
   Không thấy hàm phù hợp thì viết nháp rồi đưa cho spec_nav_similar_functions.
3. Kiểm tra hành vi, export, dependency và ranh giới service trước khi tái sử dụng.
   Hàm ở service khác không mặc nhiên có thể import trực tiếp.
4. Dùng spec_nav_callers trước khi đổi signature hoặc hành vi của hàm.
   Tự kiểm tra các chỗ được đánh dấu likely, ambiguous, unresolved hoặc dynamic.
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
| `spec_nav_similar_functions` | Tìm hàm có hành vi giống một hàm hoặc một bản nháp, dù tên khác hẳn. |
| `spec_nav_read_function` | Đọc code chính xác của một hàm, kèm signature, tài liệu và import liên quan. |
| `spec_nav_functions` | Xem danh mục hàm, lọc và lấy từng trang. |
| `spec_nav_callers` | Kiểm tra lời gọi, references, lời gọi động và những trường hợp chưa resolve được. |
| `spec_nav_map` | Tìm dòng khớp regex, kèm tên hàm chứa dòng đó. |

Ví dụ tham số cho agent gọi tool — không phải lệnh terminal:

| Tool | Tham số ví dụ |
|---|---|
| `spec_nav_services` | `{}` |
| `spec_nav_find_functions` | `{ "query": "calculate order fees", "limit": 20 }` |
| `spec_nav_similar_functions` | `{ "code": "function tinhPhi(order) { … }" }` hoặc `{ "id": "<id>" }` |
| `spec_nav_read_function` | `{ "file": "services/billing/src/fees.ts", "name": "calculateFee" }` |
| `spec_nav_functions` | `{ "services": ["services/api"], "name": "fee", "limit": 100 }` |
| `spec_nav_callers` | `{ "symbol": "calculateFee", "file": "services/billing/src/fees.ts", "format": "json" }` |
| `spec_nav_map` | `{ "pattern": "handling_fee\|handlingFee\|HANDLING_FEE" }` |

Thay đường dẫn và tên hàm ví dụ bằng kết quả thực tế từ repo của bạn. Đọc hàm cũng có thể dùng `id` do tool trả về.

### Cách đọc kết quả

- **MORE / nextCursor:** Còn trang kết quả. Gọi lại với cùng truy vấn và truyền cursor. Lấy hết trang không đồng nghĩa mọi loại file trong repo đều đã được hỗ trợ.
- **PARTIAL / coverage:** Có phần chưa đọc được, chẳng hạn ngôn ngữ không hỗ trợ, file lỗi parse hoặc file bị bỏ qua. Cần kiểm tra thêm bằng công cụ khác.
- **via calls / bodyOnly:** Ứng viên chỉ khớp qua tên các hàm nó gọi, hoặc chỉ trong thân hàm; được xếp sau các ứng viên khớp ở tên/signature/tài liệu. Kết quả quá rộng có thể bị giữ lại để giảm nhiễu; tool báo số lượng.
- **similarity:** Code giống nhau (cùng lời gọi, cùng từ vựng), không có nghĩa là dùng thay nhau được.
- **likely / ambiguous / dynamic / unresolved:** Lần lượt: chỉ có một khai báo trùng tên nhưng chưa chứng minh; nhiều khai báo có thể khớp; tên xuất hiện dạng chuỗi/symbol (gọi động); chưa xác định được. Không coi là callers đã xác nhận.
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

## 简体中文

### 它做什么？

`mcp-spec-nav` 是供 Claude Code 等编码代理使用的本地 MCP server。它读取你指定仓库中的源代码，并提供以下工具：

- 跨服务和共享包查找已有函数——按关键词、按它调用的函数，或按与草稿代码的行为相似度。
- 读取函数源码、签名、文档以及相关 import。
- 修改函数前查找调用方：TypeScript/JavaScript/Vue 经类型检查器确认；Python、Go、Java、Kotlin、Swift 等其他语言基于证据（import、限定符、接收者类型…）判断；动态调用单独列出。
- 在受支持的源文件中按正则搜索，并给出每个匹配所在的函数。

**示例：** 你让 Claude 新增订单费用计算。Claude 不会立刻再写一个实现，而是先在 billing 服务和共享包中查找已有的费用函数，阅读之后再判断是否可以复用。

MCP 负责读取代码并提供信息；由编码代理决定复用什么并完成修改。它不保证能找到所有相关函数。

### 选择安装方式

| | 方式一：`.mcp.json` | 方式二：Claude Desktop 扩展（`.mcpb`） |
|---|---|---|
| 客户端 | Claude Code（以及其他读取 `.mcp.json` 的客户端） | Claude Desktop |
| 需要 | Node.js 18+、npm/npx、Git | 只需 Claude Desktop——扩展使用其内置的 Node.js 运行 |
| 指定要扫描的仓库 | 配置文件中的 `SPEC_NAV_ROOT` | 扩展设置中的文件夹选择器 |
| 适合 | 写代码：Claude 在仓库中阅读、规划并修改代码 | 了解代码：在对话中查找、阅读和检查函数 |

两种方式运行的是同一个 server、同一套工具，可以同时使用。

### 方式一：用 Claude Code 快速开始

**需要：** Node.js 18 或更高版本、npm/npx、Git，以及要扫描的仓库的本地副本。首次安装需要联网。

#### 1. 添加 MCP 配置

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

#### 2. 检查连接

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

#### 3. 在真实任务上试用

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

### 方式二：安装为 Claude Desktop 扩展

**需要：** Claude Desktop，以及要扫描的仓库的本地副本。不需要安装 Node.js。

#### 1. 获取 `.mcpb` 文件

从 [Releases](https://github.com/khoitd-voyager/mcp-spec-nav/releases) 页面下载 `mcp-spec-nav-<version>.mcpb`，或自行构建：

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run pack:mcpb
```

文件生成在 `build/mcp-spec-nav-<version>.mcpb`。

#### 2. 安装

双击 `.mcpb` 文件，或打开 Claude Desktop → **Settings → Extensions → Advanced settings → Install Extension…** 并选择该文件。查看扩展信息后点击 **Install**。

#### 3. 选择仓库

在扩展设置中，把 **Repository to scan** 设为要扫描的代码根目录（指向 monorepo 根目录即可覆盖所有服务），然后启用扩展。

之后想扫描其他仓库，打开 **Settings → Extensions → Spec Nav → Configure** 选择另一个文件夹。扩展一次只扫描一个仓库。

#### 4. 检查

新建对话并发送：

```text
使用 spec-nav 列出这个仓库中的服务。
显示实际扫描的仓库根目录，以及无法扫描的文件。
```

[在真实任务上试用](#3-在真实任务上试用) 中的提示词同样适用于 Claude Desktop。Claude Desktop 负责阅读和解释代码；要让 Claude 直接修改仓库中的代码，请使用 Claude Code。

### 让 Claude 在日常编码中使用它

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

### 工具参考

| 工具 | 用途 |
|---|---|
| `spec_nav_services` | 检查扫描根目录、发现的项目、文件/函数数量和覆盖率。 |
| `spec_nav_find_functions` | 跨服务查找可能满足需求的函数，排序并说明匹配原因。 |
| `spec_nav_similar_functions` | 查找行为与某个函数或草稿相似的函数，即使名称完全不同。 |
| `spec_nav_read_function` | 读取某个函数的精确源码，以及签名、文档和相关 import。 |
| `spec_nav_functions` | 按条件筛选、分页浏览函数目录。 |
| `spec_nav_callers` | 检查调用、引用、动态调用以及无法解析的用法。 |
| `spec_nav_map` | 查找匹配正则的行，并给出所在函数。 |

供代理调用工具的参数示例——不是终端命令：

| 工具 | 参数示例 |
|---|---|
| `spec_nav_services` | `{}` |
| `spec_nav_find_functions` | `{ "query": "calculate order fees", "limit": 20 }` |
| `spec_nav_similar_functions` | `{ "code": "function shippingCost(order) { … }" }` 或 `{ "id": "<id>" }` |
| `spec_nav_read_function` | `{ "file": "services/billing/src/fees.ts", "name": "calculateFee" }` |
| `spec_nav_functions` | `{ "services": ["services/api"], "name": "fee", "limit": 100 }` |
| `spec_nav_callers` | `{ "symbol": "calculateFee", "file": "services/billing/src/fees.ts", "format": "json" }` |
| `spec_nav_map` | `{ "pattern": "handl(e\|ing)_?fee\|handling_charge\|HANDLING_FEE" }` |

请用你仓库中的实际结果替换示例路径和函数名。读取函数也可以使用工具返回的 `id`；函数较长时，把返回的 `nextCursor` 作为 `cursor` 继续读取。`spec_nav_callers` 可用限定名（如 `OrderService.calculateFee`）或声明所在文件消除歧义；`spec_nav_map` 不区分大小写，默认跳过注释和 import 行（`includeComments: true` 可包含它们）。

### 理解结果

- **MORE / nextCursor：** 还有更多结果。用同样的查询加上 cursor 再调用。分页取完不等于仓库中所有类型的文件都已受支持。
- **PARTIAL / 覆盖率：** 有部分内容未能读取，例如语言不受支持、文件解析出错或被跳过。请用其他工具进一步检查。
- **via calls / body only：** 候选仅通过它调用的函数名匹配，或仅在函数体中匹配；排序在名称/签名/文档匹配的候选之后。过于宽泛的结果可能被隐藏以减少噪声，工具会报告数量。
- **相似度：** 代码看起来相像（相同的调用、相同的词汇），不代表可以互相替换。
- **likely / ambiguous / dynamic / unresolved：** 依次表示：只有一个同名声明但尚未证实；可能匹配多个声明；名称以字符串/符号形式出现（动态调用）；无法确定。不要把它们视为已确认的调用方。即使 `exhaustive: true`（仅限经类型检查的目标），也不涵盖运行时拼接的名称、HTTP/RPC/队列调用或外部仓库。
- **STALE ID：** 函数已被修改或不在原来的位置。重新查找并使用当前 ID 读取。

`services: ["."]` 只选择根项目自身的文件。省略 `services` 则覆盖整个仓库。新增、修改、删除的文件会在后续调用中更新。

### 故障排查

| 现象 | 检查方法 |
|---|---|
| MCP 无法连接 | 检查 Node.js/npm/Git、配置是否有效，以及安装时能否访问 GitHub。 |
| 服务不对或找不到源文件 | 让 Claude 调用 `spec_nav_services`，检查 `SPEC_NAV_ROOT` 和当前会话使用的配置文件。 |
| 缺少某个函数 | 检查过滤条件、覆盖率、语言以及受支持的函数形式。 |
| 搜索不到合适的函数 | 换用其他英文关键词、浏览函数目录，或使用普通搜索。 |
| 读取函数时报告 stale | 重新查找该函数并使用当前 ID。 |
| 修改了 MCP 源码但结果不变 | `npx github:` 使用已提交的包；开发时请使用下方的本地配置。 |
| Claude Desktop 扩展无法运行 | 确认已设置 **Repository to scan** 并在 **Settings → Extensions** 中启用扩展；在 **Settings → Developer** 查看 MCP 日志。 |
| Claude Desktop 扫描了错误的仓库 | 在扩展设置中修改 **Repository to scan**，然后新建对话。 |

## Supported languages / Ngôn ngữ hỗ trợ

| Language / Ngôn ngữ / 语言 | Extensions / Đuôi file / 文件扩展名 |
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
| Kotlin | `.kt`, `.kts` |
| Swift | `.swift` |
| Vue / Svelte / Astro | `.vue`, `.svelte`, `.astro` (script blocks; templates for callers) |

TS/JS support named declarations, methods, accessors, arrows/function expressions stored in variables or properties, supported assignments and CommonJS exports; Vue/Svelte/Astro components are read as their `<script>` (and frontmatter) with line numbers unchanged. Kotlin and Swift are read by a structural scanner (strings, interpolation, nested comments and brackets lexed exactly; classes, objects, extensions, `fun`/`func`, `init`/`constructor`, expression bodies, closures and computed properties recognised) because the published tree-sitter grammars do not parse them reliably here. Other languages use tree-sitter.

Callers are **type-checked in TS/JS/Vue/Svelte/Astro** and **evidence-based in every other supported language** (see `spec_nav_callers`).

TS/JS hỗ trợ declaration có tên, method, accessor, arrow/function expression lưu trong biến/property, các dạng assignment được hỗ trợ và CommonJS export; component Vue/Svelte/Astro được đọc qua `<script>` (và frontmatter), giữ nguyên số dòng. Kotlin và Swift dùng scanner cấu trúc riêng (đọc chính xác chuỗi, interpolation, comment lồng nhau, ngoặc; nhận diện class, object, extension, `fun`/`func`, `init`/`constructor`, thân dạng biểu thức, closure, computed property) vì grammar tree-sitter hiện có không parse ổn định. Các ngôn ngữ khác dùng tree-sitter.

Callers được **kiểm tra bằng type checker cho TS/JS/Vue/Svelte/Astro** và **theo bằng chứng cho mọi ngôn ngữ còn lại**.

TS/JS 支持具名声明、方法、访问器、保存在变量或属性中的箭头函数/函数表达式、受支持的赋值形式以及 CommonJS 导出；Vue/Svelte/Astro 组件按其 `<script>`（及 frontmatter）读取，行号保持不变。Kotlin 和 Swift 使用结构化扫描器读取（精确识别字符串、插值、嵌套注释和括号；识别 class、object、extension、`fun`/`func`、`init`/`constructor`、表达式函数体、闭包和计算属性），因为现有的 tree-sitter 语法在这里无法稳定解析它们。其他语言使用 tree-sitter。

调用方分析在 **TS/JS/Vue/Svelte/Astro 中经类型检查**，在 **其他所有受支持语言中基于证据**。

## Benchmark

Two simulated agents ran the same tasks — one with only Grep/Read/Edit (like Claude Code's built-in tools), one with spec-nav plus Read/Edit. Each session is a whole feature request: reuse existing logic, change a function's signature and update every caller, change a constant everywhere, then read and edit every file involved. Agents are deterministic policies, not an LLM; the baseline is given an LLM's synonym knowledge and the same generous "if it was read, it was recognised" rule. Method, assumptions and limits: [bench/README.md](bench/README.md#english). Full reports: [bench/results/](bench/results/).

Hai agent mô phỏng chạy cùng task — một bên chỉ có Grep/Read/Edit, một bên có thêm spec-nav. Mỗi session là một feature request trọn vẹn: tái sử dụng logic có sẵn, đổi signature một hàm và sửa mọi caller, đổi một hằng số ở mọi nơi, rồi đọc và sửa từng file. Agent là chính sách tất định, không phải LLM; phía không-MCP được cho sẵn kiến thức đồng nghĩa như LLM và cùng luật chấm hào phóng. Phương pháp, giả định và giới hạn: [bench/README.md](bench/README.md#tiếng-việt).

两个模拟代理执行相同的任务——一个只有 Grep/Read/Edit，另一个额外有 spec-nav。每个会话是一个完整的功能需求：复用已有逻辑、修改一个函数的签名并更新所有调用方、在所有位置修改一个常量，然后阅读并修改每个文件。代理是确定性策略，不是 LLM；无 MCP 一侧预先获得了 LLM 式的同义词知识，并采用同样宽松的评分规则。方法、假设与局限：[bench/README.md](bench/README.md#简体中文)。

| | Synthetic, 100 sessions | Synthetic, 50 large sessions | immich (real), 20 sessions | immich (real), 10 large sessions |
|---|---:|---:|---:|---:|
| Context per session, no MCP → MCP | 31k → 24k (−25%) | 92k → 71k (−24%) | 116k → 98k (−16%) | 302k → 227k (−25%) |
| …of which search phase | −57% | −55% | −70% | −69% |
| Input tokens with prompt caching | −18% | −26% | −16% | −38% |
| Tool calls (model turns) | −10% | −9% | −2% | −20% |
| Existing function reused | 97% → 99% | 90% → 95% | 55% → 90% | 40% → 93% |
| Callers complete, nothing extra | 100% → 100% | 100% → 100% | 85% → 90% | 53% → 73% |
| Wrong edits per session | 0 → 0 | 0 → 0 | 0.3 → 0.2 | 14.4 → 2.4 |
| Session fully correct | 97% → 99% | 70% → 86% | 50% → 85% | 0% → 30% |
| Tool time incl. MCP cold start | +4.1 s | +6.1 s | +3.2 s | +6.6 s |

Reading what you will edit costs the same either way; the saving is in the search phase. On small, single-concept changes the gain is small — and every MCP turn carries ~3.8k tokens of tool definitions. Quality gains come from finding code under other names (reuse) and from not editing same-named calls on other classes (callers).

Phần đọc file để sửa tốn như nhau; khoản tiết kiệm nằm ở pha tìm kiếm. Với thay đổi nhỏ, một khái niệm, lợi ích ít — và mỗi lượt có MCP mang thêm ~3,8k token định nghĩa tool. Chất lượng tăng nhờ tìm được code dù tên khác (reuse) và không sửa nhầm lời gọi trùng tên ở class khác (callers).

无论哪种方式，读取要修改的文件成本相同；节省来自搜索阶段。对于小型、单一概念的修改收益很小——而且每个有 MCP 的轮次都会多带约 3.8k token 的工具定义。质量提升来自于找到名称不同的代码（复用），以及不误改其他类上同名方法的调用（调用方）。

**Large repository / Repo rất lớn / 超大仓库** — VS Code (14,306 files, ~4.5M lines, 154k catalogued functions), Apple M4: first index 31 s, then `find_functions` 2.6–4.3 s, `map` 0.5–1.8 s, `similar_functions` 0.9 s, `read_function` 0.15 s; `callers` 16 s for an ordinary function, 90 s and 3 GB RAM for a name mentioned in 822 files (`readFile`). Server memory 0.7–0.9 GB outside `callers`. Details: [bench/results/perf-vscode.md](bench/results/perf-vscode.md).

VS Code（14,306 个文件，约 450 万行，154k 个函数入目录），Apple M4：首次索引 31 s，之后 `find_functions` 2.6–4.3 s、`map` 0.5–1.8 s、`similar_functions` 0.9 s、`read_function` 0.15 s；普通函数的 `callers` 16 s，对在 822 个文件中出现的名称（`readFile`）需要 90 s 和 3 GB 内存。`callers` 之外 server 内存为 0.7–0.9 GB。

```bash
npm run bench                                   # synthetic: 100 + 50 large sessions
node bench/real.mjs --repo /path/to/your/repo   # your own repository, oracle-checked
node bench/perf.mjs --repo /path/to/huge/repo   # timings and memory
```

## Limits / Giới hạn

| Area / Phần | English | Tiếng Việt | 简体中文 |
|---|---|---|---|
| Search | Words, called names, abbreviations, synonym and concept lists, IDF — still lexical. `spec_nav_similar_functions` finds same-behaviour code under unrelated names only when it shares calls or vocabulary; two implementations written with nothing in common are missed. | Tìm theo từ, tên hàm được gọi, viết tắt, đồng nghĩa, khái niệm, IDF — vẫn là từ vựng. `spec_nav_similar_functions` tìm được code cùng hành vi khác tên khi chúng có chung lời gọi/từ vựng; hai cách viết không chung gì thì vẫn sót. | 基于词、被调用名称、缩写、同义词和概念列表、IDF——本质仍是词汇匹配。`spec_nav_similar_functions` 只有在代码共享调用或词汇时，才能找到名称无关但行为相同的代码；两段毫无共同点的实现仍会遗漏。 |
| Translation | Vietnamese written with diacritics is matched through a built-in dictionary of ~100 common domain terms; other words are not translated. | Tiếng Việt có dấu được dịch qua từ điển ~100 thuật ngữ phổ biến; từ ngoài từ điển không được dịch. | 带声调的越南语通过内置的约 100 个常用领域术语词典进行匹配；其他词不翻译。中文查询不会被翻译，请使用英文关键词。 |
| Reuse | Check exports, behavior and package/service dependencies yourself. | Cần kiểm tra export, hành vi và dependency trước khi tái sử dụng. | 请自行检查导出、行为以及包/服务依赖。 |
| Callers | Outside TS/JS, binding is by evidence (imports, qualifiers, declared receiver types), not a type checker: inferred types, inheritance and overloads can leave sites `likely`/`ambiguous`. Names built at runtime, HTTP/RPC/queue calls and external repositories are not traced. | Ngoài TS/JS, gắn lời gọi theo bằng chứng (import, qualifier, kiểu receiver được khai báo), không có type checker: kiểu suy luận, kế thừa, overload có thể để lại `likely`/`ambiguous`. Tên ghép lúc chạy, gọi qua HTTP/RPC/queue và repo ngoài không được lần theo. | 在 TS/JS 之外，绑定依据证据（import、限定符、声明的接收者类型），而非类型检查器：推断类型、继承和重载可能使位置停留在 `likely`/`ambiguous`。运行时拼接的名称、HTTP/RPC/队列调用和外部仓库不会被追踪。 |
| Anonymous callbacks | Inline anonymous callbacks are not individually catalogued; JS/TS counts them in coverage. | Callback anonymous không có mục riêng; coverage đếm chúng trong JS/TS. | 内联匿名回调不会单独入目录；JS/TS 会在覆盖率中统计它们。 |
| Function forms | JS/TS destructuring assignments, dynamic property assignments, factory-created functions, `Object.assign`/`Object.defineProperty` and some chained assignments are not fully covered. Other-language assigned lambdas/closures are not catalogued. | Chưa bao phủ đầy đủ assignment qua destructuring/property động, hàm từ factory, `Object.assign`/`Object.defineProperty` và một số gán nối. Lambda/closure gán biến ở ngôn ngữ khác chưa có trong danh mục. | JS/TS 的解构赋值、动态属性赋值、工厂创建的函数、`Object.assign`/`Object.defineProperty` 以及部分链式赋值尚未完全覆盖。其他语言中赋值给变量的 lambda/闭包不会入目录。 |
| Unsupported files | Dart, Lua, Objective-C, SQL and other unsupported source types are not parsed (they are counted in coverage). | Không parse Dart, Lua, Objective-C, SQL và các loại nguồn chưa hỗ trợ (có đếm trong coverage). | Dart、Lua、Objective-C、SQL 等不受支持的源文件类型不会被解析（但计入覆盖率统计）。 |
| Exclusions | Dependency/build directories, hidden directories, virtualenvs, declaration files, minified JS and supported files over 1.5 MB are excluded. | Bỏ qua dependency/build, thư mục ẩn, virtualenv, file declaration, JS minified và file hỗ trợ lớn hơn 1,5 MB. | 排除依赖/构建目录、隐藏目录、虚拟环境、声明文件、压缩过的 JS，以及超过 1.5 MB 的受支持文件。 |
| Types | Return types are reported when explicitly written; they are not inferred by the catalog. | Danh mục lấy kiểu trả về được khai báo, không suy luận kiểu. | 只报告显式书写的返回类型；目录不做类型推断。 |
| Large repos | Measured on VS Code (14k files): first index ~31 s, searches seconds. TS/JS callers type-check only files that mention the name, in batches, following imports two steps; for a very common name this takes minutes and ~3 GB, and calls whose receiver type lies further away are reported `unresolved`. | Đo trên VS Code (14k file): index lần đầu ~31 s, tìm kiếm vài giây. Callers TS/JS chỉ type-check file nhắc tới tên, theo lô, lần import 2 bước; tên rất phổ biến tốn vài phút và ~3 GB, lời gọi có kiểu receiver nằm xa hơn được báo `unresolved`. | 在 VS Code（14k 个文件）上测得：首次索引约 31 s，搜索数秒。TS/JS 调用方分析只对提及该名称的文件分批做类型检查，沿 import 追踪两层；对于非常常见的名称需要数分钟和约 3 GB 内存，接收者类型位于更远处的调用会报告为 `unresolved`。 |
| Dependencies | TS/JS type resolution is best with dependencies installed (`node_modules`); without them, library types are unknown and more calls end up `unresolved`. | Resolve kiểu TS/JS tốt nhất khi đã cài dependency (`node_modules`); thiếu thì kiểu thư viện không có và nhiều lời gọi thành `unresolved`. | 已安装依赖（`node_modules`）时 TS/JS 类型解析效果最好；未安装时库类型未知，更多调用会变成 `unresolved`。 |

The server reads the current local checkout. No search API key is required, and its search does not send code to an external search service. Results are returned to your connected coding agent; that client's model/data handling settings still apply.

Server đọc checkout local hiện tại. Không cần API key tìm kiếm và phần tìm kiếm không gửi code tới dịch vụ search bên ngoài. Kết quả được trả cho coding agent đã kết nối; cách client/model xử lý dữ liệu vẫn theo cấu hình của bạn.

server 读取当前的本地代码副本。不需要搜索 API 密钥，搜索过程也不会把代码发送到外部搜索服务。结果返回给已连接的编码代理；该客户端对模型和数据的处理仍遵循你的配置。

## Local installation / Cài từ source

Use this when developing the MCP or testing changes before pushing them.

Dùng cách này khi phát triển MCP hoặc thử thay đổi chưa push.

在开发本 MCP 或测试尚未推送的修改时使用。

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run build
```

Configure `.mcp.json` with absolute paths / Cấu hình `.mcp.json` bằng đường dẫn tuyệt đối / 用绝对路径配置 `.mcp.json`：

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

`args` 指向 MCP 的安装位置；`SPEC_NAV_ROOT` 指向要扫描的代码。修改 MCP 源码后，重新构建并重启客户端会话。

## Development / Phát triển

```bash
npm run typecheck
npm test
```

`npm test` builds the bundle and tests it through MCP stdio on fixture repositories.

`npm test` build bundle rồi kiểm thử qua MCP stdio trên các repo mẫu.

`npm test` 会构建 bundle，并在示例仓库上通过 MCP stdio 进行测试。

### Package the Claude Desktop extension / Đóng gói extension cho Claude Desktop / 打包 Claude Desktop 扩展

```bash
npm run pack:mcpb
```

This builds `dist/index.cjs`, stages it under `build/mcpb/` with `manifest.json`, `web-tree-sitter` and only the grammar `.wasm` files, validates the manifest and writes `build/mcp-spec-nav-<version>.mcpb`. The manifest is generated by [scripts/pack-mcpb.mjs](scripts/pack-mcpb.mjs); its version comes from `package.json`. To publish, attach the `.mcpb` file to a GitHub release.

Lệnh này build `dist/index.cjs`, gom vào `build/mcpb/` cùng `manifest.json`, `web-tree-sitter` và chỉ các file `.wasm` của grammar, kiểm tra manifest rồi tạo `build/mcp-spec-nav-<version>.mcpb`. Manifest được sinh từ [scripts/pack-mcpb.mjs](scripts/pack-mcpb.mjs), version lấy từ `package.json`. Muốn phát hành thì đính kèm file `.mcpb` vào GitHub release.

该命令构建 `dist/index.cjs`，将其连同 `manifest.json`、`web-tree-sitter` 和语法的 `.wasm` 文件放入 `build/mcpb/`，校验 manifest，并生成 `build/mcp-spec-nav-<version>.mcpb`。manifest 由 [scripts/pack-mcpb.mjs](scripts/pack-mcpb.mjs) 生成，版本号取自 `package.json`。发布时把 `.mcpb` 文件附加到 GitHub release。

To run the tests against the packed extension instead of `dist/` / Chạy test trên bản extension đã đóng gói thay vì `dist/` / 针对打包后的扩展（而非 `dist/`）运行测试：

```bash
unzip -q build/mcp-spec-nav-<version>.mcpb -d /tmp/spec-nav-mcpb
SPEC_NAV_DIST=/tmp/spec-nav-mcpb/dist/index.cjs node --test test/*.test.mjs
```

These checks validate the tested scenarios. They do not establish that an agent will produce better code on every task. See [Benchmark](#benchmark) for with/without-MCP measurements, and run `bench/real.mjs` on your own repository.

Các kiểm tra xác nhận tình huống đã test, không chứng minh AI sẽ code tốt hơn trong mọi task. Xem [Benchmark](#benchmark) để biết số đo có/không MCP, và chạy `bench/real.mjs` trên repo của bạn.

这些检查验证的是已测试的场景，并不能证明代理在每个任务上都会写出更好的代码。有/无 MCP 的对比数据见 [Benchmark](#benchmark)，也可以在你自己的仓库上运行 `bench/real.mjs`。

## License / Giấy phép

MIT. See [LICENSE](LICENSE). / MIT，见 [LICENSE](LICENSE)。

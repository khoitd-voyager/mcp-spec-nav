# Tham khảo tool

[English](tools.md) · [Tiếng Việt](tools.vi.md) · [简体中文](tools.zh-CN.md)

← [README](../../README.vi.md) · [Cài đặt](installation.vi.md) · [Khi gặp lỗi](troubleshooting.vi.md)

Đây là tham số để agent gọi tool, không phải lệnh terminal. Agent sẽ tự gọi giúp bạn. Thay đường dẫn và tên hàm ví dụ bằng kết quả thực tế từ repo của bạn.

| Tool | Mục đích |
|---|---|
| `spec_nav_services` | Kiểm tra đường dẫn quét, các project, số lượng file/hàm và coverage. |
| `spec_nav_find_functions` | Tìm các hàm có thể đáp ứng yêu cầu, xếp hạng và giải thích vì sao khớp. |
| `spec_nav_similar_functions` | Tìm hàm có hành vi giống một hàm hoặc một bản nháp, dù tên khác hẳn. |
| `spec_nav_read_function` | Đọc code chính xác của một hàm (hoặc tối đa 10 hàm mỗi lần gọi), kèm signature, tài liệu và import liên quan. |
| `spec_nav_functions` | Xem danh mục hàm, lọc và lấy từng trang. |
| `spec_nav_callers` | Kiểm tra lời gọi, references, lời gọi động và những trường hợp chưa resolve được. |
| `spec_nav_map` | Tìm dòng khớp regex, kèm tên hàm chứa dòng đó. |
| `spec_nav_trace_flow` | Lần theo link HTTP, RPC và event giữa các service, theo chiều upstream hoặc downstream, kèm bằng chứng và phần chưa resolve. |

Tham số dùng chung:

- `services` — giới hạn trong các service/thư mục này, tính từ `SPEC_NAV_ROOT` (ví dụ `"services/api"`, `"packages"`). `"."` chỉ chọn file của project gốc. Bỏ trống để khảo sát toàn repo (mặc định).
- `cursor` — giá trị `nextCursor` của trang trước. Giữ nguyên các tham số còn lại.
- `format` — `"text"` (mặc định, gọn) hoặc `"json"` (có cấu trúc).

## `spec_nav_services`

```json
{}
```

Liệt kê các project dưới thư mục gốc (ở mọi độ sâu) dưới dạng giá trị `service` mà các tool khác nhận, kèm số file, số hàm của từng project và tóm tắt coverage. Dùng khi chưa rõ nên truyền gì, hoặc để kiểm tra `SPEC_NAV_ROOT` trỏ đúng repo.

## `spec_nav_find_functions`

```json
{ "query": "calculate order fees", "limit": 20 }
```

Kết quả có ID của hàm và lý do khớp. Tool tìm trong tên, alias export, signature, tài liệu, đường dẫn, tên các hàm được gọi và (mặc định) thân hàm; từ càng hiếm càng có trọng số cao.

Tham số khác: `services`, `file` (chuỗi con của đường dẫn hoặc glob `*`), `language`, `searchBodies` (mặc định `true`; `false` bỏ các kết quả chỉ khớp trong thân hàm), `limit` (mặc định 20, tối đa 100), `cursor`, `format`.

## `spec_nav_similar_functions`

```json
{ "code": "function shippingCost(order) { const km = distanceKm(order.from, order.to); return round(km * zoneRate(order.zone), 2); }" }
```

Hoặc `{ "id": "<id>" }` (hay `file` + `name`, thêm `line` nếu cần) cho một hàm có sẵn. Tool so sánh lời gọi và từ vựng trong thân của mọi hàm, bỏ qua tên.

Tham số khác: `services`, `inFile`, `language`, `minScore` (mặc định 0.2), `limit` (mặc định 10, tối đa 100), `cursor`, `format`.

## `spec_nav_read_function`

```json
{ "file": "services/billing/src/fees.ts", "name": "calculateFee" }
```

Dùng đường dẫn/tên thật từ kết quả, hoặc truyền `{ "id": "<id do tool trả về>" }`. `name` có thể là tên đầy đủ (`OrderService.calculateFee`), tên ngắn hoặc tên được export; thêm `line` để chọn giữa các hàm trùng tên. Kết quả gồm signature, toàn bộ doc comment, các import hàm dùng và source chính xác kèm số dòng.

Hàm dài được chia phần: đọc tiếp bằng `nextCursor` trả về, truyền vào `cursor` (hoặc dùng `fromLine`); `maxLines` đặt số dòng mỗi phần (mặc định 400). Không có phần nào bị cắt mà không báo.

Để chỉ đọc một phần của hàm dài — component hay route handler cả nghìn dòng — truyền `lines` (dòng trong file, ví dụ các hit của map) và tùy chọn `around` (mặc định 15, tối đa 60): kết quả gồm chữ ký hàm và ±`around` dòng quanh mỗi dòng, gộp khi chồng nhau, dòng được yêu cầu đánh dấu `>`. `file` + `lines` không có `name` đọc khúc ở bất kỳ đâu trong file, mỗi khúc ghi nó nằm trong hàm nào. Dùng được trong batch, nên nhiều chỗ ở nhiều file về trong một lần gọi.

Đọc tối đa 10 hàm trong một lần gọi bằng `functions`:

```json
{ "functions": [
  { "file": "services/billing/src/fees.ts", "name": "calculateFee" },
  { "id": "<id do tool trả về>" }
] }
```

Các hàm dùng chung một trang: mỗi hàm nhận phần đều của dung lượng còn lại, nên hàm ngắn chừa chỗ cho hàm dài. Hàm không vừa sẽ kết thúc bằng `nextCursor` riêng, đọc tiếp bằng một lần gọi đơn (`{ "cursor": "…" }`). Hàm không tìm thấy, trùng tên hoặc STALE được báo ngay tại vị trí của nó; các hàm khác vẫn được đọc.

## `spec_nav_functions`

```json
{ "services": ["services/api"], "name": "fee", "limit": 100 }
```

Bỏ `services` để xem mọi project. `services: ["."]` chỉ chọn file của project gốc. Bộ lọc gồm `file`, `name` (chuỗi con không phân biệt hoa thường của tên đầy đủ, hoặc `/regex/`), `kind` (ví dụ `method`, `function`, `constructor`, `arrow`), `language` và `exportedOnly`. `limit` mặc định 200 (tối đa 1000).

## `spec_nav_callers`

```json
{ "symbol": "calculateFee", "file": "services/billing/src/fees.ts", "format": "json" }
```

Dùng tên đầy đủ như `OrderService.calculateFee`, `className` hoặc `file` khai báo để phân biệt hàm đích. `service` thu hẹp nơi khai báo; `searchServices` thu hẹp nơi tìm caller. `limit` mặc định 100 site mỗi trang; `limit` truyền vào được tôn trọng tới khoảng 120k ký tự. Mỗi site có `snippet` là nguyên dòng code và `usage`: kết quả lời gọi được dùng thế nào (`assigned`, `template string ${…}`, `String(…)`, `+= (accumulated)`, `arithmetic +`, `.toFixed on the result`, `returned`…). `usage` ở cấp trên đếm trên mọi site, không chỉ trang hiện tại. Trang chưa đủ site sẽ mở đầu bằng `partial` (còn bao nhiêu site chưa hiện, theo từng file) và `nextPage` (lệnh lấy trang tiếp). Khi hàm đích gọi HTTP hoặc có site nằm trong endpoint handler, `boundaries` (ngay sau `usage`) ghi luôn phía bên kia — `sends to <service>: <handler>` hoặc `called by <service>: <file:line>` — lấy từ flow graph được dựng nền sau khi server khởi động; khi graph chưa sẵn, `nextTrace` đưa lệnh `spec_nav_trace_flow` thay thế. `next` đọc các hàm gọi trong một lần: hàm ngắn đọc nguyên, hàm dài (trên 80 dòng) chỉ đọc ±15 dòng quanh lời gọi. Chỉ tìm trong các service import được nơi khai báo: chính service đó, và service import nó qua tên package, alias `paths` trong tsconfig hoặc đường dẫn tương đối; kết quả có note ghi rõ đã tìm ở đâu. Hàm bọc trong `cache(…)`, `unstable_cache(…)`, `memo(…)` hay `useCallback(…)` được nhận theo tên biến.

TypeScript/JavaScript (và script, template của Vue/Svelte/Astro) được resolve bằng type checker của TypeScript. Các ngôn ngữ hỗ trợ khác được gắn theo bằng chứng — cùng file/class, qualifier, import hoặc alias, package, hoặc receiver được khai báo đúng kiểu class — và trường `reason` của từng site cho biết bằng chứng nào. Mỗi site có hàm chứa nó, tham số của hàm đó và số đối số.

Output luôn là JSON (mặc định có thụt lề; `format: "json"` trả về trên một dòng). Trường `notes` ghi rõ những gì không được tính: tên tính lúc chạy, lời gọi qua HTTP/RPC/queue, loại file không hỗ trợ và code ngoài repo. Muốn lần theo link HTTP, RPC và event giữa các service, dùng [`spec_nav_trace_flow`](#spec_nav_trace_flow).

## `spec_nav_map`

```json
{ "pattern": "handl(e|ing)_?fee|handling_charge|HANDLING_FEE" }
```

Không phân biệt hoa thường. Mặc định bỏ qua dòng comment/import; đặt `includeComments: true` để lấy cả chúng. File config, docs và file text khác (JSON, YAML, Markdown, `.env`, SQL, HTML/CSS…; trừ lockfile) cũng được quét và liệt kê sau phần code, đánh dấu `[text: no functions]`; `includeText: false` để chỉ quét code. `^` và `$` khớp theo từng dòng. `file` lọc theo đường dẫn (chuỗi con, glob có `*`, hoặc regex: `/…/`, hay bất kỳ giá trị nào có `|` `(` `^` `$` `\`, ví dụ `services/(order|payment)`; nếu không khớp file nào thì kết quả nói rõ, không trả về map rỗng); `context` thêm tối đa 10 dòng (giá trị lớn hơn được tính là 10) trước và sau mỗi hit như `grep -C`, hiển thị dạng `line : source`. Khi một trang nêu không quá mười chỗ, kết quả kết thúc bằng lệnh `Next —` soạn sẵn để đọc bằng một lần `spec_nav_read_function`: hàm bao ngoài ngắn thì đọc nguyên, hàm dài (trên 80 dòng) hoặc hit ở cấp file thì chỉ đọc ±15 dòng quanh hit. Khi một hit gọi HTTP hoặc nằm trong endpoint handler, khối "Service boundaries" phía trên các hit ghi lời gọi đi tới đâu hoặc ai gọi endpoint đó (từ flow graph dựng sau khi khởi động; khi chưa sẵn thì gợi ý lệnh `spec_nav_trace_flow`). Tham số khác: `services`, `cursor`, `pageSize` (trang cũng được cắt ở khoảng 30k ký tự).

`spec_nav_find_functions` kết thúc bằng lệnh đọc sẵn các ứng viên đầu bảng, còn `spec_nav_callers` có lệnh đọc các hàm đang gọi (trường `next`) khi không quá mười hàm.

## `spec_nav_trace_flow`

```json
{ "file": "web/src/api.ts", "name": "placeOrder" }
```

Lần theo những gì hàm này gọi tới. `{ "endpoint": "POST /orders", "direction": "upstream" }` liệt kê ai gọi tới một route, `{ "topic": "order.created" }` liệt kê consumer của một topic, `{}` liệt kê mọi link tìm được.

Điểm bắt đầu là một hàm (`id`, hoặc `file` + `name`, thêm `line` nếu cần), một `endpoint` (`"GET /api/orders/:id"` hoặc `"/orders/42"`) hoặc một `topic` (event, topic hay pattern RPC). Tham số khác: `direction` (mặc định `downstream`, hoặc `upstream`, `both`), `maxDepth` (mặc định 6, tối đa 20), `followCalls` (đi theo lời gọi trực tiếp trong một service, mặc định `true`), `includePartial` (đi tiếp qua link `partial`, mặc định `true`), `limit` (số bước mỗi trang, mặc định 30), `cursor`, `format`.

Framework được hỗ trợ, trạng thái link, confidence và phần chưa phân tích: [Lần theo luồng giữa các service](flows.vi.md).

## Cách đọc kết quả

- **MORE / nextCursor:** Còn trang kết quả. Gọi lại với cùng truy vấn và truyền cursor. Lấy hết trang không đồng nghĩa mọi loại file trong repo đều đã được hỗ trợ.
- **PARTIAL / coverage:** Có phần chưa đọc được, chẳng hạn ngôn ngữ không hỗ trợ, file lỗi parse hoặc file bị bỏ qua. Cần kiểm tra thêm bằng công cụ khác.
- **Tìm kiếm:** Kết quả là ứng viên khớp từ vựng được xếp hạng, kèm bằng chứng, không phải hiểu ngữ nghĩa. Ứng viên chỉ khớp qua tên các hàm nó gọi được đánh dấu `[via calls]`, chỉ khớp trong thân hàm là `[body only]`; cả hai xếp sau. Kết quả chỉ khớp thân hàm quá rộng có thể bị giữ lại để giảm nhiễu; tool báo số lượng.
- **similarity:** Code giống nhau (cùng lời gọi, cùng từ vựng), không có nghĩa là dùng thay nhau được.
- **Callers:** Mỗi site cho biết cách gắn. Kiểm tra các site không phải `resolved`:
  - `likely` — chỉ có một khai báo trùng tên nhưng chưa chứng minh;
  - `ambiguous` — nhiều khai báo có thể khớp;
  - `dynamic` — tên xuất hiện dạng chuỗi/symbol (`getattr`, `send(:x)`, reflection, tên event);
  - `unresolved` — chưa xác định được hàm đích.

  Không coi đây là callers đã xác nhận. Kể cả `exhaustive: true` (chỉ với hàm đích được type-check) cũng không bao gồm tên ghép lúc chạy, lời gọi qua HTTP/RPC/queue hay repo bên ngoài.
- **Flows:** `spec_nav_trace_flow` là phân tích tĩnh: link được suy ra từ code, không quan sát lúc chạy. `partial` (một phần khóa là cấu hình), `ambiguous` (nhiều đích, không chọn) và `unresolved` (khóa tính lúc chạy) là manh mối cần tự kiểm tra; dòng `gaps` liệt kê phần chưa được phân tích. Xem [trạng thái link](flows.vi.md#trạng-thái-link-và-confidence).
- **Cập nhật:** File thêm/sửa/xóa được phản ánh ở các lần gọi tiếp theo. ID hàm phụ thuộc vào source của nó; nếu đọc hàm báo `STALE ID`, tìm lại hàm và dùng ID hiện tại.

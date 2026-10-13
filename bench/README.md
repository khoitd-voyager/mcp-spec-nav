# Benchmark: có MCP vs không MCP

So sánh một agent **không có MCP** (chỉ Grep/Read/Edit như tool built-in của Claude Code) với một agent **có MCP** (spec-nav + Read/Edit) trên cùng các task, ở ba chỗ:

| Script | Repo | Đáp án lấy từ đâu |
|---|---|---|
| `bench/run.mjs` | Monorepo giả lập ~2.800 file, ~205k dòng, 10 ngôn ngữ; 100 session thường + 50 session lớn | Generator ghi lại khi cài code |
| `bench/real.mjs` | Repo thật bất kỳ (đã chạy trên immich) | Oracle độc lập: `findReferences` của TypeScript, doc comment, ripgrep |
| `bench/perf.mjs` | Repo rất lớn (đã chạy trên VS Code) | — chỉ đo thời gian và RAM |

```bash
npm run build
node bench/run.mjs                                   # 100 session thường + 50 session lớn, ghi bench/results/
node bench/run.mjs --sessions 20 --large-sessions 5  # nhanh hơn
node bench/real.mjs --repo ~/code/your-repo --sessions 20 --large-sessions 10
node bench/perf.mjs --repo ~/code/huge-repo --symbols "SomeClass.someMethod"
node bench/report.mjs bench/results/<file>.json      # in lại báo cáo
```

Tùy chọn của `run.mjs`: `--seed`, `--files-per-service` (độ lớn repo), `--base-context <token>` (cộng system prompt/tool built-in vào mỗi lượt, như nhau hai bên), `--pick <ids>`, `--from <n>`, `--repo <dir>`, `--regenerate`, `--out <dir>`. Cần `rg` (ripgrep) trong PATH.

Kết quả đã chạy: [bench/results/](results/).

## Repo giả lập

`bench/generate.mjs` sinh một monorepo có seed (chạy lại ra đúng repo đó): 27 service/package, TypeScript, JavaScript, Vue, Python, Go, Java, Kotlin, Swift, Ruby, PHP. Mỗi service ~90 file code nhiễu: hàm đặt tên theo từ vựng nghiệp vụ chung (`computeCartFee`, `get_invoice_totals`…), gọi lẫn nhau — để grep và search đều gặp nhiễu như repo thật.

Trên nền đó, generator cài sẵn đáp án cho từng session và ghi lại vị trí chính xác (`.bench-tasks.json`).

## Một session = một feature request

> Feature request #8: in `services/inventory/…/refund_servicex.go`, add support for "calculate processing fee for a shipment". Reuse existing logic if the repo already has it. The change needs a new parameter on `NormalizeCouponCodeV7`: update every caller. The "risk quota" value also changes: update it everywhere it is defined, in every spelling.

**Session lớn** gộp 3 feature request như vậy trong cùng một context (một đợt thay đổi lớn): 50–120k token context mỗi session ở repo giả lập, 160–430k ở repo thật.

Agent làm bốn pha trong cùng một context:

1. **Tái sử dụng** — tìm hàm đã làm việc đó. Hàm đích có tên ở 5 mức: khớp từ (`calculateShipmentProcessingFee`), đồng nghĩa (`computeShipmentHandlingCharge`), viết tắt (`calcShipmentProcessingFeeAmt`), chỉ khớp hành vi (`settleShipmentMatrix12`, không doc), mô tả tiếng Việt. Có hàm mồi nhử tên gần giống nhưng làm việc khác.
2. **Callers** — mọi nơi gọi hàm cần đổi signature: import thường, alias, namespace, re-export, callback, `obj["name"]()`, `getattr`, template Vue, receiver JS không kiểu; kèm bẫy: method cùng tên ở class khác, hàm cục bộ trùng tên, package Go khác có hàm trùng tên, tên trong comment/chuỗi.
3. **Survey** — mọi file định nghĩa một khái niệm viết nhiều kiểu (`risk_quota`, `riskQuota`, `RISK_QUOTA`, `RiskQuota`), có nhắc trong comment làm nhiễu.
4. **Đọc + sửa** — Read trọn mọi file sẽ sửa (Claude Code bắt buộc Read trước Edit), rồi một Edit cho mỗi chỗ: signature, từng call site agent đã tìm, từng hằng số, và code mới (gọi hàm có sẵn, hoặc tự viết lại nếu không tìm thấy). Sửa thừa = sửa nhầm; sót = bug.

Session **đúng hoàn toàn** khi: tái sử dụng được hàm có sẵn, sửa đủ mọi caller không thừa chỗ nào, đổi đủ hằng số không thừa file nào.

## Hai agent

Cả hai là **chính sách tất định**, không phải LLM — để khác biệt đo được là do công cụ, không do may rủi của model. Chúng dùng chung quy tắc suy luận ở những chỗ giống nhau.

| | Không MCP | Có MCP |
|---|---|---|
| Tìm hàm | Grep định nghĩa có danh từ đặc thù trong tên (thu hẹp nếu > 60 dòng), đọc ≤ 5 file tốt nhất; không có thì đếm hit và đọc 3 file nhiều nhất | `spec_nav_find_functions`, đọc top 3 bằng `spec_nav_read_function`; đề tiếng Việt mà kết quả yếu thì hỏi lại bằng tiếng Anh; không có ứng viên rõ ràng thì viết nháp và gọi `spec_nav_similar_functions` |
| Callers | Grep `\bname\b`, lần theo alias `name as X`, bỏ comment/import/định nghĩa; method có receiver lạ thì Read 30 dòng quanh để đoán kiểu receiver; gọi qua package khác thì Read đầu file xem import | `spec_nav_callers` (đủ mọi trang); site `unresolved`/`ambiguous` thì Read 30 dòng quanh, cùng quy tắc đoán kiểu |
| Survey | Grep regex, bỏ dòng comment, lockfile và tài liệu | `spec_nav_map` cùng regex, đủ mọi trang; rồi Grep riêng các loại file spec-nav không đọc (SQL, JSON, YAML…), như hướng dẫn trong CLAUDE.md |
| Sửa | Read + Edit | Read + Edit |

**Ưu ái phía không-MCP** để không dựng người rơm:
- Nó được cho sẵn từ đồng nghĩa và bản dịch tiếng Anh như một LLM tốt tự nghĩ ra (`shipping|shipment|delivery|freight`), còn phía MCP chỉ dùng từ điển cài trong server.
- Chấm hào phóng như nhau: nếu code đúng đã vào context (đọc được) và có ít nhất một dấu hiệu khớp, coi như LLM nhận ra nó.
- Grep có `head_limit` 250 dòng và tự thu hẹp truy vấn — không đổ cả nghìn dòng vào context.

## Repo thật (`bench/real.mjs`)

Không có generator để cài đáp án, nên đáp án lấy từ nguồn độc lập với spec-nav:

- **Callers**: hàm/method TypeScript thật có 3–30 tham chiếu; đáp án = `findReferences` của TypeScript Language Service, bỏ chính khai báo, dòng import/export và khai báo của các override cùng cây kế thừa. Call site được tính khớp nếu cùng file và lệch ≤ 3 dòng (lời gọi nhiều dòng được hai công cụ báo ở dòng khác nhau), ghép 1-1, áp dụng như nhau cho hai bên.
- **Reuse**: hàm thật có JSDoc/docstring; đề bài = câu đầu của doc với mọi định danh code bị bỏ; đáp án = chính hàm đó. Agent không-MCP được cho 4 từ hiếm nhất của đề (trực giác chọn từ đặc thù), không có danh sách đồng nghĩa; agent MCP cũng không có bản nháp code nên không dùng `spec_nav_similar_functions`.
- **Survey**: khái niệm hai từ có ít nhất hai kiểu viết trong repo; đáp án = mọi file có dòng không phải comment khớp mẫu, **kể cả loại file spec-nav không đọc** (bỏ lockfile và tài liệu).

Lưu ý khi đọc kết quả immich: repo được clone không cài `node_modules`, nên kiểu của thư viện ngoài (vitest, SDK sinh ra) không có. Cả oracle lẫn spec-nav đều chịu ảnh hưởng; phần lớn "sửa nhầm" còn lại của phía MCP là lời gọi trùng tên có receiver không rõ kiểu, được agent giữ lại cho chắc.

## Đo gì

- Token: ước lượng 3,5 ký tự/token, như nhau hai bên; mỗi tool call cộng 25 token vỏ bọc. Định nghĩa 7 tool MCP (~3,7k token) được cộng vào **mỗi lượt** của phía có MCP — chi phí cố định của việc cài MCP.
  - *context cuối*: tổng mọi thứ đã vào context của session.
  - *input tích lũy*: mỗi lượt gửi lại toàn bộ context (không cache).
  - *quy đổi có prompt cache*: phần đã gửi đọc từ cache ×0,1, phần mới ghi cache ×1,25.
- Thời gian tool, gồm cả khởi động và index lần đầu của server MCP (mỗi session một server mới — cold start như session thật). Không tính thời gian model suy nghĩ; số lượt model = số tool call.
- Khoảng tin cậy 95% của chênh lệch: bootstrap theo cặp (cùng session, hai chế độ).

## Giới hạn — đọc trước khi trích dẫn số liệu

- **Repo thật cũng chỉ là một repo.** immich là TypeScript là chính; callers ở repo thật chỉ đo phần TypeScript (oracle là compiler TS). Phần callers đa ngôn ngữ chỉ được đo trên repo giả lập.
- **Không phải LLM thật.** LLM có thể khéo hơn (đọc hiểu thân hàm, đổi chiến lược) hoặc vụng hơn (bỏ qua bước kiểm tra). Kết quả nói về khả năng của *công cụ* dưới cùng một chính sách dùng, không phải về một model cụ thể.
- **Repo giả lập.** Code nhiễu đều đặn hơn code thật; các mẫu khó (alias, gọi động, trùng tên) xuất hiện dày hơn thực tế. Generator do cùng người viết MCP viết — các bẫy được chọn trước khi chạy và không chỉnh theo kết quả, nhưng vẫn nên đối chiếu bằng task thật.
- **Token là ước lượng** theo ký tự, không qua tokenizer của model.
- Phía không-MCP được cấp kiến thức đồng nghĩa ở dạng danh sách cố định; LLM thật có thể nghĩ ra nhiều hoặc ít hơn.

Muốn đo bằng model thật: dùng cùng repo và `.bench-tasks.json`, chạy `claude -p "<prompt của session>"` có và không có `--mcp-config`, lấy `usage` từ `--output-format json`, chấm theo đáp án trong file task. Cách đó tốn phí theo số session; benchmark này thì miễn phí và chạy lại được.

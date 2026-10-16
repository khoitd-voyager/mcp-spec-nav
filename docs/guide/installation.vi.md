# Cài đặt

[English](installation.md) · [Tiếng Việt](installation.vi.md) · [简体中文](installation.zh-CN.md)

← [README](../../README.vi.md) · [Tham khảo tool](tools.vi.md) · [Khi gặp lỗi](troubleshooting.vi.md)

## Chọn cách cài

| | Cách 1: Claude Code (`.mcp.json`) | Cách 2: Extension cho Claude Desktop (`.mcpb`) |
|---|---|---|
| Client | Claude Code (và các client đọc `.mcp.json`) | Claude Desktop |
| Cần có | Node.js 18+, npm/npx, Git | Chỉ cần Claude Desktop — extension chạy bằng Node.js có sẵn trong app |
| Chọn repo cần quét | `SPEC_NAV_ROOT` trong file cấu hình | Chọn thư mục trong phần cài đặt extension |
| Phù hợp khi | Code: Claude đọc, lên kế hoạch và sửa code trong repo | Hỏi về code: tìm, đọc và kiểm tra hàm trong khung chat |

Hai cách chạy cùng một server và cùng bộ tool. Có thể dùng cả hai cùng lúc.

## Claude Code

**Cần có:** Node.js từ phiên bản 18, npm/npx, Git và repo cần quét đã nằm trên máy. Lần cài đầu cần kết nối mạng.

### 1. Thêm cấu hình MCP

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

### 2. Kiểm tra kết nối

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

### 3. Dùng thử ngay

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

**Lần theo một request qua các service**

```text
Trước khi sửa endpoint POST /orders, dùng spec-nav lần theo ai gọi nó (upstream)
và nó gọi tiếp tới đâu (downstream) qua các service. Đọc cả hai đầu của mỗi link
và liệt kê các link được báo partial, ambiguous hoặc unresolved.
```

## Extension cho Claude Desktop

**Cần có:** Claude Desktop và repo cần quét đã nằm trên máy. Không cần cài Node.js.

### 1. Lấy file `.mcpb`

Tải `mcp-spec-nav-<version>.mcpb` ở trang [Releases](https://github.com/khoitd-voyager/mcp-spec-nav/releases), hoặc tự đóng gói:

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run pack:mcpb
```

File được tạo ở `build/mcp-spec-nav-<version>.mcpb`.

### 2. Cài extension

Bấm đúp vào file `.mcpb`, hoặc mở Claude Desktop → **Settings → Extensions → Advanced settings → Install Extension…** rồi chọn file. Xem thông tin extension và bấm **Install**.

### 3. Chọn repo cần quét

Trong phần cài đặt extension, đặt **Repository to scan** là thư mục gốc của code cần quét (trỏ tới gốc monorepo để quét mọi service), rồi bật extension.

Muốn quét repo khác thì mở **Settings → Extensions → Spec Nav → Configure** và chọn thư mục khác. Mỗi lần extension chỉ quét một repo.

### 4. Kiểm tra

Mở chat mới và gửi:

```text
Dùng spec-nav liệt kê các service trong repo này.
Cho tôi biết đường dẫn repo đang quét và những phần chưa quét được.
```

Các câu mẫu ở [Dùng thử ngay](#3-dùng-thử-ngay) cũng dùng được trong Claude Desktop. Claude Desktop đọc và giải thích code; muốn Claude sửa trực tiếp trong repo thì dùng Claude Code.

## Hướng dẫn Claude dùng khi code bình thường

Cài MCP chỉ làm cho tool có sẵn, không bảo đảm agent sẽ dùng. Thêm đoạn sau vào `CLAUDE.md` của dự án để hướng dẫn Claude sử dụng:

```markdown
## Tìm code có sẵn trước khi viết logic mới

Với logic mới hoặc thay đổi ảnh hưởng tới các hàm khác:

1. Dùng spec_nav_find_functions tìm implementation có sẵn trên các service.
   Dùng từ khóa tiếng Anh nếu code đặt tên bằng tiếng Anh; thử cách diễn đạt khác khi cần.
2. Dùng spec_nav_read_function đọc các ứng viên phù hợp, nhiều mục mỗi lần gọi
   (`functions`). Code không sửa: đọc hàm, hoặc class (file + tên class) thay vì cả file;
   chỉ truyền `file` để đọc cả file thay cho `cat`.
   Tránh nạp toàn bộ danh mục hoặc mọi thân hàm vào context.
   Không thấy hàm phù hợp thì viết nháp rồi đưa cho spec_nav_similar_functions.
3. Kiểm tra hành vi, export, dependency và ranh giới service trước khi tái sử dụng.
   Hàm ở service khác không mặc nhiên có thể import trực tiếp.
4. Dùng spec_nav_callers trước khi đổi signature hoặc hành vi của hàm.
   Tự kiểm tra các chỗ được đánh dấu likely, ambiguous, unresolved hoặc dynamic.
   Dùng spec_nav_map với một regex đủ rộng khi thay đổi liên quan nhiều file/service.
5. Khi thay đổi đụng tới endpoint, event hoặc lời gọi sang service khác, dùng
   spec_nav_trace_flow (upstream: ai gọi tới; downstream: nó gọi tiếp tới đâu).
   Link partial, ambiguous hoặc unresolved chỉ là manh mối, chưa phải kết luận: đọc cả hai đầu.
6. Đọc coverage và kết quả unresolved. Lấy trang tiếp theo nếu cần đủ kết quả;
   dùng tìm kiếm và đọc file thông thường cho phần không hỗ trợ hoặc còn thiếu.
7. Sau khi sửa, cập nhật các truy vấn liên quan và chạy kiểm tra phù hợp của dự án.

Áp dụng theo mức độ thay đổi. Sửa nhỏ, độc lập không cần gọi tất cả tool.
Không tìm thấy ứng viên không có nghĩa là repo chắc chắn chưa có implementation.
```

Với agent khác, chuyển hướng dẫn này sang file phù hợp, chẳng hạn `AGENTS.md`.

## Cài từ source local

Dùng cách này khi phát triển MCP hoặc thử thay đổi chưa push. `npx github:` luôn chạy bản package đã commit, nên thay đổi local không xuất hiện qua cách đó.

```bash
git clone https://github.com/khoitd-voyager/mcp-spec-nav.git
cd mcp-spec-nav
npm install
npm run build
```

Cấu hình `.mcp.json` bằng đường dẫn tuyệt đối:

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

`args` trỏ tới bản cài MCP; `SPEC_NAV_ROOT` trỏ tới code cần quét. Sau khi sửa source MCP, build lại và khởi động lại session client. Xem [Phát triển](development.vi.md) để chạy test và đóng gói.

## Quyền riêng tư

Server đọc checkout local hiện tại. Không cần API key tìm kiếm và phần tìm kiếm không gửi code tới dịch vụ search bên ngoài. Kết quả được trả cho coding agent đã kết nối; cách client/model xử lý dữ liệu vẫn theo cấu hình của bạn.

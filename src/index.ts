#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { REPO_ROOT } from "./project.js";
import {
  findCallers,
  readOutline,
  getSymbol,
  nextEnumValue,
  blastRadius,
} from "./tools.js";

const server = new McpServer({ name: "spec-nav", version: "0.1.0" });

/** Gói kết quả thành text block, và báo lỗi dạng đọc được thay vì stack trace. */
function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `LỖI: ${msg}` }], isError: true };
}

const serviceArg = z
  .string()
  .describe('Thư mục service, vd "Server/BEXMP-order" hoặc "BEXMP-storefront"');

server.registerTool(
  "spec_nav_callers",
  {
    description:
      "Mọi call site của một hàm/method, kèm HÀM BAO NGOÀI và tham số của nó. " +
      "Dùng trước khi đổi signature: cho biết mỗi chỗ sửa đã có biến cần truyền " +
      "trong scope chưa, và đang truyền mấy argument. Thay cho grep rồi mở từng file.",
    inputSchema: {
      service: serviceArg,
      symbol: z.string().describe("Tên hàm/method, vd addCouponUserHistory"),
    },
  },
  async ({ service, symbol }) => {
    try {
      return ok(findCallers(service, symbol));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_outline",
  {
    description:
      "Cấu trúc một file: class, method, function, interface, enum — kèm line range. " +
      "Dùng thay cho việc đọc cả file vài nghìn dòng chỉ để biết có gì ở đâu. " +
      "Có line range rồi thì Read đúng đoạn cần.",
    inputSchema: {
      service: serviceArg,
      path: z.string().describe("Đường dẫn file, tương đối so với repo root"),
    },
  },
  async ({ service, path }) => {
    try {
      return ok(readOutline(service, path));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_symbol",
  {
    description:
      "Signature + vị trí (file:line) của một symbol, không trả nội dung file. " +
      "Dùng để dẫn chiếu chính xác vào spec.",
    inputSchema: {
      service: serviceArg,
      name: z.string().describe("Tên function/class/method/interface"),
    },
  },
  async ({ service, name }) => {
    try {
      return ok(getSymbol(service, name));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_next_enum",
  {
    description:
      "Giá trị enum/const cuối cùng khớp prefix, cộng giá trị kế tiếp đề xuất. " +
      'Vd prefix "ERROR2_" trong error.constant.ts → biết mã cuối và mã mới nên dùng.',
    inputSchema: {
      service: serviceArg,
      path: z.string().describe("File chứa enum/const"),
      prefix: z.string().describe('Tiền tố, vd "ERROR2_"'),
    },
  },
  async ({ service, path, prefix }) => {
    try {
      return ok(nextEnumValue(service, path, prefix));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "spec_nav_blast_radius",
  {
    description:
      "File nào import file này và import cái gì — phạm vi ảnh hưởng khi đổi export. " +
      "Dùng trước khi đổi signature hoặc xoá export.",
    inputSchema: {
      service: serviceArg,
      path: z.string().describe("File cần kiểm tra"),
    },
  },
  async ({ service, path }) => {
    try {
      return ok(blastRadius(service, path));
    } catch (err) {
      return fail(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr để không lẫn vào stdout của giao thức MCP
  console.error(`spec-nav MCP đã chạy, repo root = ${REPO_ROOT}`);
}

main().catch((err) => {
  console.error("spec-nav không khởi động được:", err);
  process.exit(1);
});

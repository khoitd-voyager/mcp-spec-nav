import * as esbuild from "esbuild";
import * as fs from "node:fs";

const out = "dist/index.cjs";

// CJS, không ESM: ts-morph nạp TypeScript qua require() động, mà ESM bundle
// không hỗ trợ dynamic require.
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: out,
  packages: "bundle",
  // web-tree-sitter nạp web-tree-sitter.wasm nằm cạnh file js của nó, còn mỗi
  // grammar là một .wasm đọc từ node_modules lúc chạy. Bundle vào thì đường
  // dẫn tới các file đó sai, nên để external và require từ package đã cài.
  external: ["web-tree-sitter"],
  // Nguồn là ESM nên dùng import.meta.url để tìm file .wasm, nhưng bundle là
  // CJS — ở đó import.meta rỗng, còn __filename mới là đường dẫn thật. Thay
  // sẵn lúc build để nhánh ESM không còn trong output.
  define: { "import.meta.url": "__spec_nav_filename" },
  inject: ["src/cjs-shim.js"],
  // src/index.ts đã có shebang; thêm banner nữa sẽ bị nhân đôi.
  logLevel: "info",
});

fs.chmodSync(out, 0o755);
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`${out}  ${kb} KB  (executable)`);

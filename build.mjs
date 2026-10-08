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
  // src/index.ts đã có shebang; thêm banner nữa sẽ bị nhân đôi.
  logLevel: "info",
});

fs.chmodSync(out, 0o755);
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`${out}  ${kb} KB  (executable)`);

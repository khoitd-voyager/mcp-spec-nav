import { Project, SourceFile, Node, SyntaxKind } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";

/** Thư mục gốc các service, đọc từ env hoặc suy ra từ cwd. */
export const REPO_ROOT = process.env.SPEC_NAV_ROOT
  ? path.resolve(process.env.SPEC_NAV_ROOT)
  : process.cwd();

/** Project ts-morph nạp lười theo từng service, vì repo có nhiều service. */
const projects = new Map<string, Project>();

/** Tìm tsconfig gần nhất của một service để ts-morph hiểu path alias. */
function findTsConfig(serviceDir: string): string | undefined {
  const candidate = path.join(serviceDir, "tsconfig.json");
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Nạp project cho một service. Dùng tsconfig nếu có (để resolve alias),
 * không thì quét *.ts theo glob.
 */
export function getProject(service: string): Project {
  const cached = projects.get(service);
  if (cached) return cached;

  const serviceDir = path.resolve(REPO_ROOT, service);
  if (!fs.existsSync(serviceDir)) {
    throw new Error(
      `Không thấy service "${service}" trong ${REPO_ROOT}. ` +
        `Kiểm tra SPEC_NAV_ROOT hoặc tên service.`,
    );
  }

  const tsConfigFilePath = findTsConfig(serviceDir);
  const project = tsConfigFilePath
    ? new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false })
    : new Project({ skipFileDependencyResolution: true });

  if (!tsConfigFilePath) {
    project.addSourceFilesAtPaths([
      path.join(serviceDir, "src/**/*.ts"),
      path.join(serviceDir, "src/**/*.tsx"),
      `!${path.join(serviceDir, "**/node_modules/**")}`,
    ]);
  }

  projects.set(service, project);
  return project;
}

/** Đường dẫn tương đối so với REPO_ROOT, để output gọn và copy được vào spec. */
export function relPath(sf: SourceFile): string {
  return path.relative(REPO_ROOT, sf.getFilePath());
}

/** Dòng 1-indexed của một node. */
export function lineOf(node: Node): number {
  return node.getStartLineNumber();
}

export interface EnclosingInfo {
  /** Tên hàm/method bao ngoài, hoặc "<top-level>". */
  name: string;
  /** Dòng khai báo hàm bao ngoài. */
  line: number;
  /** Signature rút gọn, để biết có param cần thiết hay không. */
  signature: string;
  /** Tên các tham số của hàm bao ngoài. */
  params: string[];
}

const FUNCTION_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/**
 * Tìm hàm/method bao ngoài một node. Đây là thông tin spec cần nhất ở mỗi
 * call site: sửa chỗ này thì có sẵn biến cần truyền trong scope hay không.
 */
export function enclosingFunction(node: Node): EnclosingInfo {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (FUNCTION_KINDS.has(current.getKind())) {
      const fn = current as any;
      const params: string[] =
        typeof fn.getParameters === "function"
          ? fn.getParameters().map((p: any) => p.getName())
          : [];
      let name = "<anonymous>";
      if (typeof fn.getName === "function" && fn.getName()) {
        name = fn.getName();
      } else {
        // arrow/function expression gán vào biến: lấy tên biến
        const decl = current.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        if (decl) name = decl.getName();
        else if (current.getKind() === SyntaxKind.Constructor) name = "constructor";
      }
      const sigParts: string[] =
        typeof fn.getParameters === "function"
          ? fn.getParameters().map((p: any) => p.getText())
          : [];
      return {
        name,
        line: current.getStartLineNumber(),
        signature: `${name}(${sigParts.join(", ")})`,
        params,
      };
    }
    current = current.getParent();
  }
  return { name: "<top-level>", line: 1, signature: "<top-level>", params: [] };
}

import { Node, SyntaxKind } from "ts-morph";
import { getProject, relPath, enclosingFunction, EnclosingInfo } from "./project.js";

export interface CallSite {
  file: string;
  line: number;
  enclosing: string;
  enclosingLine: number;
  /** Tham số của hàm bao ngoài — spec cần biết biến cần truyền có sẵn chưa. */
  enclosingParams: string[];
  /** Số argument đang truyền tại call site này. */
  argCount: number;
  /** Text của call site, cắt ngắn. */
  snippet: string;
}

/**
 * Mọi chỗ gọi `symbol`, kèm hàm bao ngoài và tham số của nó.
 *
 * Đây là thông tin mà spec cần nhất trước khi đổi signature: sửa chỗ này
 * thì biến cần truyền đã có trong scope chưa, và đang truyền mấy argument.
 */
export function findCallers(service: string, symbol: string): {
  symbol: string;
  total: number;
  sites: CallSite[];
} {
  const project = getProject(service);
  const sites: CallSite[] = [];

  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath().includes("node_modules")) continue;
    // Chỉ quét file có chứa tên symbol — rẻ hơn nhiều so với đi hết AST.
    if (!sf.getFullText().includes(symbol)) continue;

    sf.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const call = node.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = call.getExpression();
      const calleeName = expr.getKind() === SyntaxKind.PropertyAccessExpression
        ? expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName()
        : expr.getText();
      if (calleeName !== symbol) return;

      const enc: EnclosingInfo = enclosingFunction(call);
      sites.push({
        file: relPath(sf),
        line: call.getStartLineNumber(),
        enclosing: enc.name,
        enclosingLine: enc.line,
        enclosingParams: enc.params,
        argCount: call.getArguments().length,
        snippet: call.getText().replace(/\s+/g, " ").slice(0, 120),
      });
    });
  }

  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { symbol, total: sites.length, sites };
}

export interface OutlineEntry {
  kind: string;
  name: string;
  line: number;
  endLine: number;
  signature?: string;
}

/**
 * Cấu trúc một file: class, method, function, export — kèm line range.
 * Thay cho việc đọc cả file vài nghìn dòng chỉ để biết có gì ở đâu.
 */
export function readOutline(service: string, filePath: string): {
  file: string;
  totalLines: number;
  entries: OutlineEntry[];
} {
  const project = getProject(service);
  const sf = project.getSourceFiles().find((f) => relPath(f) === filePath)
    ?? project.getSourceFile((f) => f.getFilePath().endsWith(filePath));
  if (!sf) throw new Error(`Không thấy file "${filePath}" trong service "${service}".`);

  const entries: OutlineEntry[] = [];
  const push = (kind: string, name: string, node: Node, signature?: string) => {
    entries.push({
      kind,
      name,
      line: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      signature,
    });
  };

  for (const cls of sf.getClasses()) {
    push("class", cls.getName() ?? "<anonymous>", cls);
    for (const m of cls.getMethods()) {
      const params = m.getParameters().map((p) => p.getText()).join(", ");
      push("method", `${cls.getName()}.${m.getName()}`, m, `${m.getName()}(${params})`);
    }
  }
  for (const fn of sf.getFunctions()) {
    const params = fn.getParameters().map((p) => p.getText()).join(", ");
    push("function", fn.getName() ?? "<anonymous>", fn, `${fn.getName()}(${params})`);
  }
  for (const iface of sf.getInterfaces()) push("interface", iface.getName(), iface);
  for (const en of sf.getEnums()) push("enum", en.getName(), en);
  for (const ta of sf.getTypeAliases()) push("type", ta.getName(), ta);

  entries.sort((a, b) => a.line - b.line);
  return { file: relPath(sf), totalLines: sf.getEndLineNumber(), entries };
}

/**
 * Signature + vị trí của một symbol, không trả cả file.
 */
export function getSymbol(service: string, name: string): {
  found: number;
  results: Array<{ file: string; line: number; kind: string; signature: string }>;
} {
  const project = getProject(service);
  const results: Array<{ file: string; line: number; kind: string; signature: string }> = [];

  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath().includes("node_modules")) continue;
    if (!sf.getFullText().includes(name)) continue;

    for (const fn of sf.getFunctions()) {
      if (fn.getName() !== name) continue;
      results.push({
        file: relPath(sf),
        line: fn.getStartLineNumber(),
        kind: "function",
        signature: `${name}(${fn.getParameters().map((p) => p.getText()).join(", ")})`,
      });
    }
    for (const cls of sf.getClasses()) {
      if (cls.getName() === name) {
        results.push({
          file: relPath(sf),
          line: cls.getStartLineNumber(),
          kind: "class",
          signature: `class ${name}`,
        });
      }
      for (const m of cls.getMethods()) {
        if (m.getName() !== name) continue;
        results.push({
          file: relPath(sf),
          line: m.getStartLineNumber(),
          kind: "method",
          signature: `${cls.getName()}.${name}(${m.getParameters().map((p) => p.getText()).join(", ")})`,
        });
      }
    }
    for (const iface of sf.getInterfaces()) {
      if (iface.getName() !== name) continue;
      results.push({
        file: relPath(sf),
        line: iface.getStartLineNumber(),
        kind: "interface",
        signature: `interface ${name}`,
      });
    }
  }
  return { found: results.length, results };
}

/**
 * Enum/const cuối cùng khớp prefix, cộng giá trị kế tiếp.
 * Dùng khi append vào một danh sách có mã: "ERROR2_124 là mã cuối → mã mới
 * là ERROR2_125", mà không phải đọc cả file constant.
 */
export function nextEnumValue(service: string, filePath: string, prefix: string): {
  file: string;
  lastMatch: { line: number; text: string } | null;
  suggestedNext: string | null;
} {
  const project = getProject(service);
  const sf = project.getSourceFiles().find((f) => relPath(f) === filePath)
    ?? project.getSourceFile((f) => f.getFilePath().endsWith(filePath));
  if (!sf) throw new Error(`Không thấy file "${filePath}".`);

  const re = new RegExp(`${prefix}(\\d+)`, "g");
  let maxNum = -1;
  let lastLine = 0;
  let lastText = "";

  sf.getFullText().split("\n").forEach((lineText, idx) => {
    for (const m of lineText.matchAll(re)) {
      const n = Number(m[1]);
      if (n > maxNum) {
        maxNum = n;
        lastLine = idx + 1;
        lastText = lineText.trim().slice(0, 140);
      }
    }
  });

  return {
    file: relPath(sf),
    lastMatch: maxNum >= 0 ? { line: lastLine, text: lastText } : null,
    suggestedNext: maxNum >= 0 ? `${prefix}${maxNum + 1}` : null,
  };
}

/**
 * File nào import symbol/file này — phạm vi ảnh hưởng khi đổi signature.
 */
export function blastRadius(service: string, filePath: string): {
  file: string;
  importedBy: Array<{ file: string; line: number; what: string }>;
} {
  const project = getProject(service);
  const target = project.getSourceFiles().find((f) => relPath(f) === filePath)
    ?? project.getSourceFile((f) => f.getFilePath().endsWith(filePath));
  if (!target) throw new Error(`Không thấy file "${filePath}".`);

  const importedBy: Array<{ file: string; line: number; what: string }> = [];
  for (const sf of project.getSourceFiles()) {
    if (sf === target || sf.getFilePath().includes("node_modules")) continue;
    for (const imp of sf.getImportDeclarations()) {
      const resolved = imp.getModuleSpecifierSourceFile();
      if (resolved?.getFilePath() !== target.getFilePath()) continue;
      const named = imp.getNamedImports().map((n) => n.getName());
      const def = imp.getDefaultImport()?.getText();
      importedBy.push({
        file: relPath(sf),
        line: imp.getStartLineNumber(),
        what: [def, ...named].filter(Boolean).join(", ") || "(side-effect)",
      });
    }
  }
  importedBy.sort((a, b) => a.file.localeCompare(b.file));
  return { file: relPath(target), importedBy };
}

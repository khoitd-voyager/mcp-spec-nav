/**
 * What counts as a "function" in each language we can parse.
 *
 * The node type names here are not guesses — each one was read off the tree
 * tree-sitter actually produced for a sample file in that language. Grammars
 * disagree in ways that are easy to get wrong from memory: Ruby names its
 * nodes `method` and `class` where Java uses `method_declaration` and
 * `class_declaration`, Rust wraps methods in an `impl_item` that has no name
 * of its own, and Python puts a decorated method inside a
 * `decorated_definition`. Guessing would produce the failure mode this tool
 * exists to prevent — a confident label pointing at the wrong function.
 */
export interface LangSpec {
  /** Identifier used in output and in the `languages` tool argument. */
  id: string;
  /** File extensions, lower case, including the dot. */
  extensions: string[];
  /** The npm package path of the grammar's prebuilt .wasm. */
  wasm: string;
  /**
   * Node types that are a named function, method or constructor — the things
   * worth reporting as "the code this line belongs to".
   */
  functionNodes: string[];
  /**
   * Node types that are a type/class/module scope. Used as a prefix on a
   * method name (`Order.total`), which is what makes a bare `total` or
   * `save` identifiable in a repo that has twelve of them.
   */
  containerNodes: string[];
  /**
   * Nodes that name a scope through a field other than `name` — Rust's
   * `impl_item` carries its type in `type`. Maps node type to field name.
   */
  containerNameField?: Record<string, string>;
  /**
   * Node types whose own `receiver` field supplies the qualifier, for
   * languages that attach a method to a type without nesting it inside one.
   * Go's `func (o *Order) Total()` is a top-level declaration, so without this
   * it reports as bare `Total` — indistinguishable from every other type's.
   */
  receiverNodes?: string[];
  /**
   * Node types whose name is not in a `name` field but nested inside a
   * `declarator`. C and C++ put it there, one level deeper again when the
   * return type is a pointer: `function_definition` → `pointer_declarator`
   * → `function_declarator` → identifier.
   */
  declaratorNodes?: string[];
  /**
   * Languages where a definition is a macro call rather than its own node.
   * Elixir's `def total(s)` parses as a `call` to the identifier `def`, so a
   * function is recognised by which keyword is being called.
   */
  callDefinition?: {
    /** Node type of the call, e.g. "call". */
    node: string;
    /** Keywords that define a function, e.g. def, defp. */
    functionKeywords: string[];
    /** Keywords that open a named scope, e.g. defmodule. */
    containerKeywords: string[];
  };
  /** Comment/import lines: present in the file but not a use of the symbol. */
  noise: RegExp;
}

/**
 * TypeScript is deliberately absent: it keeps going through ts-morph, which
 * resolves tsconfig path aliases and powers `spec_nav_callers`. Tree-sitter
 * would see the syntax but not the project.
 */
export const LANGUAGES: LangSpec[] = [
  {
    id: "python",
    extensions: [".py", ".pyi"],
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
    functionNodes: ["function_definition"],
    containerNodes: ["class_definition"],
    noise: /^\s*(#|"""|'''|from\s+\S+\s+import\s|import\s)/,
  },
  {
    id: "go",
    extensions: [".go"],
    wasm: "tree-sitter-go/tree-sitter-go.wasm",
    functionNodes: ["function_declaration", "method_declaration", "func_literal"],
    containerNodes: ["type_declaration"],
    receiverNodes: ["method_declaration"],
    noise: /^\s*(\/\/|\/\*|\*|import\s|")/,
  },
  {
    id: "java",
    extensions: [".java"],
    wasm: "tree-sitter-java/tree-sitter-java.wasm",
    functionNodes: ["method_declaration", "constructor_declaration"],
    containerNodes: ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"],
    noise: /^\s*(\/\/|\/\*|\*|import\s|package\s|@\w+\s*$)/,
  },
  {
    id: "ruby",
    extensions: [".rb", ".rake"],
    wasm: "tree-sitter-ruby/tree-sitter-ruby.wasm",
    functionNodes: ["method", "singleton_method"],
    containerNodes: ["class", "module", "singleton_class"],
    noise: /^\s*(#|require\s|require_relative\s)/,
  },
  {
    id: "rust",
    extensions: [".rs"],
    wasm: "tree-sitter-rust/tree-sitter-rust.wasm",
    functionNodes: ["function_item", "closure_expression"],
    containerNodes: ["impl_item", "trait_item", "mod_item"],
    // An `impl Order` names its type in `type`, not `name`.
    containerNameField: { impl_item: "type" },
    noise: /^\s*(\/\/|\/\*|\*|use\s|#\[)/,
  },
  {
    id: "php",
    extensions: [".php"],
    wasm: "tree-sitter-php/tree-sitter-php.wasm",
    functionNodes: ["function_definition", "method_declaration"],
    containerNodes: ["class_declaration", "interface_declaration", "trait_declaration"],
    noise: /^\s*(\/\/|#|\/\*|\*|use\s|namespace\s|require\s|include\s)/,
  },
  {
    id: "c",
    extensions: [".c", ".h"],
    wasm: "tree-sitter-c/tree-sitter-c.wasm",
    functionNodes: ["function_definition"],
    containerNodes: [],
    declaratorNodes: ["function_definition"],
    noise: /^\s*(\/\/|\/\*|\*|#include|#import)/,
  },
  {
    id: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    wasm: "tree-sitter-cpp/tree-sitter-cpp.wasm",
    functionNodes: ["function_definition"],
    containerNodes: ["class_specifier", "struct_specifier", "namespace_definition"],
    declaratorNodes: ["function_definition"],
    noise: /^\s*(\/\/|\/\*|\*|#include|#import|using\s)/,
  },
  {
    id: "scala",
    extensions: [".scala", ".sc"],
    wasm: "tree-sitter-scala/tree-sitter-scala.wasm",
    functionNodes: ["function_definition"],
    containerNodes: ["object_definition", "class_definition", "trait_definition"],
    noise: /^\s*(\/\/|\/\*|\*|import\s|package\s)/,
  },
  {
    id: "elixir",
    extensions: [".ex", ".exs"],
    wasm: "tree-sitter-elixir/tree-sitter-elixir.wasm",
    // Nothing here is a plain node type; see callDefinition.
    functionNodes: [],
    containerNodes: [],
    callDefinition: {
      node: "call",
      functionKeywords: ["def", "defp", "defmacro", "defmacrop"],
      containerKeywords: ["defmodule", "defprotocol", "defimpl"],
    },
    noise: /^\s*(#|@doc|@moduledoc|alias\s|import\s|require\s|use\s)/,
  },
  {
    id: "bash",
    extensions: [".sh", ".bash", ".zsh"],
    wasm: "tree-sitter-bash/tree-sitter-bash.wasm",
    functionNodes: ["function_definition"],
    containerNodes: [],
    noise: /^\s*#/,
  },
  {
    id: "csharp",
    extensions: [".cs"],
    wasm: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
    functionNodes: [
      "method_declaration",
      "constructor_declaration",
      "property_declaration",
      "local_function_statement",
    ],
    containerNodes: ["class_declaration", "struct_declaration", "interface_declaration", "record_declaration"],
    noise: /^\s*(\/\/|\/\*|\*|using\s|namespace\s|\[\w+)/,
  },
];

const BY_EXT = new Map<string, LangSpec>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) BY_EXT.set(ext, lang);
}

/** The language for a file extension, or undefined if we cannot parse it. */
export function languageForExt(ext: string): LangSpec | undefined {
  return BY_EXT.get(ext.toLowerCase());
}

/** Every extension tree-sitter can label, for the file walker. */
export const PARSEABLE_EXTENSIONS: string[] = LANGUAGES.flatMap((l) => l.extensions);

export function languageById(id: string): LangSpec | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

# Supported languages

[English](languages.md) · [Tiếng Việt](languages.vi.md) · [简体中文](languages.zh-CN.md)

← [README](../../README.md) · [Tool reference](tools.md)

| Language | Extensions | Callers |
|---|---|---|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | Type-checked |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | Type-checked |
| Vue / Svelte / Astro | `.vue`, `.svelte`, `.astro` (script blocks; templates for callers) | Type-checked |
| Python | `.py`, `.pyi` | Evidence-based |
| Go | `.go` | Evidence-based |
| Java | `.java` | Evidence-based |
| C# | `.cs` | Evidence-based |
| Ruby | `.rb`, `.rake` | Evidence-based |
| Rust | `.rs` | Evidence-based |
| PHP | `.php` | Evidence-based |
| C | `.c`, `.h` | Evidence-based |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | Evidence-based |
| Scala | `.scala`, `.sc` | Evidence-based |
| Elixir | `.ex`, `.exs` | Evidence-based |
| Bash | `.sh`, `.bash`, `.zsh` | Evidence-based |
| Kotlin | `.kt`, `.kts` | Evidence-based |
| Swift | `.swift` | Evidence-based |

## How each language is read

- **TS/JS** support named declarations, methods, accessors, arrows/function expressions stored in variables or properties, supported assignments and CommonJS exports.
- **Vue/Svelte/Astro** components are read as their `<script>` (and frontmatter) with line numbers unchanged.
- **Kotlin and Swift** are read by a structural scanner (strings, interpolation, nested comments and brackets lexed exactly; classes, objects, extensions, `fun`/`func`, `init`/`constructor`, expression bodies, closures and computed properties recognised) because the published tree-sitter grammars do not parse them reliably here.
- **Other languages** use tree-sitter.

## Callers

Callers are **type-checked in TS/JS/Vue/Svelte/Astro** and **evidence-based in every other supported language**: same file/class, qualifier, import or alias, package, or a receiver declared with the class's type. Inferred types, inheritance and overloads can leave evidence-based sites `likely` or `ambiguous`. See [Reading the results](tools.md#reading-the-results).

## Cross-service flows

`spec_nav_trace_flow` has adapters for TypeScript/JavaScript and Python frameworks only; other languages are reported as not traced. See [Supported frameworks](flows.md#supported-frameworks).

## Not parsed

Dart, Lua, Objective-C, SQL and other unsupported source types are not parsed; they are counted in coverage. Dependency/build directories, hidden directories, virtualenvs, declaration files, minified JS and supported files over 1.5 MB are excluded.

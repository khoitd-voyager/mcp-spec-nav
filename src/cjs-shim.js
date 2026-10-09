// Injected by build.mjs, where `import.meta.url` is replaced with
// `__spec_nav_filename`. In the CJS bundle `__filename` is the real path of
// the output file, which is what grammar .wasm resolution needs; resolving
// against the cwd instead would fail wherever npx unpacked the package.
export const __spec_nav_filename = `file://${__filename}`;

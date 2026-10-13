/**
 * Single-file components: Vue (`.vue`), Svelte (`.svelte`) and Astro
 * (`.astro`).
 *
 * Their logic is ordinary TypeScript or JavaScript inside `<script>` blocks
 * (and, for Astro, the `---` frontmatter fence). Rather than a grammar of
 * their own, the script is handed to the same TypeScript parser every `.ts`
 * file goes through — with everything outside the script blanked to spaces,
 * newlines kept, so every offset, line and column in the result is the
 * component file's own.
 *
 * The template is not code the TypeScript parser can read, but it does call
 * the script's functions (`@click="save"`, `{format(price)}`); its extent is
 * kept so callers can look there too.
 */

export interface SfcScript {
  /** The file text with everything but script code replaced by spaces; same length, same lines. */
  masked: string;
  /** Whether any block declares TypeScript (`lang="ts"`). */
  typescript: boolean;
  /** Extents of script code, as [start, end) offsets. */
  scripts: Array<[number, number]>;
  /** Extents of markup outside every script and style block. */
  template: Array<[number, number]>;
}

export const SFC_EXTENSIONS = new Set([".vue", ".svelte", ".astro"]);

export function sfcLanguage(ext: string): string | undefined {
  if (ext === ".vue") return "vue";
  if (ext === ".svelte") return "svelte";
  if (ext === ".astro") return "astro";
  return undefined;
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

const SCRIPT_OPEN = /<script\b([^>]*)>/gi;
const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;

export function extractSfcScript(text: string, ext: string): SfcScript {
  const scripts: Array<[number, number]> = [];
  let typescript = false;

  // Astro: the frontmatter fence at the top of the file is the component script.
  if (ext === ".astro") {
    const m = text.match(/^(\s*)---[^\n]*\n([\s\S]*?)\n---/);
    if (m) {
      const start = m[1].length + m[0].indexOf("\n", m[1].length) + 1;
      scripts.push([start, start + m[2].length]);
      typescript = true; // Astro frontmatter is TypeScript.
    }
  }

  SCRIPT_OPEN.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = SCRIPT_OPEN.exec(text)); ) {
    const attrs = m[1];
    // `<script src="…">` and JSON/template scripts carry no component code.
    if (/\bsrc\s*=/.test(attrs) || /\btype\s*=\s*["'](?!module|text\/javascript|text\/typescript)[^"']*["']/i.test(attrs)) continue;
    const start = m.index + m[0].length;
    const close = text.toLowerCase().indexOf("</script", start);
    const end = close < 0 ? text.length : close;
    scripts.push([start, end]);
    if (/\blang\s*=\s*["']?(ts|typescript|tsx)\b/i.test(attrs)) typescript = true;
    SCRIPT_OPEN.lastIndex = end;
  }
  scripts.sort((a, b) => a[0] - b[0]);

  const parts: string[] = [];
  let pos = 0;
  for (const [s, e] of scripts) {
    parts.push(blank(text.slice(pos, s)), text.slice(s, e));
    pos = e;
  }
  parts.push(blank(text.slice(pos)));
  const masked = parts.join("");

  // The template: whatever is neither script nor style.
  const excluded: Array<[number, number]> = scripts.map(([s, e]) => [s, e]);
  STYLE_BLOCK.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = STYLE_BLOCK.exec(text)); ) excluded.push([m.index, m.index + m[0].length]);
  excluded.sort((a, b) => a[0] - b[0]);
  const template: Array<[number, number]> = [];
  let t = 0;
  for (const [s, e] of excluded) {
    if (s > t) template.push([t, s]);
    t = Math.max(t, e);
  }
  if (t < text.length) template.push([t, text.length]);

  return { masked, typescript, scripts, template };
}

/**
 * What the TypeScript parser should read for a TS-family file: the file
 * itself, or a component's masked script, with the extension that selects
 * TS or JS parsing.
 */
export function tsParseView(ext: string, text: string): { text: string; ext: string; sfc?: SfcScript } {
  if (!SFC_EXTENSIONS.has(ext)) return { text, ext };
  const sfc = extractSfcScript(text, ext);
  return { text: sfc.masked, ext: sfc.typescript ? ".ts" : ".js", sfc };
}

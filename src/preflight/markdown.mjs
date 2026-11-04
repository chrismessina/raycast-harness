// Markdown-aware destination extraction for `readme-assets` and `readme-links` (T3, T4, Q9).
// Code is blanked first (fenced blocks, 4-space-indented blocks, inline spans: a documented example
// is not an embed), then every rendered destination is collected with its source line: inline
// images and links (plain or `<angle>` destinations, balanced or escaped parentheses, a title,
// whitespace and line breaks inside the parentheses), reference-style images and links through
// their `[label]: dest` definitions, nested forms (`[![badge](img)](link)`), and HTML `<img>`,
// `<a>`, `<source>`, `<video>`, `<audio>` with `src`, `href` and every `srcset` candidate, any
// attribute whitespace, tags spanning lines. Query strings and fragments are stripped from path
// checks; percent-encoding is decoded.

/**
 * @typedef {{ kind: "image" | "link", target: string, line: number, raw: string }} Embed
 */

const LIST_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])( +|\t|$)/;

/**
 * Blank everything that does not render as content, keeping newlines so line numbers survive:
 * fenced blocks (``` or ~~~, opening indentation ≤ 3
 * relative to the enclosing list item, closed by a fence of the same character at least as long,
 * or by the end of the file), indented code blocks, and inline code spans.
 *
 * Indentation is judged relative to the enclosing list item's content column (CommonMark's
 * container rule): `- item` opens a container whose content starts after the marker; a later line
 * indented at least that far belongs to the item, and it is code only when it is indented 4+
 * columns past the content column after a blank line. A line indented less closes the container.
 * So `- item`, blank, 4 spaces + text is a continuation paragraph (rendered), and `- item`, blank,
 * 8 spaces + text is code inside the item (blanked). Blank lines inside a code run belong to it.
 * HTML comments (`<!-- … -->`, across lines) are blanked last, so delimiters inside code are inert.
 * @param {string} text
 */
export function stripCode(text) {
  const lines = text.split("\n");
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  /** The content column the open indented code block is measured against, or null. @type {number | null} */
  let code = null;
  let prevBlank = true;
  /** Content columns of the open list items, innermost last. @type {number[]} */
  const containers = [];
  const out = lines.map((line) => {
    const blank = /^\s*$/.test(line);
    const indent = /** @type {RegExpMatchArray} */ (line.match(/^[ \t]*/))[0].replace(/\t/g, "    ").length;
    const trimmed = line.trimStart();
    if (fence) {
      const close = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return "";
    }
    if (code !== null) {
      if (blank || indent >= code + 4) return "";
      code = null;
    }
    if (blank) { prevBlank = true; return ""; }
    while (containers.length && indent < /** @type {number} */ (containers[containers.length - 1])) containers.pop();
    const base = containers[containers.length - 1] ?? 0;
    const rel = indent - base;
    if (rel >= 4 && prevBlank) { code = base; prevBlank = false; return ""; }
    const marker = line.match(LIST_MARKER);
    if (marker) {
      // The item's content starts after the marker and one to four spaces (more than four: one).
      const gap = marker[3].replace(/\t/g, "    ").length;
      containers.push(indent + marker[2].length + (gap === 0 || gap > 4 ? 1 : gap));
      prevBlank = false;
      return stripInlineCode(line);
    }
    const open = rel <= 3 ? trimmed.match(/^(`{3,}|~{3,})/) : null;
    if (open) { fence = { char: open[1][0], length: open[1].length }; prevBlank = false; return ""; }
    prevBlank = false;
    return stripInlineCode(line);
  });
  // Comments are blanked after code, so a `<!--` or `-->` quoted inside a code span or fence is
  // inert and cannot swallow the rendered content between them.
  return out.join("\n").replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Blank `code` spans: a run of N backticks closes at the next run of exactly N. @param {string} line */
function stripInlineCode(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") { out += line[i++]; continue; }
    let n = 0;
    while (line[i + n] === "`") n++;
    const open = i;
    let j = i + n;
    let closed = -1;
    while (j < line.length) {
      if (line[j] !== "`") { j++; continue; }
      let m = 0;
      while (line[j + m] === "`") m++;
      if (m === n) { closed = j; break; }
      j += m;
    }
    if (closed === -1) { out += line.slice(open, open + n); i = open + n; continue; }
    out += " ".repeat(closed + n - open);
    i = closed + n;
  }
  return out;
}

/**
 * Parse an inline destination starting right after `](` at `p`: optional whitespace (line breaks
 * included), `<dest>` or a bare destination with balanced or backslash-escaped parentheses, an
 * optional title, whitespace, then `)`. Returns the unescaped destination and the index after `)`.
 * @param {string} text @param {number} p
 * @returns {{ target: string, end: number } | null}
 */
function parseDestination(text, p) {
  const len = text.length;
  while (p < len && /\s/.test(text[p])) p++;
  let target;
  if (text[p] === "<") {
    const close = text.indexOf(">", p + 1);
    if (close === -1 || text.slice(p, close).includes("\n")) return null;
    target = text.slice(p + 1, close);
    p = close + 1;
  } else {
    const start = p;
    let depth = 0;
    let raw = "";
    while (p < len) {
      const c = text[p];
      if (c === "\\" && p + 1 < len) { raw += text[p + 1]; p += 2; continue; }
      if (/\s/.test(c)) break;
      if (c === "(") depth++;
      if (c === ")") { if (depth === 0) break; depth--; }
      raw += c;
      p++;
    }
    if (p === start) return null;
    target = raw;
  }
  while (p < len && /\s/.test(text[p])) p++;
  const q = text[p];
  if (q === '"' || q === "'" || q === "(") {
    const closeChar = q === "(" ? ")" : q;
    let k = p + 1;
    while (k < len && text[k] !== closeChar) k += text[k] === "\\" ? 2 : 1;
    if (k >= len) return null;
    p = k + 1;
    while (p < len && /\s/.test(text[p])) p++;
  }
  if (text[p] !== ")") return null;
  return { target, end: p + 1 };
}

/**
 * Walk `text` for Markdown images and links; `defs` resolves reference labels. Offsets are
 * absolute in the original document so `base` positions a nested label's matches.
 * @param {string} text @param {Map<string, string>} defs @param {{ kind: "image" | "link", target: string, offset: number, raw: string }[]} out @param {number} base
 */
function scanMarkdown(text, defs, out, base) {
  const len = text.length;
  let i = 0;
  while (i < len) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c !== "[") { i++; continue; }
    const image = i > 0 && text[i - 1] === "!" && !(i > 1 && text[i - 2] === "\\");
    let depth = 1;
    let j = i + 1;
    while (j < len && depth > 0) {
      if (text[j] === "\\") { j += 2; continue; }
      if (text[j] === "[") depth++;
      else if (text[j] === "]") depth--;
      j++;
    }
    if (depth > 0) { i++; continue; }
    const label = text.slice(i + 1, j - 1);
    // Any bracket inside the label can be a nested image or link (inline, reference or shortcut).
    const nested = label.includes("[");
    const kind = image ? "image" : "link";
    const start = image ? i - 1 : i;
    if (text[j] === "(") {
      const d = parseDestination(text, j + 1);
      if (d) {
        out.push({ kind, target: d.target, offset: base + start, raw: text.slice(start, d.end) });
        if (nested) scanMarkdown(label, defs, out, base + i + 1);
        i = d.end;
        continue;
      }
    }
    if (text[j] === ":") { i = j + 1; continue; } // a definition line, not a reference
    if (text[j] === "[") {
      const k = text.indexOf("]", j + 1);
      if (k !== -1 && !text.slice(j + 1, k).includes("\n")) {
        const ref = text.slice(j + 1, k).trim();
        const dest = defs.get((ref || label).trim().toLowerCase());
        if (dest !== undefined) out.push({ kind, target: dest, offset: base + start, raw: text.slice(start, k + 1) });
        if (nested) scanMarkdown(label, defs, out, base + i + 1);
        i = k + 1;
        continue;
      }
    }
    const dest = defs.get(label.trim().toLowerCase());
    if (dest !== undefined) out.push({ kind, target: dest, offset: base + start, raw: text.slice(start, j) });
    if (nested) scanMarkdown(label, defs, out, base + i + 1);
    i = j;
  }
}

/**
 * Every rendered image and link destination in a Markdown document, with its 1-based line.
 * @param {string} markdown
 * @returns {Embed[]}
 */
export function extractEmbeds(markdown) {
  const text = stripCode(markdown);
  /** @type {Map<string, string>} */
  const defs = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)/);
    if (!m) continue;
    const dest = m[2];
    defs.set(m[1].trim().toLowerCase(), dest.startsWith("<") ? dest.slice(1, dest.endsWith(">") ? -1 : undefined) : dest);
  }
  /** @type {{ kind: "image" | "link", target: string, offset: number, raw: string }[]} */
  const found = [];
  scanMarkdown(text, defs, found, 0);
  // HTML tags may span lines, so they are matched over the whole document.
  const tag = /<(img|a|source|video|audio)\b([^>]*)>/gi;
  const attr = /\b(src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (const m of text.matchAll(tag)) {
    const kind = m[1].toLowerCase() === "a" ? "link" : "image";
    for (const a of m[2].matchAll(attr)) {
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      const targets = a[1].toLowerCase() === "srcset" ? value.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean) : [value];
      for (const target of targets) found.push({ kind, target, offset: m.index ?? 0, raw: m[0] });
    }
  }
  found.sort((a, b) => a.offset - b.offset);
  return found.map((f) => ({ kind: f.kind, target: f.target, line: text.slice(0, f.offset).split("\n").length, raw: f.raw }));
}

/** A destination as a filesystem path: decoded, query and fragment removed. @param {string} target */
export function targetPath(target) {
  let t = target.split(/[?#]/)[0];
  try { t = decodeURIComponent(t); } catch { /* keep as is */ }
  return t;
}

/** True for `https://…`, `mailto:`, `raycast://` and the like. @param {string} target */
export function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

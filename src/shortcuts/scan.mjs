// Shortcut scan for `rx shortcuts check`: finds every declared shortcut in an extension's source
// and groups it with the actions it can collide with, without a TypeScript parser.
//
// WHY A TEXT SCAN. `rx` carries one runtime dependency (pngjs). ESLint's bundled parser (espree)
// cannot read TSX and no TypeScript ESLint parser is installed with it, so the CLI cannot reuse the
// ESLint rules in eslint-plugin/. This file is a comment-aware, brace-balanced text scan. The ESLint
// rules are the precise path for a repository that runs lint with a TypeScript parser.
//
// WHAT IT RESOLVES
//   shortcut={Keyboard.Shortcut.Common.X}           → the table's X (also `Shortcut.Common.X`, `Common.X`)
//   shortcut={{ modifiers: [...], key: "x" }}       → one binding, the same on every platform
//   shortcut={{ macOS: {...}, Windows: {...} }}     → one binding per platform (`windows` accepted)
//   shortcut: {...} / shortcut: Keyboard.Shortcut.Common.X   inside an object (a toast action)
// A panel is one `<ActionPanel …>…</ActionPanel>` element: everything lexically inside it, nested
// `ActionPanel.Section`s and `ActionPanel.Submenu`s included (keyboard-conventions counts submenu
// actions in the resolved panel). A toast is one `showToast(…)` / `showFailureToast(…)` /
// `Toast(…)` call: its `primaryAction` and `secondaryAction` are one group.
//
// DOCUMENTED LIMITS (each is a `kind: "unresolved"` shortcut or a `loose` group in `data`, never
// a silent pass; an unresolved shortcut still counts as "declares a shortcut")
//   - A shortcut held in a variable, a conditional, a spread or a helper's return is not resolved.
//   - A component rendered inside a panel (`<ItemActions item={x} />`) is not expanded: its own
//     actions, declared in another file or outside any `<ActionPanel>`, form a `loose` group that
//     is checked for reserved bindings but never paired for collisions.
//   - A `<ActionPanel>` built from an array `.map(...)` contributes each literal once.
//   - Only the `cond ? (<A/>) : (<B/>)` ternary form (the consequent in parentheses) marks its two
//     sides as mutually exclusive, and only when the scanner can see it runs once per panel: a
//     ternary inside any arrow or `function` body, or any `for`/`while` body, that begins inside
//     the panel (`items.map(…)`, `Array.from(items, mapper)`, a helper callback) may run once per
//     item, so the pair stands. Callbacks are not classified; every one withholds exclusivity. `cond && <A/>` beside `!cond && <B/>` is
//     paired as if both render.
//   - A props spread on an action (`<Action {...props} />`, `<ActionPanel.Submenu {...p}>`) and a
//     composed component rendered as a panel child (`<ItemActions item={x} />`) may carry shortcuts
//     the scan cannot see: each is recorded as an `unresolved` shortcut and counts as declared, so an
//     extension whose shortcuts all arrive that way still needs the runtime table.
//   - Comments are blanked by a small tokenizer that understands strings and template literals;
//     a regular-expression literal containing a quote can confuse it. `//` directly after `:` is
//     kept (a URL in JSX text).
//   - Object literals are read as JSON after quoting keys; a computed key or an expression value
//     (`key: props.key`) makes the shortcut unresolved.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PLATFORMS, readBinding } from "./table.mjs";

/**
 * @typedef {import("./table.mjs").Binding} Binding
 * @typedef {{ id: number, kind: "panel" | "toast" | "loose", file: string, line: number }} Group
 * @typedef {{
 *   file: string, line: number, group: number, title: string | null, source: string,
 *   kind: "common" | "single" | "platform" | "unresolved",
 *   name?: string,
 *   bindings: Partial<Record<"macOS" | "Windows", Binding>>,
 *   branches: string[],
 * }} Shortcut  `bindings` is filled for `single` and `platform`; `common` is resolved by the caller
 *   against the table; `unresolved` has none. `branches` names each `cond ? (…) : (…)` the site sits
 *   in, as `<ternary index>:a` or `:b`; two sites on different sides of one ternary never render
 *   together, so they are never paired (see `exclusive`).
 * @typedef {{ files: number, shortcuts: Shortcut[], groups: Group[] }} Scan
 */

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Every source file under `<root>/src` (falls back to the root when there is no `src`), skipping
 * node_modules, dot-directories, `.d.ts` and test files.
 * @param {string} root
 */
export function sourceFiles(root) {
  const base = isDir(join(root, "src")) ? join(root, "src") : root;
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && isDir(p))) walk(p);
      else if (e.isFile()) {
        const ext = e.name.slice(e.name.lastIndexOf("."));
        if (!SOURCE_EXT.has(ext) || e.name.endsWith(".d.ts") || /\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) continue;
        out.push(p);
      }
    }
  };
  if (isDir(base)) walk(base);
  return out.sort();
}

/** @param {string} p */
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Replace comments with spaces (newlines kept, so offsets and line numbers survive) while leaving
 * string and template-literal contents alone.
 * @param {string} s
 */
export function blankComments(s) {
  const out = s.split("");
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n && s[i] !== q) {
        if (s[i] === "\\") i++;
        else if (q === "`" && s[i] === "$" && s[i + 1] === "{") {
          // skip a template expression with its own nesting
          let d = 0;
          while (i < n) {
            if (s[i] === "{") d++;
            else if (s[i] === "}" && --d === 0) break;
            i++;
          }
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      let k = i - 1;
      while (k >= 0 && (s[k] === " " || s[k] === "\t")) k--;
      if (k >= 0 && s[k] === ":") { i += 2; continue; } // `https://` in JSX text
      while (i < n && s[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) if (s[i] !== "\n") out[i] = " ";
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Index of the bracket closing the one at `open`, or -1. @param {string} s @param {number} open */
export function matchBracket(s, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const close = pairs[/** @type {keyof typeof pairs} */ (s[open])];
  if (!close) return -1;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") { if (--depth === 0) return c === close ? i : -1; }
  }
  return -1;
}

/** @param {string} s @param {number} index */
function lineAt(s, index) {
  let line = 1;
  for (let i = 0; i < index && i < s.length; i++) if (s[i] === "\n") line++;
  return line;
}

/**
 * Read a shortcut object literal as data. Returns null for anything that is not a literal
 * `{ modifiers, key }` or `{ macOS, Windows }`.
 * @param {string} literal text from `{` to its matching `}`
 * @returns {{ kind: "single" | "platform", bindings: Partial<Record<"macOS" | "Windows", Binding>> } | null}
 */
export function parseShortcutLiteral(literal) {
  const json = literal
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, body) => `"${body.replace(/"/g, '\\"')}"`)
    .replace(/([{,[]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
  /** @type {any} */
  let obj;
  try { obj = JSON.parse(json); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const single = readBinding(obj);
  if (single) return { kind: "single", bindings: { macOS: single, Windows: single } };
  /** @type {Partial<Record<"macOS" | "Windows", Binding>>} */
  const bindings = {};
  for (const p of PLATFORMS) {
    const raw = obj[p] ?? (p === "Windows" ? obj.windows : undefined);
    if (raw === undefined) continue;
    const b = readBinding(raw);
    if (!b) return null;
    bindings[p] = b;
  }
  return Object.keys(bindings).length ? { kind: "platform", bindings } : null;
}

const COMMON_RE = /^(?:Keyboard\.)?(?:Shortcut\.)?Common\.([A-Z][A-Za-z]*)$/;

/**
 * @param {string} text file contents
 * @param {string} file display path
 * @param {Group[]} groups accumulates groups (ids continue across files)
 * @returns {Shortcut[]}
 */
export function scanSource(text, file, groups) {
  const s = blankComments(text);
  /** @type {{ start: number, end: number, kind: "panel" | "toast", id: number }[]} */
  const ranges = [];

  // Panels: `<ActionPanel` not followed by `.` (Section/Submenu are inside a panel, not one).
  const panelRe = /<ActionPanel(?![\w.])/g;
  for (let m; (m = panelRe.exec(s)); ) {
    const tagEnd = s.indexOf(">", m.index);
    if (tagEnd === -1) continue;
    if (s[tagEnd - 1] === "/") continue; // self-closing: no children
    let depth = 1;
    const re = /<\/ActionPanel>|<ActionPanel(?![\w.])/g;
    re.lastIndex = tagEnd;
    let end = -1;
    for (let t; (t = re.exec(s)); ) {
      if (t[0] === "</ActionPanel>") { if (--depth === 0) { end = t.index + t[0].length; break; } }
      else depth++;
    }
    if (end === -1) end = s.length;
    const id = groups.length;
    groups.push({ id, kind: "panel", file, line: lineAt(s, m.index) });
    ranges.push({ start: m.index, end, kind: "panel", id });
  }

  // Toasts: the argument list of showToast / showFailureToast / Toast(...).
  const toastRe = /\b(?:showToast|showFailureToast|Toast)\s*\(/g;
  for (let m; (m = toastRe.exec(s)); ) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(s, open);
    if (close === -1) continue;
    const id = groups.length;
    groups.push({ id, kind: "toast", file, line: lineAt(s, m.index) });
    ranges.push({ start: m.index, end: close + 1, kind: "toast", id });
  }

  // Ternary JSX branches: `cond ? (<…>) : (<…>)`. Sites on opposite sides never render together.
  /** @type {{ a: [number, number], b: [number, number] }[]} */
  const ternaries = [];
  const ternRe = /\?\s*\(\s*</g;
  for (let m; (m = ternRe.exec(s)); ) {
    const open = s.indexOf("(", m.index);
    const close = matchBracket(s, open);
    if (close === -1) continue;
    const colon = /^\s*:\s*/.exec(s.slice(close + 1));
    if (!colon) continue;
    const altStart = close + 1 + colon[0].length;
    let altEnd;
    if (s[altStart] === "(") altEnd = matchBracket(s, altStart);
    else {
      let depth = 0;
      altEnd = -1;
      for (let i = altStart; i < s.length; i++) {
        const c = s[i];
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") { if (depth === 0) { altEnd = i; break; } depth--; }
      }
    }
    if (altEnd === -1) continue;
    ternaries.push({ a: [open, close + 1], b: [altStart, altEnd + 1] });
  }
  /** Ternary sides holding `index`, skipping ternaries repeated inside the group that starts at `groupStart`. */
  const branchesFor = (/** @type {number} */ index, /** @type {number} */ groupStart) =>
    ternaries.flatMap((t, i) => {
      if (groupStart >= 0 && repeatedWithin(t.a[0], groupStart)) return [];
      return index >= t.a[0] && index < t.a[1] ? [`${i}:a`] : index >= t.b[0] && index < t.b[1] ? [`${i}:b`] : [];
    });

  // Function bodies and loop bodies that begin inside the group. A ternary inside one of them may
  // run once per item (`.map`, `Array.from(items, mapper)`, a helper callback, a `for` body), so its
  // two sides can both render into the panel. The scanner does not classify callbacks: any arrow or
  // `function` body, and any `for`/`while` body, withholds exclusivity. Exclusivity holds only
  // when the ternary sits directly in the group's own expression, which runs once per panel.
  /** @type {[number, number][]} */
  const repeats = [];
  const bodyRe = /=>|\bfunction\b|\b(?:for|while)\s*\(/g;
  for (let m; (m = bodyRe.exec(s)); ) {
    let at = m.index + m[0].length;
    if (m[0] !== "=>") {
      // `function name(params)` / `for (…)`: the body follows the parameter or head parentheses
      const open = s.indexOf("(", m[0] === "function" ? at : m.index);
      const close = open === -1 ? -1 : matchBracket(s, open);
      if (close === -1) continue;
      at = close + 1;
    }
    const ws = /^\s*/.exec(s.slice(at));
    at += ws ? ws[0].length : 0;
    let end = -1;
    if (s[at] === "{" || s[at] === "(") end = matchBracket(s, at);
    else if (m[0] === "=>") {
      // expression body: up to a `,`, `;` or closing bracket at depth 0
      let depth = 0;
      for (let i = at; i < s.length; i++) {
        const c = s[i];
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") { if (depth === 0) { end = i - 1; break; } depth--; }
        else if ((c === "," || c === ";") && depth === 0) { end = i - 1; break; }
      }
    }
    if (end !== -1) repeats.push([m.index, end + 1]);
  }
  /** Is `index` inside a repeat that starts after `from` (so the repeat is inside that group)? */
  const repeatedWithin = (/** @type {number} */ index, /** @type {number} */ from) =>
    repeats.some(([a, b]) => a > from && index >= a && index < b);

  /** @type {number | null} */
  let looseId = null;
  /** The innermost range holding `index`, or the file's loose group. @returns {{ id: number, start: number }} */
  const groupFor = (/** @type {number} */ index) => {
    let best = null;
    for (const r of ranges) {
      if (index < r.start || index >= r.end) continue;
      if (!best || r.end - r.start < best.end - best.start) best = r;
    }
    if (best) return { id: best.id, start: best.start };
    if (looseId === null) {
      looseId = groups.length;
      groups.push({ id: looseId, kind: "loose", file, line: 1 });
    }
    return { id: looseId, start: -1 };
  };

  /** @type {Shortcut[]} */
  const out = [];
  const re = /(^|[^\w.$])shortcut\s*(=|:)\s*/g;
  for (let m; (m = re.exec(s)); ) {
    const at = m.index + m[1].length;
    const valueStart = m.index + m[0].length;
    const op = m[2];
    /** @type {string} */
    let expr;
    let literalIndex = -1;
    if (op === "=") {
      if (s[valueStart] !== "{") continue; // `const shortcut = …` or a string attribute: not a shortcut prop we can read
      const close = matchBracket(s, valueStart);
      if (close === -1) continue;
      expr = s.slice(valueStart + 1, close).trim();
      if (expr.startsWith("{")) literalIndex = valueStart + 1 + s.slice(valueStart + 1, close).indexOf("{");
    } else {
      if (s[valueStart] === "{") {
        const close = matchBracket(s, valueStart);
        if (close === -1) continue;
        expr = s.slice(valueStart, close + 1);
        literalIndex = valueStart;
      } else {
        const stop = s.slice(valueStart).search(/[,;)}\n]/);
        expr = s.slice(valueStart, stop === -1 ? s.length : valueStart + stop).trim();
        if (/^Keyboard\.Shortcut(?!\.Common\.)/.test(expr) || expr === "" || /^\w+\s*\|/.test(expr)) continue; // a type annotation
      }
    }
    const line = lineAt(s, at);
    const { id: group, start } = groupFor(at);
    const title = op === "=" ? jsxTitle(s, at) : objectTitle(s, at);
    /** @type {Shortcut} */
    const sc = { file, line, group, title, source: expr.replace(/\s+/g, " ").slice(0, 120), kind: "unresolved", bindings: {}, branches: branchesFor(at, start) };
    const common = COMMON_RE.exec(expr);
    if (common) { sc.kind = "common"; sc.name = common[1]; }
    else if (literalIndex !== -1) {
      const lit = parseShortcutLiteral(expr.startsWith("{") ? expr : s.slice(literalIndex, matchBracket(s, literalIndex) + 1));
      if (lit) { sc.kind = lit.kind; sc.bindings = lit.bindings; }
    }
    out.push(sc);
  }

  // Props spreads on actions, and composed components rendered as panel children: shortcuts the
  // scan cannot see. Each is one unresolved, declared shortcut.
  const tagRe = /<([A-Z][\w.]*)\b/g;
  for (let m; (m = tagRe.exec(s)); ) {
    const name = m[1];
    const end = tagEnd(s, m.index);
    if (end === -1) continue;
    const tag = s.slice(m.index, end + 1);
    const actionLike = name === "Action" || name.startsWith("Action.") || name === "ActionPanel.Submenu";
    const panelPart = name === "ActionPanel" || name.startsWith("ActionPanel.") || name === "Fragment" || name.endsWith(".Fragment");
    if (actionLike) {
      if (!/\{\s*\.\.\./.test(tag)) continue;
    } else {
      if (panelPart) continue;
      const { id } = groupFor(m.index);
      if (groups[id].kind !== "panel" || insideOpeningTag(s, m.index)) continue; // a prop value such as target={<View/>}
    }
    const { id: group, start } = groupFor(m.index);
    out.push({
      file,
      line: lineAt(s, m.index),
      group,
      title: readTitle(tag, /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\})/),
      source: tag.replace(/\s+/g, " ").slice(0, 120),
      kind: "unresolved",
      bindings: {},
      branches: branchesFor(m.index, start),
    });
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

/** Index of the `>` closing the opening tag that starts at `start` (brace-aware), or -1. @param {string} s @param {number} start */
function tagEnd(s, start) {
  let depth = 0;
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (c === "{") { const close = matchBracket(s, i); if (close === -1) return -1; i = close; continue; }
    if (c === ">" && depth === 0) return i;
  }
  return -1;
}

/** Is `index` inside another element's opening tag (so it is a prop value, not a child)? @param {string} s @param {number} index */
function insideOpeningTag(s, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (s[i] !== "<" || !/[A-Za-z]/.test(s[i + 1] ?? "")) continue;
    let depth = 0;
    let left = false;
    for (const c of s.slice(i, index)) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) { left = true; break; }
    }
    if (!left) return true;
    if (depth <= 0) return false; // that tag closed at depth 0 before us: we are a sibling or child, not a prop
  }
  return false;
}

/**
 * Do two sites of one file sit on opposite sides of the same ternary? Then they never render
 * together and cannot collide.
 * @param {Shortcut} x @param {Shortcut} y
 */
export function exclusive(x, y) {
  if (x.file !== y.file) return false;
  for (const bx of x.branches) {
    const [t, side] = bx.split(":");
    if (y.branches.includes(`${t}:${side === "a" ? "b" : "a"}`)) return true;
  }
  return false;
}

/**
 * The `title` of the JSX opening tag that contains `index`, or null. Candidates are tried from the
 * nearest `<Name` backward; one whose text up to `index` has a `>` at brace depth 0 is a tag we have
 * already left (or an element nested in a prop), so the search continues outward.
 * @param {string} s @param {number} index
 */
function jsxTitle(s, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (s[i] !== "<" || !/[A-Za-z]/.test(s[i + 1] ?? "")) continue;
    const head = s.slice(i, index);
    let depth = 0;
    let left = false;
    for (const c of head) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) { left = true; break; }
    }
    if (left) continue;
    const end = s.indexOf(">", index);
    const tag = s.slice(i, end === -1 ? s.length : end);
    return readTitle(tag, /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\})/);
  }
  return null;
}

/** The `title:` inside the object literal that contains `index`, or null. @param {string} s @param {number} index */
function objectTitle(s, index) {
  let depth = 0;
  let start = -1;
  for (let i = index - 1; i >= 0; i--) {
    const c = s[i];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start === -1) return null;
  const end = matchBracket(s, start);
  const body = s.slice(start, end === -1 ? s.length : end + 1);
  return readTitle(body, /\btitle\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)/);
}

/** @param {string} text @param {RegExp} re */
function readTitle(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  return m.slice(1).find((g) => g !== undefined) ?? null;
}

/**
 * Scan every source file of an extension.
 * @param {string} root
 * @returns {Scan}
 */
export function scanExtension(root) {
  /** @type {Group[]} */
  const groups = [];
  /** @type {Shortcut[]} */
  const shortcuts = [];
  const files = sourceFiles(root);
  for (const f of files) shortcuts.push(...scanSource(readFileSync(f, "utf8"), relative(root, f), groups));
  return { files: files.length, shortcuts, groups };
}

/**
 * The platforms an extension targets. Absent `platforms` means macOS only: the field postdates
 * Windows support, so an extension without it has no Windows leg (keyboard-conventions).
 * @param {string} root
 * @returns {("macOS" | "Windows")[]}
 */
export function declaredPlatforms(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (Array.isArray(pkg.platforms)) {
      const list = PLATFORMS.filter((p) => pkg.platforms.includes(p));
      if (list.length) return list;
    }
  } catch { /* unreadable manifest: the root rule already required one; default below */ }
  return ["macOS"];
}

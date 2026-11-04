// AST helpers shared by the shortcut rules: read a literal shortcut object, know which modifiers
// Raycast calls ambiguous, find the platforms an extension declares, and load a runtime table.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { AMBIGUOUS_MODIFIERS, PLATFORMS, loadTable, normalizeBinding, readBinding } from "../../src/shortcuts/table.mjs";

export { AMBIGUOUS_MODIFIERS, PLATFORMS };

/**
 * @typedef {import("../../src/shortcuts/table.mjs").Binding} Binding
 * @typedef {{ kind: "single" | "platform", bindings: Partial<Record<"macOS" | "Windows", Binding>>, lowercaseWindows: boolean }} ShortcutValue
 */

/**
 * Static value of an ObjectExpression, or undefined when any part is not a literal.
 * @param {any} node
 * @returns {unknown}
 */
export function staticValue(node) {
  if (!node) return undefined;
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined;
    case "ArrayExpression": {
      const out = [];
      for (const el of node.elements) {
        const v = staticValue(el);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    case "ObjectExpression": {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const p of node.properties) {
        if (p.type !== "Property" || p.computed) return undefined;
        const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : undefined;
        if (key === undefined) return undefined;
        const v = staticValue(p.value);
        if (v === undefined) return undefined;
        out[key] = v;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * Read `{ modifiers, key }` or `{ macOS, Windows }` from an ObjectExpression.
 * @param {any} node
 * @returns {ShortcutValue | null}
 */
export function readShortcutObject(node) {
  if (!node || node.type !== "ObjectExpression") return null;
  const v = /** @type {any} */ (staticValue(node));
  if (!v || typeof v !== "object") return null;
  const single = readBinding(v);
  if (single) return { kind: "single", bindings: { macOS: single, Windows: single }, lowercaseWindows: false };
  /** @type {ShortcutValue["bindings"]} */
  const bindings = {};
  let lowercaseWindows = false;
  for (const p of PLATFORMS) {
    let raw = v[p];
    if (raw === undefined && p === "Windows" && v.windows !== undefined) { raw = v.windows; lowercaseWindows = true; }
    if (raw === undefined) continue;
    const b = readBinding(raw);
    if (!b) return null;
    bindings[p] = b;
  }
  return Object.keys(bindings).length ? { kind: "platform", bindings, lowercaseWindows } : null;
}

/** @param {Binding} b */
export function isAmbiguous(b) {
  return b.modifiers.some((m) => AMBIGUOUS_MODIFIERS.has(m));
}

/**
 * Is this node the value of a `shortcut` JSX attribute or a `shortcut:` object property?
 * @param {any} node an ObjectExpression
 */
export function isShortcutValue(node) {
  const p = node.parent;
  if (!p) return false;
  if (p.type === "JSXExpressionContainer" && p.parent?.type === "JSXAttribute" && p.parent.name?.name === "shortcut") return true;
  if (p.type === "Property" && !p.computed && p.key?.type === "Identifier" && p.key.name === "shortcut" && p.value === node) return true;
  return false;
}

/**
 * The platforms to audit: the rule option, else `platforms` in the nearest package.json walking up
 * from the linted file (so a monorepo extension reads its own manifest), else macOS only.
 * @param {{ platforms?: string[] } | undefined} options @param {string} from a file or directory to start from
 * @returns {("macOS" | "Windows")[]}
 */
export function platformsFor(options, from) {
  const pick = (/** @type {unknown} */ list) => (Array.isArray(list) ? PLATFORMS.filter((p) => list.includes(p)) : []);
  const fromOption = pick(options?.platforms);
  if (fromOption.length) return fromOption;
  let dir = existsSync(from) && statSync(from).isDirectory() ? from : dirname(from);
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      try {
        const fromPkg = pick(JSON.parse(readFileSync(file, "utf8")).platforms);
        return fromPkg.length ? fromPkg : ["macOS"];
      } catch { return ["macOS"]; }
    }
    const parent = dirname(dir);
    if (parent === dir) return ["macOS"];
    dir = parent;
  }
}

/** @type {Map<string, import("../../src/shortcuts/table.mjs").ShortcutTable>} */
const tables = new Map();
/**
 * Load (once per path) the table a rule's `table` option names; relative to cwd.
 * @param {string | undefined} path @param {string} cwd
 */
export function tableFor(path, cwd) {
  if (!path) return null;
  const abs = path.startsWith("/") ? path : join(cwd, path);
  let t = tables.get(abs);
  if (!t) { t = loadTable(abs); tables.set(abs, t); }
  return t;
}

/**
 * Which Common constant a single-form literal spells out, on which platform, per the table.
 * @param {Binding} b @param {import("../../src/shortcuts/table.mjs").ShortcutTable} table
 * @returns {{ name: string, platform: "macOS" | "Windows" }[]}
 */
export function commonMatches(b, table) {
  const n = normalizeBinding(b);
  const out = [];
  for (const [name, entry] of Object.entries(table.shortcuts))
    for (const platform of PLATFORMS) if (normalizeBinding(entry[platform]) === n) out.push({ name, platform });
  return out;
}

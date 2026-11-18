// The runtime `Keyboard.Shortcut.Common` table: where it comes from, how it is identified, and
// how two shortcuts are compared against it.
//
// Source of truth is the API shim the installed Raycast app loads, not the npm `@raycast/api`
// package (types only, no index.js) and not `@raycast/eslint-plugin`'s COMMON_SHORTCUTS (which
// disagreed with the app on five constants at 2.2.0). The extraction here is the one the plugin's
// keyboard-conventions reference used by hand: find `<ident>.Common={`, take the balanced object,
// make it JSON. The minified identifier changes between app builds, so it is never pinned.
//
// A table is identified by `shimFingerprint`, the SHA-256 of the shim file; a cached table is only
// used for the app whose shim produced it. Nothing here claims a bundled table matches any runtime:
// there is no bundled table.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RxError } from "../errors.mjs";

/** @typedef {{ modifiers: string[], key: string }} Binding */
/** @typedef {{ macOS: Binding, Windows: Binding }} CommonEntry */
/** @typedef {{ appVersion: string | null, shimFingerprint: string, shortcuts: Record<string, CommonEntry> }} ShortcutTable */

/** Where Raycast.app is looked for, in order, when no `--app` is given. */
export const APP_CANDIDATES = () => ["/Applications/Raycast.app", join(homedir(), "Applications", "Raycast.app")];
/** @param {string} app path of Raycast.app */
export const shimPathFor = (app) => join(app, "Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources/api/node_modules/@raycast/api/index.js");
/** @param {string} app */
export const plistPathFor = (app) => join(app, "Contents", "Info.plist");
/** The first candidate whose shim exists, or null. */
export function discoverApp() {
  return APP_CANDIDATES().find((app) => existsSync(shimPathFor(app))) ?? null;
}

export const MODIFIERS = new Set(["cmd", "ctrl", "opt", "alt", "shift", "windows"]);
/** Raycast's own term: a single-form shortcut carrying one of these needs both platforms spelled out. */
export const AMBIGUOUS_MODIFIERS = new Set(["cmd", "ctrl", "windows"]);
export const PLATFORMS = /** @type {const} */ (["macOS", "Windows"]);

/**
 * Bindings the panel assigns itself, by the view that hosts it. developers.raycast.com/api-reference/user-interface/action-panel
 * (and the `ActionPanel` doc comment in `@raycast/api`'s types): the first and second action get `↵` and
 * `⌘↵` in a List, Grid or Detail, and `⌘↵` and `⌘⇧↵` in a Form. A shortcut prop that spells out a default
 * of the panel's own view either is that default or collides with it. Raycast lists both `return` and
 * `enter` as key equivalents, so both spellings are reserved.
 */
export const RESERVED = Object.freeze(
  ["return", "enter"].flatMap((key) => [
    { modifiers: [], key, why: { list: "the primary action's default in a List, Grid or Detail" } },
    { modifiers: ["cmd"], key, why: { list: "the secondary action's default in a List, Grid or Detail", form: "the primary action's default in a Form" } },
    { modifiers: ["cmd", "shift"], key, why: { form: "the secondary action's default in a Form" } },
  ]),
);

/** Elements whose `actions` prop takes the panel, by the defaults their view assigns. */
const LIST_HOSTS = new Set(["List", "List.Item", "List.EmptyView", "Grid", "Grid.Item", "Grid.EmptyView", "Detail"]);

/** @param {string | null} host @returns {"list" | "form" | null} */
const viewOf = (host) => (host === "Form" ? "form" : host && LIST_HOSTS.has(host) ? "list" : null);

/** @param {string} shimPath */
export function fingerprintShim(shimPath) {
  return createHash("sha256").update(readFileSync(shimPath)).digest("hex");
}

/**
 * Extract the `Common` table from a shim's source text.
 * @param {string} source
 * @returns {Record<string, CommonEntry>}
 */
export function extractCommonTable(source) {
  const m = /\b\w+\.Common=\{/.exec(source);
  if (!m) throw new RxError("shim has no `<ident>.Common={` table; the extraction needs updating for this Raycast build", { id: "shortcut-runtime-table" });
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let j = start; j < source.length; j++) {
    const c = source[j];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { end = j; break; }
  }
  if (end === -1) throw new RxError("shim `Common` table is not brace-balanced", { id: "shortcut-runtime-table" });
  const literal = source.slice(start, end + 1);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(literal.replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'));
  } catch (e) {
    throw new RxError(`shim \`Common\` table is not JSON after quoting keys: ${/** @type {Error} */ (e).message}`, { id: "shortcut-runtime-table" });
  }
  return validateTable(parsed, "shim");
}

/**
 * Check the shape `{ Name: { macOS: { modifiers, key }, Windows: { modifiers, key } } }`.
 * @param {unknown} obj @param {string} what
 * @returns {Record<string, CommonEntry>}
 */
export function validateTable(obj, what) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new RxError(`${what}: shortcuts table is not an object`, { id: "shortcut-runtime-table" });
  /** @type {Record<string, CommonEntry>} */
  const out = {};
  for (const [name, entry] of Object.entries(/** @type {Record<string, unknown>} */ (obj))) {
    if (!/^[A-Z][A-Za-z]*$/.test(name)) throw new RxError(`${what}: ${JSON.stringify(name)} is not a Common constant name`, { id: "shortcut-runtime-table" });
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (!e || typeof e !== "object") throw new RxError(`${what}: Common.${name} is not an object`, { id: "shortcut-runtime-table" });
    /** @type {Partial<CommonEntry>} */
    const clean = {};
    for (const p of PLATFORMS) {
      const b = readBinding(e[p]);
      if (!b) throw new RxError(`${what}: Common.${name}.${p} is not { modifiers: string[], key: string }`, { id: "shortcut-runtime-table" });
      clean[p] = b;
    }
    out[name] = /** @type {CommonEntry} */ (clean);
  }
  if (Object.keys(out).length === 0) throw new RxError(`${what}: shortcuts table is empty`, { id: "shortcut-runtime-table" });
  return out;
}

/** @param {unknown} v @returns {Binding | null} */
export function readBinding(v) {
  if (!v || typeof v !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  if (typeof o.key !== "string" || !o.key) return null;
  if (!Array.isArray(o.modifiers) || !o.modifiers.every((m) => typeof m === "string" && MODIFIERS.has(m))) return null;
  return { modifiers: /** @type {string[]} */ (o.modifiers.slice()), key: o.key };
}

/**
 * Read a saved table file (`rx shortcuts runtime` output or `--table`).
 * @param {string} file
 * @returns {ShortcutTable}
 */
export function loadTable(file) {
  if (!existsSync(file)) throw new RxError(`shortcuts table ${file} does not exist`, { id: "shortcut-runtime-table" });
  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new RxError(`shortcuts table ${file} is not JSON: ${/** @type {Error} */ (e).message}`, { id: "shortcut-runtime-table" });
  }
  if (!doc || typeof doc !== "object" || typeof doc.shimFingerprint !== "string" || !doc.shimFingerprint)
    throw new RxError(`shortcuts table ${file} lacks shimFingerprint; write it with \`rx shortcuts runtime\``, { id: "shortcut-runtime-table" });
  return {
    appVersion: typeof doc.appVersion === "string" ? doc.appVersion : null,
    shimFingerprint: doc.shimFingerprint,
    shortcuts: validateTable(doc.shortcuts, file),
  };
}

/**
 * Canonical form for comparing two bindings: `opt` and `alt` are the same key under two names
 * (Raycast's KeyModifier note), modifier order is irrelevant, keys are case-insensitive.
 * @param {Binding} b
 */
export function normalizeBinding(b) {
  const mods = [...new Set(b.modifiers.map((m) => (m === "alt" ? "opt" : m)))].sort();
  return `${mods.join("+")}${mods.length ? "+" : ""}${b.key.toLowerCase()}`;
}

/** Human form: `⌘⇧C` on macOS, `ctrl+shift+c` elsewhere. @param {Binding} b @param {"macOS" | "Windows"} platform */
export function formatBinding(b, platform) {
  if (platform !== "macOS") return [...b.modifiers, b.key].join("+");
  const glyph = { cmd: "⌘", ctrl: "⌃", opt: "⌥", alt: "⌥", shift: "⇧", windows: "⊞" };
  const keyGlyph = { arrowUp: "↑", arrowDown: "↓", arrowLeft: "←", arrowRight: "→", return: "↵", enter: "⌤", space: "␣", escape: "⎋", tab: "⇥", backspace: "⌫", delete: "⌦" };
  return b.modifiers.map((m) => glyph[/** @type {keyof typeof glyph} */ (m)] ?? m).join("") + (keyGlyph[/** @type {keyof typeof keyGlyph} */ (b.key)] ?? b.key.toUpperCase());
}

/**
 * The default `b` spells out on a panel hosted by `host` (an element name such as `Form` or
 * `List.Item`, or null when the scan could not see it). `certain` is false when the binding is a
 * default only in some views and the host is unknown: the caller WARNs instead of FAILing.
 * @param {Binding} b @param {string | null} host
 * @returns {{ why: string, certain: boolean } | null}
 */
export function reservedMatch(b, host) {
  const n = normalizeBinding(b);
  const entry = RESERVED.find((r) => normalizeBinding(r) === n);
  if (!entry) return null;
  const why = /** @type {Partial<Record<"list" | "form", string>>} */ (entry.why);
  const view = viewOf(host);
  if (view) return why[view] ? { why: why[view], certain: true } : null;
  const all = /** @type {string[]} */ (Object.values(why));
  return { why: all.join(" and "), certain: all.length === 2 };
}

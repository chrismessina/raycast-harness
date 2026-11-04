// Load and validate a preset file (schema/preset.schema.json), resolve its anchors, and index its
// rx bindings by check id for the preset-aware commands.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RxError } from "../errors.mjs";
import { validate } from "./schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, "..", "..", "schema", "preset.schema.json");

/**
 * @typedef {{ kind: "rx" | "eslint" | "judgment", check: string, coverage: "full" | "partial", options?: Record<string, any> }} Binding
 * @typedef {{ id: string, title: string, anchor: string, tag: "build" | "verify" | "both" | "lint", applies: any, severity: "block" | "report", bindings: Binding[] }} Rule
 * @typedef {{
 *   schema: 1, owner: string, rules: Rule[], judgments?: { id: string, question?: string }[],
 *   dependencies?: { api: { "existing-1x": { floor: string }, "2x": { floor: string }, new: "2x" } },
 *   holdout?: { localOnly: string[] }, ship?: { keep: { path: string, extensions: string[], reason: string }[] },
 * }} Preset
 * @typedef {{ path: string, preset: Preset, rxBindings: Map<string, { rule: Rule, binding: Binding }[]> }} LoadedPreset
 */

/** @returns {any} */
export function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

/**
 * Read and schema-validate a preset. Throws RxError (ERROR input) on an unreadable or invalid
 * file; `rx preset check` reports the same errors as a FAIL instead through `validatePreset`.
 * @param {string} file
 * @param {string} [cwd]
 * @returns {LoadedPreset}
 */
export function loadPreset(file, cwd = process.cwd()) {
  const path = resolve(cwd, file);
  const { preset, errors } = readPreset(path);
  if (errors.length) throw new RxError(`preset ${file} is invalid:\n${errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`, { id: "input" });
  return index(path, /** @type {Preset} */ (preset));
}

/**
 * Read a preset without throwing on schema errors. An unreadable file still throws.
 * @param {string} path absolute
 * @returns {{ preset: unknown, errors: { path: string, message: string }[] }}
 */
export function readPreset(path) {
  if (!existsSync(path)) throw new RxError(`preset ${path} does not exist`, { id: "input" });
  let preset;
  try {
    preset = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RxError(`preset ${path} is not valid JSON: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  return { preset, errors: validate(preset, loadSchema()) };
}

/** @param {string} path @param {Preset} preset @returns {LoadedPreset} */
export function index(path, preset) {
  /** @type {Map<string, { rule: Rule, binding: Binding }[]>} */
  const rxBindings = new Map();
  for (const rule of preset.rules)
    for (const binding of rule.bindings)
      if (binding.kind === "rx") {
        const list = rxBindings.get(binding.check) ?? [];
        list.push({ rule, binding });
        rxBindings.set(binding.check, list);
      }
  return { path, preset, rxBindings };
}

/**
 * Where an anchor points: the file (resolved from the preset's directory) and the 1-based line of
 * the section it names, or null when it does not resolve. The fragment resolves, in order, to a
 * `**ID:** `<fragment>`` marker (the section is that marker's nearest preceding heading), a table
 * row `| `<fragment>` |`, or a heading whose slug equals the fragment.
 * @param {string} anchor
 * @param {string} presetPath absolute path of the preset file
 * @param {Map<string, string[] | null>} [cache] file → lines
 * @returns {{ file: string, line: number | null, exists: boolean }}
 */
export function resolveAnchor(anchor, presetPath, cache = new Map()) {
  const hash = anchor.indexOf("#");
  const relFile = anchor.slice(0, hash);
  const fragment = anchor.slice(hash + 1);
  const file = resolve(dirname(presetPath), relFile);
  if (!cache.has(file)) cache.set(file, existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : null);
  const lines = cache.get(file);
  if (!lines) return { file, line: null, exists: false };
  const marker = new RegExp(`\\*\\*ID:\\*\\*\\s*\`${escapeRe(fragment)}\``);
  const row = new RegExp(`^\\|\\s*\`${escapeRe(fragment)}\`\\s*\\|`);
  for (let i = 0; i < lines.length; i++) {
    if (marker.test(lines[i])) {
      for (let j = i; j >= 0; j--) if (/^#{1,6}\s/.test(lines[j])) return { file, line: j + 1, exists: true };
      return { file, line: i + 1, exists: true };
    }
  }
  for (let i = 0; i < lines.length; i++) if (row.test(lines[i])) return { file, line: i + 1, exists: true };
  for (let i = 0; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i]) && slug(lines[i]) === fragment) return { file, line: i + 1, exists: true };
  return { file, line: null, exists: true };
}

/** @param {string} s */
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** GitHub-style heading slug. @param {string} heading */
export function slug(heading) {
  return heading.replace(/^#{1,6}\s+/, "").toLowerCase().replace(/[`*_]/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

// The `--entries` file `rx audit record` reads (docs/commands.md §4.9). One JSON array; each item
// is one of three shapes, told apart by its keys:
//
//   rule entry     { id, scope, result: "pass" | "fail" | "n-a", evidence }
//                  `id` is a preset rule id, or `greptile/<rule id>` for a Greptile judgment rule
//   disposition    { path, localHash, baseline, disposition: "keep-local" | "adopt-published", reason }
//                  for a stale CHECK / NEW? path or a png OLDER-SHOT image (plan-review-2 F9)
//   verification   { verification: "writes-files" | "web-requests" | "calls-ai", result, evidence }
//                  destination / runtime proof for an external effect the extension has
//
// Validation here is about shape only: a malformed file is ERROR input before any verdict. What
// the entries must cover is decided in src/commands/audit.mjs.

import { readFileSync } from "node:fs";
import { RxError } from "../errors.mjs";

export const RESULTS = /** @type {const} */ (["pass", "fail", "n-a"]);
export const DISPOSITIONS = /** @type {const} */ (["keep-local", "adopt-published"]);
export const EFFECTS = /** @type {const} */ (["writes-files", "web-requests", "calls-ai"]);

/**
 * @typedef {{ id: string, scope: string, result: "pass" | "fail" | "n-a", evidence: string }} RuleEntry
 * @typedef {{ path: string, localHash: string, baseline: string, disposition: "keep-local" | "adopt-published", reason: string }} Disposition
 * @typedef {{ verification: "writes-files" | "web-requests" | "calls-ai", result: "pass" | "fail" | "n-a", evidence: string }} Verification
 * @typedef {{ entries: RuleEntry[], dispositions: Disposition[], verifications: Verification[] }} EntriesFile
 */

/** @param {unknown} v */
const str = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * @param {string} file absolute path
 * @returns {EntriesFile}
 */
export function readEntries(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new RxError(`--entries ${file}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  return parseEntries(raw, file);
}

/**
 * @param {unknown} raw
 * @param {string} [where] for messages
 * @returns {EntriesFile}
 */
export function parseEntries(raw, where = "--entries") {
  if (!Array.isArray(raw)) throw new RxError(`${where}: expected a JSON array of entries`, { id: "input" });
  /** @type {EntriesFile} */
  const out = { entries: [], dispositions: [], verifications: [] };
  /** @type {string[]} */
  const problems = [];
  raw.forEach((item, i) => {
    const at = `${where}[${i}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) { problems.push(`${at}: not an object`); return; }
    const o = /** @type {Record<string, unknown>} */ (item);
    if ("disposition" in o || "path" in o) {
      const keys = ["path", "localHash", "baseline", "disposition", "reason"];
      for (const k of keys) if (!str(o[k])) problems.push(`${at}: disposition needs a non-empty "${k}"`);
      if (str(o.disposition) && !DISPOSITIONS.includes(/** @type {any} */ (o.disposition))) problems.push(`${at}: disposition must be one of ${DISPOSITIONS.join(", ")}`);
      for (const k of Object.keys(o)) if (!keys.includes(k)) problems.push(`${at}: unknown key "${k}"`);
      if (!problems.some((p) => p.startsWith(at))) out.dispositions.push(/** @type {Disposition} */ (o));
      return;
    }
    if ("verification" in o) {
      const keys = ["verification", "result", "evidence"];
      for (const k of keys) if (!str(o[k])) problems.push(`${at}: verification needs a non-empty "${k}"`);
      if (str(o.verification) && !EFFECTS.includes(/** @type {any} */ (o.verification))) problems.push(`${at}: verification must be one of ${EFFECTS.join(", ")}`);
      if (str(o.result) && !RESULTS.includes(/** @type {any} */ (o.result))) problems.push(`${at}: result must be one of ${RESULTS.join(", ")}`);
      for (const k of Object.keys(o)) if (!keys.includes(k)) problems.push(`${at}: unknown key "${k}"`);
      if (!problems.some((p) => p.startsWith(at))) out.verifications.push(/** @type {Verification} */ (o));
      return;
    }
    const keys = ["id", "scope", "result", "evidence"];
    for (const k of keys) if (!str(o[k])) problems.push(`${at}: entry needs a non-empty "${k}"`);
    if (str(o.result) && !RESULTS.includes(/** @type {any} */ (o.result))) problems.push(`${at}: result must be one of ${RESULTS.join(", ")}`);
    for (const k of Object.keys(o)) if (!keys.includes(k)) problems.push(`${at}: unknown key "${k}"`);
    if (!problems.some((p) => p.startsWith(at))) out.entries.push(/** @type {RuleEntry} */ (o));
  });
  if (problems.length) throw new RxError(`${where} is malformed:\n${problems.join("\n")}`, { id: "input" });
  const seen = new Set();
  for (const e of out.entries) {
    if (seen.has(e.id)) throw new RxError(`${where}: rule ${JSON.stringify(e.id)} appears twice`, { id: "input" });
    seen.add(e.id);
  }
  // Duplicates are never last-wins (a `fail` then a `pass` for the same thing would erase the fail).
  const seenKeys = new Set();
  for (const d of out.dispositions) {
    const k = dispositionKey(d);
    if (seenKeys.has(k)) throw new RxError(`${where}: disposition for ${JSON.stringify(d.path)} (localHash ${d.localHash}, baseline ${d.baseline}) appears twice`, { id: "input" });
    seenKeys.add(k);
  }
  const seenEffects = new Set();
  for (const v of out.verifications) {
    if (seenEffects.has(v.verification)) throw new RxError(`${where}: verification ${JSON.stringify(v.verification)} appears twice`, { id: "input" });
    seenEffects.add(v.verification);
  }
  return out;
}

/** The disposition key the stale and png rows carry. @param {{ path: string, localHash: string, baseline: string }} k */
export function dispositionKey(k) {
  return `${k.path}\u0000${k.localHash}\u0000${k.baseline}`;
}

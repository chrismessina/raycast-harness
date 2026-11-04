// The audit decision, computed from its parts (docs/commands.md §4.9; Codex Wave 3 review P1 #4).
// `rx audit record` uses this to fill `blocking` / `reportOnly`, and `rx guard` RECOMPUTES the same
// decision from the stored entries, dispositions, verifications and evidence instead of trusting
// the stored `blocking` list, so a hand-written audit.json authorizes nothing.

import { evaluate, render } from "../preset/applies.mjs";
import { dispositionKey } from "./entries.mjs";
import { GREPTILE_PREFIX, greptileJudgmentRules } from "./greptile.mjs";

/**
 * @typedef {{ id: string, severity: "block" | "report", why: string }} Applicable
 * @typedef {{ path: string, localHash: string, baseline: string, kind: string }} RequiredDisposition
 * @typedef {("writes-files" | "web-requests" | "calls-ai")} Effect
 */

/**
 * The rules an audit must cover for this extension: every non-build preset rule whose
 * applicability is true or unknown (an unknown still needs an answer), plus every Greptile
 * judgment rule.
 * @param {import("../preset/load.mjs").LoadedPreset} loaded
 * @param {import("../preset/applies.mjs").ApplyContext} applyCtx
 * @returns {Applicable[]}
 */
export function applicableRules(loaded, applyCtx) {
  /** @type {Applicable[]} */
  const out = [];
  for (const rule of loaded.preset.rules) {
    if (rule.tag === "build") continue;
    const applied = evaluate(rule.applies, applyCtx);
    if (applied.value === false) continue;
    out.push({ id: rule.id, severity: rule.severity, why: applied.value === true ? render(rule.applies) : `${applied.reason} (decide and record)` });
  }
  for (const g of greptileJudgmentRules()) out.push({ id: g.entryId, severity: g.severity, why: "Greptile judgment rule" });
  return out;
}

/** Every id an entries file may name for this preset. @param {import("../preset/load.mjs").LoadedPreset} loaded */
export function knownRuleIds(loaded) {
  return new Set([...loaded.preset.rules.map((r) => r.id), ...greptileJudgmentRules().map((g) => g.entryId)]);
}

/** The external effects the applicability context detects. @param {import("../preset/applies.mjs").ApplyContext} applyCtx @returns {Effect[]} */
export function effectsOf(applyCtx) {
  /** @type {Effect[]} */
  const out = [];
  if (applyCtx.writesFiles) out.push("writes-files");
  if (applyCtx.webRequests) out.push("web-requests");
  if (applyCtx.callsAI) out.push("calls-ai");
  return out;
}

/**
 * The stale CHECK / NEW? rows of a receipt's recorded stale data, as required dispositions.
 * @param {any} staleData receipt.data.stale
 * @returns {RequiredDisposition[]}
 */
export function staleDispositions(staleData) {
  /** @type {RequiredDisposition[]} */
  const out = [];
  if (!staleData || typeof staleData.baseline !== "string") return out;
  for (const f of Array.isArray(staleData.files) ? staleData.files : []) {
    if ((f?.class === "CHECK" || f?.class === "NEW?") && typeof f.path === "string" && typeof f.localHash === "string") out.push({ path: f.path, localHash: f.localHash, baseline: staleData.baseline, kind: f.class });
  }
  return out;
}

/**
 * The png OLDER-SHOT rows of a `rx png` data.files[], as required dispositions.
 * @param {any[]} files
 * @returns {RequiredDisposition[]}
 */
export function pngDispositions(files) {
  /** @type {RequiredDisposition[]} */
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (f?.outcome === "OLDER-SHOT" && typeof f.path === "string" && typeof f.localHash === "string" && typeof f.baseline === "string") out.push({ path: f.path, localHash: f.localHash, baseline: f.baseline, kind: "OLDER-SHOT" });
  }
  return out;
}

/**
 * The decision. Pure.
 * @param {{
 *   applicable: Applicable[],
 *   entries: import("./entries.mjs").RuleEntry[],
 *   dispositions: import("./entries.mjs").Disposition[],
 *   verifications: import("./entries.mjs").Verification[],
 *   required: RequiredDisposition[],
 *   effects: Effect[],
 *   evidence: { shortcuts: import("../verdict.mjs").Result[], png: import("../verdict.mjs").Result[] },
 * }} p
 * @returns {{
 *   blocking: string[], reportOnly: string[],
 *   missing: Applicable[], failed: { rule: Applicable, entry: import("./entries.mjs").RuleEntry }[],
 *   unresolved: RequiredDisposition[], unmatched: import("./entries.mjs").Disposition[],
 *   missingEffects: Effect[], failedEffects: Effect[], strayEffects: string[],
 * }}
 */
export function decide({ applicable, entries, dispositions, verifications, required, effects, evidence }) {
  /** @type {string[]} */
  const blocking = [];
  /** @type {string[]} */
  const reportOnly = [];
  const byId = new Map(entries.map((e) => [e.id, e]));

  const missing = applicable.filter((a) => !byId.has(a.id));
  if (missing.length) blocking.push(`coverage: ${missing.map((m) => m.id).join(", ")}`);

  /** @type {{ rule: Applicable, entry: import("./entries.mjs").RuleEntry }[]} */
  const failed = [];
  for (const a of applicable) {
    const e = byId.get(a.id);
    if (!e || e.result !== "fail") continue;
    failed.push({ rule: a, entry: e });
    if (a.severity === "block") blocking.push(`${a.id}: fail`);
    else reportOnly.push(a.id);
  }

  // Embedded evidence: an ERROR or FAIL blocks; empty evidence is itself a reason (the check did
  // not run), so an audit without it never authorizes.
  if (!evidence.shortcuts.length) blocking.push("shortcut evidence missing");
  for (const r of evidence.shortcuts) if (r.verdict === "FAIL" || r.verdict === "ERROR") blocking.push(`${r.id}: ${r.verdict}`);
  if (!evidence.png.length) blocking.push("png evidence missing");
  for (const r of evidence.png) if (r.verdict === "FAIL" || r.verdict === "ERROR") blocking.push(`png: ${r.message}`);

  const given = new Map(dispositions.map((d) => [dispositionKey(d), d]));
  const unresolved = required.filter((n) => !given.has(dispositionKey(n)));
  const needed = new Set(required.map(dispositionKey));
  const unmatched = dispositions.filter((d) => !needed.has(dispositionKey(d)));
  if (unresolved.length || unmatched.length) blocking.push(`dispositions: ${unresolved.length} missing, ${unmatched.length} unmatched`);

  const byEffect = new Map(verifications.map((v) => [v.verification, v]));
  const missingEffects = effects.filter((e) => !byEffect.has(e));
  const failedEffects = effects.filter((e) => byEffect.get(e)?.result === "fail");
  const strayEffects = verifications.filter((v) => !effects.includes(v.verification)).map((v) => v.verification);
  if (missingEffects.length || failedEffects.length) blocking.push(`verification: ${[...missingEffects.map((e) => `${e} missing`), ...failedEffects.map((e) => `${e} failed`)].join(", ")}`);

  return { blocking, reportOnly, missing, failed, unresolved, unmatched, missingEffects, failedEffects, strayEffects };
}

/** Is `x` a well-formed verdict result? @param {any} x */
export function isResult(x) {
  return !!x && typeof x === "object" && typeof x.id === "string" && ["PASS", "FAIL", "WARN", "N/A", "ERROR"].includes(x.verdict) && typeof x.message === "string" && Array.isArray(x.details);
}

export { GREPTILE_PREFIX };

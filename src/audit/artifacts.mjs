// Structural validation of the two state artifacts `rx guard` trusts nothing about (Codex Wave 3
// review P1 #4): the receipt `rx gates` writes and the audit `rx audit record` writes. Every field
// the contract lists must be present and well-formed, the recorded rx version must be the running
// one, and every required step must have left results. A problem is returned as one sentence
// naming the field; null means well-formed. Decisions (FAIL/ERROR results, fingerprints, blocking
// reasons) are the caller's; this is shape only.

import { FINGERPRINT_FIELDS } from "../fingerprint.mjs";
import * as apiFloor from "../commands/api-floor.mjs";
import * as preflight from "../commands/preflight.mjs";
import { REQUIRED_STEPS } from "../commands/gates.mjs";
import { EFFECTS, parseEntries } from "./entries.mjs";
import { isResult } from "./evaluate.mjs";

/** Does a result id belong to a step's output? @type {Record<string, (id: string) => boolean>} */
export const STEP_RESULT_IDS = {
  stale: (id) => id === "stale" || id.startsWith("stale-"),
  scan: (id) => id.startsWith("scan-"),
  preflight: (id) => id in (preflight.spec.checks ?? {}),
  "api-floor": (id) => id in (apiFloor.spec.checks ?? {}),
  build: (id) => id === "build",
  tsc: (id) => id === "tsc",
  lint: (id) => id === "lint",
};

/** @param {unknown} v */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v */
const str = (v) => typeof v === "string" && v.length > 0;

/**
 * @param {any} receipt
 * @param {{ version: string }} p
 * @returns {string | null}
 */
export function validateReceipt(receipt, { version }) {
  if (!isObj(receipt)) return "the receipt is not a JSON object";
  if (!isObj(receipt.fingerprints)) return "the receipt has no fingerprints";
  for (const k of [...FINGERPRINT_FIELDS, "combined"]) if (!str(receipt.fingerprints[k])) return `the receipt's fingerprints lack ${k}`;
  if (!isObj(receipt.inputs) || !str(receipt.inputs.preset) || !str(receipt.inputs.forbidden)) return "the receipt lacks inputs.preset / inputs.forbidden";
  if (!Array.isArray(receipt.results) || receipt.results.length === 0) return "the receipt has no results";
  for (const r of receipt.results) if (!isResult(r)) return "the receipt holds a malformed result";
  if (!Array.isArray(receipt.steps) || !receipt.steps.every((/** @type {unknown} */ s) => typeof s === "string")) return "the receipt has no steps list";
  for (const step of REQUIRED_STEPS) {
    if (!receipt.steps.includes(step)) return `the receipt lacks step ${step}`;
    if (!receipt.results.some((/** @type {any} */ r) => STEP_RESULT_IDS[step](r.id))) return `the receipt lists step ${step} but holds none of its results`;
  }
  if (!isObj(receipt.data) || !isObj(receipt.data.stale)) return "the receipt lacks data.stale";
  if (receipt.rxVersion !== version) return `the receipt was written by rx ${String(receipt.rxVersion)}, not the running ${version}`;
  if (!str(receipt.at)) return "the receipt lacks at";
  if (!isObj(receipt.subject) || !str(receipt.subject.root) || !str(receipt.subject.gitCommonDir)) return "the receipt lacks subject.root / subject.gitCommonDir";
  if (!str(receipt.generation)) return "the receipt lacks generation";
  return null;
}

/**
 * @param {any} audit
 * @param {{ version: string }} p
 * @returns {string | null}
 */
export function validateAudit(audit, { version }) {
  if (!isObj(audit)) return "the audit is not a JSON object";
  if (!str(audit.fingerprint)) return "the audit lacks fingerprint";
  if (audit.rxVersion !== version) return `the audit was written by rx ${String(audit.rxVersion)}, not the running ${version}`;
  if (!str(audit.at)) return "the audit lacks at";
  if (!Array.isArray(audit.applicable) || !audit.applicable.every((/** @type {any} */ a) => isObj(a) && str(a.id) && (a.severity === "block" || a.severity === "report"))) return "the audit lacks a well-formed applicable list";
  for (const k of ["entries", "dispositions", "verifications"]) if (!Array.isArray(audit[k])) return `the audit lacks ${k}`;
  try {
    parseEntries([...audit.entries, ...audit.dispositions, ...audit.verifications], "audit.json");
  } catch (e) {
    return `the audit's entries are malformed: ${/** @type {Error} */ (e).message.split("\n")[0]}`;
  }
  if (!Array.isArray(audit.required) || !audit.required.every((/** @type {any} */ r) => isObj(r) && str(r.path) && str(r.localHash) && str(r.baseline) && str(r.kind))) return "the audit lacks a well-formed required-dispositions list";
  if (!Array.isArray(audit.effects) || !audit.effects.every((/** @type {any} */ e) => EFFECTS.includes(e))) return "the audit lacks a well-formed effects list";
  if (!isObj(audit.evidence) || !Array.isArray(audit.evidence.shortcuts) || !Array.isArray(audit.evidence.png)) return "the audit lacks evidence.shortcuts / evidence.png";
  for (const r of [...audit.evidence.shortcuts, ...audit.evidence.png]) if (!isResult(r)) return "the audit holds a malformed evidence result";
  for (const k of ["blocking", "reportOnly"]) if (!Array.isArray(audit[k]) || !audit[k].every((/** @type {unknown} */ s) => typeof s === "string")) return `the audit lacks ${k}`;
  if (!isObj(audit.subject) || !str(audit.subject.root) || !str(audit.subject.gitCommonDir)) return "the audit lacks subject.root / subject.gitCommonDir";
  if (!str(audit.receiptGeneration) || !str(audit.receiptMac)) return "the audit lacks receiptGeneration / receiptMac";
  // Absent (an audit written before the field existed) is the guard's "rules changed" sentence,
  // not a shape problem; present, it must be well-formed.
  if (audit.greptileRules !== undefined) {
    const g = audit.greptileRules;
    if (!isObj(g) || !str(g.repo) || typeof g.sha !== "string" || !/^[0-9a-f]{40}$/.test(g.sha) || typeof g.digest !== "string" || !/^[0-9a-f]{64}$/.test(g.digest)) return "the audit's greptileRules is not { repo, sha (40 hex), digest (64 hex) }";
  }
  return null;
}

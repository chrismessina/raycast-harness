// `rx audit record --preset f --entries f [--root d]` · `rx audit show [--root d]`
// (docs/commands.md §4.9; plan-review-1 #3, plan-review-2 F4 and F9; Q2). The judgment evidence
// the receipt cannot hold, validated against the preset and the current gates run:
//
//   coverage       one rule entry per applicable preset rule (tag ≠ build; applicability through
//                  src/preset/applies.mjs over the extension) and per Greptile judgment rule
//                  (src/audit/greptile.mjs); a missing one → FAIL audit-coverage
//   severity       copied from the preset, never supplied: a `block` rule with result fail →
//                  FAIL audit-<id>; a `report` rule with result fail → WARN audit-<id>
//   shortcuts      `rx shortcuts check` run in-process and embedded; its ERROR (runtime evidence
//                  unavailable) or FAIL blocks, and is never an accepted N/A (F4)
//   dispositions   every stale CHECK / NEW? / REMOVE / DELETED path in the receipt and every png OLDER-SHOT
//                  image in this run (`rx png` run in-process against the recorded published copy)
//                  needs a disposition matching { path, localHash, baseline } exactly (a REMOVE
//                  or DELETED row's localHash is "absent", and only `remove-published` answers it, which
//                  answers nothing else); a missing, unmatched or misfit one → FAIL
//                  audit-dispositions
//   verifications  one per external effect the extension has (writes files, makes web requests,
//                  calls Raycast AI, from the applicability context) → FAIL audit-verification
//   greptile rules the rules in use (repo, sha, digest of config.json rules + files.json) are stored
//                  as `greptileRules`; guard and show block when they change (src/audit/greptile.mjs).
//                  One snapshot is loaded at the start and used for applicability, the entry ids
//                  and the stamp; if the rules in use differ from it just before the write →
//                  ERROR audit-greptile-rules, nothing written
//   receipt        no current receipt → ERROR audit-receipt with the guard's own sentence: missing,
//                  not attested by this machine's key, malformed, written for another checkout or
//                  an earlier gates attempt (src/binding.mjs), stale fingerprints, or recording a
//                  FAIL/ERROR; also when the receipt's `greptileRules` (the rules rx gates brought
//                  current) is not the snapshot this recording took; the audit is tied to the
//                  receipt's combined fingerprint, its subject, its generation and its attestation MAC
//
// The previous audit.json is deleted as the first action of `record`, so a recording that fails
// on its inputs never leaves an old authorization behind. audit.json is then written whenever the
// inputs were valid, blocking failures included, so `rx guard` sees the latest judgment; `guard`
// recomputes the decision from the stored parts (src/audit/evaluate.mjs) and never trusts the
// stored `blocking` list. The written audit carries an `attestation` (src/attest.mjs) that
// `guard` verifies before anything else. Evidence text may span lines: it goes into details, messages stay one
// line.

import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { attest, inspectKey, loadOrCreateKey, verifyAttestation } from "../attest.mjs";
import { auditBindingProblem, receiptBindingProblem, receiptFailures } from "../binding.mjs";
import { RxError } from "../errors.mjs";
import { computeFingerprints, diffFingerprints } from "../fingerprint.mjs";
import { loadPreset } from "../preset/load.mjs";
import { buildApplyContext, loadSources, readLockfile, readPublished } from "../preflight/context.mjs";
import { repoStatePath, repoStatePathReadOnly, writeJsonAtomic } from "../state.mjs";
import { PublishedCopyChanged, withPublishedCopy } from "../published-copy.mjs";
import { validateReceipt } from "../audit/artifacts.mjs";
import { EFFECTS, dispositionKey, readEntries } from "../audit/entries.mjs";
import { freshGreptileRulesStamp, greptileRulesAgreementProblem, greptileRulesStamp, receiptRulesProblem, stampOf, withGreptileRulesSnapshot } from "../audit/greptile.mjs";
import { GREPTILE_PREFIX, applicableRules, decide, deletesPublished, effectsOf, knownRuleIds, pngDispositions, staleDispositions } from "../audit/evaluate.mjs";
import { runStep } from "../audit/step.mjs";
import { Results } from "../verdict.mjs";
import * as png from "./png.mjs";
import * as shortcuts from "./shortcuts.mjs";

/** @type {NonNullable<import("../cli.mjs").CommandSpec["checks"]>} */
const RECORD_CHECKS = {
  "audit-coverage": "one entry per applicable preset rule and Greptile judgment rule (FAIL naming the missing ids)",
  "audit-*": "audit-<rule id>: a rule whose entry says fail (FAIL for a block rule, WARN for a report rule)",
  "audit-dispositions": "every stale CHECK / NEW? / REMOVE / DELETED path and png OLDER-SHOT image in this run has a disposition matching { path, localHash, baseline } (REMOVE and DELETED: localHash \"absent\", disposition remove-published, which no other row accepts)",
  "audit-verification": "a destination / runtime verification entry per external effect the extension has (writes files, web requests, Raycast AI)",
  "audit-greptile-rules": { description: "ERROR when the Greptile rules in use changed while the audit was being recorded (another rx greptile update finished mid-recording); nothing is written", levels: ["ERROR"] },
  "audit-receipt": { description: "ERROR when there is no current receipt (missing, not attested by this machine's key, malformed, written for another checkout or an earlier gates attempt, its fingerprints no longer match the tree, it records a FAIL/ERROR, it was written with a different preset, or its greptileRules are not the Greptile rules in use)", levels: ["ERROR"] },
  "attest-key": { description: "ERROR when the attestation key exists but is unusable (not a regular file, not 32 bytes, accessible to group or other), or its directory exists with group or other access; rx never replaces the key or chmods a directory it did not create", levels: ["ERROR"] },
  ...shortcuts.spec.subcommands?.check.checks,
  ...png.spec.checks,
};

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "audit",
  summary: "record (validate and write) or show the agent audit that rx guard requires beside the gates receipt",
  root: "required",
  flags: { "--root": { type: "string", value: "<dir>", help: "extension root" } },
  network: "none",
  state: "record deletes then writes repo/audit.json (attested with the rx key, created on first need at $XDG_CONFIG_HOME/raycast-harness/attest.key) and reads repo/receipt.json (its attestation, subject, generation and fingerprint), the root's generation file under $XDG_CONFIG_HOME/raycast-harness/generations/ and repo/stale/baseline.json; rotates nothing; show reads the same and creates nothing",
  subcommands: {
    record: {
      name: "record",
      summary: "validate the entries against the preset and the current gates run, embed the shortcut and png evidence, write repo/audit.json",
      flags: {
        "--root": { type: "string", value: "<dir>", help: "extension root" },
        "--preset": { type: "string", value: "<file>", required: true, help: "preset JSON: rule ids, applicability and severity" },
        "--entries": { type: "string", value: "<file>", required: true, help: "JSON array of rule entries, dispositions and verifications (see src/audit/entries.mjs); must live outside the extension root" },
      },
      checks: RECORD_CHECKS,
      data: {
        written: "boolean — audit.json written",
        fingerprint: "string — the receipt's combined fingerprint the audit is tied to",
        entries: "number — rule entries accepted",
        blocking: "string[] — every reason rx guard will block on (empty when the audit is clean)",
        reportOnly: "string[] — report-severity rules whose entry says fail",
        dispositions: "number — dispositions matched",
        applicable: "string[] — the rule ids that needed an entry",
      },
      examples: ["rx audit record --preset presets/chrismessina.json --entries ../audit-entries.json"],
    },
    show: {
      name: "show",
      summary: "print the recorded audit and whether it still matches the current receipt",
      flags: { "--root": { type: "string", value: "<dir>", help: "extension root" } },
      checks: {
        "audit-show": { description: "PASS when audit.json exists, matches the current receipt's fingerprint and the Greptile rules in use, and has no blocking failure; WARN when it is stale or blocking, when the receipt's, the audit's and the current Greptile rules do not all agree (the guard's sentence), or when the receipt's or the audit's provenance fails (the guard's sentence); N/A when none is recorded", levels: ["PASS", "WARN", "N/A"] },
      },
      data: { audit: "the recorded audit.json, or null", receipt: "{ present, fingerprint } for the current receipt" },
      examples: ["rx audit show"],
    },
  },
};

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  if (ctx.args.subcommand === "show") return show(ctx);
  return record(ctx);
}

/**
 * The receipt, or null when none is readable.
 * @param {string} root
 * @returns {Promise<{ path: string, receipt: any } | null>}
 */
export async function readReceipt(root) {
  const path = await repoStatePathReadOnly(root, "receipt.json");
  if (!existsSync(path)) return null;
  try {
    return { path, receipt: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return null;
  }
}

/** Split evidence text into one detail per line (so a message stays one line). @param {string} text @param {string} [prefix] */
export function evidenceDetails(text, prefix = "") {
  const lines = String(text).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  return (lines.length ? lines : ["(empty)"]).map((l, i) => ({ text: i === 0 && prefix ? `${prefix}${l}` : l }));
}

/**
 * Is `file` inside `root` (real paths, so a symlinked entries file cannot hide in the payload)?
 * @param {string} file @param {string} root
 */
export function insideRoot(file, root) {
  try {
    const f = realpathSync(file);
    const r = realpathSync(root);
    return f === r || f.startsWith(r + sep);
  } catch {
    return false;
  }
}

/**
 * Called by the dispatcher when `record`'s arguments fail to parse (a missing `--entries`): the
 * previous audit goes then too, as it would at the start of record(). `show` deletes nothing.
 * @type {NonNullable<import("../cli.mjs").CommandModule["invalidate"]>}
 */
export async function invalidate({ root, subcommand, log }) {
  if (!root || subcommand !== "record") return;
  const auditPath = await repoStatePath(root, "audit.json");
  const removed = existsSync(auditPath);
  rmSync(auditPath, { force: true });
  if (removed) log(`audit: removed the previous audit at ${auditPath} (the arguments did not parse); run rx audit record again\n`);
}

/** Tests only: called just before the rules are re-checked and the audit written. @type {(() => void | Promise<void>) | null} */
let beforeWriteHook = null;
/** @param {(() => void | Promise<void>) | null} fn */
export function _setBeforeWriteHookForTests(fn) {
  beforeWriteHook = fn;
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function record(ctx) {
  const root = /** @type {string} */ (ctx.root);

  // 1. The previous audit never survives the start of a recording.
  const auditPath = await repoStatePath(root, "audit.json");
  const removed = existsSync(auditPath);
  rmSync(auditPath, { force: true });
  if (removed) ctx.log(`audit: removed the previous audit at ${auditPath}; a new one is written only when the inputs are valid\n`);
  // One snapshot of the Greptile rules for the whole recording.
  return withGreptileRulesSnapshot((rules) => recordWith(ctx, auditPath, rules));
}

/**
 * @param {import("../cli.mjs").CommandContext} ctx @param {string} auditPath
 * @param {import("../greptile/rules.mjs").LoadedRules} rules the snapshot pinned at the start
 */
async function recordWith(ctx, auditPath, rules) {
  const { args, results, cwd, version } = ctx;
  const root = /** @type {string} */ (ctx.root);
  const empty = (/** @type {string | null} */ fingerprint) => ({ data: { written: false, fingerprint, entries: 0, blocking: [], reportOnly: [], dispositions: 0, applicable: [] }, fingerprint });
  const key = loadOrCreateKey();

  // 2. Inputs.
  const loaded = loadPreset(/** @type {string} */ (args.flags["--preset"]), cwd);
  const entriesPath = resolve(cwd, /** @type {string} */ (args.flags["--entries"]));
  if (insideRoot(entriesPath, root)) throw new RxError(`--entries ${entriesPath} is inside the extension root ${root}; ray publish would copy it, so keep it outside (the payload fingerprint would also change)`, { id: "input" });
  const file = readEntries(entriesPath);

  // 3. The receipt this audit is tied to. Missing, malformed, incomplete or stale → ERROR.
  const found = await readReceipt(root);
  if (!found) {
    results.error("audit-receipt", `no receipt at ${await repoStatePathReadOnly(root, "receipt.json")}; run rx gates first`);
    return empty(null);
  }
  const { receipt } = found;
  const forged = verifyAttestation(receipt, key, { name: "receipt.json", rerun: "rx gates, then rx audit record" });
  if (forged) {
    results.error("audit-receipt", forged);
    return empty(null);
  }
  const problem = validateReceipt(receipt, { version });
  if (problem) {
    results.error("audit-receipt", `${problem} (${found.path}); run rx gates again`);
    return empty(null);
  }
  const unbound = await receiptBindingProblem(receipt, root);
  if (unbound) {
    results.error("audit-receipt", unbound);
    return empty(null);
  }
  const fresh = await computeFingerprints({ root, version, presetPath: receipt.inputs.preset, forbiddenPath: receipt.inputs.forbidden });
  const drift = diffFingerprints(receipt.fingerprints, fresh);
  if (drift.length) {
    results.error("audit-receipt", `the receipt at ${found.path} is stale: ${drift.filter((d) => d !== "combined").join(", ") || "fingerprints"} changed since rx gates ran; run rx gates again`);
    return empty(fresh.combined);
  }
  const failures = receiptFailures(receipt);
  if (failures) {
    results.error("audit-receipt", failures);
    return empty(fresh.combined);
  }
  if (resolve(loaded.path) !== resolve(receipt.inputs.preset)) {
    results.error("audit-receipt", `--preset ${loaded.path} is not the preset the receipt was written with (${receipt.inputs.preset}); run rx gates with this preset or pass that one`);
    return empty(fresh.combined);
  }
  // The rules rx gates brought current must be the rules this recording judges against.
  const stamp = stampOf(rules);
  const rulesMoved = receiptRulesProblem(receipt.greptileRules, stamp);
  if (rulesMoved) {
    results.error("audit-receipt", rulesMoved);
    return empty(fresh.combined);
  }

  // 4. Applicability over the extension, exactly as preflight computes it.
  /** @type {any} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (e) {
    throw new RxError(`cannot read ${join(root, "package.json")}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) throw new RxError(`${join(root, "package.json")} is not a JSON object`, { id: "input" });
  const applyCtx = buildApplyContext({ pkg, owner: loaded.preset.owner, sources: loadSources(root), lock: readLockfile(root), published: await readPublished(root) });
  const applicable = applicableRules(loaded, applyCtx);
  const known = knownRuleIds(loaded);
  const unknown = file.entries.filter((e) => !known.has(e.id)).map((e) => e.id);
  if (unknown.length) throw new RxError(`--entries ${entriesPath}: unknown rule id(s) ${unknown.join(", ")} (preset rule ids, or ${GREPTILE_PREFIX}<rule> for Greptile judgment rules)`, { id: "input" });
  const effects = effectsOf(applyCtx);

  // 5. Embedded evidence: shortcuts (F4) and png against the receipt's published copy.
  const sc = await runStep(shortcuts, ctx, { root, flags: { "--root": root }, subcommand: "check" });
  results.merge(sc.results);
  const staleData = receipt.data.stale;
  /** @type {Record<string, string>} */
  const pngFlags = { "--root": root };
  /** @type {import("../verdict.mjs").Result[]} */
  let pngResults = [];
  /** @type {any[]} */
  let pngFiles = [];
  const runPng = async () => {
    const pngRun = await runStep(png, ctx, { root, flags: pngFlags });
    results.merge(pngRun.results);
    pngResults = pngRun.results.items;
    pngFiles = /** @type {any[]} */ (pngRun.data.files ?? []);
  };
  if (staleData.published === true) {
    // The receipt's exact baseline, read through the published-copy service: validated and read
    // under one hold of the upstream lock, so the png evidence is against the copy gates judged.
    let entered = false;
    try {
      if (typeof staleData.name !== "string") throw new PublishedCopyChanged(staleData.name, staleData.baseline);
      await withPublishedCopy({ name: staleData.name, expectedBaseline: String(staleData.baseline) }, async (copy) => {
        entered = true;
        pngFlags["--published"] = /** @type {string} */ (copy.directory);
        await runPng();
      });
    } catch (e) {
      if (e instanceof PublishedCopyChanged) {
        results.error("png", e.message);
        pngResults = results.items.filter((r) => r.id === "png");
      } else if (!entered && e instanceof RxError && e.id === "github") {
        // The lock wait gave up: reported as the png step's own ERROR, as when png held the lock.
        const r = new Results();
        r.error(e.id, e.message);
        results.merge(r);
        pngResults = r.items;
      } else throw e;
    }
  } else await runPng();
  const required = [...pngDispositions(pngFiles), ...staleDispositions(staleData)];
  const given = new Map(file.dispositions.map((x) => [dispositionKey(x), x]));

  // 6. The decision, from the same function rx guard recomputes with.
  const d = decide({ applicable, entries: file.entries, dispositions: file.dispositions, verifications: file.verifications, required, effects, evidence: { shortcuts: sc.results.items, png: pngResults } });

  if (d.missing.length) results.fail("audit-coverage", `${d.missing.length} applicable rule(s) have no entry`, d.missing.map((m) => ({ text: `${m.id} (${m.why})` })));
  else results.pass("audit-coverage", `${applicable.length} applicable rule(s) covered (${applicable.filter((a) => !a.id.startsWith(GREPTILE_PREFIX)).length} preset, ${applicable.filter((a) => a.id.startsWith(GREPTILE_PREFIX)).length} Greptile judgment)`);

  for (const { rule, entry } of d.failed) {
    const id = `audit-${rule.id.replace(/\//g, "-")}`;
    const details = [{ text: `scope: ${entry.scope.split(/\r?\n/)[0]}` }, ...evidenceDetails(entry.evidence, "evidence: ")];
    if (rule.severity === "block") results.fail(id, `${rule.id}: fail (blocking)`, details);
    else results.warn(id, `${rule.id}: fail (report-only)`, details);
  }

  if (d.unresolved.length || d.unmatched.length) {
    results.fail("audit-dispositions", `${d.unresolved.length} outcome(s) without a disposition; ${d.unmatched.length} disposition(s) match nothing in this run`, [
      ...d.unresolved.map((n) => ({ file: n.path, text: `${n.kind} needs a disposition${deletesPublished(n.kind) ? " remove-published" : ""}: localHash=${n.localHash} baseline=${n.baseline}` })),
      ...d.unmatched.map((x) => ({ file: x.path, text: required.some((n) => dispositionKey(n) === dispositionKey(x))
        ? `${x.disposition} does not answer this row: remove-published answers a stale REMOVE or DELETED row and nothing else`
        : `stale disposition: localHash=${x.localHash} baseline=${x.baseline} matches no current CHECK / NEW? / REMOVE / DELETED / OLDER-SHOT` })),
    ]);
  } else if (required.length) {
    results.pass("audit-dispositions", `${required.length} outcome(s) dispositioned`, required.map((n) => {
      const g = given.get(dispositionKey(n));
      return { file: n.path, text: `${n.kind}: ${g?.disposition} — ${String(g?.reason ?? "").split(/\r?\n/)[0]}` };
    }));
  } else results.na("audit-dispositions", "no stale CHECK / NEW? / REMOVE / DELETED path and no png OLDER-SHOT image in this run");

  const byEffect = new Map(file.verifications.map((v) => [v.verification, v]));
  if (d.missingEffects.length || d.failedEffects.length) {
    results.fail("audit-verification", `${d.missingEffects.length} external effect(s) unverified, ${d.failedEffects.length} failed`, [
      ...d.missingEffects.map((e) => ({ text: `${e}: no verification entry (destination / runtime evidence)` })),
      ...d.failedEffects.flatMap((e) => evidenceDetails(byEffect.get(e)?.evidence ?? "", `${e}: fail — `)),
    ]);
  } else if (effects.length) {
    const nPass = effects.filter((e) => byEffect.get(e)?.result === "pass").length;
    results.pass("audit-verification", `${effects.length} external effect(s) recorded: ${nPass} pass, ${effects.length - nPass} n-a${d.strayEffects.length ? ` (${d.strayEffects.join(", ")} recorded but not detected in src/)` : ""}`, effects.flatMap((e) => evidenceDetails(byEffect.get(e)?.evidence ?? "", `${e}: ${byEffect.get(e)?.result} — `)));
  } else results.na("audit-verification", `no external effect detected in src/ (${EFFECTS.join(", ")})${d.strayEffects.length ? `; ${d.strayEffects.join(", ")} recorded anyway` : ""}`);

  // 7. Write, blocking reasons included, only when the rules in use are still the snapshot the
  // entries were judged against.
  if (beforeWriteHook) await beforeWriteHook();
  const now = freshGreptileRulesStamp();
  if (now.repo !== stamp.repo || now.sha !== stamp.sha || now.digest !== stamp.digest) {
    results.error("audit-greptile-rules", `the Greptile rules changed while the audit was being recorded (${stamp.sha.slice(0, 7)} → ${now.sha.slice(0, 7)}); run rx audit record again`);
    return empty(fresh.combined);
  }
  const doc = {
    fingerprint: fresh.combined,
    receiptAt: receipt.at,
    subject: receipt.subject,
    receiptGeneration: receipt.generation,
    receiptMac: receipt.attestation.mac,
    rxVersion: version,
    at: new Date().toISOString(),
    // The Greptile rules the judgment entries were read against (rx guard blocks when they change).
    greptileRules: stamp,
    applicable: applicable.map((a) => ({ id: a.id, severity: a.severity })),
    entries: file.entries,
    dispositions: file.dispositions,
    verifications: file.verifications,
    required,
    effects,
    evidence: { shortcuts: sc.results.items, png: pngResults },
    blocking: d.blocking,
    reportOnly: d.reportOnly,
  };
  writeJsonAtomic(auditPath, attest(doc, key));
  ctx.log(`audit: written to ${auditPath}${d.blocking.length ? ` with ${d.blocking.length} blocking reason(s); rx guard will refuse a publish until they are resolved` : ""}\n`);
  return {
    data: { written: true, fingerprint: fresh.combined, entries: file.entries.length, blocking: d.blocking, reportOnly: d.reportOnly, dispositions: required.length - d.unresolved.length, applicable: applicable.map((a) => a.id) },
    fingerprint: fresh.combined,
  };
}

/**
 * The first provenance failure the guard would report for this receipt and audit (attestations,
 * the receipt's binding to this checkout and gates attempt, the audit's binding to the receipt),
 * or null. Reads the key; never creates it.
 * @param {any} receipt @param {any} audit @param {string} root
 * @returns {Promise<string | null>}
 */
async function provenanceProblem(receipt, audit, root) {
  const key = inspectKey();
  return verifyAttestation(receipt, key, { name: "receipt.json", rerun: "rx gates, then rx audit record" })
    ?? verifyAttestation(audit, key, { name: "audit.json", rerun: "rx audit record" })
    ?? (await receiptBindingProblem(receipt, root))
    ?? auditBindingProblem(audit, receipt);
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function show({ results, root: r }) {
  const root = /** @type {string} */ (r);
  const auditPath = await repoStatePathReadOnly(root, "audit.json");
  const found = await readReceipt(root);
  const receiptInfo = { present: found !== null, fingerprint: found?.receipt?.fingerprints?.combined ?? null };
  if (!existsSync(auditPath)) {
    results.na("audit-show", `no audit recorded at ${auditPath}`);
    return { data: { audit: null, receipt: receiptInfo } };
  }
  /** @type {any} */
  let audit;
  try {
    audit = JSON.parse(readFileSync(auditPath, "utf8"));
  } catch (e) {
    results.warn("audit-show", `${auditPath} is unreadable: ${/** @type {Error} */ (e).message}`);
    return { data: { audit: null, receipt: receiptInfo } };
  }
  const details = [
    { text: `recorded ${audit.at ?? "?"} by rx ${audit.rxVersion ?? "?"}; ${Array.isArray(audit.entries) ? audit.entries.length : 0} entries, ${Array.isArray(audit.dispositions) ? audit.dispositions.length : 0} dispositions, ${Array.isArray(audit.verifications) ? audit.verifications.length : 0} verifications` },
    ...(Array.isArray(audit.blocking) ? audit.blocking.map((/** @type {string} */ b) => ({ text: `blocking: ${b}` })) : []),
    ...(Array.isArray(audit.reportOnly) ? audit.reportOnly.map((/** @type {string} */ b) => ({ text: `report-only fail: ${b}` })) : []),
  ];
  const blocking = Array.isArray(audit.blocking) ? audit.blocking.length : 1;
  const provenance = found ? await provenanceProblem(found.receipt, audit, root) : null;
  const rulesChanged = found ? greptileRulesAgreementProblem(found.receipt?.greptileRules, audit.greptileRules, greptileRulesStamp()) : null;
  if (!found) results.warn("audit-show", "audit recorded but no receipt exists now; run rx gates and rx audit record again", details);
  else if (provenance) results.warn("audit-show", provenance, details);
  else if (audit.fingerprint !== receiptInfo.fingerprint) results.warn("audit-show", "audit is tied to a different receipt than the current one; run rx audit record again", details);
  else if (rulesChanged) results.warn("audit-show", rulesChanged, details);
  else if (blocking) results.warn("audit-show", `audit matches the current receipt but carries ${blocking} blocking reason(s)`, details);
  else results.pass("audit-show", `audit matches the current receipt (${String(audit.fingerprint).slice(0, 12)}) with no blocking failure`, details);
  return { data: { audit, receipt: receiptInfo }, fingerprint: typeof audit.fingerprint === "string" ? audit.fingerprint : null };
}

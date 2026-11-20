// The Greptile rules no program decides (docs/commands.md §4.9: "one entry per … Greptile
// judgment rule"). Greptile reviews every Store PR against the 61 rules in
// `src/rules/greptile/config.json`; `rx preflight` covers the mechanical ones
// (`GREPTILE_PREFLIGHT_RULES`), and the judgment ones are the rest: an agent reads the branch diff
// for each and records pass / fail / n-a with evidence in `rx audit record`. The list is checked
// against the snapshot at load, so a rule Raycast renames or removes is an ERROR here, never a
// silently skipped entry. A Greptile finding at any of its severities (`high` / `medium` / `low`)
// holds a Store PR, so every judgment rule is blocking, except one whose own text says it never
// blocks (GREPTILE_REPORT_ONLY_RULES).
//
// Every rule in the snapshot is classified: bound to preflight checks, listed as judgment, or
// both. A rule is preflight-only ONLY when its checks cover the whole rule text; a check that
// covers part of a rule (a heuristic, a fixed file list where the rule says "such as", a
// presence check where the rule also asks for a judgment) leaves the rule a judgment rule too, so
// its uncovered part still needs an audit entry. `unclassifiedGreptileRules()` names the ones that are neither, and the test suite fails on
// any, so a rule Raycast adds upstream cannot pass an audit unread.
//
// A preflight-only exemption is bound to the rule it was reviewed against, not just its id:
// `GREPTILE_MECHANICAL_RULES` stores the digest of that rule's text and scope
// (ruleContentDigest(), src/greptile/rules.mjs). When the rules in use carry a different digest for
// the id (an `rx greptile update` copy whose rule was broadened), the rule is a required judgment
// entry again, with a `why` saying the mechanical mapping needs re-review, until this release
// re-reads the rule and records the new digest.
//
// The entry id in an `--entries` file is `greptile/<rule id>`; the result id is
// `audit-greptile-<rule id>`.
//
// An audit is bound to the rules it was judged against: `rx audit record` stores
// `greptileRules: { repo, sha, digest }` (greptileRulesStamp()), and `rx guard` / `rx audit show`
// block on any difference from the rules in use now (greptileRulesProblem()), so a rule whose text
// changed under the same id never reuses an audit recorded against the old text. `rx gates` keeps
// the rules current (src/greptile/update.mjs) and stores the same stamp in the receipt; `rx audit
// record` refuses a receipt whose stamp is not its snapshot (receiptRulesProblem()), and the guard
// and `rx audit show` require the receipt's, the audit's and the current stamp to agree
// (greptileRulesAgreementProblem()).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RxError } from "../errors.mjs";
import { loadGreptileRules, ruleContentDigest, rulesDigest } from "../greptile/rules.mjs";

/**
 * A rule set's identity, as a receipt and an audit store it in `greptileRules`.
 * @typedef {{ repo: string, sha: string, digest: string }} RulesStamp
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const GREPTILE_CONFIG = join(HERE, "..", "rules", "greptile", "config.json");

/** Greptile rule ids that need an audit entry: judgment-only rules, and rules preflight covers only in part. */
export const GREPTILE_JUDGMENT_RULES = Object.freeze([
  "changelog-entries",
  "supported-platforms",
  "shortcut-platform-keys",
  "launch-command-try-catch",
  "preference-types",
  "action-organization",
  "preference-storage",
  "no-hardcoded-secrets",
  "root-navigation-title",
  "ai-tools-evals",
  "ai-instructions",
  "readme-user-facing",
  "docs-match-behavior",
  "no-native-binaries",
  "failure-toasts",
  "error-empty-state",
  "no-silent-failure",
  "shell-command-injection",
  "no-analytics-or-keychain",
  "store-naming",
  "backward-compatible-updates",
  "loading-navigation-placeholders",
  "third-party-tos-signals",
  "owner-field",
  "contributors-third-party-updates",
  "deprecated-apis",
  "manifest-basics",
  "menu-bar-commands",
  "destructive-actions",
  "list-search-filtering",
  "data-hooks",
  "script-and-sql-utils",
  "ai-api-usage",
  "ai-skills",
  "ai-model-provider",
  "oauth-utils",
  "action-title-case",
  "extension-overlap",
  "data-hooks-bugs",
  "oauth-token-bugs",
  "mcp-registry-entries",
  // Preflight covers part of each of these (classification "both").
  "store-screenshots",
  "unused-dependencies",
  "eslint-flat-config",
  "no-custom-localization",
  "extension-categories",
  "prettier-config",
  "npm-lockfile-registry",
  "generated-preference-argument-types",
  "manifest-title-case",
  "raycast-trash",
  "favicon-utility",
  "launch-command-api",
  "no-agent-scaffolding",
  "no-generated-files",
  "no-dev-material",
  "store-description",
  // changelog-placeholder FAILs a top entry with no {PR_MERGE_DATE}, but passes a second new dated
  // entry under it and a placeholder written into the bracketed title.
  "changelog-hardcoded-date",
]);

/**
 * Judgment rules whose own text says a finding is never a blocker: their audit entry is still
 * required, and a `fail` is report-only. Each is bound to the ruleContentDigest() of the text that
 * says so, like GREPTILE_MECHANICAL_RULES: a rule whose text changed is blocking again until it is
 * re-read. changelog-hardcoded-date: "Mention it at most once per PR, as a suggestion, and never as
 * a required change or a blocker."
 */
export const GREPTILE_REPORT_ONLY_RULES = Object.freeze({
  "changelog-hardcoded-date": "762b5608cbce9db4c9156afc9c3e4f8be62e101576f02174589446d3955d5a54",
});

/**
 * Greptile rule ids `rx preflight` checks mechanically, each with the preflight result ids that
 * cover it (`src/preflight/catalog.mjs`). A rule may also be a judgment rule when part of it needs
 * reading.
 */
export const GREPTILE_PREFLIGHT_RULES = Object.freeze({
  "generated-preference-argument-types": ["hand-typed-preferences"],
  "changelog-entries": ["changelog-exists", "changelog-order", "changelog-placeholder", "changelog-updated"],
  "changelog-hardcoded-date": ["changelog-placeholder"],
  "store-screenshots": ["screenshots", "screenshot-count", "screenshot-format", "screenshot-size"],
  "unused-dependencies": ["unused-dependencies"],
  "eslint-flat-config": ["eslint-config"],
  "no-custom-localization": ["localization"],
  "prettier-config": ["prettierrc"],
  "extension-categories": ["categories"],
  "manifest-title-case": ["title-case"],
  "native-fetch": ["native-fetch"],
  "raycast-trash": ["trash"],
  "supported-platforms": ["platforms"],
  "platforms-field": ["platforms"],
  "shortcut-platform-keys": ["shortcut-platform-case"],
  "favicon-utility": ["favicon"],
  "launch-command-api": ["launch-command"],
  "preference-types": ["preference-type"],
  "no-agent-scaffolding": ["agent-scaffolding"],
  "no-nested-review-config": ["nested-review-config"],
  "readme-user-facing": ["readme-assets", "readme-links", "readme-dev-sections"],
  "no-generated-files": ["generated-files"],
  "no-dev-material": ["dev-material"],
  "npm-lockfile-registry": ["lockfile", "npm-registry"],
  "backward-compatible-updates": ["command-renamed"],
  "manifest-basics": ["icon-size"],
  "store-description": ["store-description"],
});

/**
 * The fully mechanical rules (in GREPTILE_PREFLIGHT_RULES, not in GREPTILE_JUDGMENT_RULES), each
 * with the ruleContentDigest() of the rule text and scope its preflight mapping was reviewed
 * against. Re-read the rule and update the digest only after confirming the checks still cover
 * all of it.
 */
export const GREPTILE_MECHANICAL_RULES = Object.freeze({
  "native-fetch": "fc256b5b13ba836ec56bf2aa14083cab4e962fcf64aca14817f6127d7f7ca896",
  "no-nested-review-config": "e63de3c543780cff9cd0daaf859bc2318c6ecd5a195128aeac948fae34b00a23",
  "platforms-field": "e8d2d483fcfa3087e6c027bf8ff52c65e0f30f3f13834e5104de184196f2b826",
});

/** The `why` a mechanical rule carries when its text or scope differs from what was reviewed. */
export const MECHANICAL_REREVIEW = "Greptile rule changed since its mechanical mapping to rx preflight was reviewed; the mapping needs re-review, so judge the rule in the audit";

export const GREPTILE_PREFIX = "greptile/";

/** Invalid-cache warnings already printed by this process: each is printed once. */
const warned = new Set();

/** The rules in use, read fresh (a cache copy can change between calls); each warning once. */
function loadFresh() {
  return loadGreptileRules({
    warn: (m) => {
      if (warned.has(m)) return;
      warned.add(m);
      process.stderr.write(`${m}\n`);
    },
  });
}

/**
 * The snapshot `rx audit record` pinned for the length of one recording, else null.
 * @type {import("../greptile/rules.mjs").LoadedRules | null}
 */
let pinned = null;

/** The pinned snapshot during a recording, else the rules in use read fresh. */
function rulesInUse() {
  return pinned ?? loadFresh();
}

/**
 * Run `fn` with ONE snapshot of the rules in use: applicability, the known
 * entry ids and the recorded stamp all read this snapshot, never a copy an `rx greptile update`
 * in another process wrote mid-recording. The pin is released when `fn` settles.
 * @template T @param {(snapshot: import("../greptile/rules.mjs").LoadedRules) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withGreptileRulesSnapshot(fn) {
  const snapshot = loadFresh();
  pinned = snapshot;
  try {
    return await fn(snapshot);
  } finally {
    pinned = null;
  }
}

/**
 * A rule set's identity: provenance and digest.
 * @param {import("../greptile/rules.mjs").LoadedRules} r
 * @returns {RulesStamp}
 */
export function stampOf(r) {
  return { repo: r.source.repo, sha: r.source.sha, digest: rulesDigest(r.rules) };
}

/**
 * What `rx audit record` stores as `greptileRules`: the rules in use, by provenance and digest.
 * @returns {RulesStamp}
 */
export function greptileRulesStamp() {
  return stampOf(rulesInUse());
}

/** The identity of the rules in use now, read fresh even while a recording holds its snapshot. */
export function freshGreptileRulesStamp() {
  return stampOf(loadFresh());
}

/**
 * The guard's sentence when an audit's `greptileRules` (absent on an audit written before this
 * field existed) differs from the rules in use now, else null. `rerun` is the command it
 * prescribes: `rx audit record` alone works only while the receipt names the rules in use.
 * @param {unknown} recorded the audit's greptileRules @param {RulesStamp} current
 * @param {string} [rerun]
 * @returns {string | null}
 */
function greptileRulesProblem(recorded, current, rerun = "run rx audit record again") {
  if (sameGreptileRules(recorded, current)) return null;
  return `the Greptile rules changed since the audit was recorded (${stampSha7(recorded)} → ${current.sha.slice(0, 7)}); ${rerun}`;
}

/**
 * Do two rules stamps name the same rules (repo, sha and digest)? An absent stamp matches nothing.
 * @param {unknown} a @param {unknown} b
 */
export function sameGreptileRules(a, b) {
  const x = /** @type {any} */ (a);
  const y = /** @type {any} */ (b);
  return !!x && !!y && typeof x === "object" && typeof y === "object" && x.repo === y.repo && x.sha === y.sha && x.digest === y.digest;
}

/** A stamp's short SHA, or `unrecorded`. @param {unknown} s */
export function stampSha7(s) {
  const sha = /** @type {any} */ (s)?.sha;
  return typeof sha === "string" ? sha.slice(0, 7) : "unrecorded";
}

/**
 * `rx audit record`'s sentence when the receipt's `greptileRules` is not the snapshot the recording
 * took (the receipt was written against other rules), else null.
 * @param {unknown} receiptRules @param {RulesStamp} snapshot
 * @returns {string | null}
 */
export function receiptRulesProblem(receiptRules, snapshot) {
  if (sameGreptileRules(receiptRules, snapshot)) return null;
  return `the Greptile rules changed since rx gates ran (${stampSha7(receiptRules)} → ${snapshot.sha.slice(0, 7)}); run rx gates again`;
}

/**
 * The guard's (and `rx audit show`'s) sentence unless the receipt's `greptileRules`, the audit's
 * `greptileRules` and the rules in use now are identical, else null. Three stamps can disagree in
 * three ways, each with its own sentence and command:
 *   - the audit alone differs (the receipt and the rules in use agree; the audit recorded the
 *     field): "the audit was recorded against other Greptile rules than the receipt …; run rx
 *     audit record again"
 *   - the audit differs from the rules in use otherwise (the rules-agreement check, including `unrecorded`
 *     for an audit written before the field existed): "the Greptile rules changed since the audit
 *     was recorded …; run rx audit record again" while the receipt names the rules in use, else
 *     "…; run rx gates, then rx audit record" (recording alone would refuse that receipt)
 *   - the receipt alone differs (the audit and the rules in use agree): "the Greptile rules changed
 *     since rx gates ran …; run rx gates, then rx audit record"
 * Whenever the receipt's rules are not the rules in use, the command is `rx gates`, then `rx audit
 * record`: `rx audit record` refuses a receipt written under other rules.
 * @param {unknown} receiptRules @param {unknown} auditRules
 * @param {RulesStamp} current
 * @returns {string | null}
 */
export function greptileRulesAgreementProblem(receiptRules, auditRules, current) {
  const receiptCurrent = sameGreptileRules(receiptRules, current);
  if (auditRules !== undefined && receiptCurrent && !sameGreptileRules(auditRules, receiptRules)) {
    return `the audit was recorded against other Greptile rules than the receipt (${stampSha7(auditRules)} vs ${stampSha7(receiptRules)}); run rx audit record again`;
  }
  const audit = greptileRulesProblem(auditRules, current, receiptCurrent ? undefined : "run rx gates, then rx audit record");
  if (audit) return audit;
  if (!receiptCurrent) return `the Greptile rules changed since rx gates ran (${stampSha7(receiptRules)} → ${current.sha.slice(0, 7)}); run rx gates, then rx audit record`;
  return null;
}

/**
 * The rule set at `configPath` (tests and shipped-copy checks), else the Greptile rules in use
 * (`loadGreptileRules()`: an `rx greptile update` cache copy or the shipped one).
 * @param {string} [configPath]
 * @returns {Map<string, { id: string, rule?: string, scope?: string[] }>}
 */
function snapshotRules(configPath) {
  /** @type {{ rules?: { id: string, rule?: string, scope?: string[] }[] }} */
  let config;
  try {
    config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : rulesInUse().rules.config;
  } catch (e) {
    throw new RxError(`cannot read the Greptile snapshot ${configPath ?? "the Greptile rules in use"}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  return new Map((config.rules ?? []).map((r) => [r.id, r]));
}

/**
 * The judgment rules, each verified to exist in the core snapshot, then every preflight-only rule
 * whose text or scope differs from what its mechanical mapping was reviewed against (with `why`),
 * then every rule this release has not classified.
 * @param {string} [configPath] a rule file to read instead of the rules in use
 * @returns {{ id: string, entryId: string, severity: "block" | "report", title: string, why?: string }[]}
 */
export function greptileJudgmentRules(configPath) {
  const byId = snapshotRules(configPath);
  const missing = GREPTILE_JUDGMENT_RULES.filter((id) => !byId.has(id));
  if (missing.length) throw new RxError(`Greptile judgment rule(s) absent from the snapshot ${configPath ?? "the Greptile rules in use"}: ${missing.join(", ")}; run rx greptile outdated`, { id: "input" });
  const judgment = new Set(GREPTILE_JUDGMENT_RULES);
  // A preflight-only rule is exempt only while it reads as reviewed; a missing digest fails closed.
  const reviewed = /** @type {Record<string, string>} */ (GREPTILE_MECHANICAL_RULES);
  const changed = Object.keys(GREPTILE_PREFLIGHT_RULES).filter((id) => !judgment.has(id) && byId.has(id) && ruleContentDigest(/** @type {any} */ (byId.get(id))) !== reviewed[id]);
  // A rule in the rules in use that this release has not classified (an `rx greptile update` copy
  // can be ahead of rx) is a required judgment entry too, so a new upstream rule never passes an
  // audit silently.
  const classified = new Set([...GREPTILE_JUDGMENT_RULES, ...Object.keys(GREPTILE_PREFLIGHT_RULES)]);
  const unclassified = [...byId.keys()].filter((id) => !classified.has(id));
  const advisory = /** @type {Record<string, string>} */ (GREPTILE_REPORT_ONLY_RULES);
  const reportOnly = (/** @type {string} */ id) => Object.hasOwn(advisory, id) && byId.has(id) && ruleContentDigest(/** @type {any} */ (byId.get(id))) === advisory[id];
  const row = (/** @type {string} */ id) => ({
    id,
    entryId: `${GREPTILE_PREFIX}${id}`,
    severity: /** @type {"block" | "report"} */ (reportOnly(id) ? "report" : "block"),
    title: (byId.get(id)?.rule ?? id).split("\n")[0].trim() || id,
  });
  return [...GREPTILE_JUDGMENT_RULES.map(row), ...changed.map((id) => ({ ...row(id), why: MECHANICAL_REREVIEW })), ...unclassified.map(row)];
}

/**
 * Snapshot rule ids that are neither bound to a preflight check nor listed as judgment rules, in
 * snapshot order. Empty means every rule Greptile can raise is handled somewhere.
 * @param {string} [configPath] a rule file to read instead of the rules in use
 * @returns {string[]}
 */
export function unclassifiedGreptileRules(configPath) {
  const judgment = new Set(GREPTILE_JUDGMENT_RULES);
  return [...snapshotRules(configPath).keys()].filter((id) => !judgment.has(id) && !Object.hasOwn(GREPTILE_PREFLIGHT_RULES, id));
}

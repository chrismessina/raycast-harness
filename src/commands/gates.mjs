// `rx gates --preset f --forbidden f [--root d] [--json]` (docs/commands.md §4.8; plan-review-1 #2,
// plan-review-2 F3; Q1): the mechanical gates, in order, and the receipt that proves they ran.
//
//   1. rotate this root's generation (src/binding.mjs) before any git call or state-directory
//      creation, then delete any existing receipt (a half-finished run must never look current,
//      and a receipt saved before this attempt must never become current again by being restored)
//   2. greptile-rules: the check-and-update routine `rx greptile update` runs
//      (src/greptile/update.mjs): one request for the last commit on raycast/extensions main that
//      touched .greptile/; when it differs from the rules in use, fetch, validate and install the
//      live rules as a new cache copy. A network failure, live rules that fail validation, or a
//      write that fails is a WARN and the run continues on the copy in use; never an ERROR. The
//      whole step has a deadline (GREPTILE_RULES_DEADLINE_MS); when it expires the step WARNs
//      and the run continues on the copy in use, with nothing installed. The stamp
//      { repo, sha, digest } (src/audit/greptile.mjs stampOf) of exactly the snapshot the step
//      reported (the routine's `selected`, never a reload) goes into the receipt as `greptileRules`.
//   3. stale → scan → preflight (only when published: --published, the copy of stale's exact
//      baseline, read through the published-copy service under the upstream lock) → api-floor,
//      each run in-process (src/audit/step.mjs) and merged with its own ids
//   4. `npm run build` → `npx --no-install tsc --noEmit` → `npm run lint` (build first: it
//      generates raycast-env.d.ts, which tsc needs; Q1). Missing local tooling → ERROR tooling;
//      nothing is ever installed.
//   5. fingerprint the tree (src/fingerprint.mjs), check that the Greptile rules in use are still
//      the snapshot step 2 stamped (gates-rules-changed: another `rx greptile update` may have
//      installed a copy meanwhile; run synchronously right before the write, after the last
//      await) and, only when no step FAILed or ERRORed,
//      write repo/receipt.json atomically (temp file in the state dir, then rename), carrying
//      its subject (root and git common dir) and the generation from step 1, attested with this
//      machine's rx key (src/attest.mjs; created on first need, before any step runs, so a bad
//      key is an ERROR attest-key that costs no build).
//
// Network: greptile-rules' (GitHub API via gh: raycast/extensions commits and .greptile/ contents),
// stale's (GitHub API, git fetch), api-floor's optional npm read, and whatever the project's own
// build and lint scripts do.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { attest, loadOrCreateKey } from "../attest.mjs";
import { rotateGeneration, subjectOf } from "../binding.mjs";
import { RxError } from "../errors.mjs";
import { run as exec } from "../exec.mjs";
import { computeFingerprints } from "../fingerprint.mjs";
import { withPublishedCopy } from "../published-copy.mjs";
import { sameGreptileRules, stampOf, stampSha7 } from "../audit/greptile.mjs";
import { describeRules, loadGreptileRules } from "../greptile/rules.mjs";
import { notInUseMessage, updateWithin, updatedMessage } from "../greptile/update.mjs";
import { transport } from "../pr/transport.mjs";
import { repoStatePath, writeJsonAtomic } from "../state.mjs";
import { Results } from "../verdict.mjs";
import { blocked, runStep } from "../audit/step.mjs";
import * as apiFloor from "./api-floor.mjs";
import * as preflight from "./preflight.mjs";
import * as scan from "./scan.mjs";
import * as stale from "./stale.mjs";

/** The steps a receipt must hold, in run order. `rx guard` requires every one. */
export const REQUIRED_STEPS = /** @type {const} */ (["greptile-rules", "stale", "scan", "preflight", "api-floor", "build", "tsc", "lint"]);

/** How long the greptile-rules step may take as a whole before gates continues on the copy in use. */
export const GREPTILE_RULES_DEADLINE_MS = 30_000;
let greptileRulesDeadlineMs = GREPTILE_RULES_DEADLINE_MS;

/**
 * Tests only: replace the greptile-rules step's deadline; returns the previous one.
 * @param {number} ms
 */
export function setGreptileRulesDeadline(ms) {
  const prev = greptileRulesDeadlineMs;
  greptileRulesDeadlineMs = ms;
  return prev;
}

/** The fingerprint fields no step may change between the start and the end of a run. */
export const TREE_FIELDS = /** @type {const} */ (["payload", "head", "publishRange", "preset", "forbidden"]);

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "gates",
  summary: "keep the Greptile rules current, run stale → scan → preflight → api-floor → build → tsc → lint and write the receipt rx guard requires",
  root: "required",
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root" },
    "--preset": { type: "string", value: "<file>", required: true, help: "preset JSON (passed to preflight and api-floor; its bytes are fingerprinted)" },
    "--forbidden": { type: "string", value: "<file>", required: true, help: "forbidden-values file for rx scan (its bytes are fingerprinted)" },
  },
  network: "greptile-rules' (GitHub API via gh: the latest raycast/extensions commit touching .greptile/ on main, then its .greptile/ contents when that differs from the copy in use); stale's (GitHub API, git fetch of raycast/extensions); api-floor's optional npm read; `npm run build` and `npm run lint` do whatever the project's scripts do. Never installs packages",
  state: "rotates $XDG_CONFIG_HOME/raycast-harness/generations/<root hash>.json first, then deletes and later writes repo/receipt.json { fingerprints, inputs, results, steps, data, subject, generation, greptileRules, rxVersion, at, attestation } (only when no step FAILed or ERRORed); writes a new Greptile rules copy under greptile/rules/ in the cross-repo cache when the live rules changed; reads repo/stale/; uses the cross-repo upstream/ cache; creates the attestation key $XDG_CONFIG_HOME/raycast-harness/attest.key on first need",
  checks: {
    "greptile-rules": { description: "the Greptile rules in use are current (PASS current), were updated to raycast/extensions main (PASS updated), or could not be checked (also when the step's 30 s deadline expires), failed validation or could not be installed (WARN; gates continues on the copy in use and the receipt records it); ERROR only when no copy of the rules can be loaded", levels: ["PASS", "WARN", "ERROR"] },
    ...stale.spec.checks,
    ...scan.spec.checks,
    ...preflight.spec.checks,
    ...apiFloor.spec.checks,
    "gates-tree-changed": "the payload, HEAD, publish range, preset and forbidden list are the same after the steps as before them (a build or lint that writes into the payload is a FAIL; no receipt)",
    "gates-rules-changed": { description: "the Greptile rules in use when the receipt is written are the snapshot the greptile-rules step reported and stamped (FAIL, no receipt, when another rx greptile update installed a copy while gates ran; ERROR when the rules can no longer be loaded)", levels: ["PASS", "FAIL", "ERROR"] },
    build: "`npm run build` exits 0 (first error lines in details on FAIL)",
    tsc: "`npx --no-install tsc --noEmit` exits 0 (first error lines in details on FAIL)",
    lint: "`npm run lint` exits 0 (first error lines in details on FAIL)",
    "attest-key": "ERROR when the attestation key exists but is unusable (not a regular file, not 32 bytes, accessible to group or other), or its directory or generations/ exists with group or other access; rx never replaces the key or chmods a directory it did not create",
  },
  data: {
    receipt: "string | null — the receipt path when written, null when a step blocked it",
    fingerprints: "{ payload, head, publishRange, preset, forbidden, rxVersion, baseline, combined }",
    steps: "[{ name, exit }] — every step in run order with its own exit code (0, 1, 2)",
    greptileRules: "{ repo, sha, digest } | null — the Greptile rules the receipt is bound to (null when they could not be loaded)",
  },
  examples: ["rx gates --preset presets/chrismessina.json --forbidden ../forbidden.txt"],
};

/** How many lines of tool output a FAIL detail carries. */
const DETAIL_LINES = 12;

/**
 * The first non-empty lines of a tool's output as details.
 * @param {string} stderr @param {string} stdout
 */
export function firstErrorLines(stderr, stdout) {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const out = lines.slice(0, DETAIL_LINES).map((text) => ({ text }));
  if (lines.length > DETAIL_LINES) out.push({ text: `… ${lines.length - DETAIL_LINES} more line(s)` });
  return out;
}

/** @param {string} root @returns {Record<string, string>} */
function readScripts(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const s = pkg?.scripts;
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

/**
 * Run one tool step (`build`, `tsc`, `lint`). A tool that cannot be found is `ERROR tooling`
 * (the dispatcher's id; nothing is installed), a non-zero exit is a FAIL with the first output
 * lines, exit 0 a PASS.
 * @param {"build" | "tsc" | "lint"} name
 * @param {string} root
 * @param {import("../verdict.mjs").Results} results
 * @param {NodeJS.ProcessEnv} env
 * @param {(s: string) => void} log
 */
async function toolStep(name, root, results, env, log) {
  const scripts = readScripts(root);
  if (!existsSync(join(root, "node_modules"))) {
    results.error("tooling", `${name}: ${join(root, "node_modules")} is missing; run npm install there (rx never installs)`);
    return;
  }
  /** @type {string} */
  let cmd;
  /** @type {string[]} */
  let args;
  if (name === "tsc") {
    if (!existsSync(join(root, "node_modules", ".bin", "tsc"))) {
      results.error("tooling", "tsc: node_modules/.bin/tsc is missing; add typescript to devDependencies and npm install (rx never installs)");
      return;
    }
    cmd = "npx";
    args = ["--no-install", "tsc", "--noEmit"];
  } else {
    if (typeof scripts[name] !== "string" || !scripts[name].trim()) {
      results.error("tooling", `${name}: package.json has no "${name}" script`);
      return;
    }
    cmd = "npm";
    args = ["run", name];
  }
  log(`gates: ${cmd} ${args.join(" ")}\n`);
  /** @type {import("../exec.mjs").ExecResult} */
  let r;
  try {
    r = await exec(cmd, args, { cwd: root, env, timeoutMs: 600_000 });
  } catch (e) {
    // ENOENT (npm/npx not on PATH), a timeout or a signal: the step did not complete.
    const message = e instanceof RxError ? e.message : /** @type {Error} */ (e).message;
    results.error("tooling", `${name}: ${message}`);
    return;
  }
  if (r.code === 0) results.pass(name, `${cmd} ${args.join(" ")} exit 0`);
  else results.fail(name, `${cmd} ${args.join(" ")} exit ${r.code}`, firstErrorLines(r.stderr, r.stdout));
}

/**
 * The `greptile-rules` step: bring the rules in use up to date (the routine `rx greptile update`
 * runs, bounded by the step's deadline) and return the stamp of exactly the snapshot it selected
 * and reported (never a reload), or null when no copy loads (an ERROR; no receipt). Never an
 * ERROR for a network, validation, write failure or an expired deadline.
 * @param {import("../verdict.mjs").Results} results @param {(s: string) => void} log
 * @returns {Promise<{ repo: string, sha: string, digest: string } | null>}
 */
async function greptileRulesStep(results, log) {
  /** @type {import("../greptile/update.mjs").UpdateOutcome} */
  let o;
  try {
    o = await updateWithin({ fetcher: transport(), warn: log, deadlineMs: greptileRulesDeadlineMs });
  } catch (e) {
    results.error("greptile-rules", `could not load the Greptile rules: ${/** @type {Error} */ (e).message}`);
    return null;
  }
  const using = `using ${o.before.source.kind} copy from ${o.before.source.fetched.slice(0, 10)}`;
  const details = o.changes.map((text) => ({ text }));
  switch (o.status) {
    case "unchecked":
      results.warn("greptile-rules", `could not check (offline or gh unavailable): ${using}`, [{ text: o.error }]);
      break;
    case "timed-out":
      results.warn("greptile-rules", `could not check within ${greptileRulesDeadlineMs / 1000} s: ${using}`, [{ text: o.error }]);
      break;
    case "invalid":
      results.warn("greptile-rules", `the live rules failed validation and were not installed: ${using}`, [{ text: o.error }]);
      break;
    case "write-failed":
      results.warn("greptile-rules", `could not install the live rules: ${using}`, [{ text: o.error }, ...details]);
      break;
    case "current":
      results.pass("greptile-rules", `current: ${describeRules(o.before.source)}`);
      break;
    case "not-in-use":
      results.warn("greptile-rules", notInUseMessage(o), details);
      break;
    default:
      results.pass("greptile-rules", updatedMessage(o), details);
  }
  return stampOf(o.selected);
}

/**
 * gates-rules-changed: the rules in use now are still the snapshot the greptile-rules step stamped.
 * @param {{ repo: string, sha: string, digest: string }} stamped
 * @param {import("../verdict.mjs").Results} results @param {(s: string) => void} log
 */
function checkRulesUnchanged(stamped, results, log) {
  /** @type {{ repo: string, sha: string, digest: string }} */
  let now;
  try {
    now = stampOf(loadGreptileRules({ warn: log }));
  } catch (e) {
    results.error("gates-rules-changed", `could not load the Greptile rules: ${/** @type {Error} */ (e).message}`);
    return;
  }
  if (sameGreptileRules(stamped, now)) results.pass("gates-rules-changed", "the Greptile rules in use are the ones the greptile-rules step reported");
  else results.fail("gates-rules-changed", `the Greptile rules changed while rx gates ran (${stampSha7(stamped)} → ${stampSha7(now)}); run rx gates again`);
}

/**
 * Called by the dispatcher when the arguments fail to parse (a missing `--forbidden`, an unknown
 * flag): the generation rotates and the previous receipt goes then too, as at the start of run().
 * @type {NonNullable<import("../cli.mjs").CommandModule["invalidate"]>}
 */
export async function invalidate({ root, log }) {
  if (!root) return;
  await rotateThenDelete(root, (receiptPath) => log(`gates: removed the previous receipt at ${receiptPath} (the arguments did not parse); run rx gates again\n`));
}

/**
 * Rotate this root's generation, then delete its receipt. The rotation comes first and needs no
 * git (the generation key is the root's realpath), so a git lookup or state-directory creation
 * that fails afterward cannot leave an old receipt/audit pair authorized. A rotation that fails
 * still deletes the receipt when the state path resolves, and its own error is the one reported.
 * `announce` runs right after an existing receipt is deleted, before any rotation error is rethrown.
 * @param {string} root
 * @param {(receiptPath: string) => void} announce
 * @returns {Promise<{ generation: string, receiptPath: string }>}
 */
async function rotateThenDelete(root, announce) {
  /** @type {string | undefined} */
  let generation;
  /** @type {unknown} */
  let rotationError;
  try {
    generation = rotateGeneration(root);
  } catch (e) {
    rotationError = e;
  }
  /** @type {string} */
  let receiptPath;
  try {
    receiptPath = await repoStatePath(root, "receipt.json");
    const existed = existsSync(receiptPath);
    rmSync(receiptPath, { force: true });
    if (existed) announce(receiptPath);
  } catch (e) {
    throw rotationError ?? e;
  }
  if (rotationError !== undefined) throw rotationError;
  return { generation: /** @type {string} */ (generation), receiptPath };
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  const { args, results, cwd, env, log, version } = ctx;
  const root = /** @type {string} */ (ctx.root);
  // 1. A new generation, then no receipt survives the start of a run: both before any input is
  //    even validated, and the rotation before any git call or state-directory creation, so a run
  //    that fails cannot leave an old authorization behind, and a receipt saved before this attempt
  //    cannot be restored into authority afterward. A rotation that fails (a config directory open
  //    to group or other) still deletes the receipt.
  const { generation, receiptPath } = await rotateThenDelete(root, (path) => log(`gates: removed the previous receipt at ${path}; a new one is written only when every step passes\n`));

  const presetPath = resolve(cwd, /** @type {string} */ (args.flags["--preset"]));
  const forbiddenPath = resolve(cwd, /** @type {string} */ (args.flags["--forbidden"]));
  for (const [flag, file] of [["--preset", presetPath], ["--forbidden", forbiddenPath]]) {
    if (!existsSync(file)) throw new RxError(`${flag} ${file} does not exist`, { id: "input" });
  }
  const key = loadOrCreateKey();

  /** @type {{ name: string, exit: number }[]} */
  const steps = [];
  const record = (/** @type {string} */ name, /** @type {import("../verdict.mjs").Results} */ r) => {
    steps.push({ name, exit: r.exit });
    results.merge(r);
  };

  // 2. The Greptile rules: current before anything is judged, and the stamp the receipt carries.
  //    Not a fingerprint field: the receipt holds it beside the fingerprints, and the guard
  //    compares it with the audit's and the rules in use (src/audit/greptile.mjs).
  const rulesRun = new Results();
  const greptileRules = await greptileRulesStep(rulesRun, log);
  record("greptile-rules", rulesRun);

  // The tree as it is before any step runs. Build and lint may write into the payload (generated
  // assets, an autofix); the receipt must describe what scan and preflight inspected, so the
  // fingerprint is taken again at the end and any difference is a FAIL with no receipt.
  const before = await computeFingerprints({ root, version, presetPath, forbiddenPath });

  // 3. The rx steps.
  const staleRun = await runStep(stale, ctx, { root, flags: { "--root": root } });
  record("stale", staleRun.results);
  const staleName = typeof staleRun.data.name === "string" ? staleRun.data.name : null;
  const published = staleRun.data.published === true && typeof staleRun.data.baseline === "string" && staleName !== null;
  const baseline = staleRun.data.published === true && typeof staleRun.data.baseline === "string" ? staleRun.data.baseline : staleRun.data.published === false ? "unpublished" : undefined;

  const scanRun = await runStep(scan, ctx, { root, flags: { "--root": root, "--forbidden": forbiddenPath } });
  record("scan", scanRun.results);

  /** @type {Record<string, string>} */
  const preflightFlags = { "--root": root, "--preset": presetPath };
  /** @type {Results} */
  let preflightResults;
  if (published) {
    // The copy stale compared, by its exact baseline: the service validates it and holds the
    // upstream lock for the whole preflight step. A cache that moved meanwhile is ERROR github.
    let entered = false;
    try {
      preflightResults = await withPublishedCopy({ name: /** @type {string} */ (staleName), expectedBaseline: /** @type {string} */ (staleRun.data.baseline) }, async (copy) => {
        entered = true;
        preflightFlags["--published"] = /** @type {string} */ (copy.directory);
        return (await runStep(preflight, ctx, { root, flags: preflightFlags })).results;
      });
    } catch (e) {
      if (entered || !(e instanceof RxError)) throw e;
      preflightResults = new Results();
      preflightResults.error(e.id, e.message);
    }
  } else preflightResults = (await runStep(preflight, ctx, { root, flags: preflightFlags })).results;
  record("preflight", preflightResults);

  const apiFloorRun = await runStep(apiFloor, ctx, { root, flags: { "--root": root, "--preset": presetPath } });
  record("api-floor", apiFloorRun.results);

  // 4. The tool steps, in the order the project needs them (build generates raycast-env.d.ts).
  for (const name of /** @type {const} */ (["build", "tsc", "lint"])) {
    const r = new Results();
    await toolStep(name, root, r, env, log);
    record(name, r);
  }

  // 5. Fingerprint again; a step that changed the tree fails the run (the baseline field is the
  //    one legitimate change: stale records it during the run).
  const fingerprints = await computeFingerprints({ root, version, presetPath, forbiddenPath, baseline });
  const changed = TREE_FIELDS.filter((k) => before[k] !== fingerprints[k]);
  if (changed.length) results.fail("gates-tree-changed", `${changed.join(", ")} changed while the steps ran; a step wrote into the payload (generated files, an autofix?), so scan and preflight did not see what would ship`, changed.map((k) => ({ text: `${k}: ${before[k].slice(0, 16)}… → ${fingerprints[k].slice(0, 16)}…` })));
  else results.pass("gates-tree-changed", "the tree is what the steps inspected");
  /** @type {string | null} */
  let receipt = null;
  // The receipt's last await. gates-rules-changed runs after it, synchronously, so nothing can
  // install a rules copy between the check and writeJsonAtomic.
  const subject = !blocked(results) && greptileRules ? await subjectOf(root) : null;
  if (greptileRules) checkRulesUnchanged(greptileRules, results, log);
  if (subject && !blocked(results) && greptileRules) {
    const doc = {
      fingerprints,
      inputs: { preset: presetPath, forbidden: forbiddenPath },
      results: results.items,
      steps: steps.map((s) => s.name),
      data: { stale: staleRun.data },
      subject,
      generation,
      // The Greptile rules this run brought current; `rx audit record` and `rx guard` require them.
      greptileRules,
      rxVersion: version,
      at: new Date().toISOString(),
    };
    writeJsonAtomic(receiptPath, attest(doc, key));
    receipt = receiptPath;
    log(`gates: receipt written to ${receiptPath}\n`);
  } else {
    log(`gates: no receipt (a step FAILed or ERRORed)\n`);
  }
  return { data: { receipt, fingerprints, steps, greptileRules }, fingerprint: fingerprints.combined };
}

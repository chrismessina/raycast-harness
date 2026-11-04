// `rx guard [--json]` (docs/commands.md §4.9): the plugin's PreToolUse hook. Reads the hook
// payload on stdin and decides whether a Bash command may run.
//
//   ready     the command's text mentions marking a PR ready for review (`gh pr ready`,
//             `gh api … draft=false` / `ready_for_review`, the GraphQL markPullRequestReadyForReview
//             mutation), in any quoting, anywhere in the line: always blocked; marking ready is
//             Chris's click.
//   publish   the WHOLE command is `npm run publish` or `ray publish`, optionally after exactly one
//             `cd <literal dir> &&` and before plain output redirections (the exact-shape allowlist
//             in src/audit/publish-command.mjs; there is no shell parser). Checked against the
//             extension that resolves from the `cd` directory, or from the payload's cwd. Allowed
//             only when, for that root, (a) repo/receipt.json exists and is well-formed
//             (src/audit/artifacts.mjs), (b) every fingerprint equals a fresh computation,
//             (c) every required step is present with its results and no FAIL / ERROR, and
//             (d) repo/audit.json exists, is well-formed, carries the same combined fingerprint and
//             its decision — RECOMPUTED here from the stored entries, dispositions, verifications
//             and evidence (src/audit/evaluate.mjs), never read from its `blocking` list — has no
//             blocking reason. Anything else blocks with one sentence naming what is missing or
//             stale.
//   unknown   the command's text mentions the word `publish` but is not one of those shapes
//             (`npm run "publish"`, `npx ray publish`, `FOO=1 npm run publish`, `(cd x); npm run
//             publish`, `git commit -m "ray publish"`, …): blocked, "write it as a plain command".
//             Words that only contain publish (`--published`, `--record-publication`) are not
//             mentions, so the plugin's own rx calls pass.
//   other     any other tool or command: allowed, silently.
//
// Hook transport — recorded from https://code.claude.com/docs/en/hooks (Claude Code hooks
// reference, "PreToolUse" and "Exit codes", read 2026-10-30) and
// https://code.claude.com/docs/en/plugins-reference (`hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`):
//   stdin   one JSON object: { session_id, transcript_path, cwd, hook_event_name: "PreToolUse",
//           tool_name, tool_input: { command, description, … }, tool_use_id, … }
//   allow   exit 0, nothing on stdout (stdout is parsed as JSON only when it is a single object)
//   block   exit 0 with one JSON object on stdout:
//           { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
//             "permissionDecisionReason": "<one sentence>" } }
//           `deny` prevents the tool call and the reason is shown to Claude. (The deprecated
//           top-level `decision: "block"` form still maps to deny; the exit-2-with-stderr form
//           blocks too but is not what this hook uses.) Precedence across hooks: deny > ask > allow.
//   wiring  `$WP/hooks/hooks.json`: { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
//           { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/rx.mjs",
//           "guard"], "onFailure": "block" } ] } ] } } — exec form (`args` present), the form the
//           docs recommend for a path placeholder; `CLAUDE_PLUGIN_ROOT` is also exported to the
//           process; `onFailure: "block"` (v2.1.295+) makes a hook that crashes block too.
// Without `--json` this command returns `transport: { stdout, exit }` for the dispatcher to write
// verbatim instead of verdict lines (the one documented exception to the verdict protocol: the
// host's transport wins). With `--json` the envelope carries `guard` as PASS (allow) / FAIL
// (block) / N/A (not a publish or ready command) and exits per the verdict, for tests.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { RxError } from "../errors.mjs";
import { computeFingerprints, diffFingerprints } from "../fingerprint.mjs";
import { loadPreset } from "../preset/load.mjs";
import { buildApplyContext, loadSources, readLockfile, readPublished } from "../preflight/context.mjs";
import { resolveRoot } from "../root.mjs";
import { repoStatePathReadOnly } from "../state.mjs";
import { validateAudit, validateReceipt } from "../audit/artifacts.mjs";
import { dispositionKey, parseEntries } from "../audit/entries.mjs";
import { applicableRules, decide as decideAudit, effectsOf, staleDispositions } from "../audit/evaluate.mjs";
import { readCommand } from "../audit/publish-command.mjs";

export const HOOKS_DOC_URL = "https://code.claude.com/docs/en/hooks";
export const PLUGINS_DOC_URL = "https://code.claude.com/docs/en/plugins-reference";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "guard",
  summary: "PreToolUse hook: allow `ray publish` / `npm run publish` only behind a current receipt and audit; always block `gh pr ready`",
  root: "none",
  network: "none",
  state: "reads repo/receipt.json and repo/audit.json of the extension that resolves from the publish command's directory (the hook payload's cwd, or the one `cd <dir> &&` the allowed shapes admit); creates nothing",
  checks: {
    guard: { description: "PASS allow / FAIL block (with the one-sentence reason) / N/A not a publish or ready command", levels: ["PASS", "FAIL", "N/A"] },
  },
  data: {
    decision: "\"allow\" | \"block\"",
    reason: "string — the sentence a block carries; \"allowed\" or why it was not a guarded command",
    command: "string | null — the Bash command examined",
    roots: "string[] — the extension root the publish resolved to (one element, or none when blocked before any state was read)",
    receipt: "{ present, fresh, complete } for the root checked; null until a root check begins (not a publish, blocked before any state was read, or no root resolves)",
    audit: "{ present, fresh, blocking } for the root checked; null on the same early returns as receipt",
  },
  examples: ["echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm run publish\"},\"cwd\":\".\"}' | rx guard --json"],
};

/** The JSON decision document Claude Code reads on a block. @param {string} reason */
export function denyDocument(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n";
}

/**
 * @typedef {{ present: boolean, fresh: boolean, complete: boolean }} ReceiptState
 * @typedef {{ present: boolean, fresh: boolean, blocking: boolean }} AuditState
 * @typedef {{ ok: boolean, reason: string, receipt: ReceiptState, audit: AuditState, fingerprint: string | null }} RootCheck
 */

/**
 * Conditions (a)–(d) for one extension root.
 * @param {string} root
 * @param {string} version
 * @returns {Promise<RootCheck>}
 */
export async function checkRoot(root, version) {
  const receiptState = { present: false, fresh: false, complete: false };
  const auditState = { present: false, fresh: false, blocking: true };
  /** @type {string | null} */
  let fp = null;
  const fail = (/** @type {string} */ reason) => ({ ok: false, reason, receipt: receiptState, audit: auditState, fingerprint: fp });

  /** @type {string} */
  let receiptPath;
  try {
    receiptPath = await repoStatePathReadOnly(root, "receipt.json");
  } catch (e) {
    return fail(`${root} has no rx state (${/** @type {Error} */ (e).message.split("\n")[0]}); it is not inside a git repository, so rx gates never ran there`);
  }
  if (!existsSync(receiptPath)) return fail(`no gates receipt at ${receiptPath}; run rx gates, then rx audit record`);
  /** @type {any} */
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (e) {
    return fail(`the receipt at ${receiptPath} is unreadable (${/** @type {Error} */ (e).message}); run rx gates again`);
  }
  const shape = validateReceipt(receipt, { version });
  if (shape) return fail(`${shape}; run rx gates again`);
  receiptState.present = true;

  const fresh = await computeFingerprints({ root, version, presetPath: receipt.inputs.preset, forbiddenPath: receipt.inputs.forbidden });
  fp = fresh.combined;
  const drift = diffFingerprints(receipt.fingerprints, fresh);
  if (drift.length) return fail(`the receipt is stale: ${drift.filter((d) => d !== "combined").join(", ") || "fingerprints"} changed since rx gates ran; run rx gates and rx audit record again`);
  receiptState.fresh = true;

  const bad = receipt.results.filter((/** @type {any} */ r) => r.verdict === "FAIL" || r.verdict === "ERROR");
  if (bad.length) return fail(`the receipt records ${bad.length} FAIL/ERROR result(s) (${[...new Set(bad.map((/** @type {any} */ r) => r.id))].slice(0, 5).join(", ")}); a receipt is only written clean, so this one was edited: run rx gates again`);
  receiptState.complete = true;

  const auditPath = await repoStatePathReadOnly(root, "audit.json");
  if (!existsSync(auditPath)) return fail(`no audit at ${auditPath}; run rx audit record`);
  /** @type {any} */
  let audit;
  try {
    audit = JSON.parse(readFileSync(auditPath, "utf8"));
  } catch (e) {
    return fail(`the audit at ${auditPath} is unreadable (${/** @type {Error} */ (e).message}); run rx audit record again`);
  }
  const auditShape = validateAudit(audit, { version });
  if (auditShape) return fail(`${auditShape}; run rx audit record again`);
  auditState.present = true;
  if (audit.fingerprint !== fresh.combined) return fail("the audit is tied to a different receipt than the current tree; run rx audit record again");
  auditState.fresh = true;

  // Recompute the decision from the parts. The preset is the receipt's; applicability and effects
  // come from the tree the fingerprint just proved unchanged.
  /** @type {import("../preset/load.mjs").LoadedPreset} */
  let loaded;
  try {
    loaded = loadPreset(receipt.inputs.preset, root);
  } catch (e) {
    return fail(`the preset the receipt names cannot be loaded (${/** @type {Error} */ (e).message.split("\n")[0]}); run rx gates again`);
  }
  /** @type {any} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (e) {
    return fail(`cannot read ${join(root, "package.json")}: ${/** @type {Error} */ (e).message}`);
  }
  const applyCtx = buildApplyContext({ pkg, owner: loaded.preset.owner, sources: loadSources(root), lock: readLockfile(root), published: await readPublished(root) });
  const applicable = applicableRules(loaded, applyCtx);
  const storedIds = new Set(audit.applicable.map((/** @type {any} */ a) => a.id));
  const liveIds = new Set(applicable.map((a) => a.id));
  if (storedIds.size !== liveIds.size || [...liveIds].some((id) => !storedIds.has(id))) return fail("the audit's applicable rules differ from what the preset and tree require now; run rx audit record again");
  const effects = effectsOf(applyCtx);

  // Required dispositions: stale rows from the receipt (independent of the audit), png OLDER-SHOT
  // rows from the audit's own record, cross-checked against its embedded png evidence.
  const stale = staleDispositions(receipt.data.stale);
  const storedStale = audit.required.filter((/** @type {any} */ r) => r.kind !== "OLDER-SHOT");
  const staleKeys = new Set(stale.map(dispositionKey));
  if (storedStale.length !== stale.length || storedStale.some((/** @type {any} */ r) => !staleKeys.has(dispositionKey(r)))) return fail("the audit's required dispositions do not match the receipt's stale CHECK / NEW? rows; run rx audit record again");
  const olderShots = audit.required.filter((/** @type {any} */ r) => r.kind === "OLDER-SHOT");
  const pngOlder = new Set(audit.evidence.png.filter((/** @type {any} */ r) => r.verdict === "WARN" && /OLDER-SHOT/.test(r.message)).map((/** @type {any} */ r) => r.details[0]?.file ?? ""));
  if (olderShots.length !== pngOlder.size || olderShots.some((/** @type {any} */ r) => !pngOlder.has(r.path))) return fail("the audit's png OLDER-SHOT dispositions do not match its png evidence; run rx audit record again");

  const parts = parseEntries([...audit.entries, ...audit.dispositions, ...audit.verifications], "audit.json");
  const d = decideAudit({ applicable, entries: parts.entries, dispositions: parts.dispositions, verifications: parts.verifications, required: [...olderShots, ...stale], effects, evidence: audit.evidence });
  if (d.blocking.length) return fail(`the audit carries ${d.blocking.length} blocking reason(s): ${d.blocking.slice(0, 3).join("; ")}${d.blocking.length > 3 ? "; …" : ""}`);
  auditState.blocking = false;
  return { ok: true, reason: "allowed: current receipt and audit", receipt: receiptState, audit: auditState, fingerprint: fp };
}

/**
 * Decide for a hook payload.
 * @param {any} payload the parsed hook payload
 * @param {string} version the running rx version
 * @returns {Promise<{ decision: "allow" | "block", guarded: boolean, reason: string, command: string | null, roots: string[], receipt: ReceiptState | null, audit: AuditState | null, fingerprint: string | null }>}
 */
export async function decide(payload, version) {
  const command = payload?.tool_name === "Bash" && typeof payload?.tool_input?.command === "string" ? payload.tool_input.command : null;
  /** @type {{ command: string | null, roots: string[], receipt: null, audit: null, fingerprint: null }} */
  const none = { command, roots: [], receipt: null, audit: null, fingerprint: null };
  if (command === null) return { decision: "allow", guarded: false, reason: `not a Bash command (tool ${JSON.stringify(payload?.tool_name ?? null)})`, ...none };

  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const read = readCommand(command, cwd);
  if (read.kind === "ready") return { decision: "block", guarded: true, reason: "marking a PR ready for review is Chris's click, not the agent's; leave it a draft and hand him the link", ...none };
  if (read.kind === "unknown") return { decision: "block", guarded: true, reason: `cannot determine what this command runs: ${read.reason}`, ...none };
  if (read.kind === "other") return { decision: "allow", guarded: false, reason: "not a publish or ready command", ...none };

  // The directory bash would publish from, physically: a `cd` into a symlink lands in the target's
  // repository, and the lexical parent of a symlink is not where npm looks for package.json. A
  // directory that does not exist blocks (bash's `cd` would fail and nothing would run; still, the
  // guard never guesses).
  if (!existsSync(read.dir)) return { decision: "block", guarded: true, reason: `publish blocked: the directory ${read.dir} does not exist`, ...none };
  const dir = realpathSync(read.dir);
  /** @type {string} */
  let root;
  try {
    root = resolveRoot({ cwd: dir });
  } catch (e) {
    return { decision: "block", guarded: true, reason: `publish blocked: no extension root resolves from ${dir} (${/** @type {Error} */ (e).message}); run rx gates from the extension and publish from there`, ...none };
  }
  const check = await checkRoot(root, version);
  const rest = { command, roots: [root], receipt: check.receipt, audit: check.audit, fingerprint: check.fingerprint };
  if (!check.ok) return { decision: "block", guarded: true, reason: `publish of ${root} blocked: ${check.reason}`, ...rest };
  return { decision: "allow", guarded: true, reason: `${check.reason} for ${root}`, ...rest };
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, results, stdin, log, version }) {
  const raw = await stdin();
  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new RxError(`hook payload on stdin is not JSON: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  if (payload === null || typeof payload !== "object") throw new RxError("hook payload on stdin is not a JSON object", { id: "input" });

  const d = await decide(payload, version);
  if (!d.guarded) results.na("guard", d.reason);
  else if (d.decision === "allow") results.pass("guard", d.reason);
  else results.fail("guard", d.reason);
  if (d.decision === "block") log(`rx guard: ${d.reason}\n`);

  const data = { decision: d.decision, reason: d.reason, command: d.command, roots: d.roots, receipt: d.receipt, audit: d.audit };
  /** @type {import("../cli.mjs").CommandOutput & { transport?: { stdout: string, exit: number } }} */
  const out = { data, fingerprint: d.fingerprint };
  // The hook transport (see the header). The dispatcher writes `transport.stdout` verbatim and
  // exits `transport.exit` when it is present and --json was not given.
  if (!args.json) out.transport = { stdout: d.decision === "block" ? denyDocument(d.reason) : "", exit: 0 };
  return out;
}

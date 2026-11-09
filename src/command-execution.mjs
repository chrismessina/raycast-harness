// The completion kernel: what it means for one command invocation to finish, shared by the
// dispatcher (src/cli.mjs) and the in-process step runner `gates` and `audit record` use
// (src/audit/step.mjs). Argument parsing, root resolution, invalidation on an argument error,
// help, output rendering and the hook transport stay the dispatcher's; the step arguments and
// their order stay the composite command's. Both share these rules (docs/commands.md §1, §3):
//
//   - results a command recorded before it threw are kept, and the throw is appended as one ERROR
//   - a command that returns with no result at all is `ERROR protocol` (silence is never a pass)
//   - a result whose id the command did not declare is `ERROR protocol` (validateCompletion)
//   - a thrown RxError is ERROR under its own id; any other throw is `ERROR internal`
//   - ERROR outranks FAIL (Results.exit, src/verdict.mjs)
//
// Per-command error policy (a judge provider outage becomes an advisory fallback, an npm currency
// failure N/A, a failed executable start ERROR) lives in the commands, never here.

import { RxError, firstLine } from "./errors.mjs";

/** Ids the dispatcher itself may emit; a command need not declare them. */
export const PROTOCOL_IDS = new Set(["args", "root", "input", "tooling", "github", "npm", "git", "protocol", "internal"]);

/**
 * How a throw is reported. The dispatcher and the step runner differ here, and the
 * difference is observable, so each keeps its own:
 *   - `logStack`: write the stack of a non-RxError throw to `log` (stderr). The dispatcher does;
 *     a step does not (its composite's own stderr carries no step stacks).
 *   - `contain`: when recording the ERROR itself throws (an RxError whose id is not a valid check
 *     id), record `ERROR internal error while reporting an error: …` instead. The dispatcher
 *     does; a step lets that throw escape to its composite, whose dispatcher then reports it.
 * @typedef {{ logStack: boolean, contain: boolean }} ErrorPolicy
 */

/** @type {Readonly<ErrorPolicy>} */
export const CLI_ERRORS = Object.freeze({ logStack: true, contain: true });
/** @type {Readonly<ErrorPolicy>} */
export const STEP_ERRORS = Object.freeze({ logStack: false, contain: false });

/**
 * Does `id` match a declared check id (exact, or a declared `prefix-*`)?
 * @param {string} id @param {Record<string, unknown>} checks
 */
export function declared(id, checks) {
  if (id in checks) return true;
  return Object.keys(checks).some((k) => k.endsWith("*") && id.startsWith(k.slice(0, -1)));
}

/**
 * The ids a (sub)command declares: the command's own checks plus the selected subcommand's.
 * @param {import("./cli.mjs").CommandSpec} spec @param {string | null | undefined} subcommand
 * @returns {Record<string, unknown>}
 */
export function declaredChecks(spec, subcommand) {
  const sub = subcommand && spec.subcommands ? spec.subcommands[subcommand] : null;
  return { ...(spec.checks ?? {}), ...(sub?.checks ?? {}) };
}

/**
 * The first result whose id is neither a protocol id nor declared, if any.
 * @param {import("./verdict.mjs").Results} results @param {Record<string, unknown>} checks
 */
export function strayResult(results, checks) {
  return results.items.find((r) => !PROTOCOL_IDS.has(r.id) && !declared(r.id, checks));
}

/**
 * The check-id registry: append one `ERROR protocol` when a result carries an undeclared id.
 * Returns whether it did.
 * @param {string} name the command name the message carries
 * @param {Record<string, unknown>} checks the declared ids (declaredChecks)
 * @param {import("./verdict.mjs").Results} results
 */
export function validateCompletion(name, checks, results) {
  const stray = strayResult(results, checks);
  if (stray) results.error("protocol", `${name} emitted undeclared check id ${JSON.stringify(stray.id)}; declare it in spec.checks and docs/commands.md`);
  return Boolean(stray);
}

/**
 * Silence is never a pass: append `ERROR protocol` when a command returned with no result.
 * @param {string} name @param {import("./verdict.mjs").Results} results
 */
export function requireResults(name, results) {
  if (results.items.length === 0) results.error("protocol", `${name} produced no results; silence is never a pass`);
}

/**
 * Turn any thrown value into one ERROR result (first line as the message, the rest as details).
 * An RxError keeps its id; anything else is `ERROR internal` with its name. With `policy.contain`
 * this never throws; without it, a failure to record the ERROR propagates.
 * @param {import("./verdict.mjs").Results} results
 * @param {unknown} e
 * @param {(s: string) => void} log
 * @param {ErrorPolicy} policy
 */
export function appendThrownError(results, e, log, policy) {
  try {
    const err = /** @type {Error & { id?: string }} */ (e);
    const lines = String(err?.message ?? String(e)).split(/\r?\n/).filter((l) => l.trim());
    const message = lines.shift()?.trim() ?? "(no message)";
    const details = lines.map((text) => ({ text: text.trim() }));
    if (e instanceof RxError) results.error(e.id, message, details);
    else {
      results.error("internal", `${err?.name ?? "Error"}: ${message}`, details);
      if (policy.logStack && err?.stack) log(err.stack + "\n");
    }
  } catch (inner) {
    if (!policy.contain) throw inner;
    results.items.push({ id: "internal", verdict: "ERROR", message: `error while reporting an error: ${firstLine(/** @type {Error} */ (inner).message)}`, details: [] });
  }
}

/**
 * @typedef {{
 *   threw: boolean,
 *   data: Record<string, unknown>,
 *   fingerprint: string | null,
 *   transport: { stdout: string, exit: number } | undefined,
 * }} Execution
 *   `transport` is passed through untouched for the dispatcher (the only caller that honors it).
 */

/**
 * Run one command module against a context the caller built, and complete it: a return with no
 * result is `ERROR protocol`; a throw keeps every result recorded before it and appends one ERROR
 * (appendThrownError). Never parses arguments, resolves a root or calls `invalidate`. The
 * declared-id check is the caller's (validateCompletion), because the dispatcher applies it to
 * every path to stdout, error paths before the run included.
 * @param {import("./cli.mjs").CommandModule} mod
 * @param {import("./cli.mjs").CommandContext} ctx
 * @param {ErrorPolicy} policy
 * @returns {Promise<Execution>}
 */
export async function executeCommand(mod, ctx, policy) {
  try {
    const out = await mod.run(ctx);
    requireResults(mod.spec.name, ctx.results);
    return { threw: false, data: out?.data ?? {}, fingerprint: out?.fingerprint ?? null, transport: out?.transport };
  } catch (e) {
    appendThrownError(ctx.results, e, ctx.log, policy);
    return { threw: true, data: {}, fingerprint: null, transport: undefined };
  }
}

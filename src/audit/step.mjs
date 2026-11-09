// Run another rx command in-process (docs/commands.md §4.8: `gates` and `audit record` run their
// steps by importing the modules and calling `run(ctx)`, never by spawning `rx`, so one process
// owns the state and the upstream lock). The run and its completion are the dispatcher's own
// kernel (src/command-execution.mjs): results recorded before a throw are kept, silence is
// `ERROR protocol`, a thrown RxError becomes one ERROR result under its own id and any other
// throw is `ERROR internal`. What a step never gets is the dispatcher's surroundings: no argument
// parsing, no root resolution, no `invalidate`, no output, and no hook transport (a returned
// `transport` is dropped).

import { STEP_ERRORS, executeCommand } from "../command-execution.mjs";
import { Results } from "../verdict.mjs";

/**
 * @typedef {{ results: Results, data: Record<string, unknown>, fingerprint: string | null }} StepOutcome
 */

/**
 * @param {import("../cli.mjs").CommandModule} mod
 * @param {import("../cli.mjs").CommandContext} parent the calling command's context (cwd, env, stdin, log, version)
 * @param {{
 *   root: string | null,
 *   flags?: Record<string, string | boolean | number | string[]>,
 *   subcommand?: string | null,
 * }} p
 *   A step's undeclared id is caught one level up: the composite merges the step's results and
 *   the dispatcher checks them against the composite's spec, which spreads every step's checks.
 *   Errors follow STEP_ERRORS (no stack on stderr; a failure to record the ERROR escapes to the
 *   composite).
 * @returns {Promise<StepOutcome>}
 */
export async function runStep(mod, parent, { root, flags = {}, subcommand = null }) {
  const results = new Results();
  /** @type {import("../cli.mjs").CommandContext} */
  const ctx = {
    args: { subcommand, positionals: {}, flags, json: false, help: false },
    root,
    cwd: parent.cwd,
    env: parent.env,
    results,
    stdin: parent.stdin,
    log: parent.log,
    version: parent.version,
  };
  const out = await executeCommand(mod, ctx, STEP_ERRORS);
  return { results, data: out.data, fingerprint: out.fingerprint };
}

/** Does a result set hold anything that blocks (FAIL or ERROR)? @param {Results} results */
export function blocked(results) {
  return results.has("FAIL") || results.has("ERROR");
}

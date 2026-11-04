// Run another rx command in-process (docs/commands.md §4.8: `gates` and `audit record` run their
// steps by importing the modules and calling `run(ctx)`, never by spawning `rx`, so one process
// owns the state and the upstream lock). A thrown RxError becomes one ERROR result under its own
// id, exactly as the dispatcher would report it; any other throw is `ERROR internal`.

import { RxError } from "../errors.mjs";
import { Results } from "../verdict.mjs";

/**
 * @typedef {{ results: Results, data: Record<string, unknown>, fingerprint: string | null }} StepOutcome
 */

/**
 * @param {import("../cli.mjs").CommandModule} mod
 * @param {import("../cli.mjs").CommandContext} parent the calling command's context (cwd, env, stdin, log, version)
 * @param {{ root: string | null, flags?: Record<string, string | boolean | number | string[]>, subcommand?: string | null }} p
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
  try {
    const out = await mod.run(ctx);
    if (results.items.length === 0) results.error("protocol", `${mod.spec.name} produced no results; silence is never a pass`);
    return { results, data: out?.data ?? {}, fingerprint: out?.fingerprint ?? null };
  } catch (e) {
    const err = /** @type {Error & { id?: string }} */ (e);
    const lines = String(err?.message ?? String(e)).split(/\r?\n/).filter((l) => l.trim());
    const message = lines.shift()?.trim() ?? "(no message)";
    const details = lines.map((text) => ({ text: text.trim() }));
    if (e instanceof RxError) results.error(e.id, message, details);
    else results.error("internal", `${err?.name ?? "Error"}: ${message}`, details);
    return { results, data: {}, fingerprint: null };
  }
}

/** Does a result set hold anything that blocks (FAIL or ERROR)? @param {Results} results */
export function blocked(results) {
  return results.has("FAIL") || results.has("ERROR");
}

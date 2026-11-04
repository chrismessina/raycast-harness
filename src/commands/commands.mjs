// `rx commands [--json]`: every command's contract, from the specs the dispatcher loaded.
// The plugin's CI validates each runner call's command and flags against this output, and
// `reference/rx.md` is generated from it.

import { GLOBAL_FLAGS } from "../args.mjs";
import { loadCommands } from "../cli.mjs";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "commands",
  summary: "list every command with its arguments, root rule, network boundary, state and data schema",
  root: "none",
  network: "none",
  state: "none",
  checks: { commands: "the command registry loaded" },
  data: { commands: "Command[] — { name, summary, root, network, state, positionals, flags, subcommands, checks, data }" },
};

/** @param {import("../args.mjs").ArgSchema} s @param {import("../args.mjs").ArgSchema} [parent] */
function describe(s, parent) {
  return {
    name: s.name,
    summary: s.summary,
    root: s.root ?? parent?.root ?? "none",
    network: s.network ?? parent?.network ?? "none",
    state: s.state ?? parent?.state ?? "none",
    positionals: s.positionals ?? [],
    flags: { ...(s.flags ?? {}), ...GLOBAL_FLAGS },
    subcommands: s.subcommands
      ? Object.fromEntries(Object.entries(s.subcommands).map(([n, sub]) => [n, describe({ ...sub, name: n }, s)]))
      : {},
    checks: { ...(parent?.checks ?? {}), ...(s.checks ?? {}) },
    data: s.data ?? parent?.data ?? {},
  };
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ results }) {
  const mods = await loadCommands();
  const commands = [...mods.values()].map((m) => describe(m.spec));
  results.pass("commands", `${commands.length} commands: ${commands.map((c) => c.name).join(", ")}`);
  return { data: { commands } };
}

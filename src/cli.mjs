// The dispatcher. Discovers commands from src/commands/*.mjs (each exports `spec` and `run`),
// parses arguments against the command's schema, resolves the extension root when the contract
// says the command takes one, runs the command, and emits results. Every failure path ends in
// an ERROR result and exit 2; nothing here calls process.exit.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { helpText, parseArgs } from "./args.mjs";
import { RxError } from "./errors.mjs";
import { resolveRoot } from "./root.mjs";
import { Results, emit } from "./verdict.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
export const VERSION = /** @type {string} */ (PKG.version);

/**
 * @typedef {import("./args.mjs").ArgSchema} CommandSpec
 * @typedef {{
 *   args: import("./args.mjs").ParsedArgs,
 *   root: string | null,
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   results: Results,
 *   stdin: () => Promise<string>,
 *   log: (s: string) => void,
 *   version: string,
 * }} CommandContext
 *   `root` is the resolved extension root (always set when spec.root is "required"; null when
 *   "optional" found none or "none"). `log` writes progress to stderr, never to stdout.
 * @typedef {{ data?: Record<string, unknown>, fingerprint?: string | null } | void} CommandOutput
 * @typedef {{ spec: CommandSpec, run: (ctx: CommandContext) => Promise<CommandOutput> }} CommandModule
 */

/** @returns {Promise<Map<string, CommandModule>>} */
export async function loadCommands() {
  const dir = join(HERE, "commands");
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).sort();
  /** @type {Map<string, CommandModule>} */
  const map = new Map();
  for (const f of files) {
    /** @type {CommandModule} */
    const mod = await import(pathToFileURL(join(dir, f)).href);
    if (!mod.spec?.name || typeof mod.run !== "function") throw new Error(`src/commands/${f} must export spec and run`);
    if (map.has(mod.spec.name)) throw new Error(`duplicate command ${mod.spec.name} in src/commands/${f}`);
    map.set(mod.spec.name, mod);
  }
  return map;
}

/** @param {() => Promise<string>} [stdinReader] */
function defaultStdin(stdinReader) {
  return stdinReader ?? (async () => {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  });
}

/**
 * Run the CLI. Returns the exit code; never calls process.exit.
 * @param {string[]} argv tokens after the program name
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdout?: (s: string) => void, stderr?: (s: string) => void, stdin?: () => Promise<string> }} [io]
 */
export async function runCli(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const write = io.stdout ?? ((s) => process.stdout.write(s));
  const log = io.stderr ?? ((s) => process.stderr.write(s));
  const commands = await loadCommands();

  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") {
    write(usage(commands));
    return name ? 0 : 2;
  }
  if (name === "--version" || name === "-v") {
    write(`${VERSION}\n`);
    return 0;
  }

  const json = rest.includes("--json");
  const results = new Results();
  const finish = (/** @type {Record<string, unknown>} */ data = {}, /** @type {string | null} */ fingerprint = null) =>
    emit({ command: name, version: VERSION, fingerprint, data, results, json, write });

  const mod = commands.get(name);
  if (!mod) {
    results.error("args", `unknown command ${JSON.stringify(name)}; run \`rx commands\``);
    return finish();
  }

  /** @type {import("./args.mjs").ParsedArgs} */
  let args;
  try {
    args = parseArgs(rest, mod.spec);
  } catch (e) {
    return fromError(e, results, finish, log);
  }
  if (args.help) {
    write(helpText(mod.spec, args.subcommand ?? undefined));
    return 0;
  }

  const sub = args.subcommand && mod.spec.subcommands ? mod.spec.subcommands[args.subcommand] : null;
  const rootMode = sub?.root ?? mod.spec.root ?? "none";
  /** @type {string | null} */
  let root = null;
  if (rootMode !== "none") {
    try {
      root = resolveRoot({ root: typeof args.flags["--root"] === "string" ? args.flags["--root"] : null, cwd });
    } catch (e) {
      // "optional" tolerates finding nothing, never ambiguity or a bad --root.
      const noneFound = e instanceof RxError && /no extension found/.test(e.message);
      if (!(rootMode === "optional" && noneFound)) return fromError(e, results, finish, log);
    }
  }

  try {
    const out = await mod.run({ args, root, cwd, env, results, stdin: defaultStdin(io.stdin), log, version: VERSION });
    if (results.items.length === 0) results.error("protocol", `${name} produced no results; silence is never a pass`);
    return finish(out?.data ?? {}, out?.fingerprint ?? null);
  } catch (e) {
    return fromError(e, results, finish, log);
  }
}

/**
 * @param {unknown} e
 * @param {Results} results
 * @param {(data?: Record<string, unknown>, fingerprint?: string | null) => number} finish
 * @param {(s: string) => void} log
 */
function fromError(e, results, finish, log) {
  if (e instanceof RxError) {
    results.error(e.id, e.message);
  } else {
    const err = /** @type {Error} */ (e);
    results.error("internal", `${err?.name ?? "Error"}: ${err?.message ?? String(e)}`);
    if (err?.stack) log(err.stack + "\n");
  }
  return finish();
}

/** @param {Map<string, CommandModule>} commands */
function usage(commands) {
  const lines = [`rx ${VERSION}: tested, explicit-verdict checks for Raycast extensions`, "", "Usage: rx <command> [args] [--json]", "", "Commands:"];
  const width = Math.max(...[...commands.keys()].map((k) => k.length));
  for (const [n, m] of commands) lines.push(`  ${n.padEnd(width)}  ${m.spec.summary}`);
  lines.push("", "Run `rx <command> --help` for its arguments, root rule, network boundary and state location.", "Verdicts: PASS FAIL WARN N/A ERROR; exit 0 = no FAIL/ERROR, 1 = FAIL, 2 = ERROR.");
  return lines.join("\n") + "\n";
}

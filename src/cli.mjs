// The dispatcher. Discovers commands from src/commands/*.mjs (each exports `spec` and `run`),
// parses arguments against the command's schema, resolves the extension root when the contract
// says the command takes one, runs the command, and emits results. Every failure path, including
// a command module that fails to load, ends in an ERROR result and exit 2; nothing here calls
// process.exit.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { helpText, parseArgs } from "./args.mjs";
import { RootError, RxError } from "./errors.mjs";
import { resolveRoot } from "./root.mjs";
import { Results, emit } from "./verdict.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
export const VERSION = /** @type {string} */ (PKG.version);

/** Ids the dispatcher itself may emit; a command need not declare them. */
export const PROTOCOL_IDS = new Set(["args", "root", "input", "tooling", "github", "npm", "git", "protocol", "internal"]);

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
 *   "optional" found none or "none"). A "none" command that needs a root from somewhere else
 *   (guard reads it from the hook payload) calls resolveRoot itself. `log` writes progress to
 *   stderr, never to stdout.
 * @typedef {{ data?: Record<string, unknown>, fingerprint?: string | null } | void} CommandOutput
 * @typedef {{ spec: CommandSpec, run: (ctx: CommandContext) => Promise<CommandOutput> }} CommandModule
 */

export const COMMANDS_DIR = join(HERE, "commands");

/**
 * @param {string} [dir] test-only override of the commands directory
 * @returns {Promise<Map<string, CommandModule>>}
 */
export async function loadCommands(dir = COMMANDS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).sort();
  /** @type {Map<string, CommandModule>} */
  const map = new Map();
  for (const f of files) {
    /** @type {CommandModule} */
    let mod;
    try {
      mod = await import(pathToFileURL(join(dir, f)).href);
    } catch (e) {
      throw new RxError(`command module ${f} failed to load: ${firstLine(/** @type {Error} */ (e).message)}`, { id: "protocol" });
    }
    if (!mod.spec?.name || typeof mod.run !== "function") throw new RxError(`command module ${f} must export spec and run`, { id: "protocol" });
    if (map.has(mod.spec.name)) throw new RxError(`duplicate command ${mod.spec.name} in ${f}`, { id: "protocol" });
    map.set(mod.spec.name, mod);
  }
  return map;
}

/** @param {string} s */
function firstLine(s) {
  return String(s ?? "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "(no message)";
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
 * Does `id` match a declared check id (exact, or a declared `prefix-*`)?
 * @param {string} id @param {Record<string, unknown>} checks
 */
export function declared(id, checks) {
  if (id in checks) return true;
  return Object.keys(checks).some((k) => k.endsWith("*") && id.startsWith(k.slice(0, -1)));
}

/**
 * Run the CLI. Returns the exit code; never calls process.exit.
 * @param {string[]} argv tokens after the program name
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdout?: (s: string) => void, stderr?: (s: string) => void, stdin?: () => Promise<string>, commandsDir?: string }} [io]
 *   `commandsDir` is a test-only override of where commands are discovered.
 */
export async function runCli(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const write = io.stdout ?? ((s) => process.stdout.write(s));
  const log = io.stderr ?? ((s) => process.stderr.write(s));

  const [name, ...rest] = argv;
  const results = new Results();
  const json = rest.includes("--json") || name === "--json";
  /** The ids this command declared; filled in once the (sub)command is known. */
  /** @type {Record<string, unknown>} */
  let checks = {};
  // Every path to stdout goes through here, so the check-id registry is enforced on completion
  // and on every error path alike.
  const finish = (/** @type {Record<string, unknown>} */ data = {}, /** @type {string | null} */ fingerprint = null) => {
    const stray = results.items.find((r) => !PROTOCOL_IDS.has(r.id) && !declared(r.id, checks));
    if (stray) results.error("protocol", `${name} emitted undeclared check id ${JSON.stringify(stray.id)}; declare it in spec.checks and docs/commands.md`);
    return emit({ command: name ?? "", version: VERSION, fingerprint, data, results, json, write });
  };

  /** @type {Map<string, CommandModule>} */
  let commands;
  try {
    commands = await loadCommands(io.commandsDir);
  } catch (e) {
    return fromError(e, results, finish, log);
  }

  // Informational paths. Unknown tokens are still errors; --json has no meaning here and is one too.
  if (!name || name === "--help" || name === "-h" || name === "--version" || name === "-v") {
    if (rest.length) {
      results.error("args", `unknown argument ${JSON.stringify(rest[0])}`);
      return finish();
    }
    if (name === "--version" || name === "-v") {
      write(`${VERSION}\n`);
      return 0;
    }
    write(usage(commands));
    return name ? 0 : 2;
  }

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
    if (args.json) {
      results.error("args", "--help prints text; it cannot be combined with --json");
      return finish();
    }
    write(helpText(mod.spec, args.subcommand ?? undefined));
    return 0;
  }

  const sub = args.subcommand && mod.spec.subcommands ? mod.spec.subcommands[args.subcommand] : null;
  checks = { ...(mod.spec.checks ?? {}), ...(sub?.checks ?? {}) };
  const rootMode = sub?.root ?? mod.spec.root ?? "none";
  /** @type {string | null} */
  let root = null;
  if (rootMode !== "none") {
    try {
      root = resolveRoot({ root: typeof args.flags["--root"] === "string" ? args.flags["--root"] : null, cwd });
    } catch (e) {
      // "optional" tolerates finding nothing, never ambiguity or a bad --root.
      if (!(rootMode === "optional" && e instanceof RootError && e.kind === "none")) return fromError(e, results, finish, log);
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
 * Turn any thrown value into one ERROR result (first line as the message, the rest as details)
 * without ever throwing itself.
 * @param {unknown} e
 * @param {Results} results
 * @param {(data?: Record<string, unknown>, fingerprint?: string | null) => number} finish
 * @param {(s: string) => void} log
 */
function fromError(e, results, finish, log) {
  try {
    const err = /** @type {Error & { id?: string }} */ (e);
    const lines = String(err?.message ?? String(e)).split(/\r?\n/).filter((l) => l.trim());
    const message = lines.shift()?.trim() ?? "(no message)";
    const details = lines.map((text) => ({ text: text.trim() }));
    if (e instanceof RxError) results.error(e.id, message, details);
    else {
      results.error("internal", `${err?.name ?? "Error"}: ${message}`, details);
      if (err?.stack) log(err.stack + "\n");
    }
  } catch (inner) {
    results.items.push({ id: "internal", verdict: "ERROR", message: `error while reporting an error: ${firstLine(/** @type {Error} */ (inner).message)}`, details: [] });
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

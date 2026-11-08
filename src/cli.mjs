// The dispatcher. Discovers commands from src/commands/*.mjs (each exports `spec` and `run`),
// parses arguments against the command's schema, resolves the extension root when the contract
// says the command takes one, runs the command, and emits results. Every failure path, including
// a command module that fails to load, ends in an ERROR result and exit 2; nothing here calls
// process.exit.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { helpText, parseArgs } from "./args.mjs";
import { ArgError, RootError, RxError } from "./errors.mjs";
import { CLI_ERRORS, appendThrownError, declaredChecks, executeCommand, strayResult, validateCompletion } from "./command-execution.mjs";
import { resolveRoot } from "./root.mjs";
import { FORMATS, emit } from "./output.mjs";
import { Results } from "./verdict.mjs";

// The completion kernel's registry helpers, re-exported where commands have always imported them.
export { PROTOCOL_IDS, declared } from "./command-execution.mjs";

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
 *   "optional" found none or "none"). A "none" command that needs a root from somewhere else
 *   (guard reads it from the hook payload) calls resolveRoot itself. `log` writes progress to
 *   stderr, never to stdout.
 * `transport` is the documented exception for `guard` (docs/commands.md §4.9 "Transport"): when present
 * and no output format was given (neither `--format` nor `--json`), the dispatcher writes `transport.stdout` verbatim and returns
 * `transport.exit` instead of rendering verdict lines. The check-id registry is still enforced.
 * @typedef {{ data?: Record<string, unknown>, fingerprint?: string | null, transport?: { stdout: string, exit: number } } | void} CommandOutput
 * `invalidate` is optional: a command whose run() begins by deleting a prior authorization
 * (`gates` → receipt.json, `audit record` → audit.json) exports it so that an argument error, which
 * the dispatcher reports BEFORE run() starts, deletes it too (docs/commands.md §4.8, §4.9). It is
 * called with the subcommand the parser selected and the root: resolved from cwd when no `--root`
 * was given, from the parsed `--root` value when exactly one was given and parsed, else null (an
 * explicit root that cannot be read names no repository); it is best-effort and its own failure is
 * never reported, so the arguments stay the only result. `--help` with `--json` is an `ERROR args` that is a help request: it
 * invalidates nothing.
 * @typedef {{ spec: CommandSpec, run: (ctx: CommandContext) => Promise<CommandOutput>, invalidate?: (ctx: { root: string | null, subcommand: string | null, cwd: string, log: (s: string) => void }) => Promise<void> }} CommandModule
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
    const mod = await importCommand(dir, f);
    if (map.has(mod.spec.name)) throw new RxError(`duplicate command ${mod.spec.name} in ${f}`, { id: "protocol" });
    map.set(mod.spec.name, mod);
  }
  return map;
}

/**
 * Import one command module file and check that it exports spec and run.
 * @param {string} dir @param {string} f the file name
 * @returns {Promise<CommandModule>}
 */
async function importCommand(dir, f) {
  /** @type {CommandModule} */
  let mod;
  try {
    mod = await import(pathToFileURL(join(dir, f)).href);
  } catch (e) {
    throw new RxError(`command module ${f} failed to load: ${firstLine(/** @type {Error} */ (e).message)}`, { id: "protocol" });
  }
  if (!mod.spec?.name || typeof mod.run !== "function") throw new RxError(`command module ${f} must export spec and run`, { id: "protocol" });
  return mod;
}

/** Commands that read the whole registry; the dispatcher loads every module for them. */
const REGISTRY_READERS = new Set(["commands", "preset"]);

/**
 * The registry the dispatcher needs for `name`: only `<name>.mjs` when that file exists and declares
 * that name, else every command (loadCommands, which also runs the registry-wide checks). Usage,
 * help, version and the registry readers always load everything.
 * @param {string | undefined} name
 * @param {string} [dir]
 * @returns {Promise<Map<string, CommandModule>>}
 */
async function commandsFor(name, dir = COMMANDS_DIR) {
  if (name && /^[a-z0-9][a-z0-9-]*$/.test(name) && !REGISTRY_READERS.has(name) && existsSync(join(dir, `${name}.mjs`))) {
    const mod = await importCommand(dir, `${name}.mjs`);
    if (mod.spec.name === name) return new Map([[name, mod]]);
  }
  return loadCommands(dir);
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
  // The format for output produced before the arguments parse (a module that fails to load, an
  // unknown command, an argument error); once they parse, the parsed format replaces it.
  /** @type {import("./output.mjs").Format} */
  let format = requestedFormat(argv);
  /** The ids this command declared; filled in once the (sub)command is known. */
  /** @type {Record<string, unknown>} */
  let checks = {};
  // Every path to stdout goes through here, so the check-id registry is enforced on completion
  // and on every error path alike (src/command-execution.mjs validateCompletion).
  const finish = (/** @type {Record<string, unknown>} */ data = {}, /** @type {string | null} */ fingerprint = null) => {
    validateCompletion(String(name), checks, results);
    return emit({ command: name ?? "", version: VERSION, fingerprint, data, results, format, write });
  };

  /** @type {Map<string, CommandModule>} */
  let commands;
  try {
    commands = await commandsFor(name, io.commandsDir);
  } catch (e) {
    return fromError(e, results, finish, log);
  }

  // Informational paths. Unknown tokens are still errors; --json and --format have no meaning here
  // and are errors too.
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
    if (mod.invalidate && e instanceof ArgError) await invalidateOnArgError(mod, e, rest, cwd, log);
    return fromError(e, results, finish, log);
  }
  format = args.format ?? "text";
  if (args.help) {
    if (format !== "text") {
      const given = rest.includes("--json") ? "--json" : `--format ${format}`;
      results.error("args", `--help prints text; it cannot be combined with ${given}`);
      return finish();
    }
    write(helpText(mod.spec, args.subcommand ?? undefined));
    return 0;
  }

  const sub = args.subcommand && mod.spec.subcommands ? mod.spec.subcommands[args.subcommand] : null;
  checks = declaredChecks(mod.spec, args.subcommand);
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

  // The run and its completion are the shared kernel's (src/command-execution.mjs); what happens
  // to stdout afterwards, the hook transport included, is the dispatcher's. Rendering stays inside
  // this try so that output that cannot be rendered is itself reported as an ERROR.
  /** @type {Awaited<ReturnType<typeof executeCommand>>} */
  let out;
  try {
    out = await executeCommand(mod, { args, root, cwd, env, results, stdin: defaultStdin(io.stdin), log, version: VERSION }, CLI_ERRORS);
    if (!out.threw) {
      if (out.transport && !args.format) {
        const stray = strayResult(results, checks);
        // A protocol error outranks the transport: the ERROR line prints and exit 2 blocks the hook.
        if (stray) return finish(out.data, out.fingerprint);
        if (out.transport.stdout) write(out.transport.stdout);
        return out.transport.exit;
      }
      return finish(out.data, out.fingerprint);
    }
  } catch (e) {
    return fromError(e, results, finish, log);
  }
  // The command threw and the kernel already recorded the ERROR. Its report is rendered outside the
  // catch above, as the dispatcher always did: output that fails while reporting an error escapes
  // after one write attempt instead of being reported a second time.
  return finish(out.data, out.fingerprint);
}

/**
 * Call a module's `invalidate` after its arguments failed to parse. The parser's own partial result
 * (`ArgError.partial`) says which subcommand it selected and which flags it parsed before throwing,
 * so this never re-derives either. The root: when no `--root` token was given at all, the one that
 * resolves from cwd; when exactly one was given and the parser parsed its value, that one; in every
 * other case (an empty, missing or never-parsed value, or two `--root` tokens) null, because an
 * explicit root that cannot be read names no repository and the cwd's is never the fallback.
 * @param {CommandModule} mod
 * @param {ArgError} e
 * @param {string[]} rest
 * @param {string} cwd
 * @param {(s: string) => void} log
 */
async function invalidateOnArgError(mod, e, rest, cwd, log) {
  const partial = e.partial;
  const rootTokens = rest.filter((t) => t === "--root" || t.startsWith("--root=")).length;
  const parsedRoot = partial && typeof partial.flags["--root"] === "string" ? partial.flags["--root"] : null;
  /** @type {string | null} */
  let root = null;
  try {
    if (rootTokens === 0) root = resolveRoot({ cwd });
    else if (rootTokens === 1 && parsedRoot) root = resolveRoot({ root: parsedRoot, cwd });
  } catch {
    // No root resolves: nothing to invalidate.
  }
  try {
    await /** @type {NonNullable<CommandModule["invalidate"]>} */ (mod.invalidate)({ root, subcommand: partial?.subcommand ?? null, cwd, log });
  } catch {
    // Best-effort: the argument error is the result; a failed deletion must not hide it.
  }
}

/**
 * Turn any thrown value into one ERROR result under the dispatcher's error policy (stack logged,
 * never throws; src/command-execution.mjs appendThrownError) and print.
 * @param {unknown} e
 * @param {Results} results
 * @param {(data?: Record<string, unknown>, fingerprint?: string | null) => number} finish
 * @param {(s: string) => void} log
 */
function fromError(e, results, finish, log) {
  appendThrownError(results, e, log, CLI_ERRORS);
  return finish();
}

/**
 * The output format the raw tokens ask for, for output written before they parse: JSON whenever
 * `--json` is among them (an argument error a JSON consumer causes still reaches it as an envelope),
 * else the last valid `--format` value, else text. A conflicting or invalid pair is the parser's
 * ERROR to report; this only picks how that ERROR prints.
 * @param {string[]} argv
 * @returns {import("./output.mjs").Format}
 */
export function requestedFormat(argv) {
  if (argv.includes("--json")) return "json";
  /** @type {import("./output.mjs").Format} */
  let found = "text";
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const value = t === "--format" ? argv[i + 1] : t.startsWith("--format=") ? t.slice("--format=".length) : undefined;
    if (value !== undefined && (/** @type {readonly string[]} */ (FORMATS)).includes(value)) found = /** @type {import("./output.mjs").Format} */ (value);
  }
  return found;
}

/** @param {Map<string, CommandModule>} commands */
function usage(commands) {
  const lines = [`rx ${VERSION}: tested, explicit-verdict checks for Raycast extensions`, "", "Usage: rx <command> [args] [--json]", "", "Commands:"];
  const width = Math.max(...[...commands.keys()].map((k) => k.length));
  for (const [n, m] of commands) lines.push(`  ${n.padEnd(width)}  ${m.spec.summary}`);
  lines.push("", "Run `rx <command> --help` for its arguments, root rule, network boundary and state location.", "Verdicts: PASS FAIL WARN N/A ERROR; exit 0 = no FAIL/ERROR, 1 = FAIL, 2 = ERROR.");
  return lines.join("\n") + "\n";
}

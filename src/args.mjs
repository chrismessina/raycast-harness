// Argument parsing for every command, from a declared schema. Unknown arguments, missing values
// and missing required inputs throw ArgError (ERROR, exit 2): the legacy scripts silently ignored
// unknown flags, so a zsh word-splitting accident (`--published "$X"` arriving as one argument)
// passed as a clean run. Here it is a hard stop.

import { ArgError } from "./errors.mjs";
import { FORMATS } from "./output.mjs";

/**
 * @typedef {{ name: string, required?: boolean, help: string }} Positional
 * @typedef {{ type: "string" | "boolean" | "int", required?: boolean, repeat?: boolean, help: string, value?: string }} Flag
 *   `value` is the placeholder in --help, e.g. "<dir>".
 * @typedef {{
 *   name: string,
 *   summary: string,
 *   positionals?: Positional[],
 *   flags?: Record<string, Flag>,
 *   subcommands?: Record<string, ArgSchema>,
 *   root?: "required" | "optional" | "none",
 *   network?: string,
 *   state?: string,
 *   data?: Record<string, unknown>,
 *   checks?: Record<string, string | { description: string, levels: Array<"PASS" | "FAIL" | "WARN" | "N/A" | "ERROR"> }>,
 *   examples?: string[],
 * }} ArgSchema
 *   `checks` declares every check id the command may emit (`"stale-*"` declares a prefix); the
 *   dispatcher rejects an undeclared id as `ERROR protocol`, and `rx preset check` validates rx
 *   bindings against it. A value may be the description string or `{ description, levels }`;
 *   `levels` lists the verdicts the check can produce. Absent `levels` means the check is
 *   assumed able to FAIL (so a report-only preset rule may not bind it); an advisory check
 *   declares `levels: ["PASS", "WARN", "N/A"]` to be bindable by a report rule. `root`, `network`, `state`, `data` describe the contract (docs/commands.md) and are reported
 *   by `rx commands --json`; a subcommand inherits them from its parent unless it sets its own.
 * @typedef {{
 *   subcommand: string | null,
 *   positionals: Record<string, string>,
 *   flags: Record<string, string | boolean | number | string[]>,
 *   json: boolean,
 *   format?: import("./output.mjs").Format | null,
 *   help: boolean,
 * }} ParsedArgs
 *   `format` is the output format the arguments asked for, or null (or absent) when neither
 *   `--format` nor `--json` was given, which means text. `--json` is an exact alias of
 *   `--format json`: either sets `json: true` and `format: "json"`.
 */

/** Accepted by every command and never listed in a schema. */
export const GLOBAL_FLAGS = /** @type {Record<string, Flag>} */ ({
  "--json": { type: "boolean", help: "print the JSON envelope instead of verdict lines (same as --format json)" },
  "--format": { type: "string", value: "<text|json|md>", help: "output format: text (verdict lines, the default), json (the envelope) or md (a Markdown report of the results)" },
  "--help": { type: "boolean", help: "show this help" },
});

/**
 * @param {string[]} argv tokens after the command name
 * @param {ArgSchema} schema
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, schema) {
  /** @type {ParsedArgs} */
  const out = { subcommand: null, positionals: {}, flags: {}, json: false, format: null, help: false };
  try {
    return parse(argv, schema, out);
  } catch (e) {
    if (e instanceof ArgError) e.partial = out;
    throw e;
  }
}

/**
 * @param {string[]} argv
 * @param {ArgSchema} schema
 * @param {ParsedArgs} out filled progressively, so an ArgError can carry what was parsed before it
 * @returns {ParsedArgs}
 */
function parse(argv, schema, out) {
  const tokens = [...argv];

  if (!schema.subcommands) {
    parseTokens(tokens, { ...GLOBAL_FLAGS, ...(schema.flags ?? {}) }, schema.positionals ?? [], out);
    if (out.help) return out; // --help waives only the missing-required checks; every token was validated
    requireInputs(schema, out);
    return out;
  }

  // A command with subcommands takes the subcommand as its first non-flag token that is not the
  // value of a preceding valued flag (`audit --root /path show` selects `show`, not `/path`).
  const names = Object.keys(schema.subcommands);
  const everyFlag = { ...GLOBAL_FLAGS, ...(schema.flags ?? {}) };
  for (const sub of Object.values(schema.subcommands)) for (const [n, f] of Object.entries(sub.flags ?? {})) everyFlag[n] ??= f;
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) break;
    const def = everyFlag[t.split("=")[0]];
    if (def && def.type !== "boolean" && !t.includes("=")) i++; // skip the flag's value
  }
  if (i >= tokens.length) {
    // No subcommand. Validate every token against the union of flags the same way a subcommand
    // would, so duplicates, missing values and unknown names are still errors; then either help
    // or "needs a subcommand".
    parseTokens(tokens, everyFlag, [], out);
    if (out.help) return out;
    throw new ArgError(`${schema.name} needs a subcommand: ${names.join(", ")}`);
  }
  const sub = tokens.splice(i, 1)[0];
  if (!names.includes(sub)) throw new ArgError(`unknown ${schema.name} subcommand ${JSON.stringify(sub)}; expected one of ${names.join(", ")}`);
  out.subcommand = sub;
  const active = schema.subcommands[sub];
  parseTokens(tokens, { ...GLOBAL_FLAGS, ...(active.flags ?? {}) }, active.positionals ?? [], out);
  if (out.help) return out;
  requireInputs(active, out);
  return out;
}

/**
 * The one flag/positional loop. Throws ArgError on anything the schema does not declare.
 * @param {string[]} tokens
 * @param {Record<string, Flag>} flags
 * @param {Positional[]} positionals
 * @param {ParsedArgs} out
 */
function parseTokens(tokens, flags, positionals, out) {
  /** @type {Set<string>} */
  const seen = new Set();
  let pi = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("--")) {
      let name = tok;
      /** @type {string | undefined} */
      let inline;
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        name = tok.slice(0, eq);
        inline = tok.slice(eq + 1);
      }
      const def = flags[name];
      if (!def) throw new ArgError(`unknown argument ${JSON.stringify(tok)}`);
      if (seen.has(name) && !def.repeat) throw new ArgError(`${name} given twice`);
      seen.add(name);
      if (def.type === "boolean") {
        if (inline !== undefined) throw new ArgError(`${name} takes no value`);
        if (name === "--json") setFormat(out, "--json", "json");
        else if (name === "--help") out.help = true;
        else out.flags[name] = true;
        continue;
      }
      let value = inline;
      if (value === undefined) {
        if (i + 1 >= tokens.length) throw new ArgError(`${name} needs a value`);
        value = tokens[++i];
      }
      if (value === "" || /^\s+$/.test(value)) throw new ArgError(`${name} has an empty value (an unset shell variable?)`);
      if (value.startsWith("--") && !inline) throw new ArgError(`${name} needs a value, got ${JSON.stringify(value)}`);
      /** @type {string | number} */
      let v = value;
      if (name === "--format") {
        if (!(/** @type {readonly string[]} */ (FORMATS)).includes(value)) throw new ArgError(`--format must be one of ${FORMATS.join(", ")}, got ${JSON.stringify(value)}`);
        setFormat(out, `--format ${value}`, /** @type {import("./output.mjs").Format} */ (value));
        continue;
      }
      if (def.type === "int") {
        if (!/^\d+$/.test(value)) throw new ArgError(`${name} must be an integer, got ${JSON.stringify(value)}`);
        v = Number(value);
      }
      if (def.repeat) {
        const prev = out.flags[name];
        out.flags[name] = Array.isArray(prev) ? [...prev, String(v)] : [String(v)];
      } else {
        out.flags[name] = v;
      }
      continue;
    }
    // A stray "-x" short flag is not something any rx command accepts.
    if (/^-[^-]/.test(tok)) throw new ArgError(`unknown argument ${JSON.stringify(tok)}`);
    const def = positionals[pi++];
    if (!def) throw new ArgError(`unexpected argument ${JSON.stringify(tok)}`);
    if (tok === "") throw new ArgError(`<${def.name}> is empty (an unset shell variable?)`);
    out.positionals[def.name] = tok;
  }
}

/**
 * Record the output format one flag asked for. `--json` is `--format json`, so the two agree only
 * on json; any other pairing is an ArgError naming both flags.
 * @param {ParsedArgs} out @param {string} given the flag as typed, e.g. "--format md"
 * @param {import("./output.mjs").Format} format
 */
function setFormat(out, given, format) {
  if (out.format && out.format !== format) {
    const other = out.json ? "--json" : `--format ${out.format}`;
    throw new ArgError(`${other} and ${given} conflict: --json is --format json; give one output format`);
  }
  out.format = format;
  if (format === "json") out.json = true;
}

/** @param {ArgSchema} active @param {ParsedArgs} out */
function requireInputs(active, out) {
  for (const p of active.positionals ?? []) if (p.required && !(p.name in out.positionals)) throw new ArgError(`missing <${p.name}>`);
  for (const [name, def] of Object.entries(active.flags ?? {})) if (def.required && !(name in out.flags)) throw new ArgError(`missing ${name}`);
}

/**
 * --help text for a command or one of its subcommands.
 * @param {ArgSchema} schema
 * @param {string} [sub]
 */
export function helpText(schema, sub) {
  const active = sub && schema.subcommands ? schema.subcommands[sub] : schema;
  const lines = [];
  const name = sub ? `${schema.name} ${sub}` : schema.name;
  lines.push(`rx ${name}: ${active.summary}`, "");
  if (!sub && schema.subcommands) {
    lines.push("Subcommands:");
    for (const [n, s] of Object.entries(schema.subcommands)) lines.push(`  ${n.padEnd(12)} ${s.summary}`);
    lines.push("", `Run \`rx ${schema.name} <subcommand> --help\` for one subcommand.`);
  } else {
    const pos = (active.positionals ?? []).map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`)).join(" ");
    const fl = Object.entries(active.flags ?? {})
      .map(([n, f]) => {
        const v = f.type === "boolean" ? "" : ` ${f.value ?? "<value>"}`;
        return f.required ? `${n}${v}` : `[${n}${v}]`;
      })
      .join(" ");
    lines.push(`Usage: rx ${name} ${[pos, fl, "[--json]"].filter(Boolean).join(" ")}`, "");
    if (active.positionals?.length) {
      lines.push("Arguments:");
      for (const p of active.positionals) lines.push(`  <${p.name}>`.padEnd(26) + p.help);
      lines.push("");
    }
    const all = { ...(active.flags ?? {}), ...GLOBAL_FLAGS };
    lines.push("Flags:");
    for (const [n, f] of Object.entries(all)) {
      const v = f.type === "boolean" ? "" : ` ${f.value ?? "<value>"}`;
      lines.push(`  ${n}${v}`.padEnd(26) + f.help + (f.required ? " (required)" : "") + (f.repeat ? " (repeatable)" : ""));
    }
  }
  const root = active.root ?? schema.root ?? "none";
  const network = active.network ?? schema.network;
  const state = active.state ?? schema.state;
  lines.push("", `Root:    ${describeRoot(root)}`);
  if (network) lines.push(`Network: ${network}`);
  if (state) lines.push(`State:   ${state}`);
  if (active.examples?.length) lines.push("", "Examples:", ...active.examples.map((e) => `  ${e}`));
  return lines.join("\n") + "\n";
}

/** @param {"required" | "optional" | "none"} root */
function describeRoot(root) {
  if (root === "none") return "not an extension command";
  const how = "--root <dir> wins; otherwise the nearest package.json with a `commands` array walking up from cwd, else one level down; more than one candidate is an ERROR";
  return root === "required" ? how : `optional; ${how}`;
}

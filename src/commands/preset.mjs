// `rx preset check <file>` and `rx preset table <file> --into <reference.md> [--check]` (plan 4.16).

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { declared, loadCommands } from "../cli.mjs";
import { RootError, RxError } from "../errors.mjs";
import { CHECKS } from "../preflight/catalog.mjs";
import { render } from "../preset/applies.mjs";
import { index, readPreset, resolveAnchor } from "../preset/load.mjs";
import { resolveRoot } from "../root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let eslintPlugin = join(HERE, "..", "..", "eslint-plugin", "index.mjs");
/** Test hook: point the ESLint registry elsewhere (a missing file exercises the ERROR path). @param {string} path */
export function _setEslintPlugin(path) { eslintPlugin = path; }
const DECISIONS = join(HERE, "..", "judge", "decisions");
export const MATRIX_START = "<!-- rx:matrix:start -->";
export const MATRIX_END = "<!-- rx:matrix:end -->";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "preset",
  summary: "validate a preset (check) or regenerate the audit matrix it describes (table)",
  root: "none",
  network: "none",
  state: "table rewrites the region between <!-- rx:matrix:start --> and <!-- rx:matrix:end --> in --into (compare only with --check)",
  subcommands: {
    check: {
      name: "check",
      summary: "schema, duplicate ids, anchors, bindings against their registries, severity downgrades",
      positionals: [{ name: "file", required: true, help: "preset JSON" }],
      checks: {
        "preset-schema": "valid against schema/preset.schema.json; unknown fields rejected",
        "preset-ids": "no duplicate rule ids",
        "preset-anchors": "every anchor resolves to a section in its reference file",
        "preset-bindings": "a non-build rule has a binding; each binding exists in its own registry (rx checks, ESLint rules, judgment decisions)",
        "preset-severity": "no report-severity rule binds a core check that would FAIL (it would downgrade a Store failure)",
      },
      data: { rules: "number", bindings: "{ rx, eslint, judgment }", errors: "string[]", eslintRegistry: "\"present\" | \"absent\"" },
    },
    table: {
      name: "table",
      summary: "regenerate the audit matrix region in a reference file from the preset",
      positionals: [{ name: "file", required: true, help: "preset JSON" }],
      flags: {
        "--into": { type: "string", value: "<reference.md>", required: true, help: "the reference file holding the rx:matrix markers" },
        "--check": { type: "boolean", help: "compare only; FAIL when the region differs" },
      },
      checks: { "preset-table": "the matrix region is written (or, with --check, identical)" },
      data: { rows: "number", changed: "boolean" },
    },
  },
};

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  if (ctx.args.subcommand === "check") return check(ctx);
  return table(ctx);
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function check({ args, cwd, results }) {
  const path = resolve(cwd, args.positionals.file);
  const { preset, errors } = readPreset(path);
  if (errors.length) {
    results.fail("preset-schema", `${errors.length} schema error${errors.length === 1 ? "" : "s"}`, errors.map((e) => ({ text: `${e.path}: ${e.message}` })));
    for (const id of ["preset-ids", "preset-anchors", "preset-bindings", "preset-severity"]) results.na(id, "schema invalid; fix preset-schema first");
    return { data: { rules: 0, bindings: { rx: 0, eslint: 0, judgment: 0 }, errors: errors.map((e) => `${e.path}: ${e.message}`), eslintRegistry: "unknown" } };
  }
  results.pass("preset-schema", "valid against schema/preset.schema.json");
  const loaded = index(path, /** @type {import("../preset/load.mjs").Preset} */ (preset));
  const rules = loaded.preset.rules;

  // ids
  const seen = new Map();
  /** @type {string[]} */
  const dupes = [];
  for (const r of rules) { if (seen.has(r.id)) dupes.push(r.id); seen.set(r.id, true); }
  if (dupes.length) results.fail("preset-ids", `duplicate rule id${dupes.length === 1 ? "" : "s"}: ${[...new Set(dupes)].join(", ")}`);
  else results.pass("preset-ids", `${rules.length} unique rule ids`);

  // anchors
  const cache = new Map();
  const badAnchors = rules.filter((r) => { const a = resolveAnchor(r.anchor, path, cache); return !a.exists || a.line === null; });
  if (badAnchors.length) results.fail("preset-anchors", `${badAnchors.length} anchor${badAnchors.length === 1 ? "" : "s"} do not resolve`, badAnchors.map((r) => ({ text: `${r.id}: ${r.anchor}` })));
  else results.pass("preset-anchors", `${rules.length} anchors resolve`);

  // bindings against their registries
  const commands = await loadCommands();
  /** @type {Record<string, string | { description: string, levels: string[] }>} */
  const rxChecks = {};
  for (const m of commands.values()) {
    Object.assign(rxChecks, m.spec.checks ?? {});
    for (const sub of Object.values(m.spec.subcommands ?? {})) Object.assign(rxChecks, sub.checks ?? {});
  }
  // The ESLint registry is loaded only when the preset has eslint bindings; a registry the preset
  // needs that cannot be loaded is ERROR preset-bindings (never a silent pass).
  const needsEslint = rules.some((r) => r.bindings.some((b) => b.kind === "eslint"));
  /** @type {Set<string> | null} */
  let eslintRules = null;
  if (needsEslint) {
    if (!existsSync(eslintPlugin)) throw new RxError(`the preset has eslint bindings but the ESLint plugin registry ${eslintPlugin} is not present`, { id: "preset-bindings" });
    try {
      const plugin = await import(pathToFileURL(eslintPlugin).href);
      const rulesObj = plugin.default?.rules ?? plugin.rules;
      if (!rulesObj || typeof rulesObj !== "object") throw new Error("the module exports no `rules` object");
      eslintRules = new Set(Object.keys(rulesObj));
    } catch (e) {
      if (e instanceof RxError) throw e;
      throw new RxError(`the ESLint plugin registry ${eslintPlugin} failed to load: ${/** @type {Error} */ (e).message}`, { id: "preset-bindings" });
    }
  }
  const judgmentIds = new Set((loaded.preset.judgments ?? []).map((j) => j.id));
  const counts = { rx: 0, eslint: 0, judgment: 0 };
  /** @type {import("../verdict.mjs").Detail[]} */
  const bad = [];
  for (const r of rules) {
    if (r.tag !== "build" && r.bindings.length === 0) bad.push({ text: `${r.id}: a ${r.tag} rule has no binding` });
    for (const b of r.bindings) {
      counts[b.kind]++;
      if (b.kind === "rx" && !declared(b.check, rxChecks)) bad.push({ text: `${r.id}: rx check ${JSON.stringify(b.check)} is not in rx commands --json` });
      if (b.kind === "eslint" && !(eslintRules ?? new Set()).has(b.check)) bad.push({ text: `${r.id}: eslint rule ${JSON.stringify(b.check)} is not in eslint-plugin/index.mjs` });
      if (b.kind === "judgment" && !judgmentIds.has(b.check) && !existsSync(join(DECISIONS, `${b.check}.json`)))
        bad.push({ text: `${r.id}: judgment ${JSON.stringify(b.check)} is neither in src/judge/decisions/ nor in the preset's judgments[]` });
    }
  }
  if (bad.length) results.fail("preset-bindings", `${bad.length} binding problem${bad.length === 1 ? "" : "s"}`, bad);
  else results.pass("preset-bindings", `${counts.rx} rx, ${counts.eslint} eslint, ${counts.judgment} judgment bindings resolve${needsEslint ? "" : " (no eslint bindings; registry not consulted)"}`);

  // severity: a report rule may not bind a core check that can FAIL. Capability comes from the
  // registry's `levels` for the bound check (the preflight catalog publishes its levels there
  // too); a check whose command declares no `levels` is assumed able to FAIL.
  /** The registry entry for a check id: exact key or a declared `prefix-*`. @param {string} id */
  const registryEntry = (id) => {
    if (id in rxChecks) return rxChecks[id];
    const prefix = Object.keys(rxChecks).find((k) => k.endsWith("*") && id.startsWith(k.slice(0, -1)));
    return prefix === undefined ? undefined : rxChecks[prefix];
  };
  /** @type {import("../verdict.mjs").Detail[]} */
  const downgrades = [];
  for (const r of rules) {
    if (r.severity !== "report") continue;
    for (const b of r.bindings) {
      if (b.kind !== "rx") continue;
      const info = CHECKS[b.check];
      if (info && info.class !== "core") continue; // a preset-class check takes its severity from the preset
      const entry = registryEntry(b.check);
      const levels = entry !== undefined && typeof entry === "object" ? entry.levels : undefined;
      const canFail = info ? info.level === "FAIL" : levels ? levels.includes("FAIL") : true;
      if (!canFail) continue;
      const why = levels || info
        ? "which FAILs on its own; a preset cannot downgrade it"
        : `whose command declares no \`levels\`, so it is assumed able to FAIL; if it never FAILs, declare \`checks["${b.check}"] = { description, levels: ["PASS", "WARN", "N/A"] }\` in that command's spec`;
      downgrades.push({ text: `${r.id} (report) binds core check ${b.check}, ${why}` });
    }
  }
  if (downgrades.length) results.fail("preset-severity", `${downgrades.length} binding${downgrades.length === 1 ? "" : "s"} would downgrade a core FAIL`, downgrades);
  else results.pass("preset-severity", "no binding downgrades a core check");

  return { data: { rules: rules.length, bindings: counts, errors: [...bad.map((d) => d.text), ...downgrades.map((d) => d.text)], eslintRegistry: needsEslint ? "present" : "not needed" } };
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function table({ args, cwd, results }) {
  const path = resolve(cwd, args.positionals.file);
  const given = resolve(cwd, /** @type {string} */ (args.flags["--into"]));
  const checkOnly = args.flags["--check"] === true;
  const { preset, errors } = readPreset(path);
  if (errors.length) throw new RxError(`preset ${path} is invalid: ${errors[0].path}: ${errors[0].message}`, { id: "input" });
  if (!existsSync(given)) throw new RxError(`--into ${given} does not exist`, { id: "preset-table" });
  // The real path (symlinks resolved) is what the refusal examines and what gets written.
  const into = realpathSync(given);
  // Refuse to write inside an extension: the generated region belongs to a plugin reference file.
  try {
    const ext = resolveRoot({ cwd: dirname(into) });
    throw new RxError(`--into ${into} is inside the extension ${ext}; the matrix belongs in a plugin reference file`, { id: "preset-table" });
  } catch (e) {
    if (!(e instanceof RootError && e.kind === "none")) throw e;
  }
  const loaded = index(path, /** @type {import("../preset/load.mjs").Preset} */ (preset));
  const cache = new Map();
  const rows = loaded.preset.rules
    .filter((r) => r.tag !== "build")
    .map((r) => ({ r, a: resolveAnchor(r.anchor, path, cache) }))
    .filter(({ a }) => a.exists && a.line !== null && realpathSync(a.file) === into)
    .sort((x, y) => /** @type {number} */ (x.a.line) - /** @type {number} */ (y.a.line));
  const lines = ["| Rule | ID | Tag | Applies | Severity | Binding |", "|---|---|---|---|---|---|"];
  for (const { r } of rows) {
    const binding = r.bindings.map((b) => `${b.kind} \`${b.check}\`${b.coverage === "partial" ? " (partial)" : ""}`).join("; ") || "—";
    lines.push(`| ${cell(r.title)} | \`${r.id}\` | \`${r.tag}\` | ${cell(render(r.applies))} | **${r.severity}** | ${binding} |`);
  }
  const region = lines.join("\n");
  const text = readFileSync(into, "utf8");
  // Exactly one start marker followed by exactly one end marker; anything else (missing, duplicate,
  // nested, reversed) is an error and nothing is written.
  const starts = text.split(MATRIX_START).length - 1;
  const ends = text.split(MATRIX_END).length - 1;
  const start = text.indexOf(MATRIX_START);
  const end = text.indexOf(MATRIX_END);
  if (starts === 0 || ends === 0) throw new RxError(`${into} lacks the ${MATRIX_START} / ${MATRIX_END} markers`, { id: "preset-table" });
  if (starts !== 1 || ends !== 1) throw new RxError(`${into} has ${starts} start and ${ends} end markers; exactly one of each is required`, { id: "preset-table" });
  if (end < start) throw new RxError(`${into}: ${MATRIX_END} comes before ${MATRIX_START}`, { id: "preset-table" });
  const before = text.slice(0, start + MATRIX_START.length);
  const after = text.slice(end);
  const next = `${before}\n${region}\n${after}`;
  const changed = next !== text;
  if (checkOnly) {
    if (changed) results.fail("preset-table", `the matrix region in ${into} differs from the preset (${rows.length} rows); run rx preset table without --check`);
    else results.pass("preset-table", `the matrix region in ${into} is current (${rows.length} rows)`);
  } else {
    if (changed) writeFileSync(into, next);
    results.pass("preset-table", `${changed ? "wrote" : "unchanged"} ${rows.length} rows in ${into}`);
  }
  return { data: { rows: rows.length, changed } };
}

/** @param {string} s */
function cell(s) { return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }

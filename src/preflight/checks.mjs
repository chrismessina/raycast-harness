// The preflight checks. Legacy behavior is ported check for check from the plugin's
// scripts/preflight.mjs (Phase 2); the Phase 3 fixes and new checks are marked with their
// plan ids. Every id in catalog.mjs comes out exactly once per run (docs/commands.md §1: silence
// is never a pass).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as changelogParse from "../changelog/parse.mjs";
import { RxError } from "../errors.mjs";
import { evaluate } from "../preset/applies.mjs";
import { CHECKS, CHECK_IDS } from "./catalog.mjs";
import {
  allPreferences, buildApplyContext, commandsOf, filesUnder, grepSources, isObj, loadSources, pngSize, read,
  readLockfile, readPublished,
} from "./context.mjs";
import { gitIgnoredSet, gitignoreMatcher } from "./gitignore.mjs";
import { extractEmbeds, isExternal, targetPath } from "./markdown.mjs";

/** The N/A message when a comparison check ran without --published (a missing flag, not a fact about publication). */
export const NO_PUBLISHED_COPY = "no published copy given; pass --published <dir> (rx stale prints it)";

const HERE = dirname(fileURLToPath(import.meta.url));
/** @type {any} */
export const STORE = JSON.parse(readFileSync(join(HERE, "..", "rules", "store.json"), "utf8"));

/**
 * The one placeholder predicate, shared with `rx changelog`: `placeholderProblems(text)` from
 * `src/changelog/parse.mjs` (conflict markers, occurrence count anywhere in the file, placement in
 * the top heading). One implementation, so the two commands cannot disagree.
 */
const { placeholderProblems } = changelogParse;

/** Every line holding the placeholder, as details. @param {string} text */
function placeholderLines(text) {
  return text.split(/\r?\n/).flatMap((l, i) => (l.includes(changelogParse.PLACEHOLDER) ? [{ file: "CHANGELOG.md", line: i + 1, text: l.trim() }] : []));
}

/**
 * @typedef {import("../verdict.mjs").Detail} Detail
 * @typedef {{ level: "FAIL" | "WARN", message: string, details: Detail[], cap: "report" | "block" }} Finding
 * @typedef {{ id: string, verdict: import("../verdict.mjs").Verdict, message: string, details: Detail[] }} Outcome
 * @typedef {{ root: string, publishedDir: string | null, preset: import("../preset/load.mjs").LoadedPreset | null }} Options
 */

/** Collects findings per check id and turns them into exactly one outcome per id. */
class Collector {
  constructor() {
    /** @type {Map<string, Finding[]>} */
    this.findings = new Map();
    /** @type {Map<string, string>} */
    this.naReasons = new Map();
    /** @type {Map<string, string>} */
    this.passMessages = new Map();
    /** Per-check cap for checks that run once (no options). @type {Map<string, "report" | "block">} */
    this.caps = new Map();
    /** The cap of the binding whose findings are being recorded right now (set by withCap). @type {"report" | "block" | null} */
    this.currentCap = null;
  }
  /** @param {string} id @param {"FAIL" | "WARN"} level @param {string} message @param {Detail[]} [details] */
  add(id, level, message, details = []) {
    if (!(id in CHECKS)) throw new Error(`unknown check id ${id}`);
    const list = this.findings.get(id) ?? [];
    // Each finding carries the severity of the binding that produced it, so a failing report rule
    // and a passing block rule on the same check cannot combine into a FAIL.
    list.push({ level, message, details, cap: this.currentCap ?? this.caps.get(id) ?? "block" });
    this.findings.set(id, list);
  }
  /** Run `fn` recording findings under one binding's severity. @param {"report" | "block"} cap @param {() => void} fn */
  withCap(cap, fn) {
    const prev = this.currentCap;
    this.currentCap = cap;
    try { fn(); } finally { this.currentCap = prev; }
  }
  /** @param {string} id @param {string} message */
  fail(id, message, /** @type {Detail[]} */ details = []) { this.add(id, "FAIL", message, details); }
  /** @param {string} id @param {string} message */
  warn(id, message, /** @type {Detail[]} */ details = []) { this.add(id, "WARN", message, details); }
  /** @param {string} id @param {string} reason */
  na(id, reason) { this.naReasons.set(id, reason); }
  /** @param {string} id @param {string} message */
  pass(id, message) { this.passMessages.set(id, message); }
  /** @returns {Outcome[]} */
  outcomes() {
    return CHECK_IDS.map((id) => {
      const found = this.findings.get(id);
      if (found?.length) {
        const effective = (/** @type {Finding} */ f) => (f.level === "FAIL" && f.cap === "report" ? "WARN" : f.level);
        const worst = found.some((f) => effective(f) === "FAIL") ? "FAIL" : "WARN";
        const message = found.map((f) => f.message).join("; ");
        return { id, verdict: /** @type {"FAIL" | "WARN"} */ (worst), message, details: found.flatMap((f) => f.details) };
      }
      const na = this.naReasons.get(id);
      if (na !== undefined) return { id, verdict: "N/A", message: na, details: [] };
      return { id, verdict: "PASS", message: this.passMessages.get(id) ?? CHECKS[id].description, details: [] };
    });
  }
}

/** @param {{ file: string, line: number, text: string }[]} hits */
const where = (hits) => hits.map((h) => ({ file: h.file, line: h.line, text: h.text }));

/**
 * Run every check. Returns one outcome per catalog id plus the `data` block.
 * @param {Options} opts
 */
export async function runPreflight({ root, publishedDir, preset }) {
  const c = new Collector();
  const owner = preset?.preset.owner ?? null;
  const classes = Object.fromEntries(CHECK_IDS.map((id) => [id, CHECKS[id].class]));
  const base = { root, published: publishedDir !== null, publishedDir, preset: preset?.path ?? null, checks: classes };

  // package.json first: without it nothing else has an input.
  const pkgText = read(join(root, "package.json"));
  /** @type {any} */
  let pkg;
  let usable = false;
  if (pkgText === null) c.fail("package-json", "no package.json — run from the extension root");
  else {
    try {
      pkg = JSON.parse(pkgText);
      // `null`, an array, a string: valid JSON, not a manifest.
      if (isObj(pkg)) usable = true;
      else c.fail("package-json", `package.json must be a JSON object, not ${pkg === null ? "null" : Array.isArray(pkg) ? "an array" : `a ${typeof pkg}`}`);
    } catch (e) {
      c.fail("package-json", `package.json is not valid JSON: ${/** @type {Error} */ (e).message}`);
    }
  }
  if (!usable) {
    for (const id of CHECK_IDS) if (id !== "package-json") c.na(id, "package.json could not be read; nothing to inspect");
    return { outcomes: c.outcomes(), data: { ...base, selfAuthored: null } };
  }
  const notArrays = ["commands", "preferences", "categories", "platforms"].filter((k) => pkg[k] !== undefined && !Array.isArray(pkg[k]));
  if (notArrays.length) c.fail("package-json", `must be arrays in package.json: ${notArrays.join(", ")}`);
  /** @type {string[]} */
  const badMembers = [];
  for (const k of ["commands", "preferences"]) if (Array.isArray(pkg[k]) && pkg[k].some((/** @type {unknown} */ v) => !isObj(v))) badMembers.push(k);
  for (const cmd of commandsOf(pkg)) if (Array.isArray(cmd.preferences) && cmd.preferences.some((/** @type {unknown} */ v) => !isObj(v))) badMembers.push(`commands.${cmd.name}.preferences`);
  if (badMembers.length) c.fail("package-json", `every entry must be an object in package.json: ${badMembers.join(", ")}`);
  c.pass("package-json", "package.json parses and its list fields are arrays of objects");

  const sources = loadSources(root);
  const lock = readLockfile(root);
  const published = publishedDir !== null ? true : await readPublished(root);
  const ctx = buildApplyContext({ pkg, owner, sources, lock, published });
  const commands = commandsOf(pkg);

  // Which preset-class checks run, with which options and cap. Several applicable rules may bind
  // the same check with different options: every distinct option set is evaluated and the
  // collector keeps the strictest outcome (any FAIL wins); the cap is `report` only if every
  // applicable rule is report-only.
  /**
   * Per check: every distinct option set its applicable bindings carry, each with the strictest
   * severity among the rules that bound that exact set (so the rule association survives the
   * deduplication), plus the ids of those rules.
   * @type {Map<string, { options: Record<string, any>, cap: "report" | "block", rules: string[] }[]>}
   */
  const options = new Map();
  for (const id of CHECK_IDS) {
    if (CHECKS[id].class !== "preset") continue;
    const bindings = preset?.rxBindings.get(id) ?? [];
    if (!bindings.length) { c.na(id, preset ? `no preset rule binds ${id}` : "no preset (core enforces only Store facts)"); continue; }
    /** @type {{ rule: import("../preset/load.mjs").Rule, binding: import("../preset/load.mjs").Binding, applied: import("../preset/applies.mjs").Applied }[]} */
    const applicable = [];
    /** @type {string | null} */
    let skipReason = null;
    for (const b of bindings) {
      const applied = evaluate(b.rule.applies, ctx);
      if (applied.value === true) applicable.push({ ...b, applied });
      else skipReason ??= applied.value === false ? `rule ${b.rule.id} does not apply: ${applied.reason}` : `rule ${b.rule.id}: ${applied.reason}`;
    }
    if (!applicable.length) { c.na(id, skipReason ?? `rule does not apply`); continue; }
    // Checks that run once (no options) take the strictest severity among their applicable rules.
    c.caps.set(id, applicable.every((a) => a.rule.severity === "report") ? "report" : "block");
    /** @type {Map<string, { options: Record<string, any>, cap: "report" | "block", rules: string[] }>} */
    const sets = new Map();
    for (const a of applicable) {
      const o = a.binding.options ?? {};
      const key = JSON.stringify(o);
      const set = sets.get(key) ?? { options: o, cap: "report", rules: [] };
      if (a.rule.severity === "block") set.cap = "block";
      set.rules.push(a.rule.id);
      sets.set(key, set);
    }
    options.set(id, [...sets.values()]);
  }
  const enabled = (/** @type {string} */ id) => options.has(id);
  /** Every distinct option set bound to a check, each guaranteed to carry `keys`. @param {string} id @param {string[]} keys */
  const optionSets = (id, keys) => {
    const sets = options.get(id) ?? [];
    for (const s of sets) for (const key of keys) if (!(key in s.options)) throw new RxError(`preset binding for ${id} (rule ${s.rules.join(", ")}) lacks options.${key}`, { id: "input" });
    return sets;
  };
  const keep = (preset?.preset.ship?.keep ?? []).filter((k) => k.extensions.includes(String(pkg.name))).map((k) => k.path);

  // schema — Raycast docs
  if (pkg.$schema !== STORE.schemaUrl) c.fail("schema", `package.json "$schema" must be "${STORE.schemaUrl}"`);
  c.pass("schema", `$schema is ${STORE.schemaUrl}`);

  // categories — extension-categories
  const cats = Array.isArray(pkg.categories) ? pkg.categories : [];
  if (cats.length === 0) c.fail("categories", "package.json needs at least one category");
  else {
    const unknown = cats.filter((/** @type {string} */ x) => !STORE.categories.includes(x));
    if (unknown.length) c.fail("categories", `unknown or miscased categories: ${unknown.join(", ")} (allowed: ${STORE.categories.join(", ")})`);
    else if (cats.includes("Other")) c.warn("categories", '"Other" is only for extensions no listed category fits');
  }
  c.pass("categories", `categories: ${cats.join(", ")}`);

  // platforms — supported-platforms
  if (Array.isArray(pkg.platforms)) {
    const bad = pkg.platforms.filter((/** @type {string} */ p) => !STORE.platforms.includes(p));
    if (bad.length) c.fail("platforms", `platforms may only contain macOS and Windows; found ${bad.join(", ")}`);
    c.pass("platforms", `platforms: ${pkg.platforms.join(", ")}`);
  } else c.pass("platforms", "no platforms field (defaults to macOS)");

  // preference-type — preference-types (there is no "number" type)
  const prefs = allPreferences(pkg);
  const badPrefs = prefs.filter(({ p }) => !STORE.preferenceTypes.includes(p.type));
  if (badPrefs.length)
    c.fail("preference-type", `preference types must be one of ${STORE.preferenceTypes.join(", ")}: ` + badPrefs.map(({ where: w, p }) => `${p.name} (${w}) is "${p.type}"`).join("; "));
  if (!prefs.length) c.na("preference-type", "no preferences declared");
  else c.pass("preference-type", `${prefs.length} preference type${prefs.length === 1 ? "" : "s"} valid`);

  // title-case — manifest-title-case (preset-class heuristic)
  if (enabled("title-case")) {
    const titles = [["extension", pkg.title], ...commands.map((cmd) => [`command ${cmd.name}`, cmd.title]), ...prefs.map(({ where: w, p }) => [`preference ${p.name} (${w})`, p.title])];
    const untitled = titles.filter(([, t]) => typeof t === "string" && titleCaseProblems(t).length);
    if (untitled.length) c.warn("title-case", "titles should be Title Case: " + untitled.map(([w, t]) => `${w}: "${t}" (${titleCaseProblems(t).join(", ")})`).join("; "));
    c.pass("title-case", `${titles.filter(([, t]) => typeof t === "string").length} titles are Title Case`);
  }

  // changelog — changelog-entries
  const log = read(join(root, "CHANGELOG.md"));
  if (log === null) {
    c.fail("changelog-exists", "CHANGELOG.md is missing");
    for (const id of ["changelog-order", "changelog-placeholder", "changelog-updated"]) c.na(id, "CHANGELOG.md is missing");
  } else {
    c.pass("changelog-exists", "CHANGELOG.md exists");
    const heads = changelogHeadings(log);
    const P = STORE.mergeDatePlaceholder;
    /** @type {string[]} */
    const problems = [];
    if (heads.some((h) => /^\[?\s*unreleased\s*\]?$/i.test(h.title) || /unreleased/i.test(h.date ?? ""))) problems.push('no "Unreleased" section — use ' + P);
    const dated = heads.map((h) => h.date).filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (let i = 1; i < dated.length; i++) if (/** @type {string} */ (dated[i]) > /** @type {string} */ (dated[i - 1])) problems.push(`dates must descend: ${dated[i - 1]} is above ${dated[i]}`);
    const malformed = heads.filter((h) => h.date && h.date !== P && !/^\d{4}-\d{2}-\d{2}$/.test(h.date));
    if (malformed.length) problems.push(`dates must be YYYY-MM-DD or ${P}: ${malformed.map((h) => h.raw).join(" | ")}`);
    if (problems.length) c.fail("changelog-order", problems.join("; "));
    c.pass("changelog-order", `${heads.length} entries, dates descend`);

    // changelog-placeholder (Q10): the one predicate shared with `rx changelog` (src/changelog/parse.mjs):
    // occurrences anywhere in the file, placement on the top heading, conflict markers.
    const ph = placeholderProblems(log);
    if (ph.problems.length) c.fail("changelog-placeholder", ph.problems.join("; "), placeholderLines(log));
    c.pass("changelog-placeholder", `one ${P}, in the top entry's heading`);

    if (publishedDir === null) c.na("changelog-updated", NO_PUBLISHED_COPY);
    else {
      const pub = read(join(publishedDir, "CHANGELOG.md"));
      const pubTop = pub === null ? null : changelogHeadings(pub)[0]?.raw;
      if (pubTop && heads[0]?.raw === pubTop && heads[0]?.date !== P) c.fail("changelog-updated", `CHANGELOG has no new entry — the top entry is still "${pubTop}"`);
      if (pub === null) c.na("changelog-updated", "published copy has no CHANGELOG.md to compare with");
      else c.pass("changelog-updated", "the top entry is new");
    }
  }

  // command-renamed
  if (publishedDir === null) c.na("command-renamed", NO_PUBLISHED_COPY);
  else {
    /** @type {any[] | null} */
    let pubCommands = null;
    try {
      const pub = JSON.parse(read(join(publishedDir, "package.json")) ?? "null");
      if (isObj(pub) && (pub.commands === undefined || Array.isArray(pub.commands))) pubCommands = pub.commands ?? [];
    } catch { /* stays null */ }
    if (pubCommands === null) c.warn("command-renamed", `no readable commands in ${join(publishedDir, "package.json")}; renames not checked`);
    const unnamed = (pubCommands ?? []).filter((x) => !isObj(x) || typeof x.name !== "string").length;
    if (unnamed) c.warn("command-renamed", `${unnamed} published command entr${unnamed === 1 ? "y has" : "ies have"} no string name; those were not checked`);
    const names = (/** @type {any[] | null} */ cs) => (Array.isArray(cs) ? cs.filter(isObj).map((x) => x.name).filter((n) => typeof n === "string") : []);
    const local = names(commands), publishedNames = names(pubCommands);
    const gone = publishedNames.filter((n) => !local.includes(n));
    const added = local.filter((n) => !publishedNames.includes(n));
    if (gone.length) {
      const msg = `published command names are gone: ${gone.join(", ")}` +
        (added.length ? ` (new: ${added.join(", ")}). Keep the old name and change the title` : " — confirm the removal is intended") +
        "; if this checkout never had them, it is behind upstream (develop step 0)";
      if (added.length) c.fail("command-renamed", msg); else c.warn("command-renamed", msg);
    }
    c.pass("command-renamed", "every published command name is still present");
  }

  // lockfile and npm-registry
  const otherLocks = ["npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].filter((f) => existsSync(join(root, f)));
  if (otherLocks.length) c.fail("lockfile", `only package-lock.json is allowed; remove ${otherLocks.join(", ")}`);
  else if (!existsSync(join(root, "package-lock.json"))) c.fail("lockfile", "package-lock.json is missing; run npm install");
  c.pass("lockfile", "package-lock.json is the only lock file");
  npmRegistry(root, c);

  // screenshots — store-screenshots (presence); screenshot-count / -format / -size are new (§4.1)
  const metaDir = join(root, "metadata");
  const metaEntries = existsSync(metaDir) ? readdirSync(metaDir) : null;
  const pngs = (metaEntries ?? []).filter((f) => f.toLowerCase().endsWith(".png"));
  if (commands.some((cmd) => cmd.mode === "view")) {
    if (!pngs.length) c.fail("screenshots", "a view command needs at least one screenshot in metadata/");
    c.pass("screenshots", `${pngs.length} screenshot${pngs.length === 1 ? "" : "s"} in metadata/`);
  } else c.na("screenshots", "no view command; the Store needs no screenshots");
  if (metaEntries === null) for (const id of ["screenshot-count", "screenshot-format", "screenshot-size"]) c.na(id, "metadata/ absent");
  else {
    if (pngs.length > STORE.screenshot.max) c.fail("screenshot-count", `${pngs.length} screenshots in metadata/; the Store accepts at most ${STORE.screenshot.max}`);
    c.pass("screenshot-count", `${pngs.length} of at most ${STORE.screenshot.max} screenshots`);
    const notPng = metaEntries.filter((f) => !f.toLowerCase().endsWith(".png"));
    if (notPng.length) c.fail("screenshot-format", `only .png screenshots are accepted; remove from metadata/: ${notPng.join(", ")}`, notPng.map((f) => ({ file: `metadata/${f}`, text: "not a .png" })));
    c.pass("screenshot-format", "every file under metadata/ is a .png");
    if (!pngs.length) c.na("screenshot-size", "no .png under metadata/");
    else {
      const wrong = pngs.filter((f) => { const s = pngSize(join(metaDir, f)); return !s || s.width !== STORE.screenshot.width || s.height !== STORE.screenshot.height; });
      if (wrong.length) c.fail("screenshot-size", `screenshots must be ${STORE.screenshot.width}×${STORE.screenshot.height} PNG: ${wrong.map((f) => `metadata/${f}`).join(", ")}`, wrong.map((f) => ({ file: `metadata/${f}`, text: describeSize(pngSize(join(metaDir, f))) })));
      c.pass("screenshot-size", `every screenshot is ${STORE.screenshot.width}×${STORE.screenshot.height}`);
    }
  }

  // icon-size (§4.1)
  iconSize(root, pkg, commands, c);

  // readme-assets (T3, T4) and readme-links (Q9)
  readmeChecks(root, c);

  // unused-dependencies
  const code = sources.map((s) => s.code).join("\n");
  const deps = Object.keys(pkg.dependencies ?? {});
  const unused = deps.filter((dep) => {
    if (dep.startsWith("@types/")) return false;
    const esc = dep.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    return !new RegExp(`(from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)["'\`]${esc}(/[^"'\`]*)?["'\`]`).test(code);
  });
  if (unused.length) c.fail("unused-dependencies", `dependencies no file under src/ imports: ${unused.join(", ")}`);
  if (!deps.length) c.na("unused-dependencies", "no dependencies declared");
  else c.pass("unused-dependencies", `${deps.length} dependenc${deps.length === 1 ? "y is" : "ies are"} imported`);

  // native-fetch
  const fetchHits = grepSources(sources, /(from\s*|require\(\s*|import\(\s*)["'](node-fetch|cross-fetch|isomorphic-fetch)["']/);
  if (fetchHits.length) c.fail("native-fetch", "fetch is a global on Raycast's Node runtime; drop the polyfill import", where(fetchHits));
  c.pass("native-fetch", "no fetch polyfill imported");

  // eslint-config
  const legacy = readdirSync(root).filter((f) => f.startsWith(".eslintrc"));
  if (legacy.length) c.fail("eslint-config", `legacy ESLint config ${legacy.join(", ")}; use eslint.config.js with defineConfig from "eslint/config"`);
  const flat = readdirSync(root).find((f) => /^eslint\.config\.(c|m)?[jt]s$/.test(f));
  if (flat) {
    const src = read(join(root, flat)) ?? "";
    if (/(from\s*|require\(\s*)["']eslint["']/.test(src) && /defineConfig/.test(src)) c.fail("eslint-config", `${flat} imports defineConfig from "eslint"; import it from "eslint/config"`);
    else if (!/defineConfig/.test(src)) c.warn("eslint-config", `${flat} does not use defineConfig from "eslint/config"`);
    c.pass("eslint-config", `${flat} is a flat config`);
  } else if (!legacy.length) c.fail("eslint-config", "no eslint.config.{js,mjs,cjs,ts}; Raycast's lint needs the flat config");

  // prettierrc (preset-class)
  for (const s of optionSets("prettierrc", ["printWidth", "singleQuote"])) c.withCap(s.cap, () => prettierrc(root, pkg, c, s.options));

  // hand-typed-preferences (preset-class)
  if (enabled("hand-typed-preferences")) {
    const hits = [...grepSources(sources, /\b(interface|type)\s+(Preferences|Arguments)\b(?!\.)/), ...grepSources(sources, /getPreferenceValues\s*<\s*\{/)];
    if (hits.length) c.fail("hand-typed-preferences", "use the generated Preferences / Arguments types from raycast-env.d.ts", where(hits));
    c.pass("hand-typed-preferences", "no hand-written Preferences / Arguments types");
  }

  // shortcut-platform-case
  const caseHits = grepSources(sources, /[{,]\s*["']?(windows|macos|MacOS|Macos|MacOs)["']?\s*:\s*\{/);
  if (caseHits.length) c.fail("shortcut-platform-case", "platform keys are Windows and macOS", where(caseHits));
  if (!grepSources(sources, /\bshortcut\s*[=:]/).length && !caseHits.length) c.na("shortcut-platform-case", "no shortcuts declared in src/");
  else c.pass("shortcut-platform-case", "platform keys are spelled macOS and Windows");

  // What ships (agent-scaffolding, dev-material, generated-files: preset-class)
  if (enabled("agent-scaffolding") || enabled("dev-material") || enabled("generated-files")) await fileChecks(root, publishedDir, c, enabled, keep);

  // warn-only heuristics
  /** @type {[string, RegExp, string][]} */
  const heuristics = [
    ["launch-command", /raycast:\/\/extensions\/[^/"'`\s]+\/[^/"'`\s]+\/[^/"'`\s]+/, "prefer launchCommand() (or openExtensionPreferences()) over a raycast://extensions/<author>/<ext>/<command> deeplink"],
    ["favicon", /google\.com\/s2\/favicons|icons\.duckduckgo\.com\/ip[23]|favicon\.yandex/, "prefer getFavicon() from @raycast/utils — unless this code adds validation, racing, or sources getFavicon lacks"],
    ["trash", /(exec|execSync|spawn|spawnSync|execFile)\b.*(\.Trash|\brm\s+-)/, "prefer trash() from @raycast/api over a shell command"],
    ["localization", /navigator\.language|resolvedOptions\(\)\.locale|process\.env\.LANG\b|getSystemLocale/, "Raycast is US English only; make locale-dependent behavior a preference"],
  ];
  for (const [id, re, msg] of heuristics) {
    const hits = grepSources(sources, re);
    if (hits.length) c.warn(id, msg, where(hits));
    c.pass(id, sources.length ? "no hits in src/" : "no source files under src/");
  }

  // Preset-bound copy and logger checks (T5, Q12); one pass per distinct option set, each under its
  // own binding's severity, strictest effective outcome wins.
  for (const s of optionSets("pref-description-length", ["max"])) c.withCap(s.cap, () => lengthCheck(prefs, "description", s.options.max, "pref-description-length", c));
  for (const s of optionSets("pref-label-length", ["max"])) c.withCap(s.cap, () => lengthCheck(prefs, "label", s.options.max, "pref-label-length", c));
  for (const s of optionSets("logger", ["package", "preference"])) c.withCap(s.cap, () => loggerCheck(pkg, sources, prefs, s.options.package, s.options.preference, c));
  for (const s of optionSets("logger-verbose-copy", ["expected"])) c.withCap(s.cap, () => blockCheck(prefs, s.options.expected, "logger-verbose-copy", c));
  for (const s of optionSets("logger-strict-redaction", ["expected"])) c.withCap(s.cap, () => blockCheck(prefs, s.options.expected, "logger-strict-redaction", c));

  // AGENTS.md / CONCEPTS.md (§11.1)
  const agentIds = ["agents-md-paths", "agents-md-scripts", "agents-md-no-home-paths", "agents-md-symbols"];
  if (agentIds.some(enabled)) agentsMd(root, pkg, sources, c, agentIds.filter(enabled));

  return { outcomes: c.outcomes(), data: { ...base, selfAuthored: owner === null ? null : ctx.selfAuthored } };
}

/** @param {{ width: number, height: number } | null} s */
function describeSize(s) { return s ? `${s.width}×${s.height}` : "not a PNG"; }

/** @param {string} title */
export function titleCaseProblems(title) {
  const words = title.split(/\s+/).filter(Boolean);
  /** @type {string[]} */
  const bad = [];
  words.forEach((w, i) => {
    const core = w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (!core) return;
    if (/[A-Z]/.test(core)) return; // already capitalized, or brand casing like iPhone / macOS
    if (i > 0 && STORE.smallWords.includes(core.toLowerCase())) return;
    if (/^[a-z]/.test(core)) bad.push(core);
  });
  return bad;
}

/** @param {string} text */
export function changelogHeadings(text) {
  return text.split("\n").filter((l) => /^##\s/.test(l)).map((l) => {
    const body = l.replace(/\s+#+\s*$/, ""); // closing-ATX: "## [Unreleased] ##"
    const m = body.match(/^##\s+\[(.*?)\]\s*(?:-\s*(.+?))?\s*$/);
    return { raw: l.trim(), title: m?.[1] ?? body.replace(/^##\s+/, "").trim(), date: m?.[2]?.trim() ?? null };
  });
}

/** @param {string} root @param {Collector} c */
function npmRegistry(root, c) {
  const host = (/** @type {string} */ url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
  /** @type {Map<string, string>} */
  const settings = new Map();
  for (const line of (read(join(root, ".npmrc")) ?? "").split("\n")) {
    const m = line.match(/^\s*["']?((?:@[^:\s"']+:)?registry)["']?\s*=\s*(.*)$/);
    if (!m) continue;
    const quoted = m[2].match(/^\s*(["'])(.*?)\1/);
    settings.set(m[1], quoted ? quoted[2] : m[2].replace(/(^|[^\\])[;#].*$/, "$1").trim());
  }
  /** @type {string[]} */
  const registries = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const [key, value] of settings) {
    const h = host(value);
    if (value.includes("${") && (!h || /[${}]/.test(h))) unresolved.push(`.npmrc ${key}=${value}`);
    else if (h !== "registry.npmjs.org") registries.push(`.npmrc ${key}=${value}`);
  }
  for (const lockName of ["package-lock.json", "npm-shrinkwrap.json"]) {
    let lock;
    try { lock = JSON.parse((read(join(root, lockName)) ?? "null").replace(/^\uFEFF/, "")); } catch { continue; }
    /** @type {string[]} */
    const resolved = [];
    const walk = (/** @type {any} */ v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "resolved" && typeof x === "string") resolved.push(x); else walk(x); }
    };
    walk(lock);
    const foreign = resolved.filter((u) => /^https?:/i.test(u) && host(u) !== "registry.npmjs.org");
    const hosts = [...new Set(foreign.map((u) => host(u) ?? u))];
    if (hosts.length) registries.push(`${lockName} resolves ${foreign.length} package(s) from ${hosts.join(", ")}`);
  }
  if (registries.length) c.fail("npm-registry", "packages must come from https://registry.npmjs.org", registries.map((text) => ({ text })));
  if (unresolved.length) c.warn("npm-registry", "registry set from an environment variable; confirm it is https://registry.npmjs.org", unresolved.map((text) => ({ text })));
  c.pass("npm-registry", "every package resolves from registry.npmjs.org");
}

/** @param {string} root @param {any} pkg @param {any[]} commands @param {Collector} c */
function iconSize(root, pkg, commands, c) {
  /** @type {{ what: string, file: string }[]} */
  const icons = [];
  if (typeof pkg.icon === "string") icons.push({ what: "extension icon", file: pkg.icon });
  else c.fail("icon-size", 'package.json has no "icon"; the Store needs a 512×512 PNG in assets/');
  for (const cmd of commands) if (typeof cmd.icon === "string" && /\.png$/i.test(cmd.icon)) icons.push({ what: `command ${cmd.name} icon`, file: cmd.icon });
  /** @type {Detail[]} */
  const bad = [];
  for (const { what, file } of icons) {
    const rel = file.includes("/") ? file : `assets/${file}`;
    const abs = join(root, rel);
    if (!existsSync(abs)) { bad.push({ file: rel, text: `${what} missing` }); continue; }
    const s = pngSize(abs);
    if (!s) { bad.push({ file: rel, text: `${what} is not a PNG` }); continue; }
    if (s.width !== STORE.icon.width || s.height !== STORE.icon.height) bad.push({ file: rel, text: `${what} is ${s.width}×${s.height}` });
  }
  if (bad.length) c.fail("icon-size", `icons must be ${STORE.icon.width}×${STORE.icon.height} PNG: ${bad.map((b) => `${b.file} (${b.text})`).join(", ")}`, bad);
  c.pass("icon-size", `${icons.length} icon${icons.length === 1 ? "" : "s"} ${STORE.icon.width}×${STORE.icon.height}`);
}

/** @param {string} root @param {Collector} c */
function readmeChecks(root, c) {
  const readmePath = join(root, "README.md");
  const readme = read(readmePath);
  if (readme === null) { c.fail("readme-assets", "README.md is missing"); }
  else {
    const embeds = extractEmbeds(readme);
    // Only rendered images are judged here; a plain link to an asset is readme-links' business.
    const misplaced = embeds.filter((e) => {
      if (e.kind !== "image") return false;
      const t = targetPath(e.target);
      return /^(\.\/)?metadata\//i.test(t) || /^(\.\/)?assets\/.+\.(png|jpe?g|gif|webp|svg)$/i.test(t);
    });
    if (misplaced.length)
      c.fail("readme-assets", `README images belong in media/, not metadata/ or assets/: ${misplaced.map((e) => targetPath(e.target)).join(", ")}`, misplaced.map((e) => ({ file: "README.md", line: e.line, text: e.target })));
    c.pass("readme-assets", `${embeds.filter((e) => e.kind === "image").length} README image${embeds.filter((e) => e.kind === "image").length === 1 ? "" : "s"}, none in metadata/ or assets/`);
  }
  // readme-links (Q9): README.md and docs/**/*.md, every relative destination resolved from its own directory.
  /** @type {string[]} */
  const docs = [];
  if (readme !== null) docs.push("README.md");
  const walk = (/** @type {string} */ rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (/\.md$/i.test(e.name)) docs.push(`${rel}/${e.name}`);
    }
  };
  walk("docs");
  if (!docs.length) { c.na("readme-links", "no README.md and no docs/**/*.md"); return; }
  /** @type {Detail[]} */
  const broken = [];
  let total = 0;
  for (const rel of docs) {
    const text = read(join(root, rel)) ?? "";
    for (const e of extractEmbeds(text)) {
      if (!e.target || isExternal(e.target) || e.target.startsWith("#")) continue;
      const p = targetPath(e.target);
      if (!p) continue;
      total++;
      const abs = p.startsWith("/") ? join(root, p) : resolve(root, dirname(rel), p);
      if (!existsSync(abs)) broken.push({ file: rel, line: e.line, text: e.target });
    }
  }
  if (broken.length) c.fail("readme-links", `${broken.length} relative link${broken.length === 1 ? "" : "s"} do${broken.length === 1 ? "es" : ""} not resolve`, broken);
  c.pass("readme-links", `${total} relative link${total === 1 ? "" : "s"} resolve${total === 1 ? "s" : ""} across ${docs.length} file${docs.length === 1 ? "" : "s"}`);
}

/** @param {string} root @param {any} pkg @param {Collector} c @param {Record<string, any>} o */
function prettierrc(root, pkg, c, o) {
  const text = read(join(root, ".prettierrc"));
  if (text === null) { c.fail("prettierrc", `.prettierrc is missing (printWidth ${o.printWidth}, singleQuote ${o.singleQuote})`); return; }
  /** @type {any} */
  let conf;
  try { conf = JSON.parse(text); } catch {
    /** @type {Record<string, unknown>} */
    const yaml = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*["']?(printWidth|singleQuote)["']?\s*:\s*([^#\s]+)/);
      if (m) yaml[m[1]] = m[1] === "printWidth" ? Number(m[2]) : m[2] === "true" ? true : m[2] === "false" ? false : m[2];
    }
    conf = Object.keys(yaml).length ? yaml : null;
    if (!conf) { c.fail("prettierrc", ".prettierrc is neither JSON nor YAML with printWidth and singleQuote"); return; }
  }
  if (!isObj(conf)) { c.fail("prettierrc", `.prettierrc must be a JSON object, not ${conf === null ? "null" : Array.isArray(conf) ? "an array" : `a ${typeof conf}`}`); return; }
  if (conf.printWidth !== o.printWidth || conf.singleQuote !== o.singleQuote)
    c.fail("prettierrc", `.prettierrc must set printWidth ${o.printWidth} and singleQuote ${o.singleQuote} (has ${conf.printWidth}, ${conf.singleQuote})`);
  if (o.sortImports) {
    const plugin = o.sortImports.plugin;
    const listed = Array.isArray(conf.plugins) && conf.plugins.includes(plugin);
    const declared = plugin in (pkg.devDependencies ?? {});
    if (listed && !declared) c.fail("prettierrc", `.prettierrc lists ${plugin} but devDependencies does not declare it`);
    if (declared && !listed) c.fail("prettierrc", `devDependencies declares ${plugin} but .prettierrc does not list it`);
    if (conf.plugins !== undefined || conf.importOrder !== undefined) {
      const want = { printWidth: o.printWidth, singleQuote: o.singleQuote, plugins: [plugin], importOrder: o.sortImports.importOrder };
      if (JSON.stringify(sortKeys(conf)) !== JSON.stringify(sortKeys(want))) c.fail("prettierrc", `.prettierrc has adopted the import-sorting form but differs from the canonical file: ${JSON.stringify(conf)}`);
    }
  }
  c.pass("prettierrc", `.prettierrc sets printWidth ${o.printWidth} and singleQuote ${o.singleQuote}`);
}

/** @param {any} v */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/**
 * @param {string} root @param {string | null} publishedDir @param {Collector} c
 * @param {(id: string) => boolean} enabled @param {string[]} keep paths the preset ships on purpose for this extension
 */
async function fileChecks(root, publishedDir, c, enabled, keep) {
  const G = STORE.greptile;
  const gitignore = read(join(root, ".gitignore")) ?? "";
  const nestedPaths = G.nestedGreptile;
  const scaffoldPaths = [...G.agentScaffolding, ...readdirSync(root).filter((f) => /^CONTEXT.*\.md$/i.test(f))].filter((p) => !keep.includes(p));
  const devMaterial = G.devMaterial.filter((/** @type {string} */ p) => !keep.includes(p));
  const strayPaths = G.strays;
  const candidates = [...nestedPaths, ...scaffoldPaths, ...devMaterial, ...G.generatedDirs, ...strayPaths].flatMap((rel) => filesUnder(root, rel));
  const fromGit = gitignore ? await gitIgnoredSet(gitignore, candidates) : new Set();
  const ignored = fromGit ? (/** @type {string} */ f) => fromGit.has(f) : gitignoreMatcher(gitignore);
  const skipped = (/** @type {string} */ rel) => rel.split("/").some((part) => STORE.publishSkips.includes(part));
  const shipping = (/** @type {string} */ rel) =>
    filesUnder(root, rel).filter((f) => !skipped(f) && (!ignored(f, false) || (publishedDir !== null && existsSync(join(publishedDir, f)))));
  const flagged = (/** @type {string} */ rel) => {
    const files = shipping(rel);
    if (!files.length) return false;
    if (publishedDir === null) return true;
    const pubAbs = join(publishedDir, rel);
    if (!existsSync(pubAbs) || statSync(pubAbs).isDirectory() !== statSync(join(root, rel)).isDirectory()) return true;
    // Compare the path sets before any bytes: a renamed file (`docs/old.md` → `docs/new.md`) keeps
    // the count equal while its published counterpart does not exist.
    const pubFiles = new Set(filesUnder(publishedDir, rel));
    if (files.length !== pubFiles.size || files.some((f) => !pubFiles.has(f))) return true;
    return files.some((f) => !readFileSync(join(publishedDir, f)).equals(readFileSync(join(root, f))));
  };
  const scope = publishedDir !== null ? "new or changed versus the published copy" : "present (pass --published to see which this PR changes)";
  const details = (/** @type {string[]} */ paths) => paths.map((p) => ({ file: p, text: p }));

  if (enabled("agent-scaffolding")) {
    const nestedGreptile = nestedPaths.filter(flagged);
    if (nestedGreptile.length) c.fail("agent-scaffolding", `a nested Greptile config overrides Raycast's repo rules: ${nestedGreptile.join(", ")}`, details(nestedGreptile));
    const scaffolding = scaffoldPaths.filter(flagged);
    if (scaffolding.length) c.warn("agent-scaffolding", `agent or planning files ${scope}: ${scaffolding.join(", ")}`, details(scaffolding));
    c.pass("agent-scaffolding", keep.length ? `no agent or planning files would ship (kept on purpose: ${keep.join(", ")})` : "no agent or planning files would ship");
  }
  if (enabled("dev-material")) {
    const dev = devMaterial.filter(flagged);
    if (dev.length) c.warn("dev-material", `repo-only files ${scope}: ${dev.join(", ")}`, details(dev));
    c.pass("dev-material", "no repo-only files would ship");
  }
  if (enabled("generated-files")) {
    const builds = G.generatedDirs.filter(flagged);
    if (builds.length) c.fail("generated-files", `generated output would ship: ${builds.join(", ")}`, details(builds));
    const strays = strayPaths.filter(flagged);
    if (strays.length) c.warn("generated-files", `generated files would ship: ${strays.join(", ")}`, details(strays));
    c.pass("generated-files", "no build output or stray files would ship");
  }
}

/** @param {{ where: string, p: any }[]} prefs @param {"description" | "label"} field @param {number} max @param {string} id @param {Collector} c */
function lengthCheck(prefs, field, max, id, c) {
  const withField = prefs.filter(({ p }) => typeof p[field] === "string");
  if (!withField.length) { c.na(id, `no preference declares a ${field}`); return; }
  const long = withField.filter(({ p }) => p[field].length > max);
  if (long.length) c.fail(id, `preference ${field} over ${max} characters: ` + long.map(({ where: w, p }) => `${p.name} (${w}) ${p[field].length}`).join(", "), long.map(({ p }) => ({ file: "package.json", text: `${p.name}: ${p[field]}` })));
  c.pass(id, `${withField.length} preference ${field}${withField.length === 1 ? "" : "s"} within ${max} characters`);
}

/** @param {any} pkg @param {import("./context.mjs").Source[]} sources @param {{ where: string, p: any }[]} prefs @param {string} pkgName @param {string} prefName @param {Collector} c */
function loggerCheck(pkg, sources, prefs, pkgName, prefName, c) {
  /** @type {string[]} */
  const problems = [];
  if (!(pkgName in (pkg.dependencies ?? {}))) problems.push(`${pkgName} is not in dependencies`);
  const esc = pkgName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  if (!grepSources(sources, new RegExp(`(from\\s*|require\\(\\s*|import\\(\\s*)["']${esc}(/[^"']*)?["']`)).length) problems.push(`no file under src/ imports ${pkgName}`);
  const pref = prefs.find(({ p }) => p.name === prefName);
  if (!pref) problems.push(`no preference named ${prefName}`);
  else if (pref.p.type !== "checkbox") problems.push(`preference ${prefName} must be a checkbox (is "${pref.p.type}")`);
  if (problems.length) c.fail("logger", problems.join("; "));
  c.pass("logger", `${pkgName} is a dependency, imported, with the ${prefName} checkbox declared`);
}

/** Full-block comparison (Q12): every field of the expected preference, no partial match. @param {{ where: string, p: any }[]} prefs @param {Record<string, unknown>} expected @param {string} id @param {Collector} c */
function blockCheck(prefs, expected, id, c) {
  const name = String(expected.name);
  const found = prefs.filter(({ p }) => p.name === name);
  if (!found.length) { c.fail(id, `no preference named ${name}; declare the block verbatim`); return; }
  /** @type {Detail[]} */
  const drift = [];
  for (const { where: w, p } of found) {
    for (const [k, v] of Object.entries(expected)) if (JSON.stringify(p[k]) !== JSON.stringify(v)) drift.push({ file: "package.json", text: `${name} (${w}) ${k}: expected ${JSON.stringify(v)}, has ${JSON.stringify(p[k])}` });
    for (const k of Object.keys(p)) if (!(k in expected)) drift.push({ file: "package.json", text: `${name} (${w}) has an extra field ${k}` });
  }
  if (drift.length) c.fail(id, `the ${name} block drifts from the canonical copy in ${drift.length} field${drift.length === 1 ? "" : "s"}`, drift);
  c.pass(id, `the ${name} block matches, every field`);
}

/** The marker that exempts one AGENTS.md / CONCEPTS.md line from the paths, scripts and symbols checks. */
export const IGNORE_AGENTS_MD = "<!-- rx-ignore agents-md -->";
const ESCAPE_HINT = `, or mark a reference to another repository with ${IGNORE_AGENTS_MD}`;

/** @param {string} root @param {any} pkg @param {import("./context.mjs").Source[]} sources @param {Collector} c @param {string[]} ids */
function agentsMd(root, pkg, sources, c, ids) {
  const files = ["AGENTS.md", "CONCEPTS.md"].filter((f) => existsSync(join(root, f)));
  if (!files.length) { for (const id of ids) c.na(id, "no AGENTS.md or CONCEPTS.md"); return; }
  /** @type {Record<string, Detail[]>} */
  const bad = { "agents-md-paths": [], "agents-md-scripts": [], "agents-md-no-home-paths": [], "agents-md-symbols": [] };
  const counts = { paths: 0, scripts: 0, symbols: 0 };
  const scripts = Object.keys(pkg.scripts ?? {});
  const code = sources.map((s) => s.code).join("\n");
  // A bare file name (`api.ts`) may live anywhere in the repo, so collect every basename once.
  /** @type {Set<string>} */
  const basenames = new Set();
  const collect = (/** @type {string} */ d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      if (e.isDirectory()) collect(join(d, e.name)); else basenames.add(e.name);
    }
  };
  collect(root);
  const MIME = /^(text|application|image|audio|video|font|multipart|message|model)\//;
  // Only these extensions are files an extension repo holds; `app/Http/Kernel.php` names another repo's file.
  const REPO_EXT = /\.(md|json|ts|tsx|js|mjs|cjs|yml|yaml|png|svg)$/;
  for (const f of files) {
    const text = read(join(root, f)) ?? "";
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/\/Users\//.test(line)) bad["agents-md-no-home-paths"].push({ file: f, line: i + 1, text: line.trim().slice(0, 120) });
      // A reference to another repository opts out of the paths, scripts and symbols checks with the marker
      // on the same line or alone on the line directly above it; the home-path check above still applies.
      if (line.includes(IGNORE_AGENTS_MD) || (i > 0 && lines[i - 1].trim() === IGNORE_AGENTS_MD)) return;
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const tok = m[1].trim();
        const npm = tok.match(/^npm run ([\w:-]+)/);
        if (npm) { counts.scripts++; if (!scripts.includes(npm[1])) bad["agents-md-scripts"].push({ file: f, line: i + 1, text: tok }); continue; }
        const sym = tok.match(/^(?:[\w$]+\.)*([A-Za-z_$][\w$]*)\(\)$/);
        if (sym) { counts.symbols++; if (!new RegExp(`\\b${sym[1]}\\b`).test(code)) bad["agents-md-symbols"].push({ file: f, line: i + 1, text: tok }); continue; }
        // A slash path whose first segment is not a MIME type or a property access (`environment.supportPath/x`), or a bare file name.
        const slashPath = /^(?![@~/]|https?:)[\w.-]+(?:\/[\w.-]+)+\/?$/.test(tok) && !MIME.test(tok) && !/^[a-z]\w*\.[a-z]/.test(tok.split("/")[0]);
        const bareFile = /^[\w-]+\.(md|json|ts|tsx|js|mjs|cjs|yml|yaml|png|svg)$/.test(tok);
        const last = tok.replace(/\/$/, "").split("/").pop() ?? "";
        const foreignExt = /^[^.].*\.[^.]+$/.test(last) && !REPO_EXT.test(last); // a dotfile (`.env`) has no extension
        if ((slashPath || bareFile) && !foreignExt && !tok.includes("*")) {
          counts.paths++;
          const found = existsSync(join(root, tok)) || (bareFile && basenames.has(tok));
          if (!found) bad["agents-md-paths"].push({ file: f, line: i + 1, text: tok });
        }
      }
    });
  }
  const what = files.join(", ");
  for (const k of Object.keys(bad)) {
    const seen = new Set();
    bad[k] = bad[k].filter((d) => { const key = `${d.file}:${d.line}:${d.text}`; if (seen.has(key)) return false; seen.add(key); return true; });
  }
  if (ids.includes("agents-md-paths")) { if (bad["agents-md-paths"].length) c.fail("agents-md-paths", `${bad["agents-md-paths"].length} backticked path${bad["agents-md-paths"].length === 1 ? "" : "s"} in ${what} ${bad["agents-md-paths"].length === 1 ? "does not exist; fix it" : "do not exist; fix them"}${ESCAPE_HINT}`, bad["agents-md-paths"]); counts.paths ? c.pass("agents-md-paths", `${counts.paths} backticked paths in ${what} exist`) : c.na("agents-md-paths", `${what} names no repo paths`); }
  if (ids.includes("agents-md-scripts")) { if (bad["agents-md-scripts"].length) c.fail("agents-md-scripts", `npm scripts named in ${what} are not in package.json: ${bad["agents-md-scripts"].map((d) => d.text).join(", ")}; fix them${ESCAPE_HINT}`, bad["agents-md-scripts"]); counts.scripts ? c.pass("agents-md-scripts", `${counts.scripts} npm run references in ${what} exist`) : c.na("agents-md-scripts", `${what} names no npm scripts`); }
  if (ids.includes("agents-md-no-home-paths")) { if (bad["agents-md-no-home-paths"].length) c.fail("agents-md-no-home-paths", `home-directory path in ${what}`, bad["agents-md-no-home-paths"]); c.pass("agents-md-no-home-paths", `no home-directory path in ${what}`); }
  if (ids.includes("agents-md-symbols")) { if (bad["agents-md-symbols"].length) c.fail("agents-md-symbols", `symbols named in ${what} are not in src/: ${bad["agents-md-symbols"].map((d) => d.text).join(", ")}; fix them${ESCAPE_HINT}`, bad["agents-md-symbols"]); counts.symbols ? c.pass("agents-md-symbols", `${counts.symbols} symbol() references in ${what} exist in src/`) : c.na("agents-md-symbols", `${what} names no symbol()`); }
}

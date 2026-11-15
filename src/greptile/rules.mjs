// The one place rx reads Greptile's review rules from. Two copies can exist:
//   updated → a copy `rx greptile update` wrote under the cross-repo cache,
//             $XDG_CACHE_HOME/raycast-harness/greptile/rules/<stamp>-<sha7>/
//   shipped → src/rules/greptile/, versioned with the package
// Each copy is a directory of config.json, files.json, rules.md and SOURCE.json. Copies are ordered
// by upstream chronology, never by when they were fetched: SOURCE.json `committed` is the committer
// date of the raycast/extensions commit the copy was read at. The copy with the latest `committed`
// is used; on a tie the shipped copy wins, then the later `fetched`, then the larger SHA (a
// directory name never decides). A copy is invalid (a cache copy is warned about and skipped,
// never trusted; the shipped copy is an ERROR) when any file fails validation, its `repo` is not
// raycast/extensions, or its `committed` is unparseable or more than a day in the future. Every rx
// reader of the rules goes through loadGreptileRules().

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../attest.mjs";
import { RxError } from "../errors.mjs";
import { greptileRulesCachePath } from "../state.mjs";
import { GREPTILE_REPO, SNAPSHOT_FILES, commitTime, validateRuleSet } from "./compare.mjs";

export const SHIPPED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "rules", "greptile");

/**
 * SOURCE.json: where a copy came from. `repo` is always raycast/extensions. `source` is `main` or
 * `pr` (then `pr` names it); `sha` is the commit read; `committed` is that commit's ISO-8601
 * committer date (the ordering key); `fetched` is a date (`YYYY-MM-DD`, the shipped copy) or an
 * ISO-8601 UTC time (copies in the cache), shown to people and used only to break a tie.
 * @typedef {{ repo: string, source: "main" | "pr", sha: string, committed: string, fetched: string, pr?: number }} SourceJson
 * @typedef {{ kind: "updated" | "shipped", repo: string, sha: string, committed: string, fetched: string, path: string, origin: "main" | "pr", pr: number | null }} RulesSource
 * @typedef {{ rules: import("./compare.mjs").RuleSet, source: RulesSource }} LoadedRules
 */

/**
 * Throws unless `s` is a usable SOURCE.json. `legacy` (only `update --dest` reading the copy it
 * is about to replace) also accepts a SOURCE.json written before `committed` existed.
 * @param {any} s @param {string} which @param {boolean} [legacy]
 * @returns {asserts s is SourceJson}
 */
function validateSourceJson(s, which, legacy = false) {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`${which} SOURCE.json is not an object`);
  if (s.repo !== GREPTILE_REPO) throw new Error(`${which} SOURCE.json repo is ${JSON.stringify(s.repo)}, not ${GREPTILE_REPO}`);
  if (!(legacy && s.committed === undefined)) commitTime(s.committed, `${which} SOURCE.json committed`);
  if (s.source !== "main" && s.source !== "pr") throw new Error(`${which} SOURCE.json source is neither main nor pr`);
  if (typeof s.sha !== "string" || !/^[0-9a-f]{40}$/.test(s.sha)) throw new Error(`${which} SOURCE.json sha is not a 40-hex commit`);
  if (typeof s.fetched !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/.test(s.fetched)) throw new Error(`${which} SOURCE.json fetched is not a date`);
  if (s.pr !== undefined && !(Number.isInteger(s.pr) && s.pr > 0)) throw new Error(`${which} SOURCE.json pr is not a positive integer`);
  if (s.source === "pr" && s.pr === undefined) throw new Error(`${which} SOURCE.json source is pr but names no pr`);
}

/**
 * Read and validate one copy. Throws (a plain Error naming the file) on anything unreadable or
 * malformed. `o.legacy`: a SOURCE.json without `committed` is accepted (the copy an
 * `update --dest` replaces; never for cache selection or a copy being written).
 * @param {string} dir @param {string} which @param {{ legacy?: boolean }} [o]
 * @returns {{ set: import("./compare.mjs").RuleSet, source: SourceJson }}
 */
export function readRuleDir(dir, which, o = {}) {
  const read = (/** @type {string} */ f) => readFileSync(join(dir, f), "utf8");
  const json = (/** @type {string} */ f) => {
    try {
      return JSON.parse(read(f));
    } catch (e) {
      throw new Error(`${which} ${f}: ${/** @type {Error} */ (e).message}`, { cause: e });
    }
  };
  const source = json("SOURCE.json");
  validateSourceJson(source, which, o.legacy === true);
  let rules;
  try {
    rules = read("rules.md");
  } catch (e) {
    throw new Error(`${which} rules.md: ${/** @type {Error} */ (e).message}`, { cause: e });
  }
  const set = { config: json("config.json"), files: json("files.json"), rules };
  validateRuleSet(set, which);
  return { set, source };
}

/**
 * @param {SourceJson} s @param {"updated" | "shipped"} kind @param {string} path
 * @returns {RulesSource}
 */
function describe(s, kind, path) {
  return { kind, repo: s.repo, sha: s.sha, committed: s.committed, fetched: s.fetched, path, origin: s.source, pr: s.pr ?? null };
}

/**
 * Which of two copies sorts later (is preferred): the later upstream `committed`; on a tie the
 * shipped copy, then the later `fetched`, then the larger SHA. Positive when `a` sorts later.
 * @param {RulesSource} a @param {RulesSource} b
 */
export function compareCopies(a, b) {
  const t = Date.parse(a.committed) - Date.parse(b.committed);
  if (t) return t;
  if (a.kind !== b.kind) return a.kind === "shipped" ? 1 : -1;
  if (a.fetched !== b.fetched) return Date.parse(a.fetched) - Date.parse(b.fetched) || (a.fetched > b.fetched ? 1 : -1);
  return a.sha === b.sha ? 0 : a.sha > b.sha ? 1 : -1;
}

/**
 * SHA-256 (hex) of the canonical JSON (src/attest.mjs) of what an audit is judged against: the
 * config.json `rules` array and files.json. `rx audit record` stores it; `rx guard` and
 * `rx audit show` compare it with the rules in use now.
 * @param {import("./compare.mjs").RuleSet} set
 */
export function rulesDigest(set) {
  return createHash("sha256").update(canonicalJson({ rules: set.config.rules, files: set.files })).digest("hex");
}

/**
 * SHA-256 (hex) of the canonical JSON of what one rule asks for: its text and its scope (severity
 * is left out: it changes how loud a finding is, not what the rule covers). `src/audit/greptile.mjs`
 * binds each fully mechanical exemption to this digest, so a rule whose text or scope changes
 * upstream needs a judgment entry again until its mapping is reviewed.
 * @param {{ rule?: unknown, scope?: unknown }} rule
 */
export function ruleContentDigest(rule) {
  return createHash("sha256").update(canonicalJson({ rule: rule.rule, scope: rule.scope })).digest("hex");
}

/**
 * One line naming a copy: `raycast/extensions main @ abc1234 (2026-11-07, updated copy)`.
 * @param {RulesSource} s
 */
export function describeRules(s) {
  const where = s.origin === "pr" ? `PR #${s.pr}` : "main";
  return `${s.repo} ${where} @ ${s.sha.slice(0, 7)} (${s.fetched.slice(0, 10)}, ${s.kind} copy)`;
}

/**
 * The Greptile rules rx uses: the valid copy that sorts latest (compareCopies), the shipped one
 * included. A shipped copy that cannot be read is an ERROR input (the package is broken); an
 * invalid cache copy is reported through `warn` and skipped.
 * @param {{ warn?: (message: string) => void, shippedDir?: string }} [o]
 * @returns {LoadedRules}
 */
export function loadGreptileRules(o = {}) {
  const warn = o.warn ?? ((/** @type {string} */ m) => void process.stderr.write(`${m}\n`));
  const shippedDir = o.shippedDir ?? SHIPPED_DIR;
  /** @type {LoadedRules} */
  let shipped;
  try {
    const r = readRuleDir(shippedDir, "shipped");
    shipped = { rules: r.set, source: describe(r.source, "shipped", shippedDir) };
  } catch (e) {
    throw new RxError(`the shipped Greptile rules in ${shippedDir} are unusable: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }

  /** @type {LoadedRules | null} */
  let best = null;
  const base = greptileRulesCachePath();
  if (existsSync(base) && statSync(base).isDirectory()) {
    // Names starting with "." are an update still being written (or one that died mid-write).
    const names = readdirSync(base).filter((n) => !n.startsWith(".")).sort();
    for (const name of names) {
      const dir = join(base, name);
      try {
        const r = readRuleDir(dir, "cached");
        const cand = { rules: r.set, source: describe(r.source, "updated", dir) };
        if (!best || compareCopies(cand.source, best.source) > 0) best = cand;
      } catch (e) {
        warn(`rx: ignoring the invalid Greptile rules copy in ${dir}: ${/** @type {Error} */ (e).message}`);
      }
    }
  }
  if (best && compareCopies(best.source, shipped.source) > 0) return best;
  return shipped;
}

/**
 * Write a fetched copy into the cache atomically: the files go into a hidden temp directory beside
 * the destination, are read back through the same validation the lookup uses, and the directory is
 * then renamed into place. On any failure the temp directory is removed and nothing is left.
 * @param {Record<string, string>} raw the three live files by name
 * @param {SourceJson} source
 * @returns {string} the new copy's directory
 */
export function writeUpdatedCopy(raw, source) {
  const base = greptileRulesCachePath();
  mkdirSync(base, { recursive: true });
  const final = join(base, `${source.fetched.replace(/[:.]/g, "-")}-${source.sha.slice(0, 7)}`);
  const tmp = join(base, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmp);
  try {
    for (const f of SNAPSHOT_FILES) writeFileSync(join(tmp, f), raw[f]);
    writeFileSync(join(tmp, "SOURCE.json"), JSON.stringify(source, null, 2) + "\n");
    readRuleDir(tmp, "fetched");
    if (existsSync(final)) throw new Error(`${final} already exists`);
    renameSync(tmp, final);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return final;
}

/**
 * Replace a maintainer checkout's copy (`update --dest`) all-or-nothing: the four files are staged
 * in a hidden temp directory beside the destination and validated there (the same readRuleDir the
 * lookup uses); only then are the destination's files overwritten, the originals held in memory.
 * Each file is recorded as attempted BEFORE its write, so a write that truncates and then throws
 * (ENOSPC) is restored too. On any failure every attempted file is restored
 * and read back; the error says every file was restored only when each read-back equals the
 * original bytes, else it is marked `partial` and names the files that could not be restored.
 * @param {string} destDir a checkout's src/rules/greptile @param {Record<string, string>} raw the
 *   three live files by name @param {SourceJson} source
 * @param {{ writeFileSync: typeof writeFileSync, readFileSync: typeof readFileSync }} [io] tests only
 */
export function writeDestCopy(destDir, raw, source, io = { writeFileSync, readFileSync }) {
  const files = [...SNAPSHOT_FILES, "SOURCE.json"];
  const next = { ...raw, "SOURCE.json": JSON.stringify(source, null, 2) + "\n" };
  const stage = join(dirname(destDir), `.tmp-greptile-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(stage);
  try {
    for (const f of files) writeFileSync(join(stage, f), next[f]);
    readRuleDir(stage, "fetched");
    const originals = Object.fromEntries(files.map((f) => [f, io.readFileSync(join(destDir, f))]));
    /** @type {string[]} */
    const attempted = [];
    try {
      for (const f of files) {
        attempted.push(f);
        io.writeFileSync(join(destDir, f), next[f]);
      }
    } catch (e) {
      /** @type {string[]} */
      const unrestored = [];
      for (const f of attempted) {
        const intact = () => Buffer.from(io.readFileSync(join(destDir, f))).equals(originals[f]);
        try {
          // A write that failed before opening (EACCES) left the file as it was: nothing to restore.
          if (intact()) continue;
          io.writeFileSync(join(destDir, f), originals[f]);
          if (!intact()) unrestored.push(f);
        } catch {
          unrestored.push(f);
        }
      }
      const msg = /** @type {Error} */ (e).message;
      if (!unrestored.length) throw new Error(`${msg}; every file in ${destDir} was restored`, { cause: e });
      const partial = new Error(`${msg}; and could not restore ${unrestored.join(", ")} in ${destDir}: check them by hand`, { cause: e });
      /** @type {any} */ (partial).partial = true;
      throw partial;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// `rx api-floor --preset f [--root d] [--json]`: is @raycast/api at or above the floor the preset's
// dependency policy sets for this extension? Policy comes only from the preset (plan 4.7, 4.16;
// plan-review-1 #7; Q8). Publication status comes only from rx stale's baseline.json.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RxError } from "../errors.mjs";
import { run as exec } from "../exec.mjs";
import { compareSemver } from "../preset/applies.mjs";
import { loadPreset } from "../preset/load.mjs";
import { readLockfile } from "../preflight/context.mjs";
import { repoStatePathReadOnly } from "../state.mjs";

const PKG = "@raycast/api";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "api-floor",
  summary: "check @raycast/api (lockfile and manifest) against the preset's dependency floors; npm currency is advisory",
  root: "required",
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root" },
    "--preset": { type: "string", value: "<file>", required: true, help: "preset JSON holding dependencies.api" },
  },
  network: "optional: `npm view @raycast/api version` for the currency advisory; unreachable → N/A api-currency, the floor checks still run",
  state: "reads repo/stale/baseline.json (written by rx stale) for the publication status",
  data: {
    policy: "\"existing-1x\" | \"2x\"",
    floor: "string",
    resolved: "string — lockfile-resolved @raycast/api",
    range: "string | null — the manifest range",
    latest: "string | null — npm latest, null when unreachable",
    publication: "\"new\" | \"existing\" | \"unknown\"",
  },
  // `levels` is what `rx preset check` reads: a `report` rule may bind the two advisory checks, never the two that can FAIL.
  checks: {
    "api-floor-lockfile": { description: "lockfile-resolved @raycast/api ≥ the selected policy's floor", levels: ["PASS", "FAIL"] },
    "api-floor-manifest": { description: "the manifest range's lower bound ≥ the floor (WARN below; WARN when no range)", levels: ["PASS", "WARN"] },
    "api-floor-new": { description: "a brand-new extension (rx stale: published false) is on 2.x", levels: ["PASS", "FAIL", "N/A"] },
    "api-currency": { description: "lockfile-resolved @raycast/api equals npm latest (WARN behind; N/A npm unreachable)", levels: ["PASS", "WARN", "N/A"] },
  },
  examples: ["rx api-floor --preset presets/chrismessina.json"],
};

/** @returns {Promise<string | null>} npm latest for @raycast/api, or null when unreachable */
async function npmLatest() {
  try {
    const r = await exec("npm", ["view", PKG, "version", "--json"], { timeoutMs: 20_000 });
    if (r.code !== 0) return null;
    const v = JSON.parse(r.stdout);
    return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

let registry = npmLatest;
/** Test hook: replace the npm lookup (tests never reach the network). @param {() => Promise<string | null>} fn */
export function _setRegistry(fn) { registry = fn; }

const FULL = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const XRANGE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;

/**
 * The lowest version one comparator admits, as a lower bound; `null` for "no lower bound"
 * (`<`, `<=`, `*`); `undefined` when the comparator is not understood.
 * @param {string} c
 * @returns {string | null | undefined}
 */
function comparatorLowerBound(c) {
  const m = c.match(/^(>=|<=|>|<|=|\^|~)?\s*(.*)$/);
  if (!m) return undefined;
  const op = m[1] ?? "";
  const v = m[2].trim();
  if (op === "<" || op === "<=") return null;
  const full = v.match(FULL);
  if (full) {
    if (op === ">") {
      // The smallest version above an exact release is the next patch; above a prerelease it is
      // not representable here, so the range is reported as not understood.
      if (full[4]) return undefined;
      return `${full[1]}.${full[2]}.${Number(full[3]) + 1}`;
    }
    return `${full[1]}.${full[2]}.${full[3]}${full[4] ?? ""}`; // prerelease kept; build metadata dropped
  }
  const x = v.match(XRANGE);
  if (x) {
    if (op === ">") return undefined;
    const num = (/** @type {string | undefined} */ s) => (s !== undefined && /^\d+$/.test(s) ? s : null);
    const major = num(x[1]);
    if (major === null) return null; // `*`, `x`
    return `${major}.${num(x[2]) ?? 0}.${num(x[3]) ?? 0}`;
  }
  return undefined;
}

/**
 * The lowest version a manifest range admits, or null when the range is not understood (the
 * caller then WARNs; a bound is never invented). Semver semantics: `||` unions take the lowest
 * bound of any set; a space-separated comparator set takes the highest lower bound of its
 * comparators; `a - b` hyphen ranges start at `a`; prerelease identifiers are kept and order
 * below their release (`^1.104.25-beta.1` admits 1.104.25-beta.1); `>x.y.z` starts at the next
 * patch; `<`/`<=` contribute no lower bound.
 * @param {string} range
 */
export function rangeLowerBound(range) {
  /** @type {string[]} */
  const bounds = [];
  for (const part of range.split("||")) {
    const set = part.trim();
    if (set === "" || set === "*" || set === "latest") { bounds.push("0.0.0"); continue; }
    const hyphen = set.match(/^(\S+)\s+-\s+(\S+)$/);
    const comparators = hyphen ? [hyphen[1]] : set.split(/\s+/);
    let setBound = "0.0.0";
    for (const c of comparators) {
      const b = comparatorLowerBound(c);
      if (b === undefined) return null;
      if (b !== null && compareSemver(b, setBound) > 0) setBound = b;
    }
    bounds.push(setBound);
  }
  return bounds.sort(compareSemver)[0] ?? null;
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, root, cwd, results, log }) {
  if (!root) throw new RxError("api-floor needs an extension root", { id: "root" });
  const loaded = loadPreset(/** @type {string} */ (args.flags["--preset"]), cwd);
  const policies = loaded.preset.dependencies?.api;
  if (!policies) throw new RxError(`preset ${loaded.path} has no dependencies.api block`, { id: "input" });

  const lock = readLockfile(root);
  if (!lock.present) throw new RxError(`no package-lock.json in ${root}; run npm install`, { id: "api-floor-lockfile" });
  const resolved = lock.resolved(PKG);
  if (!resolved) throw new RxError(`${PKG} is not resolved in the lockfile`, { id: "api-floor-lockfile" });
  const major = Number(resolved.split(".")[0]);
  /** @type {"existing-1x" | "2x"} */
  let policy;
  if (major === 1) policy = "existing-1x";
  else if (major === 2) policy = "2x";
  else throw new RxError(`${PKG} ${resolved} has major ${major}; the preset defines policies for 1.x and 2.x only`, { id: "api-floor-lockfile" });
  const floor = policies[policy].floor;

  // Publication status: only from rx stale's baseline. Missing or malformed → unknown.
  /** @type {"new" | "existing" | "unknown"} */
  let publication = "unknown";
  try {
    const file = await repoStatePathReadOnly(root, "stale", "baseline.json");
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (typeof j?.published === "boolean") publication = j.published ? "existing" : "new";
    }
  } catch (e) {
    log(`api-floor: baseline unreadable: ${/** @type {Error} */ (e).message}\n`);
  }

  if (compareSemver(resolved, floor) >= 0) results.pass("api-floor-lockfile", `${PKG} ${resolved} ≥ floor ${floor} (policy ${policy})`);
  else results.fail("api-floor-lockfile", `${PKG} ${resolved} is below the ${policy} floor ${floor}`);

  /** @type {string | null} */
  let range;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const r = pkg?.dependencies?.[PKG];
    range = typeof r === "string" ? r : null;
  } catch { range = null; }
  if (range === null) results.warn("api-floor-manifest", `${PKG} has no range in package.json dependencies`);
  else {
    const lower = rangeLowerBound(range);
    if (lower === null) results.warn("api-floor-manifest", `range ${JSON.stringify(range)} not understood; check its lower bound against ${floor} by hand`);
    else if (compareSemver(lower, floor) >= 0) results.pass("api-floor-manifest", `range ${range} starts at ${lower} ≥ ${floor}`);
    else results.warn("api-floor-manifest", `range ${range} admits ${lower}, below the floor ${floor}`);
  }

  if (publication === "existing") results.na("api-floor-new", "published extension");
  else if (publication === "unknown") results.na("api-floor-new", "run rx stale first to learn whether the extension is published");
  else if (major === 1) results.fail("api-floor-new", `new extensions start on 2.x (policy ${policies.new}); ${PKG} resolves to ${resolved}`);
  else results.pass("api-floor-new", `new extension on ${resolved} (2.x)`);

  const latest = await registry();
  if (latest === null) results.na("api-currency", "npm unreachable");
  else if (compareSemver(resolved, latest) >= 0) results.pass("api-currency", `${resolved} is npm latest`);
  else {
    const crossesMajor = resolved.split(".")[0] !== latest.split(".")[0];
    results.warn("api-currency", `${resolved} is behind npm latest ${latest}${crossesMajor ? " (advisory: crossing a major is a migration, not a ship-time bump)" : ""}`);
  }

  return { data: { policy, floor, resolved, range, latest, publication } };
}

// The one check-and-update routine for the Greptile rules in use, shared by `rx greptile update`
// (cache mode) and the first `rx gates` step, `greptile-rules` (docs/commands.md §4.8, §4.12):
//
//   1. load the rules in use (src/greptile/rules.mjs loadGreptileRules)
//   2. ONE request for the last commit on raycast/extensions main that touched .greptile/; when it
//      is the copy's own SHA, the copy is current and nothing else is fetched
//   3. otherwise read the three live files, parse and validate them (validateRuleSet, through
//      diffRuleSets) and compare them with the copy in use
//   4. when anything changed, write them atomically as a new cache copy (writeUpdatedCopy: staged,
//      validated again, renamed into place), then read back which copy is in use
//
// Every outcome carries `selected`: the snapshot that is the copy in use as the routine finishes
// (`before`, or `now` after a write). `rx gates` stamps exactly that object into its receipt and
// never reloads, so the stamp always describes the snapshot the step reported.
// updateWithin() bounds the whole routine with a deadline for `rx gates`; once it expires the
// routine never starts a write, and a write already started is synchronous and finishes (or
// removes its staged directory) before the deadline can be observed.
//
// Each failure says which phase it came from, so a caller can tell "could not check" (step 2 or
// the file reads in step 3: offline, gh unavailable, an API error) from "the live rules are
// invalid" (parse or schema, step 3) from "could not write" (step 4). Nothing is installed unless
// every check passed. Every request names raycast/extensions (GREPTILE_REPO), never a copy's own
// metadata.

import { RxError } from "../errors.mjs";
import { GREPTILE_REPO, diffRuleSets, fetchLiveRaw, liveSource, parseLive } from "./compare.mjs";
import { describeRules, loadGreptileRules, writeUpdatedCopy } from "./rules.mjs";

/** @typedef {"check" | "validate"} ComparePhase */

/**
 * @param {unknown} e @param {ComparePhase} phase
 * @returns {Error & { phase: ComparePhase }}
 */
function tag(e, phase) {
  const err = e instanceof Error ? e : new Error(String(e));
  return Object.assign(err, { phase });
}

/**
 * Where the live rules are, fetched and compared with `base`. `source moved` is a change like any
 * other: it leads `changes`. Throws an Error carrying `phase`: `check` when the live rules could
 * not be located or read, `validate` when what was read does not parse or fails the schema.
 * @param {import("./rules.mjs").RulesSource} from @param {import("./compare.mjs").RuleSet} base
 * @param {import("./compare.mjs").Fetcher} f
 * @returns {Promise<{ where: Awaited<ReturnType<typeof liveSource>>, live: { raw: Record<string, string>, set: import("./compare.mjs").RuleSet } | null, changes: string[] }>}
 */
export async function compareLive(from, base, f) {
  /** @type {Awaited<ReturnType<typeof liveSource>>} */
  let where;
  /** @type {Record<string, string>} */
  let raw;
  try {
    where = await liveSource(GREPTILE_REPO, from.pr, f);
    // The copy was fetched at the commit that last touched .greptile/: nothing to fetch or compare.
    if (where.source === from.origin && where.sha === from.sha) return { where, live: null, changes: [] };
    raw = await fetchLiveRaw(GREPTILE_REPO, where.sha, f);
  } catch (e) {
    throw tag(e, "check");
  }
  try {
    const live = parseLive(raw);
    const changes = diffRuleSets(base, live.set);
    if (where.source !== from.origin) changes.unshift(`source moved ${from.origin} → ${where.source}${where.source === "main" && from.pr ? ` (PR #${from.pr} merged)` : ""}`);
    return { where, live, changes };
  } catch (e) {
    throw tag(e, "validate");
  }
}

/**
 * @typedef {{ source: string, sha: string, committed: string }} LiveRef
 * @typedef {import("./rules.mjs").LoadedRules} LoadedRules
 * @typedef {(
 *   | { status: "unchecked" | "invalid" | "timed-out", before: LoadedRules, selected: LoadedRules, live: null, changes: string[], error: string }
 *   | { status: "current", before: LoadedRules, selected: LoadedRules, live: LiveRef, label: string, changes: string[] }
 *   | { status: "write-failed", before: LoadedRules, selected: LoadedRules, live: LiveRef, changes: string[], error: string }
 *   | { status: "updated" | "not-in-use", before: LoadedRules, selected: LoadedRules, live: LiveRef, changes: string[], dir: string, now: LoadedRules }
 * )} UpdateOutcome
 *   `unchecked`: the live rules could not be located or read (offline, gh unavailable, an API
 *   error). `invalid`: they were read but do not parse or fail validation; nothing installed.
 *   `current`: the copy in use matches them; nothing written. `write-failed`: the cache copy could
 *   not be written (or failed validation once staged); nothing installed. `updated`: written and
 *   now the copy in use. `not-in-use`: written, but a copy from a later upstream commit sorts
 *   later and stays in use (`now`). `timed-out` (updateWithin only): the deadline expired first;
 *   nothing was or will be installed by this run. `selected` is `now` after a write, else `before`.
 */

/**
 * Check the rules in use against raycast/extensions main and, when they differ, install the live
 * rules as a new cache copy. Never throws for a network, validation or write failure (the status
 * says which); a shipped copy that cannot be read throws RxError input from loadGreptileRules.
 * `before` (updateWithin) is the copy in use already loaded; `signal`, once aborted, stops the
 * routine before any write (it then reports `timed-out`).
 * @param {{ fetcher: import("./compare.mjs").Fetcher, warn: (message: string) => void, before?: LoadedRules, signal?: AbortSignal }} o
 * @returns {Promise<UpdateOutcome>}
 */
export async function updateCacheCopy({ fetcher, warn, before = loadGreptileRules({ warn }), signal }) {
  /** @type {Awaited<ReturnType<typeof compareLive>>} */
  let got;
  // Every request carries the signal, so an abort kills the gh child instead of waiting it out.
  /** @type {import("./compare.mjs").Fetcher} */
  const f = signal ? { getJson: (p) => fetcher.getJson(p, { signal }), getRaw: (p) => fetcher.getRaw(p, { signal }) } : fetcher;
  try {
    got = await compareLive(before.source, before.rules, f);
  } catch (e) {
    const err = /** @type {Error & { phase?: ComparePhase }} */ (e);
    return { status: err.phase === "validate" ? "invalid" : "unchecked", before, selected: before, live: null, changes: [], error: err.message };
  }
  const { where, live: fetched, changes } = got;
  const live = { source: where.source, sha: where.sha, committed: where.committed };
  if (!changes.length) return { status: "current", before, selected: before, live, label: where.label, changes };
  // The caller's deadline expired while the request was pending: never start a write after it.
  if (signal?.aborted) return { status: "timed-out", before, selected: before, live: null, changes: [], error: "the deadline expired before the write" };
  if (!fetched) throw new RxError("internal: changes without a fetched live copy", { id: "internal" });
  // A cache copy names a PR only when it came from one.
  const pr = before.source.pr && where.source === "pr" ? { pr: before.source.pr } : {};
  /** @type {string} */
  let dir;
  try {
    dir = writeUpdatedCopy(fetched.raw, { repo: GREPTILE_REPO, ...pr, source: where.source, sha: where.sha, committed: where.committed, fetched: new Date().toISOString() });
  } catch (e) {
    return { status: "write-failed", before, selected: before, live, changes, error: /** @type {Error} */ (e).message };
  }
  // The copy just written is used only when nothing sorts later by upstream commit date (a newer
  // shipped copy, or a cache copy from a later commit that another update wrote first).
  const now = loadGreptileRules({ warn });
  return { status: now.source.path === dir ? "updated" : "not-in-use", before, selected: now, live, changes, dir, now };
}

/**
 * updateCacheCopy() bounded by `deadlineMs` (the `rx gates` step). The copy in use is loaded first
 * (a shipped copy that cannot be read throws, as in updateCacheCopy). When the deadline expires
 * first, the routine is aborted (it starts no write from then on, and the signal kills a pending
 * GitHub request's gh child) and this resolves `timed-out` with `before` selected.
 * @param {{ fetcher: import("./compare.mjs").Fetcher, warn: (message: string) => void, deadlineMs: number }} o
 * @returns {Promise<UpdateOutcome>}
 */
export async function updateWithin({ fetcher, warn, deadlineMs }) {
  const before = loadGreptileRules({ warn });
  const ac = new AbortController();
  // Messages from a routine abandoned at the deadline are not this run's to print.
  const quiet = (/** @type {string} */ m) => {
    if (!ac.signal.aborted) warn(m);
  };
  const work = updateCacheCopy({ fetcher, warn: quiet, before, signal: ac.signal });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<UpdateOutcome>} */
  const expired = new Promise((res) => {
    timer = setTimeout(() => {
      ac.abort();
      res({ status: "timed-out", before, selected: before, live: null, changes: [], error: `no answer within ${deadlineMs} ms` });
    }, deadlineMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
    // Whatever settled the race, nothing may outlive it: a request still in flight (a sibling of a
    // file fetch that failed fast, or the routine abandoned at the deadline) is cancelled now, so
    // its gh child is killed instead of running to its own timeout and keeping rx alive.
    ac.abort();
    // An abandoned routine that later fails has no one to report to.
    work.catch(() => {});
  }
}

/**
 * `updated: <old sha7> → <new sha7>, N change(s)`: the sentence both callers print for `updated`.
 * @param {{ before: import("./rules.mjs").LoadedRules, live: LiveRef, changes: string[] }} o
 */
export function updatedMessage(o) {
  return `updated: ${o.before.source.sha.slice(0, 7)} → ${o.live.sha.slice(0, 7)}, ${o.changes.length} change(s)`;
}

/**
 * The sentence both callers print for `not-in-use`.
 * @param {{ live: LiveRef, dir: string, now: import("./rules.mjs").LoadedRules }} o
 */
export function notInUseMessage(o) {
  return `wrote ${o.dir} (${o.live.sha.slice(0, 7)}, committed ${o.live.committed}) but it is not the copy in use: ${describeRules(o.now.source)}, committed ${o.now.source.committed}, sorts later; nothing to do unless that copy is wrong`;
}

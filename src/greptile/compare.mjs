// The pure half of `rx greptile outdated` / `update` and doctor's `greptile-rules` check (ported
// from the plugin's script): what changed between the Greptile rules in use (src/greptile/rules.mjs)
// and the live `.greptile/` in raycast/extensions, and where the live copy is. No I/O here except
// through the injected fetcher.

import { isObject } from "../util.mjs";

export const SNAPSHOT_FILES = ["config.json", "files.json", "rules.md"];

/** The one repository Greptile's Raycast rules come from. Every upstream request names it. */
export const GREPTILE_REPO = "raycast/extensions";

/** The severities the shipped copy uses; a rule with any other value makes a copy invalid. */
export const SEVERITIES = Object.freeze(["low", "medium", "high"]);

/** How far a commit date may sit in the future (clock skew) before the copy carrying it is invalid. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The epoch milliseconds of an upstream commit date (`commit.committer.date`), or a thrown Error
 * naming `label` when it is not an ISO-8601 time or lies more than a day in the future.
 * @param {unknown} value @param {string} label @param {number} [now]
 */
export function commitTime(value, label, now = Date.now()) {
  const t = typeof value === "string" && ISO_TIME.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) throw new Error(`${label} is not an ISO-8601 commit time: ${JSON.stringify(value)}`);
  if (t > now + FUTURE_SLACK_MS) throw new Error(`${label} ${value} is more than a day in the future`);
  return t;
}

/**
 * @typedef {{ config: any, files: any, rules: string }} RuleSet
 */

/** @param {unknown} v */
const isText = (v) => typeof v === "string" && v.trim().length > 0;
/** @param {unknown} v */
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Throws on any shape a consumer cannot use, so a malformed set never reads as "no changes" and
 * is never accepted or installed. The schema is the shipped copy's: every rule has a nonempty
 * `id` and `rule` (text), a `severity` in SEVERITIES and a `scope` array of strings; every
 * files.json entry has a nonempty `path`, a `description` string and a `scope` array of
 * strings; rules.md is text. The rules lookup, `update` (cache and --dest) and the shipped-copy
 * test all validate with this one function.
 * @param {RuleSet} set @param {string} which
 */
export function validateRuleSet(set, which) {
  if (!isObject(set.config)) throw new Error(`${which} config.json is not an object`);
  if (!Array.isArray(set.config.rules)) throw new Error(`${which} config.json has no rules array`);
  const seen = new Set();
  set.config.rules.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    if (!isObject(r)) throw new Error(`${which} config.json rule ${i} is not an object`);
    if (typeof r.id !== "string" || !r.id) throw new Error(`${which} config.json has a rule without an id`);
    if (seen.has(r.id)) throw new Error(`${which} config.json has a duplicate rule id: ${r.id}`);
    seen.add(r.id);
    if (!isText(r.rule)) throw new Error(`${which} config.json rule ${r.id} has no rule text`);
    if (!SEVERITIES.includes(r.severity)) throw new Error(`${which} config.json rule ${r.id} severity ${JSON.stringify(r.severity)} is not one of ${SEVERITIES.join(", ")}`);
    if (!isStringArray(r.scope)) throw new Error(`${which} config.json rule ${r.id} scope is not an array of strings`);
  });
  if (!isObject(set.files) || !Array.isArray(set.files.files)) throw new Error(`${which} files.json has no files array`);
  set.files.files.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
    if (!isObject(e) || !isText(e.path)) throw new Error(`${which} files.json entry ${i} has no path`);
    if (typeof e.description !== "string") throw new Error(`${which} files.json entry ${e.path} has no description string`);
    if (!isStringArray(e.scope)) throw new Error(`${which} files.json entry ${e.path} scope is not an array of strings`);
  });
  if (typeof set.rules !== "string") throw new Error(`${which} rules.md is not text`);
}

/**
 * Human-readable change lines: `rule added <id> [severity]`, `rule removed <id>`,
 * `rule changed <id> <field>` (one per field), `setting changed <key>`, `files changed <path>
 * (added|removed|changed)`, `rules.md changed…`. Empty means the two are the same.
 * @param {RuleSet} snapshot the copy in use @param {RuleSet} live
 * @returns {string[]}
 */
export function diffRuleSets(snapshot, live) {
  validateRuleSet(snapshot, "in-use");
  validateRuleSet(live, "live");
  /** @type {string[]} */
  const out = [];
  const byId = (/** @type {any} */ c) => new Map((c.rules ?? []).map((/** @type {any} */ r) => [r.id, r]));
  const a = byId(snapshot.config);
  const b = byId(live.config);
  for (const [id, r] of b) if (!a.has(id)) out.push(`rule added ${id} [${r.severity}]`);
  for (const id of a.keys()) if (!b.has(id)) out.push(`rule removed ${id}`);
  for (const [id, r] of b) {
    const o = a.get(id);
    if (!o) continue;
    for (const k of ["severity", "scope", "rule"]) if (JSON.stringify(o[k]) !== JSON.stringify(r[k])) out.push(`rule changed ${id} ${k}`);
  }
  for (const k of new Set([...Object.keys(snapshot.config), ...Object.keys(live.config)]))
    if (k !== "rules" && JSON.stringify(snapshot.config[k]) !== JSON.stringify(live.config[k])) out.push(`setting changed ${k}`);

  const paths = (/** @type {any} */ f) => new Map((f.files ?? []).map((/** @type {any} */ e) => [e.path, JSON.stringify(e)]));
  const fa = paths(snapshot.files);
  const fb = paths(live.files);
  for (const [p, e] of fb) if (fa.get(p) !== e) out.push(`files changed ${p} (${fa.has(p) ? "changed" : "added"})`);
  for (const p of fa.keys()) if (!fb.has(p)) out.push(`files changed ${p} (removed)`);

  if (snapshot.rules !== live.rules) {
    const heads = (/** @type {string} */ t) => new Set(t.split("\n").filter((l) => l.startsWith("## ")));
    const ha = heads(snapshot.rules);
    const hb = heads(live.rules);
    const added = [...hb].filter((h) => !ha.has(h));
    const gone = [...ha].filter((h) => !hb.has(h));
    out.push("rules.md changed" + (added.length ? `; sections added: ${added.join(" | ")}` : "") + (gone.length ? `; sections removed: ${gone.join(" | ")}` : ""));
  }
  return out;
}

/**
 * @typedef {{ getJson: (path: string, o?: { signal?: AbortSignal }) => Promise<any>, getRaw: (path: string, o?: { signal?: AbortSignal }) => Promise<string> }} Fetcher
 *   Paths are GitHub REST paths (`repos/<r>/commits?path=.greptile&sha=main&per_page=1`). An
 *   aborted `signal` cancels the request (src/greptile/update.mjs passes the step's deadline).
 */

/**
 * The latest commit on main that touched `.greptile/` (any file in it): one request. A copy whose
 * SHA equals it is current without fetching a file, however far main itself has moved.
 * @param {string} repo
 */
export const greptileCommitsPath = (repo) => `repos/${repo}/commits?path=.greptile&sha=main&per_page=1`;

/**
 * @param {string} repo @param {Fetcher} f
 * @returns {Promise<{ sha: string, committed: string } | null>} the SHA and its committer date (the
 *   upstream chronology copies are ordered by), or null when no commit on main touches `.greptile/`
 */
export async function lastGreptileCommit(repo, f) {
  const path = greptileCommitsPath(repo);
  const list = await f.getJson(path);
  if (!Array.isArray(list)) throw new Error(`${path} did not return a list`);
  if (!list.length) return null;
  const sha = list[0]?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${path} returned a commit without a 40-hex sha`);
  const committed = list[0]?.commit?.committer?.date;
  commitTime(committed, `${path} commit.committer.date`);
  return { sha, committed: /** @type {string} */ (committed) };
}

/**
 * Where the live rules are: the latest commit on main that touched `.greptile/` once it lands
 * there (the directory, not one file, so an edit to rules.md alone is still seen); until then, the
 * head of the PR named in SOURCE.json, which must still be open. A copy with no PR (every copy
 * `rx greptile update` writes) has no fallback: main without `.greptile/` is an error.
 * @param {string} repo @param {number | null} pr @param {Fetcher} f
 * @returns {Promise<{ source: "main" | "pr", sha: string, committed: string, label: string }>}
 */
export async function liveSource(repo, pr, f) {
  const head = await lastGreptileCommit(repo, f);
  if (head) return { source: "main", sha: head.sha, committed: head.committed, label: `main @ ${head.sha.slice(0, 7)}` };
  if (pr === null) throw new Error("no commit on main touches .greptile/: the rules moved; find where");
  const p = await f.getJson(`repos/${repo}/pulls/${pr}`);
  if (p.state !== "open") throw new Error(`PR #${pr} is ${p.merged_at ? "merged" : "closed"} but main has no .greptile/config.json: the rules moved; find where`);
  const sha = p.head?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`PR #${pr} head has no 40-hex sha`);
  // The PR head's own commit date orders it against other copies, as a main commit's does.
  const c = await f.getJson(`repos/${repo}/commits/${sha}`);
  const committed = c?.commit?.committer?.date;
  commitTime(committed, `PR #${pr} head commit.committer.date`);
  return { source: "pr", sha, committed: /** @type {string} */ (committed), label: `PR #${pr} head @ ${sha.slice(0, 7)} (open, not merged)` };
}

/**
 * Read the three live files at a SHA, unparsed: the network half of fetchLive.
 * @param {string} repo @param {string} sha @param {Fetcher} f
 * @returns {Promise<Record<string, string>>}
 */
export async function fetchLiveRaw(repo, sha, f) {
  const [config, files, rules] = await Promise.all(SNAPSHOT_FILES.map((n) => f.getRaw(`repos/${repo}/contents/.greptile/${n}?ref=${sha}`)));
  return { "config.json": config, "files.json": files, "rules.md": rules };
}

/**
 * Parse the three live files (throws on JSON that does not parse; the schema check is
 * validateRuleSet, run by diffRuleSets): the local half of fetchLive.
 * @param {Record<string, string>} raw
 * @returns {{ raw: Record<string, string>, set: RuleSet }}
 */
export function parseLive(raw) {
  return { raw, set: { config: JSON.parse(raw["config.json"]), files: JSON.parse(raw["files.json"]), rules: raw["rules.md"] } };
}

/**
 * Fetch the three live files at a SHA.
 * @param {string} repo @param {string} sha @param {Fetcher} f
 * @returns {Promise<{ raw: Record<string, string>, set: RuleSet }>}
 */
export async function fetchLive(repo, sha, f) {
  return parseLive(await fetchLiveRaw(repo, sha, f));
}

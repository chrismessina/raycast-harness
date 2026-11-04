// The pure half of `rx greptile drift` (port of the plugin's greptile-drift.mjs): what changed
// between the core snapshot (src/rules/greptile/) and the live `.greptile/` in raycast/extensions,
// and where the live copy is. No I/O here except through the injected fetcher.

export const SNAPSHOT_FILES = ["config.json", "files.json", "rules.md"];

/**
 * @typedef {{ config: any, files: any, rules: string }} RuleSet
 * @typedef {{ repo: string, pr: number, source: "main" | "pr", sha: string, fetched: string }} Source
 */

/**
 * Throws on a shape that cannot be compared safely, so a malformed set never reads as "no drift".
 * @param {RuleSet} set @param {string} which
 */
function validate(set, which) {
  if (!Array.isArray(set.config?.rules)) throw new Error(`${which} config.json has no rules array`);
  const seen = new Set();
  for (const r of set.config.rules) {
    if (typeof r?.id !== "string" || !r.id) throw new Error(`${which} config.json has a rule without an id`);
    if (seen.has(r.id)) throw new Error(`${which} config.json has a duplicate rule id: ${r.id}`);
    seen.add(r.id);
  }
  if (!Array.isArray(set.files?.files)) throw new Error(`${which} files.json has no files array`);
  if (typeof set.rules !== "string") throw new Error(`${which} rules.md is not text`);
}

/**
 * Human-readable change lines: `rule added <id> [severity]`, `rule removed <id>`,
 * `rule changed <id> <field>` (one per field), `setting changed <key>`, `files changed <path>
 * (added|removed|changed)`, `rules.md changed…`. Empty means no drift.
 * @param {RuleSet} snapshot @param {RuleSet} live
 * @returns {string[]}
 */
export function diffRuleSets(snapshot, live) {
  validate(snapshot, "snapshot");
  validate(live, "live");
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
 * @typedef {{ getJson: (path: string) => Promise<any>, getRaw: (path: string) => Promise<string> }} Fetcher
 *   Paths are GitHub REST paths (`repos/<r>/commits/main`); a missing file rejects with an error
 *   whose `.status` is 404 (or whose message contains "404").
 */

/** @param {unknown} e */
function is404(e) {
  const err = /** @type {any} */ (e);
  return err?.status === 404 || /\b404\b/.test(String(err?.message ?? ""));
}

/**
 * Where the live rules are: main's current head once `.greptile/` lands there (the head, not the
 * last commit to touch one file, so an edit to rules.md alone is still seen); until then, the
 * head of the PR named in SOURCE.json, which must still be open.
 * @param {string} repo @param {number} pr @param {Fetcher} f
 * @returns {Promise<{ source: "main" | "pr", sha: string, label: string }>}
 */
export async function liveSource(repo, pr, f) {
  const head = (await f.getJson(`repos/${repo}/commits/main`)).sha;
  if (typeof head !== "string" || !head) throw new Error(`repos/${repo}/commits/main has no sha`);
  const onMain = await f.getRaw(`repos/${repo}/contents/.greptile/config.json?ref=${head}`).then(
    () => true,
    (e) => (is404(e) ? false : Promise.reject(e)),
  );
  if (onMain) return { source: "main", sha: head, label: `main @ ${head.slice(0, 7)}` };
  const p = await f.getJson(`repos/${repo}/pulls/${pr}`);
  if (p.state !== "open") throw new Error(`PR #${pr} is ${p.merged_at ? "merged" : "closed"} but main has no .greptile/config.json: the rules moved; find where`);
  return { source: "pr", sha: p.head.sha, label: `PR #${pr} head @ ${String(p.head.sha).slice(0, 7)} (open, not merged)` };
}

/**
 * Fetch the three live files at a SHA.
 * @param {string} repo @param {string} sha @param {Fetcher} f
 * @returns {Promise<{ raw: Record<string, string>, set: RuleSet }>}
 */
export async function fetchLive(repo, sha, f) {
  const [config, files, rules] = await Promise.all(SNAPSHOT_FILES.map((n) => f.getRaw(`repos/${repo}/contents/.greptile/${n}?ref=${sha}`)));
  return { raw: { "config.json": config, "files.json": files, "rules.md": rules }, set: { config: JSON.parse(config), files: JSON.parse(files), rules } };
}

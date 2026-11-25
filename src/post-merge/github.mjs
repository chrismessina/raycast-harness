// `rx post-merge` steps 1 and 2 (docs/commands.md § rx post-merge): what GitHub says about the
// pull request and raycastbot's commits on its branch. Every call goes through the transport
// (src/pr/transport.mjs), so tests replace it and nothing here reaches github.com on its own.
// These functions record no results: they return what they found, and the command maps it.

import { RxError } from "../errors.mjs";
import { transport } from "../pr/transport.mjs";

const REPO = "repos/raycast/extensions";
export const BOT = "raycastbot";
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * @typedef {{ type: "file" | "symlink" | "submodule" | "other", mode: string, blob: string }} Side
 *   One side of a path (docs/commands.md § rx post-merge, **Identity**). An absent side is null.
 * @typedef {{ path: string, pre: Side | null, post: Side }} RewritePath
 *   `path` is extension-relative.
 * @typedef {{ status: "fail", message: string, details: import("../verdict.mjs").Detail[] }
 *   | { status: "pass", run: Array<{ sha: string, files: string[] }>, paths: RewritePath[], message: string, details: import("../verdict.mjs").Detail[] }} Rewrites
 */

/** @param {string} what */
const github = (what) => new RxError(what, { id: "github" });

/**
 * Step 1: `GET repos/raycast/extensions/pulls/<N>`.
 * @param {number} n
 * @returns {Promise<{ ref: string, state: string, merged: boolean, mergedAt: string | null, mergeSha: string | null }>}
 */
export async function readPull(n) {
  const pull = await transport().getJson(`${REPO}/pulls/${n}`);
  const ref = pull?.head?.ref;
  const state = pull?.state;
  if (typeof ref !== "string" || !ref) throw github(`GET ${REPO}/pulls/${n} has no head.ref`);
  if (state !== "open" && state !== "closed") throw github(`GET ${REPO}/pulls/${n} has state ${JSON.stringify(state)}, neither open nor closed`);
  const mergedAt = pull?.merged_at ?? null;
  if (mergedAt === null) return { ref, state, merged: false, mergedAt: null, mergeSha: null };
  const mergeSha = pull?.merge_commit_sha;
  if (typeof mergedAt !== "string" || typeof mergeSha !== "string" || !SHA_RE.test(mergeSha))
    throw github(`GET ${REPO}/pulls/${n} is merged but has no merged_at and 40-hex merge_commit_sha`);
  return { ref, state, merged: true, mergedAt, mergeSha };
}

/** @param {any} c */
const isBot = (c) => c?.author?.login === BOT;
/** @param {string | null | undefined} sha */
const sha7 = (sha) => (sha ? sha.slice(0, 7) : "none");

/**
 * Step 2: the rewrite run (the trailing raycastbot commits), the adoption set and each path's
 * `pre` and `post` sides from the two tree reads.
 * @param {{ n: number, name: string, record: import("../publication.mjs").PublicationRecord | null }} o
 * @returns {Promise<Rewrites>}
 */
export async function readRewrites({ n, name, record }) {
  const t = transport();
  const commits = await t.getJsonPages(`${REPO}/pulls/${n}/commits?per_page=100`);
  if (!Array.isArray(commits) || commits.length === 0) throw github(`GET ${REPO}/pulls/${n}/commits returned no commits`);
  for (const c of commits) if (typeof c?.sha !== "string" || !SHA_RE.test(c.sha)) throw github(`GET ${REPO}/pulls/${n}/commits returned a commit without a 40-hex sha`);

  let start = commits.length;
  while (start > 0 && isBot(commits[start - 1])) start--;
  const run = commits.slice(start);

  // The commit just before the run (the PR head itself when the run is empty) must be what rx
  // pushed, when the record is about this pull request.
  if (record && record.pr === n) {
    const before = start > 0 ? commits[start - 1].sha : null;
    if (before !== record.remoteSha)
      return { status: "fail", message: `#${n}'s last commit before raycastbot's is ${sha7(before)}, but rx recorded ${sha7(record.remoteSha)}: something else pushed to ext/${name}`, details: [] };
  }

  const stray = commits.slice(0, start).findIndex(isBot);
  if (stray !== -1) {
    const next = commits.slice(stray + 1).find((c) => !isBot(c));
    const login = next?.author?.login ?? next?.commit?.author?.name ?? "an unknown author";
    return { status: "fail", message: `raycastbot's ${sha7(commits[stray].sha)} is followed by ${sha7(next?.sha)} from ${login}; adopt by hand`, details: [] };
  }

  if (run.length === 0) return { status: "pass", run: [], paths: [], message: `raycastbot rewrote nothing on #${n}`, details: [] };

  const prefix = `extensions/${name}/`;
  /** @type {import("../verdict.mjs").Detail[]} */
  const bad = [];
  /** @type {Map<string, string>} the sha of the last run commit's row for each path */
  const lastRow = new Map();
  /** @type {Map<string, string>} the status of the first run commit's row for each path */
  const firstStatus = new Map();
  /** @type {Array<{ sha: string, files: string[] }>} */
  const rewrites = [];
  for (const c of run) {
    const detail = await t.getJson(`${REPO}/commits/${c.sha}`);
    const files = detail?.files;
    if (!Array.isArray(files)) throw github(`GET ${REPO}/commits/${c.sha} has no files[]`);
    /** @type {string[]} */
    const touched = [];
    for (const row of files) {
      const filename = row?.filename;
      const status = row?.status;
      if (typeof filename !== "string" || typeof status !== "string") throw github(`GET ${REPO}/commits/${c.sha} has a files[] row without filename and status`);
      if (!filename.startsWith(prefix) || filename.length === prefix.length || (status !== "modified" && status !== "added")) {
        bad.push({ file: filename, text: `${status}: rx adopts only files raycastbot modified or added inside the extension` });
        continue;
      }
      if (typeof row?.sha !== "string" || !SHA_RE.test(row.sha)) throw github(`GET ${REPO}/commits/${c.sha} has no 40-hex sha for ${filename}`);
      const rel = filename.slice(prefix.length);
      touched.push(rel);
      lastRow.set(rel, row.sha);
      if (!firstStatus.has(rel)) firstStatus.set(rel, status);
    }
    rewrites.push({ sha: c.sha, files: touched.sort() });
  }
  if (bad.length) return { status: "fail", message: `raycastbot changed ${bad.length} file row(s) on #${n} that rx does not adopt`, details: bad };

  const preRef = run[0]?.parents?.[0]?.sha;
  if (typeof preRef !== "string" || !SHA_RE.test(preRef)) throw github(`raycastbot's first commit ${sha7(run[0].sha)} on #${n} has no first parent`);
  const postRef = commits[commits.length - 1].sha;
  const post = await readTree(postRef, name);
  const pre = await readTree(preRef, name);

  /** @type {RewritePath[]} */
  const paths = [];
  for (const rel of [...lastRow.keys()].sort()) {
    const postSide = post.get(rel) ?? null;
    if (!postSide) throw github(`extensions/${name}/${rel} is absent from the PR head's tree (${sha7(postRef)})`);
    if (postSide.blob !== lastRow.get(rel)) throw github(`extensions/${name}/${rel} is ${sha7(postSide.blob)} in the PR head's tree but ${sha7(lastRow.get(rel))} in raycastbot's last commit to it`);
    const preSide = pre.get(rel) ?? null;
    const status = firstStatus.get(rel);
    if ((status === "added") !== (preSide === null))
      throw github(`raycastbot's first row for extensions/${name}/${rel} says ${status}, but the tree before its commits ${preSide ? "has" : "lacks"} the file`);
    paths.push({ path: rel, pre: preSide, post: postSide });
  }
  return {
    status: "pass",
    run: rewrites,
    paths,
    message: `raycastbot's ${run.length} commit(s) rewrote ${paths.length} file(s)`,
    details: paths.map((p) => ({ file: p.path, text: `${p.pre ? p.pre.blob.slice(0, 7) : "new"} → ${p.post.blob.slice(0, 7)}` })),
  };
}

/**
 * `GET repos/raycast/extensions/git/trees/<ref>:extensions/<name>?recursive=1` as path → side.
 * Directories are left out; a truncated listing is ERROR github.
 * @param {string} ref @param {string} name
 * @returns {Promise<Map<string, Side>>}
 */
async function readTree(ref, name) {
  const path = `${REPO}/git/trees/${ref}:extensions/${name}?recursive=1`;
  const r = await transport().getJson(path);
  if (r?.truncated === true) throw github(`GET ${path} is truncated; rx cannot see every file`);
  if (!Array.isArray(r?.tree)) throw github(`GET ${path} has no tree[]`);
  /** @type {Map<string, Side>} */
  const out = new Map();
  for (const row of r.tree) {
    if (typeof row?.path !== "string" || typeof row?.type !== "string" || typeof row?.mode !== "string" || typeof row?.sha !== "string")
      throw github(`GET ${path} has a row without path, type, mode and sha`);
    if (row.type === "tree") continue;
    out.set(row.path, { type: sideType(row.type, row.mode), mode: row.mode, blob: row.sha });
  }
  return out;
}

/** @param {string} objType @param {string} mode @returns {Side["type"]} */
export function sideType(objType, mode) {
  if (objType === "blob" && (mode === "100644" || mode === "100755")) return "file";
  if (objType === "blob" && mode === "120000") return "symlink";
  if (objType === "commit") return "submodule";
  return "other";
}

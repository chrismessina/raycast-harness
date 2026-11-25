// `rx post-merge` step 6 (docs/commands.md § rx post-merge, `post-merge-push`): which commit is the
// cleanup commit, the checks before the push (the branch's upstream, its single push URL, the
// remote tip, which must be the cleanup commit's parent so the push carries exactly one commit),
// and the push itself: a lease-guarded fast-forward to that one URL, with no tags and no
// remote-tracking update.

import { RxError } from "../errors.mjs";
import { git } from "../git.mjs";
import { sameSide, treeSide, typeOfMode } from "./sides.mjs";

/** @typedef {import("./decide.mjs").PathPlan} PathPlan */
/** @typedef {import("./github.mjs").Side} Side */

/**
 * @typedef {{ verdict: "PASS" | "WARN" | "N/A", message: string, details: import("../verdict.mjs").Detail[],
 *   target: { remote: string, url: string, mergeRef: string, tip: string } | null }} PushPlan
 *   `target` is set only when the push may go ahead (PASS).
 */

/** The cleanup commit's subject. @param {number} n */
export const cleanupSubject = (n) => `Adopt raycastbot's merge-time rewrites of #${n}`;

/**
 * On a run that made no commit: is HEAD the cleanup commit? Its subject, exactly one parent, and a
 * tree delta against that parent that is a non-empty subset of the adoption set, each parent entry
 * `pre` and each resulting entry `post`, with every adoption path HEAD leaves unchanged already
 * `post` in HEAD.
 * @param {{ top: string, n: number, rows: PathPlan[] }} o
 * @returns {Promise<{ status: "none" } | { status: "mismatch" } | { status: "ok", sha: string, parent: string }>}
 */
export async function qualifyHead({ top, n, rows }) {
  const sha = (await git(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: top })).stdout.trim();
  const raw = (await git(["cat-file", "commit", sha], { cwd: top })).stdout;
  const split = raw.indexOf("\n\n");
  const headers = (split === -1 ? raw : raw.slice(0, split)).split("\n");
  const subject = split === -1 ? "" : raw.slice(split + 2).split("\n")[0];
  if (subject !== cleanupSubject(n)) return { status: "none" };
  const parents = headers.filter((h) => h.startsWith("parent ")).map((h) => h.slice("parent ".length));
  if (parents.length !== 1) return { status: "mismatch" };
  const parent = parents[0];

  const byPath = new Map(rows.map((r) => [r.repoPath, r]));
  const diff = await git(["diff-tree", "-r", "-z", "--no-renames", parent, sha], { cwd: top });
  const fields = diff.stdout.split("\0");
  /** @type {Set<string>} */
  const changed = new Set();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (!fields[i].startsWith(":")) break;
    const [oldMode, newMode, oldBlob, newBlob] = fields[i].slice(1).split(" ");
    const path = fields[i + 1];
    const row = byPath.get(path);
    /** @param {string} mode @param {string} blob @returns {Side | null} */
    const side = (mode, blob) => (/^0+$/.test(mode) ? null : { type: typeOfMode(mode), mode, blob });
    if (!row || !sameSide(side(oldMode, oldBlob), row.pre) || !sameSide(side(newMode, newBlob), row.post)) return { status: "mismatch" };
    changed.add(path);
  }
  if (changed.size === 0) return { status: "mismatch" };
  for (const r of rows) if (!changed.has(r.repoPath) && !sameSide(await treeSide(top, sha, r.repoPath), r.post)) return { status: "mismatch" };
  return { status: "ok", sha, parent };
}

/**
 * Push checks 1–3 (read only).
 * @param {{ top: string, branch: string, parent: string }} o `parent` is the cleanup commit's parent
 * @returns {Promise<PushPlan>}
 */
export async function planPush({ top, branch, parent }) {
  const config = async (/** @type {string} */ key) => (await git(["config", "--get", key], { cwd: top, allowFail: true })).stdout.trim();
  const remote = await config(`branch.${branch}.remote`);
  const mergeRef = await config(`branch.${branch}.merge`);
  if (!remote || !mergeRef || remote === ".") return { verdict: "N/A", message: `${branch} has no upstream branch; push it yourself`, details: [], target: null };

  const urls = await git(["remote", "get-url", "--push", "--all", remote], { cwd: top, allowFail: true });
  const list = urls.code === 0 ? urls.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  if (list.length !== 1) return { verdict: "WARN", message: `${remote} pushes to ${list.length} URLs; not pushed`, details: [], target: null };
  const url = list[0];

  // `git push <url>` applies url.<base>.pushInsteadOf to the URL again, so it could reach a
  // repository other than the one ls-remote reads below. Any rule that would rewrite this URL stops
  // the push.
  const rules = await git(["config", "-z", "--get-regexp", "^url\\..*\\.pushinsteadof$"], { cwd: top, allowFail: true });
  if (rules.code !== 0 && rules.code !== 1) throw new RxError(`git config --get-regexp url.*.pushinsteadof failed: ${rules.stderr.trim() || `exit ${rules.code}`}`, { id: "git" });
  const prefixes = rules.code === 0 ? rules.stdout.split("\0").filter(Boolean).map((entry) => (entry.includes("\n") ? entry.slice(entry.indexOf("\n") + 1) : "")) : [];
  if (prefixes.some((p) => p !== "" && url.startsWith(p))) return { verdict: "WARN", message: `a pushInsteadOf rule rewrites ${url}; not pushed`, details: [], target: null };
  // `ls-remote <x>` and `push <x>` read a bare word as a remote name, and then reach that remote's
  // fetch URL and push URLs respectively. Only a URL git cannot read as a remote name goes on.
  if (!unambiguousUrl(url)) return { verdict: "WARN", message: `${url} could name a remote; not pushed`, details: [], target: null };

  const ls = await git(["ls-remote", url, mergeRef], { cwd: top, allowFail: true });
  if (ls.code !== 0) throw new RxError(`git ls-remote ${url} ${mergeRef} failed: ${ls.stderr.trim() || `exit ${ls.code}`}`, { id: "git" });
  const tip = ls.stdout.split("\n").map((l) => l.split("\t")).find((f) => f[1] === mergeRef)?.[0] ?? null;
  if (!tip) return { verdict: "WARN", message: `${remote} has no ${mergeRef}; not pushed`, details: [], target: null };

  if (tip !== parent) {
    const ancestor = await git(["merge-base", "--is-ancestor", tip, parent], { cwd: top, allowFail: true });
    if (ancestor.code !== 0) return { verdict: "WARN", message: `${remote} ${mergeRef} has moved past this branch; not pushed`, details: [], target: null };
    const log = await git(["-c", "log.showSignature=false", "log", "--no-decorate", "--format=%H%x09%s", `${tip}..${parent}`], { cwd: top });
    const commits = log.stdout.split("\n").filter(Boolean).map((l) => {
      const [sha, ...subject] = l.split("\t");
      return { text: `${sha.slice(0, 7)} ${subject.join("\t")}` };
    });
    return { verdict: "WARN", message: `${branch} has ${commits.length} other unpushed commit(s); not pushed, so nothing else leaves without you`, details: commits, target: null };
  }
  return { verdict: "PASS", message: `would push to ${url} ${mergeRef}`, details: [], target: { remote, url, mergeRef, tip } };
}

/**
 * Can git not read `url` as a remote name? A `<scheme>://` URL, an scp-style `<user>@<host>:<path>`
 * with no `/` before the first `:`, or an absolute path. A remote name cannot contain `:` or start
 * with `/`.
 * @param {string} url
 */
export function unambiguousUrl(url) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) || /^[^/:@]+@[^/:]+:/.test(url) || url.startsWith("/");
}

/**
 * Push check 4: `git push --no-follow-tags --force-with-lease=<merge ref>:<tip> <url>
 * <commit>:<merge ref>`. Pushing to the URL sends no tags, runs no remote.<name>.push refspec and
 * moves no remote-tracking ref; the user's pre-push hook still runs. A refusal is ERROR git.
 * @param {{ top: string, url: string, mergeRef: string, tip: string, commit: string }} o
 */
export async function push({ top, url, mergeRef, tip, commit }) {
  const r = await git(["push", "--no-follow-tags", `--force-with-lease=${mergeRef}:${tip}`, url, `${commit}:${mergeRef}`], { cwd: top, allowFail: true });
  if (r.code !== 0) throw new RxError(`git push to ${url} ${mergeRef} failed: ${r.stderr.trim() || `exit ${r.code}`}`, { id: "git" });
}

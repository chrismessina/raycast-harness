// `rx post-merge` step 5, Install (docs/commands.md § rx post-merge, `post-merge-commit` Install
// 1–6): under git's own index lock, re-check what step 3 decided, write the index through a temp
// file, write the files, release the lock onto the index, then move the branch with update-ref
// against its old value.
//
// Every stop point leaves an ADOPT or STAMP state (step 3), so running again converges. A failure
// rx catches removes the lock it created (and its temp index) and is ERROR git naming what was
// written. rx never removes an index.lock it did not create in this run.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RxError } from "../errors.mjs";
import { git, gitPath } from "../git.mjs";
import { cacheInfo, gitStrict } from "./commit.mjs";
import { currentBranch, indexSide, sameSide, workSide } from "./sides.mjs";

/** @typedef {import("./decide.mjs").PathPlan} PathPlan */
/** @typedef {"before-1" | 3 | 4 | 5 | 6} InstallStep */

/** A simulated crash: the install leaves everything exactly as a killed process would. */
export class InstallStop extends Error {}

/** @type {{ step: InstallStep, action: ((path?: string) => void | Promise<void>) | null } | null} */
let stopAt = null;

/**
 * Test hook. `step` is "before-1" (just before taking the lock) or 3, 4, 5, 6 (at the start of
 * that install step). Step 4 fires once per adoption path, before that path is written, with the
 * repository-relative path as the action's argument; its first firing is the start of step 4.
 * - Without `action`, the install throws InstallStop there, and nothing is cleaned up. That is a
 *   killed process: a lock taken at 1 stays behind, as git's own interrupted commands leave it.
 * - With `action`, the action runs there and the install goes on: a test can change the checkout
 *   between validation and install, or move the branch before update-ref. An action that throws is
 *   a failure rx catches: the lock and temp index are removed, and the run is ERROR git.
 * Pass null to clear.
 * @param {InstallStep | null} step @param {((path?: string) => void | Promise<void>) | null} [action]
 */
export function _setInstallStopForTests(step, action = null) {
  stopAt = step === null ? null : { step, action };
}

/** @param {InstallStep} step @param {string} [path] */
async function checkpoint(step, path) {
  if (!stopAt || stopAt.step !== step) return;
  if (!stopAt.action) throw new InstallStop(`install stopped at ${step} (test hook)`);
  await stopAt.action(path);
}

/**
 * @param {{ top: string, branch: string, oldHead: string, commitSha: string, n: number, commit: PathPlan[] }} o
 * @returns {Promise<{ verdict: "PASS" | "FAIL", message: string }>}
 */
export async function install({ top, branch, oldHead, commitSha, n, commit }) {
  await checkpoint("before-1");
  const lock = await gitPath(top, "index.lock");
  const indexFile = await gitPath(top, "index");

  // 1. Take git's index lock exclusively.
  try {
    closeSync(openSync(lock, "wx"));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") return { verdict: "FAIL", message: `another git process holds the index lock (${lock}); run again when it finishes` };
    throw new RxError(`cannot create ${lock}: ${/** @type {Error} */ (e).message}`, { id: "git" });
  }

  let lockOwned = true;
  /** @type {string | null} */
  let tmpIndex = null;
  /** @type {string[]} */
  const written = [];
  try {
    // 2. Re-read every input step 3 decided on.
    const changed = await changedSince({ top, branch, oldHead, commit });
    if (changed) {
      rmSync(lock, { force: true });
      lockOwned = false;
      return { verdict: "FAIL", message: `${changed} changed while rx ran; nothing was written` };
    }

    // 3. The new index, built on a copy so git's nested lock is never index.lock itself.
    await checkpoint(3);
    tmpIndex = await gitPath(top, `rx-post-merge-index-${randomBytes(8).toString("hex")}`);
    copyFileSync(indexFile, tmpIndex);
    await gitStrict(["update-index", "--add", ...cacheInfo(commit)], top, { ...process.env, GIT_INDEX_FILE: tmpIndex });
    renameSync(tmpIndex, lock);
    tmpIndex = null;

    // 4. The files.
    for (const r of commit) {
      await checkpoint(4, r.repoPath);
      const abs = join(top, r.repoPath);
      if (r.outcome === "ADOPT") {
        if (sameSide(r.work, r.post)) continue;
        writeReplacing(abs, /** @type {Buffer} */ (r.bytes), r.post.mode);
        written.push(r.repoPath);
      } else {
        const stamp = /** @type {{ unstamped: string, stamped: string }} */ (r.stamp);
        const lines = readFileSync(abs, "utf8").split("\n");
        const at = lines.indexOf(stamp.unstamped);
        const stampedOnce = lines.filter((l) => l === stamp.stamped).length === 1;
        if (at === -1 && stampedOnce) continue;
        if (at === -1 || lines.indexOf(stamp.unstamped, at + 1) !== -1) throw new Error(`${r.repoPath} no longer holds the unstamped heading exactly once`);
        lines[at] = stamp.stamped;
        writeReplacing(abs, Buffer.from(lines.join("\n"), "utf8"), r.post.mode);
        written.push(r.repoPath);
      }
    }

    // 5. Release the lock onto the index.
    await checkpoint(5);
    renameSync(lock, indexFile);
    lockOwned = false;

    // 6. Move the branch, refusing when it moved.
    await checkpoint(6);
    const u = await git(["update-ref", "-m", `rx post-merge #${n}`, `refs/heads/${branch}`, commitSha, oldHead], { cwd: top, allowFail: true });
    if (u.code !== 0) {
      // A refusal because the ref moved is the FAIL; anything else (a held ref lock, a full disk)
      // left the ref where it was, and is git's own error.
      const now = await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { cwd: top, allowFail: true });
      if (now.code === 0 && now.stdout.trim() === oldHead) throw new RxError(`git update-ref refs/heads/${branch} failed: ${u.stderr.trim() || `exit ${u.code}`}`, { id: "git" });
      return { verdict: "FAIL", message: `${branch} moved while rx ran` };
    }
    return { verdict: "PASS", message: "" };
  } catch (e) {
    if (e instanceof InstallStop) throw e;
    if (tmpIndex) rmSync(tmpIndex, { force: true });
    if (lockOwned) rmSync(lock, { force: true });
    const what = written.length ? `after writing ${written.join(", ")} (each holds its adopted content; the index is unchanged)` : "before writing any file";
    throw new RxError(`install failed ${lockOwned ? what : `after updating the index and the files, with ${branch} still at ${oldHead.slice(0, 7)}`}: ${/** @type {Error} */ (e).message}`, { id: "git" });
  }
}

/**
 * What changed since step 3 decided: the branch, its value, or a path's index or work side. Null
 * when nothing did.
 * @param {{ top: string, branch: string, oldHead: string, commit: PathPlan[] }} o
 */
async function changedSince({ top, branch, oldHead, commit }) {
  if ((await currentBranch(top)) !== branch) return "HEAD";
  const ref = await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { cwd: top, allowFail: true });
  if (ref.code !== 0 || ref.stdout.trim() !== oldHead) return branch;
  for (const r of commit) {
    const { side, unmerged } = await indexSide(top, r.repoPath);
    const work = workSide(top, r.repoPath);
    if (unmerged || !sameSide(side, r.index) || work.parentProblem || !sameSide(work.side, r.work)) return r.repoPath;
  }
  return null;
}

/**
 * Write `bytes` to a temp file beside `abs` with the git mode's permissions, then rename it over
 * `abs`. The temp file is removed when anything fails.
 * @param {string} abs @param {Buffer} bytes @param {string} mode
 */
function writeReplacing(abs, bytes, mode) {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${basename(abs)}.rx-post-merge-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, bytes);
    chmodSync(tmp, mode === "100755" ? 0o755 : 0o644);
    renameSync(tmp, abs);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

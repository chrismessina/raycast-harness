// `rx post-merge` sides (docs/commands.md § rx post-merge, **Identity** and **Conversion**): the
// `{ type, mode, blob }` triple of one path in local HEAD, the stage-0 index entry, the file on
// disk, and the published copy's HEAD in the upstream cache. Read only: nothing here writes to the
// checkout, the index or the object database.
//
// Local git runs from the repository's top level with repository-relative paths and
// --literal-pathspecs, so a monorepo checkout and a standalone one take the same calls.

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { RxError } from "../errors.mjs";
import { runBuffer } from "../exec.mjs";
import { git, gitPath, isWorkTree, topLevel } from "../git.mjs";
import { blobId } from "../upstream.mjs";
import { ownerExecutable } from "../util.mjs";
import { sideType } from "./github.mjs";

/** @typedef {import("./github.mjs").Side} Side */

/** Equal only when type, mode and blob all are; two absent sides are equal. @param {Side | null} a @param {Side | null} b */
export function sameSide(a, b) {
  if (!a || !b) return a === b;
  return a.type === b.type && a.mode === b.mode && a.blob === b.blob;
}

/** `<mode> <blob 7>`, or `none`. @param {Side | null} s */
export function sideText(s) {
  return s ? `${s.mode} ${s.blob.slice(0, 7)}` : "none";
}

/**
 * The repository the root lives in: its real top level and the extension's repository-relative
 * prefix ("" for a standalone checkout). ERROR root outside a git work tree.
 * @param {string} root
 */
export async function localRepo(root) {
  if (!(await isWorkTree(root))) throw new RxError(`${root} is not inside a git work tree; rx post-merge commits there`, { id: "root" });
  const top = realpathSync(await topLevel(root));
  const prefix = relative(top, realpathSync(root)).split("\\").join("/");
  return { top, prefix };
}

/** The repository-relative path of an extension-relative one. @param {string} prefix @param {string} rel */
export function repoPathOf(prefix, rel) {
  return prefix ? `${prefix}/${rel}` : rel;
}

const OPERATIONS = /** @type {const} */ ([
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
]);

/** The git operation in progress, or null. @param {string} top */
export async function operationInProgress(top) {
  for (const [file, op] of OPERATIONS) if (existsSync(await gitPath(top, file))) return op;
  return null;
}

/** The branch HEAD names (`git symbolic-ref -q HEAD`), or null when detached. @param {string} top */
export async function currentBranch(top) {
  const r = await git(["symbolic-ref", "-q", "HEAD"], { cwd: top, allowFail: true });
  if (r.code !== 0 || !r.stdout.startsWith("refs/heads/")) return null;
  return r.stdout.slice("refs/heads/".length);
}

/** @param {string} top */
export async function headCommit(top) {
  return (await git(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: top })).stdout.trim();
}

/** The side type of a git mode. @param {string} mode @returns {Side["type"]} */
export function typeOfMode(mode) {
  if (mode === "100644" || mode === "100755") return "file";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "submodule";
  return "other";
}

/**
 * `git ls-tree -z <ref> -- <path>` in `cwd`: the exact record for `path`, or null.
 * @param {string} cwd @param {string} ref @param {string} path
 * @returns {Promise<Side | null>}
 */
export async function treeSide(cwd, ref, path) {
  const r = await git(["--literal-pathspecs", "ls-tree", "-z", ref, "--", path], { cwd });
  for (const rec of r.stdout.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0 || rec.slice(tab + 1) !== path) continue;
    const [mode, objType, blob] = rec.slice(0, tab).split(" ");
    return { type: sideType(objType, mode), mode, blob };
  }
  return null;
}

/**
 * The stage-0 index entry (`git ls-files -s -z -- <path>`). `unmerged` is true when any entry for
 * the path has a nonzero stage. Entries under `path/` mean the index holds a directory there.
 * @param {string} top @param {string} path
 * @returns {Promise<{ side: Side | null, unmerged: boolean }>}
 */
export async function indexSide(top, path) {
  const r = await git(["--literal-pathspecs", "ls-files", "-s", "-z", "--", path], { cwd: top });
  /** @type {Side | null} */
  let side = null;
  let unmerged = false;
  let directory = false;
  for (const rec of r.stdout.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const name = rec.slice(tab + 1);
    const [mode, blob, stage] = rec.slice(0, tab).split(" ");
    if (name === path) {
      if (stage !== "0") unmerged = true;
      else side = { type: typeOfMode(mode), mode, blob };
    } else if (name.startsWith(`${path}/`)) directory = true;
  }
  if (!side && directory) side = { type: "other", mode: "040000", blob: "" };
  return { side, unmerged };
}

/**
 * The file on disk: its lstat type, executable bit and the blob id of its raw bytes (no filter).
 * `parentProblem` names a parent directory that is a symlink or not a directory.
 * @param {string} top @param {string} path repository-relative
 * @returns {{ side: Side | null, parentProblem: string | null }}
 */
export function workSide(top, path) {
  return fsStep(`reading ${path}`, () => readWorkSide(top, path));
}

/** @param {string} top @param {string} path @returns {{ side: Side | null, parentProblem: string | null }} */
function readWorkSide(top, path) {
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    const dir = segments.slice(0, i).join("/");
    /** @type {import("node:fs").Stats} */
    let st;
    try {
      st = lstatSync(join(top, dir));
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return { side: null, parentProblem: null };
      throw e;
    }
    if (st.isSymbolicLink()) return { side: null, parentProblem: `its parent directory ${dir} is a symlink` };
    if (!st.isDirectory()) return { side: null, parentProblem: `its parent ${dir} is not a directory` };
  }
  const abs = join(top, path);
  /** @type {import("node:fs").Stats} */
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return { side: null, parentProblem: null };
    throw e;
  }
  if (st.isSymbolicLink()) return { side: { type: "symlink", mode: "120000", blob: blobId(Buffer.from(readlinkSync(abs))) }, parentProblem: null };
  if (st.isDirectory()) return { side: { type: "other", mode: "040000", blob: "" }, parentProblem: null };
  if (!st.isFile()) return { side: { type: "other", mode: "", blob: "" }, parentProblem: null };
  return { side: { type: "file", mode: gitFileMode(st.mode), blob: blobId(readFileSync(abs)) }, parentProblem: null };
}

/**
 * The git mode of a regular file: 100755 when the owner execute bit (S_IXUSR) is set, as git
 * computes it, else 100644.
 * @param {number} mode lstat mode
 */
export function gitFileMode(mode) {
  return ownerExecutable(mode) ? "100755" : "100644";
}

/**
 * Run a filesystem read or write; an fs error (EACCES, EIO, ENOSPC …) becomes RxError id `git`, so
 * the run still reports every check id.
 * @template T @param {string} what @param {() => T} fn @returns {T}
 */
export function fsStep(what, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RxError) throw e;
    throw new RxError(`${what}: ${/** @type {Error} */ (e).message}`, { id: "git" });
  }
}

/**
 * A blob's exact bytes (`git cat-file blob`, no filters). `id` is the ERROR id on failure.
 * @param {string} cwd @param {string} blob @param {"git" | "github"} id
 */
export async function blobBytes(cwd, blob, id) {
  const r = await runBuffer("git", ["cat-file", "blob", blob], { cwd, id });
  if (r.code !== 0) throw new RxError(`git cat-file blob ${blob} in ${cwd} failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`, { id });
  return r.stdout;
}

/**
 * `git hash-object --path=<path> --stdin` over `bytes` (filters and line-ending conversion
 * applied as for that path). Writes nothing (no -w).
 * @param {string} top @param {string} path @param {Buffer} bytes
 */
export async function filteredHash(top, path, bytes) {
  return (await git(["hash-object", `--path=${path}`, "--stdin"], { cwd: top, input: bytes })).stdout.trim();
}

/**
 * `git hash-object --no-filters --stdin` over `bytes`, without -w: the dry-run form of step 5's
 * Prepare (a). Writes nothing.
 * @param {string} top @param {Buffer} bytes
 */
export async function rawHash(top, bytes) {
  return (await git(["hash-object", "--no-filters", "--stdin"], { cwd: top, input: bytes })).stdout.trim();
}

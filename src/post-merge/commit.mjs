// `rx post-merge` step 5, Prepare and Sign (docs/commands.md § rx post-merge, `post-merge-commit`):
// the adopted blobs go into the user's object database, a tree is built on a temporary index, and
// the commit is signed with rx's own key. Validate phase: the working tree, the index and every
// ref stay as they were; only unreachable objects are written (`git gc` collects them).

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { RxError } from "../errors.mjs";
import { git, gitPath } from "../git.mjs";
import { rawHash } from "./sides.mjs";

/** @typedef {import("./decide.mjs").PathPlan} PathPlan */

/** @type {(() => void | Promise<void>) | null} */
let beforeSign = null;

/**
 * Test hook: run `fn` just before the signing `commit-tree` call (to break the key after it was
 * inspected). Pass null to clear.
 * @param {(() => void | Promise<void>) | null} fn
 */
export function _setBeforeSignForTests(fn) {
  beforeSign = fn;
}

/**
 * Prepare: under --dry-run only the hash check (no -w). Otherwise write each post blob, then build
 * the tree on a fresh temporary index under the git dir, removed whatever happens.
 * @param {{ top: string, oldHead: string, commit: PathPlan[], dryRun: boolean }} o
 * @returns {Promise<string | null>} the tree, or null under --dry-run
 */
export async function prepare({ top, oldHead, commit, dryRun }) {
  for (const r of commit) {
    const bytes = /** @type {Buffer} */ (r.bytes);
    const id = dryRun ? await rawHash(top, bytes) : (await git(["hash-object", "-w", "--no-filters", "--stdin"], { cwd: top, input: bytes })).stdout.trim();
    if (id !== r.post.blob) throw new RxError(`git hash-object --no-filters of ${r.repoPath}'s canonical bytes printed ${id}, not ${r.post.blob}`, { id: "git" });
  }
  if (dryRun) return null;
  const index = await gitPath(top, `rx-post-merge-tree-${randomBytes(8).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await gitStrict(["read-tree", oldHead], top, env);
    await gitStrict(["update-index", "--add", ...cacheInfo(commit)], top, env);
    return (await gitStrict(["write-tree"], top, env)).stdout.trim();
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

/**
 * `--cacheinfo <post mode>,<post>,<repo path>` for each path.
 * @param {PathPlan[]} commit
 */
export function cacheInfo(commit) {
  return commit.flatMap((r) => ["--cacheinfo", `${r.post.mode},${r.post.blob},${r.repoPath}`]);
}

/**
 * Sign: `commit-tree -S` with rx's key, the three `-c` options applying to this one call, and
 * SSH_AUTH_SOCK removed so ssh-keygen signs from the key file instead of asking an agent (a locked
 * 1Password agent blocks). commit-tree runs no hooks.
 * @param {{ top: string, tree: string, oldHead: string, privateKey: string, message: string }} o
 * @returns {Promise<string>} the commit
 */
export async function sign({ top, tree, oldHead, privateKey, message }) {
  await beforeSign?.();
  const env = { ...process.env };
  delete env.SSH_AUTH_SOCK;
  const r = await gitStrict(
    ["-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${privateKey}`, "commit-tree", "-S", tree, "-p", oldHead, "-F", "-"],
    top,
    env,
    `${message}\n`,
  );
  const sha = r.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new RxError(`git commit-tree printed ${JSON.stringify(sha)}, not a commit id`, { id: "git" });
  return sha;
}

/**
 * A git call whose failure is ERROR git carrying git's whole stderr.
 * @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} [env] @param {string | Buffer} [input]
 */
export async function gitStrict(args, cwd, env, input) {
  const r = await git(args, { cwd, env, input, allowFail: true });
  if (r.code !== 0) throw new RxError(`git ${args.join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`, { id: "git" });
  return r;
}

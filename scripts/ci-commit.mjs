#!/usr/bin/env node
// `node scripts/ci-commit.mjs <message>`: commit the working tree's changes to tracked files onto
// `main` through the GitHub API (GraphQL `createCommitOnBranch`), so GitHub signs the commit and
// shows it Verified. The release workflow runs it after `scripts/bump.mjs` and the full test
// suite. A commit made with `git commit` in CI would be unsigned, since CI holds no signing key.
//
// It refuses, writing nothing, when HEAD is not the tip of origin/main (`expectedHeadOid` makes
// GitHub refuse a branch that moved, too), when a change is anything but a modification of a
// tracked file, or when there is nothing to commit. Prints the new commit's SHA on stdout.
// Needs GH_TOKEN with contents: write and GITHUB_REPOSITORY (owner/name), as Actions provides.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
/** @param {string} cmd @param {string[]} args @param {string} [input] */
const run = (cmd, args, input) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"] }).trim();

const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;

/**
 * The paths to commit from `git status --porcelain -z` output, untrimmed. Only unstaged
 * modifications of tracked files (` M <path>`) are accepted; anything else (staged, added,
 * deleted, renamed, untracked) is refused, since the release bump never produces it.
 * @param {string} porcelain
 */
export function changedPaths(porcelain) {
  const records = porcelain.split("\0").filter(Boolean);
  const bad = records.filter((r) => !r.startsWith(" M "));
  if (bad.length) throw new Error(`only unstaged modifications of tracked files are committed; found: ${bad.map((r) => JSON.stringify(r)).join(", ")}`);
  return records.map((r) => r.slice(3)).sort();
}

/**
 * The GraphQL input for committing `paths` (with their bytes) on top of `head`.
 * @param {{ repo: string, head: string, message: string, files: { path: string, bytes: Buffer }[] }} o
 */
export function commitInput({ repo, head, message, files }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GITHUB_REPOSITORY is not owner/name: ${JSON.stringify(repo)}`);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`HEAD is not a commit SHA: ${head}`);
  if (files.length === 0) throw new Error("nothing to commit");
  const [headline, ...rest] = message.split("\n");
  return {
    input: {
      branch: { repositoryNameWithOwner: repo, branchName: "main" },
      expectedHeadOid: head,
      message: { headline, body: rest.join("\n").replace(/^\n+/, "") },
      fileChanges: { additions: files.map((f) => ({ path: f.path, contents: f.bytes.toString("base64") })) },
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const message = process.argv[2];
    if (!message) throw new Error("give the commit message as the one argument");
    run("git", ["fetch", "-q", "origin", "main"]);
    const head = run("git", ["rev-parse", "HEAD"]);
    if (head !== run("git", ["rev-parse", "origin/main"])) throw new Error(`HEAD ${head.slice(0, 7)} is not origin/main; refusing to commit onto a moved branch`);
    // Not through run(): its trim() would eat the first record's leading status column.
    const porcelain = execFileSync("git", ["status", "--porcelain", "-z"], { cwd: root, encoding: "utf8" });
    const paths = changedPaths(porcelain);
    const files = paths.map((path) => ({ path, bytes: readFileSync(join(root, path)) }));
    const body = JSON.stringify({ query: MUTATION, variables: commitInput({ repo: String(process.env.GITHUB_REPOSITORY ?? ""), head, message, files }) });
    const out = JSON.parse(run("gh", ["api", "graphql", "--input", "-"], body));
    const oid = out?.data?.createCommitOnBranch?.commit?.oid;
    if (!/^[0-9a-f]{40}$/.test(oid ?? "")) throw new Error(`GitHub did not return a commit: ${JSON.stringify(out).slice(0, 200)}`);
    console.log(oid);
  } catch (e) {
    console.error(`ci-commit: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

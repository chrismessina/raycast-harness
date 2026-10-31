// Thin git helpers. Read-only unless a function says otherwise; nothing here ever runs add,
// commit, stash, checkout, restore, reset, pull or push.

import { run, runOk } from "./exec.mjs";

/**
 * @param {string[]} args
 * @param {{ cwd: string, input?: string, allowFail?: boolean }} opts
 */
export async function git(args, { cwd, input, allowFail = false }) {
  const r = await (allowFail ? run("git", args, { cwd, input }) : runOk("git", args, { cwd, input, id: "git" }));
  return { ...r, stdout: r.stdout.replace(/\n$/, "") };
}

/** `git rev-parse --git-path <name>` as an absolute path. @param {string} cwd @param {string} name */
export async function gitPath(cwd, name) {
  const rel = (await git(["rev-parse", "--git-path", name], { cwd })).stdout;
  return (await git(["rev-parse", "--path-format=absolute", "--git-path", name], { cwd })).stdout || rel;
}

/** @param {string} cwd */
export async function topLevel(cwd) {
  return (await git(["rev-parse", "--show-toplevel"], { cwd })).stdout;
}

/** @param {string} cwd @param {string} [ref] */
export async function revParse(cwd, ref = "HEAD") {
  return (await git(["rev-parse", "--verify", ref], { cwd })).stdout;
}

/** True when `cwd` is inside a git work tree. @param {string} cwd */
export async function isWorkTree(cwd) {
  const r = await git(["rev-parse", "--is-inside-work-tree"], { cwd, allowFail: true });
  return r.code === 0 && r.stdout.trim() === "true";
}

// Git scaffolding for the stale / contributions / changelog / upstream tests. Every repository is
// created inside a temp dir with `git init`; nothing here ever touches a real checkout. Commits
// are unsigned and use a fixed identity so the tests do not depend on the machine's git config.

import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/exec.mjs";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "init.defaultBranch",
  GIT_CONFIG_VALUE_1: "main",
};

/**
 * Run git in `cwd`; throws on a non-zero exit unless `allowFail`.
 * @param {string} cwd @param {string[]} args @param {{ allowFail?: boolean, env?: Record<string, string> }} [opts]
 */
export async function g(cwd, args, opts = {}) {
  const r = await run("git", args, { cwd, env: { ...GIT_ENV, ...(opts.env ?? {}) } });
  if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${r.code}: ${r.stderr}`);
  return { ...r, stdout: r.stdout.replace(/\n$/, "") };
}

/** `git init` a work tree. @param {string} dir */
export async function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  await g(dir, ["init", "-q"]);
  return dir;
}

/**
 * Write files (path → content; a Buffer for binary; null deletes) and commit everything.
 * @param {string} repo @param {Record<string, string | Buffer | null>} files @param {string} message
 * @param {{ author?: string, committer?: string }} [who] "Name <email>"
 * @returns {Promise<string>} commit sha
 */
export async function commit(repo, files, message, who = {}) {
  write(repo, files);
  await g(repo, ["add", "-A"]);
  /** @type {Record<string, string>} */
  const env = {};
  const split = (/** @type {string} */ s) => s.match(/^(.*) <(.*)>$/)?.slice(1) ?? [s, "x@example.com"];
  if (who.author) [env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL] = split(who.author);
  if (who.committer) [env.GIT_COMMITTER_NAME, env.GIT_COMMITTER_EMAIL] = split(who.committer);
  await g(repo, ["commit", "-q", "--allow-empty", "-m", message], { env });
  return (await g(repo, ["rev-parse", "HEAD"])).stdout;
}

/** @param {string} base @param {Record<string, string | Buffer | null>} files */
export function write(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel);
    if (content === null) { rmSync(abs, { force: true, recursive: true }); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** A minimal extension's files. @param {string} name @param {Record<string, string | Buffer | null>} [extra] */
export function extensionFiles(name, extra = {}) {
  return {
    "package.json": JSON.stringify({ name, title: "Example", commands: [{ name: "index", title: "Index", mode: "view" }] }, null, 2) + "\n",
    "CHANGELOG.md": `# Example Changelog\n\n## [Initial Version] - 2026-01-10\n\n- First release\n`,
    "src/index.tsx": `export default function Command() {\n  return null;\n}\n`,
    ...extra,
  };
}

/**
 * Copy a fixture directory tree (one of the `test/fixtures/...` folders) onto `dest`, replacing
 * what is there for the paths it holds.
 * @param {string} fixtureDir @param {string} dest
 */
export function applyTree(fixtureDir, dest) {
  for (const e of readdirSync(fixtureDir, { withFileTypes: true })) {
    const from = join(fixtureDir, e.name);
    const to = join(dest, e.name);
    if (e.isDirectory()) { mkdirSync(to, { recursive: true }); applyTree(from, to); }
    else cpSync(from, to);
  }
}

/** Does `p` exist as a directory? @param {string} p */
export function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * A fake `raycast/extensions`: a bare repository that `ensureUpstream` can fetch from with
 * `file://`, holding `extensions/<name>` for each extension in `extensions`. Returns the bare
 * repo path and the commit on main.
 * @param {string} dir @param {Record<string, Record<string, string | Buffer | null>>} extensions
 */
export async function fakeUpstream(dir, extensions) {
  const work = join(dir, "upstream-work");
  await initRepo(work);
  /** @type {Record<string, string | Buffer | null>} */
  const files = { "README.md": "# raycast/extensions (fixture)\n" };
  for (const [name, tree] of Object.entries(extensions)) for (const [p, c] of Object.entries(tree)) files[`extensions/${name}/${p}`] = c;
  const sha = await commit(work, files, "upstream main");
  const bare = join(dir, "upstream.git");
  await g(dir, ["clone", "-q", "--bare", work, bare]);
  await g(bare, ["config", "uploadpack.allowFilter", "true"]);
  await g(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  return { bare, url: `file://${bare}`, sha, work };
}

/**
 * Start a merge of `theirsRef` into HEAD in `repo` and leave it in progress (conflicts or not).
 * Returns git's exit code (1 = conflicts).
 * @param {string} repo @param {string} theirsRef
 */
export async function startMerge(repo, theirsRef) {
  const r = await g(repo, ["merge", "--no-commit", "--no-ff", theirsRef], { allowFail: true });
  return r.code;
}

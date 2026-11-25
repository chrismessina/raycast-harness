#!/usr/bin/env node
// `npm run release`: the whole release in one command, in the order that never burns a version.
//
// Chris's npm account stages uploads: `npm publish` puts the version in npm's staging area, and it
// is not listed until someone approves it with 2FA. Approval runs no package scripts, so the
// `postpublish` hook (which waits 60 s for npm to list the version) always gave up and the GitHub
// half was finished by hand. A rejected staged version can never be reused (E403), so nothing is
// approved before CI is green on the exact commit whose bytes were uploaded.
//
//   1. check      refuse a dry run; `node scripts/github-release.mjs --check`; remember HEAD and the
//                 `shasum` of HEAD's tarball (`npm pack --dry-run --json`: the bytes npm uploads)
//   2. upload     only when npm has neither a staged nor a listed upload of this version: `npm
//                 publish` with RX_RELEASE=1 (its postpublish hook defers to this script); then HEAD
//                 must be unchanged and the staged entry's shasum must be HEAD's
//   3. push       fast-forward origin/main to HEAD
//   4. CI         wait for the CI workflow on HEAD; anything but success stops, nothing approved
//   5. approve    `npm stage approve <id>` for the staged entry whose shasum is HEAD's, in this
//                 terminal (the 2FA prompt). A version already listed is not approved again.
//   6. finish     scripts/github-release.mjs `finish`, which also refuses when npm's gitHead for the
//                 version is not HEAD: signed tag, push, GitHub release
//
// Resuming: run it again after any failure. Step 2 finds an upload already staged (same shasum) or
// already listed (gitHead == HEAD) and skips the upload, so a re-run never uploads twice and never
// approves before CI is green. Every external program runs through `deps`, so the order is tested
// without npm, gh or a network (test/release.test.mjs). `npm stage` needs npm 11.15 or later; it
// runs through a pinned `npx npm@11.19.1`, so the npm on PATH does not matter.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finish } from "./github-release.mjs";

export const NPM_STAGE = ["-y", "npm@11.19.1"];
const root = join(fileURLToPath(import.meta.url), "..", "..");
const CI_WORKFLOW = "ci.yml";
const RUN_FIELDS = "databaseId,headSha,status,conclusion";

/**
 * The staged entries for exactly `name@version` (`npm stage list --json` prints
 * `[{ id, packageName, version, shasum, … }]`).
 * @param {unknown} items @param {string} name @param {string} version
 * @returns {{ id: string, shasum: string }[]}
 */
export function stagedFor(items, name, version) {
  if (!Array.isArray(items)) throw new Error(`npm stage list did not print a list: ${JSON.stringify(items).slice(0, 80)}`);
  return items
    .filter((i) => i && i.packageName === name && i.version === version)
    .map((i) => {
      if (typeof i.id !== "string" || !i.id) throw new Error(`a staged ${name}@${version} has no id`);
      return { id: i.id, shasum: typeof i.shasum === "string" ? i.shasum : "" };
    });
}

/**
 * The one staged entry whose bytes are HEAD's tarball, or null when none is staged. A staged entry
 * with other bytes is an error: approving it would ship something CI never checked.
 * @param {{ id: string, shasum: string }[]} entries @param {string} shasum @param {string} at
 */
export function pickStaged(entries, shasum, at) {
  if (entries.length === 0) return null;
  const mine = entries.filter((e) => e.shasum === shasum);
  if (mine.length === 1 && entries.length === 1) return mine[0];
  throw new Error(`npm has ${entries.length} staged upload(s) of ${at} and ${mine.length} match HEAD's tarball (${shasum.slice(0, 12)}); reject the others on npmjs.com (or npx ${NPM_STAGE.join(" ")} stage reject <id>) before releasing`);
}

/**
 * The newest CI run for `sha` from `gh run list --json databaseId,headSha,status,conclusion`
 * (gh lists newest first).
 * @param {unknown} runs @param {string} sha
 * @returns {{ id: number, done: boolean, ok: boolean } | null}
 */
export function ciRun(runs, sha) {
  if (!Array.isArray(runs)) throw new Error("gh run list did not print a list");
  const r = runs.find((x) => x && x.headSha === sha);
  if (!r) return null;
  return { id: Number(r.databaseId), done: r.status === "completed", ok: r.status === "completed" && r.conclusion === "success" };
}

/**
 * @typedef {{
 *   log: (s: string) => void,
 *   run: (cmd: string, args: string[]) => string,
 *   interactive: (cmd: string, args: string[], env?: Record<string, string>) => number,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   finish: (name: string, version: string, expectedCommit: string) => Promise<void>,
 * }} Deps
 *   `run` captures stdout and throws on a nonzero exit; `interactive` inherits the terminal (the
 *   upload and the 2FA prompt) and returns the exit code.
 */

/**
 * @param {{ name: string, version: string, argv?: string[], env?: Record<string, string | undefined> }} pkg
 * @param {Deps} deps
 * @param {{ ciAppearMs?: number, stageAppearMs?: number }} [timing]
 */
export async function release({ name, version, argv = [], env = {} }, deps, { ciAppearMs = 300_000, stageAppearMs = 600_000 } = {}) {
  const { log, run, interactive, sleep, now } = deps;
  const at = `${name}@${version}`;
  if (argv.includes("--dry-run") || env.npm_config_dry_run === "true")
    throw new Error("npm run release does not rehearse; for a dry run of the upload use `npm publish --dry-run`, which runs only the check");

  // npm uploads HEAD, and the check reads the version from HEAD's package.json; with the bump still
  // uncommitted the two disagree and the check names the wrong tag. Say what to do instead.
  if (run("git", ["status", "--porcelain"]).trim()) throw new Error(`commit the release first: the working tree has uncommitted changes, and npm uploads only what HEAD holds (package.json here says ${version})`);

  log(`release 1/6: checking ${at}`);
  run("node", ["scripts/github-release.mjs", "--check"]);
  const sha = run("git", ["rev-parse", "HEAD"]).trim();
  const shasum = packShasum(run);

  const listedHead = gitHeadOnNpm(run, name, version);
  let staged = listedHead ? null : pickStaged(stagedFor(JSON.parse(stageList(run, name)), name, version), shasum, at);
  if (listedHead) {
    if (listedHead !== sha) throw new Error(`npm already lists ${at} from ${listedHead.slice(0, 7)}, not HEAD ${sha.slice(0, 7)}; bump the version`);
    log(`release 2/6: ${at} is already on npm from HEAD; resuming at the push`);
  } else if (staged) {
    log(`release 2/6: ${at} is already staged with HEAD's tarball; resuming at the push`);
  } else {
    log(`release 2/6: uploading ${at} (npm may ask for 2FA here too)`);
    if (interactive("npm", ["publish"], { RX_RELEASE: "1" }) !== 0) throw new Error("npm's upload failed; nothing was pushed or approved. Fix it and run npm run release again");
    if (run("git", ["rev-parse", "HEAD"]).trim() !== sha) throw new Error(`HEAD moved during the upload; nothing was approved. Reject the staged ${at} and bump the version`);
    for (const deadline = now() + stageAppearMs; ; ) {
      staged = pickStaged(stagedFor(JSON.parse(stageList(run, name)), name, version), shasum, at);
      if (staged) break;
      const head = gitHeadOnNpm(run, name, version);
      if (head) {
        if (head !== sha) throw new Error(`npm lists ${at} from ${head.slice(0, 7)}, not HEAD ${sha.slice(0, 7)}`);
        log(`release 2/6: ${at} skipped staging and is already listed`);
        break;
      }
      if (now() > deadline) throw new Error(`${at} is neither staged nor listed on npm ten minutes after the upload; check npmjs.com, then run npm run release again`);
      // npm says "may take a few minutes to become available"; an upload that skips staging can take
      // that long to be listed (0.6.0 took more than two).
      log(`release 2/6: waiting for npm to stage or list ${at}…`);
      await sleep(15_000);
    }
  }

  log(`release 3/6: pushing ${sha.slice(0, 7)} to origin/main`);
  run("git", ["fetch", "-q", "origin", "main"]);
  if (run("git", ["rev-parse", "origin/main"]).trim() !== sha) run("git", ["push", "origin", `${sha}:refs/heads/main`]);

  if (staged) {
    log(`release 4/6: waiting for CI on ${sha.slice(0, 7)}`);
    /** @type {ReturnType<typeof ciRun>} */
    let ci;
    for (const deadline = now() + ciAppearMs; ; ) {
      ci = ciRun(JSON.parse(run("gh", ["run", "list", "--workflow", CI_WORKFLOW, "--commit", sha, "--json", RUN_FIELDS])), sha);
      if (ci) break;
      if (now() > deadline) throw new Error(`no CI run appeared for ${sha.slice(0, 7)}; ${at} is still staged and NOT approved. Run npm run release again once CI has started`);
      await sleep(10_000);
    }
    if (!ci.done) interactive("gh", ["run", "watch", String(ci.id), "--exit-status"]);
    ci = ciRun(JSON.parse(run("gh", ["run", "list", "--workflow", CI_WORKFLOW, "--commit", sha, "--json", RUN_FIELDS])), sha);
    if (!ci?.done) throw new Error(`CI on ${sha.slice(0, 7)} has not finished; ${at} is staged and NOT approved. Run npm run release again when it has`);
    if (!ci.ok) throw new Error(`CI failed on ${sha.slice(0, 7)}; ${at} is staged and NOT approved. Reject it (npx ${NPM_STAGE.join(" ")} stage reject ${staged.id}), fix, and release the next patch version: a rejected number cannot be reused`);

    log(`release 5/6: approving the staged ${at} (${staged.id})`);
    if (interactive("npx", [...NPM_STAGE, "stage", "approve", staged.id]) !== 0) throw new Error(`approving ${at} failed; nothing else changed. Run npm run release again to retry the approval`);
  } else log("release 4-5/6: already on npm, so there is nothing to approve");

  log("release 6/6: tagging and creating the GitHub release");
  await deps.finish(name, version, sha);
}

/** The shasum of the tarball npm would upload from this tree. @param {Deps["run"]} run */
function packShasum(run) {
  const out = JSON.parse(run("npm", ["pack", "--dry-run", "--json"]));
  const shasum = Array.isArray(out) ? out[0]?.shasum : undefined;
  if (typeof shasum !== "string" || !/^[0-9a-f]{40}$/.test(shasum)) throw new Error("npm pack --dry-run did not report a shasum");
  return shasum;
}

/** @param {Deps["run"]} run @param {string} name */
function stageList(run, name) {
  return run("npx", [...NPM_STAGE, "stage", "list", name, "--json"]);
}

/**
 * npm's gitHead for `name@version` when npm lists it, else null (not listed yet, or staged).
 * @param {Deps["run"]} run @param {string} name @param {string} version
 */
function gitHeadOnNpm(run, name, version) {
  let out;
  try {
    out = run("npm", ["view", `${name}@${version}`, "gitHead", "--json"]).trim();
  } catch (e) {
    if (/\bE404\b/.test(String(/** @type {any} */ (e)?.stderr ?? /** @type {any} */ (e)?.message ?? ""))) return null;
    throw e;
  }
  if (!out) return null;
  const head = JSON.parse(out);
  if (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head)) throw new Error(`npm lists ${name}@${version} without a commit (gitHead); finish it by hand`);
  return head;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  /** @type {Deps} */
  const deps = {
    log: (s) => console.log(s),
    run: (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    interactive: (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    // A freshly approved version can take minutes to be listed; wait up to ten.
    finish: (name, version, expected) => finish(name, version, false, 600_000, expected),
  };
  release({ name: pkg.name, version: pkg.version, argv: process.argv.slice(2), env: process.env }, deps).catch((e) => {
    console.error(`release: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

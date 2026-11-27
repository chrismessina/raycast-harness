#!/usr/bin/env node
// `node scripts/ci-release.mjs plan <version>`: which phase the release workflow runs for this
// version, decided from what the checked-out commit and npm hold (.github/workflows/release.yml).
//
//   prepare   HEAD's package.json is older and CHANGELOG.md has `## Unreleased`: bump, test,
//             commit through the API, then dispatch a fresh run at the release commit. The upload
//             happens in that second run, so npm's provenance (which reads GITHUB_SHA) names the
//             release commit, not the commit the first run started from.
//   publish   HEAD is the release commit (package.json says <version>) and npm does not list it:
//             test this exact commit, upload, finish.
//   finish    npm lists <version> from HEAD, or from a commit already in HEAD's history (main moved
//             after the upload): only the tag and the GitHub release remain, made on npm's commit.
//
// Anything else stops: npm lists the version from another commit, package.json is newer, or there
// is nothing pending to release. So re-running the workflow for the same version resumes from
// whatever the last run left, and never bumps twice. Prints `phase=<name>` for $GITHUB_OUTPUT.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, isVersion } from "./github-release.mjs";

/**
 * @param {{ version: string, headVersion: string, hasUnreleased: boolean, head: string, npmGitHead: string | null, npmInHistory?: boolean }} s
 *   `npmGitHead` is npm's gitHead for `version`, or null when npm does not list it; `npmInHistory`
 *   says that commit is an ancestor of HEAD.
 * @returns {"prepare" | "publish" | "finish"}
 */
export function plan({ version, headVersion, hasUnreleased, head, npmGitHead, npmInHistory = false }) {
  if (!isVersion(version)) throw new Error(`not a release version: ${JSON.stringify(version)}`);
  if (npmGitHead !== null) {
    if (npmGitHead === head || npmInHistory) return "finish";
    throw new Error(`npm already lists ${version} from ${npmGitHead.slice(0, 7)}, which is not in this run's history (${head.slice(0, 7)}); release a new version`);
  }
  if (headVersion === version) return "publish";
  if (compareVersions(version, headVersion) > 0) {
    if (!hasUnreleased) throw new Error(`CHANGELOG.md has no ## Unreleased section to release as ${version}`);
    return "prepare";
  }
  throw new Error(`${version} is below package.json's ${headVersion}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  try {
    const [cmd, version = ""] = process.argv.slice(2);
    if (cmd !== "plan") throw new Error("usage: node scripts/ci-release.mjs plan <version>");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    let npmGitHead = null;
    try {
      const out = execFileSync("npm", ["view", `${pkg.name}@${version}`, "gitHead", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (out) npmGitHead = JSON.parse(out);
    } catch (e) {
      if (!/\bE404\b/.test(String(/** @type {any} */ (e)?.stderr ?? ""))) throw e;
    }
    const npmInHistory = typeof npmGitHead === "string" && /^[0-9a-f]{40}$/.test(npmGitHead) && spawnSync("git", ["merge-base", "--is-ancestor", npmGitHead, "HEAD"], { cwd: root }).status === 0;
    const phase = plan({ version, headVersion: pkg.version, hasUnreleased: /\n## Unreleased\n/.test(readFileSync(join(root, "CHANGELOG.md"), "utf8")), head, npmGitHead, npmInHistory });
    console.error(`ci-release: ${phase} ${pkg.name}@${version} at ${head.slice(0, 7)}`);
    console.log(`phase=${phase}`);
  } catch (e) {
    console.error(`ci-release: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

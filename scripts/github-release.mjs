#!/usr/bin/env node
// Cuts the GitHub release that matches an npm release, from npm's own lifecycle (package.json):
//   prepublishOnly → `node scripts/github-release.mjs --check`: refuse the npm upload unless
//     CHANGELOG.md has a non-empty "## <version>" section, the tree is clean, and HEAD is on main,
//     so npm can never get ahead of a release GitHub can describe.
//   postpublish → `node scripts/github-release.mjs`: push main, create and push the signed tag
//     v<version> (SSH signing, so 1Password must be unlocked), and create the GitHub release from
//     that CHANGELOG section. Each step is skipped when it is already done, so a rerun after a
//     failure finishes the job: `node scripts/github-release.mjs`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The GitHub release body for `version`: its CHANGELOG section with each list item unwrapped onto
 * one line (GitHub renders a release body's line breaks), then a line to run that version.
 * @param {string} changelog @param {string} version @param {string} name the npm package name
 */
export function releaseNotes(changelog, version, name) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  if (!body) throw new Error(`CHANGELOG.md's "## ${version}" section is empty`);
  const items = body.split(/\n(?=- )/).map((item) => item.split("\n").map((l) => l.trim()).join(" "));
  return `${items.join("\n")}\n\nRun it: \`npx ${name}@${version} commands\`\n`;
}

const root = join(fileURLToPath(import.meta.url), "..", "..");
/** @param {string} cmd @param {string[]} args @param {{ input?: string }} [o] */
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", input: o.input, stdio: [o.input === undefined ? "inherit" : "pipe", "pipe", "inherit"] }).trim();
/** @param {string} cmd @param {string[]} args */
const succeeds = (cmd, args) => {
  try { execFileSync(cmd, args, { cwd: root, stdio: "ignore" }); return true; } catch { return false; }
};

function main() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = String(pkg.version);
  const tag = `v${version}`;
  const notes = releaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version, pkg.name);

  if (process.argv.includes("--check")) {
    if (run("git", ["status", "--porcelain"])) throw new Error("the working tree has uncommitted changes; commit the release first");
    const branch = run("git", ["branch", "--show-current"]);
    if (branch !== "main") throw new Error(`HEAD is on ${branch || "a detached commit"}, not main`);
    if (succeeds("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]) && run("git", ["rev-list", "-n", "1", tag]) !== run("git", ["rev-parse", "HEAD"]))
      throw new Error(`tag ${tag} already exists on another commit`);
    console.log(`github-release: ${tag} is ready (CHANGELOG section found, tree clean, on main)`);
    return;
  }

  run("git", ["push", "origin", "main"]);
  if (!succeeds("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`])) run("git", ["tag", "-s", tag, "-m", `rx ${version}`]);
  run("git", ["push", "origin", tag]);
  if (succeeds("gh", ["release", "view", tag])) {
    console.log(`github-release: ${tag} already has a GitHub release`);
    return;
  }
  run("gh", ["release", "create", tag, "--verify-tag", "--latest", "--title", `rx ${version}`, "--notes-file", "-"], { input: notes });
  console.log(`github-release: ${run("gh", ["release", "view", tag, "--json", "url", "-q", ".url"])}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`github-release: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

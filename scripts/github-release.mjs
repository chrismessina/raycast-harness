#!/usr/bin/env node
// Cuts the GitHub release that matches an npm release, from npm's own lifecycle (package.json):
//   prepublishOnly → `node scripts/github-release.mjs --check`: refuse the npm upload unless
//     CHANGELOG.md has a "## <version>" section in the grouped shape changelogProblems() checks, the tree is clean, and HEAD is on main,
//     so npm can never get ahead of a release GitHub can describe.
//   postpublish → `node scripts/github-release.mjs`: push main, create and push the signed tag
//     v<version> (SSH signing, so 1Password must be unlocked), and create the GitHub release from
//     that CHANGELOG section. Each step is skipped when it is already done, so a rerun after a
//     failure finishes the job: `node scripts/github-release.mjs`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Group headings a version's section may use, in this order, and each item's character budget. */
export const GROUPS = Object.freeze({ Breaking: 240, New: 160, Changed: 140, Fixed: 120 });
const SUMMARY_BUDGET = 200;

/**
 * A version's CHANGELOG section as blocks, each paragraph, heading and list item joined onto one
 * line (the file wraps at 100 columns; GitHub renders a release body's line breaks).
 * @param {string} changelog @param {string} version @returns {string[]}
 */
function sectionBlocks(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  /** @type {string[]} */
  const blocks = [];
  let open = false;
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    const t = line.trim();
    if (!t) { open = false; continue; }
    if (open && !t.startsWith("- ") && !t.startsWith("#")) blocks[blocks.length - 1] += ` ${t}`;
    else blocks.push(t);
    open = !t.startsWith("#");
  }
  if (!blocks.length) throw new Error(`CHANGELOG.md's "## ${version}" section is empty`);
  return blocks;
}

/**
 * The GitHub release body for `version`: its CHANGELOG section, unwrapped, then a line to run it.
 * @param {string} changelog @param {string} version @param {string} name the npm package name
 */
export function releaseNotes(changelog, version, name) {
  const blocks = sectionBlocks(changelog, version);
  const out = blocks.map((b, i) => (i > 0 && (b.startsWith("#") || !(b.startsWith("- ") && blocks[i - 1].startsWith("- "))) ? `\n${b}` : b));
  // A heading is followed by a blank line before its first item.
  return `${out.join("\n").replace(/^(#{3} .+)\n(?!\n)/gm, "$1\n\n")}\n\nRun it: \`npx ${name}@${version} commands\`\n`;
}

/**
 * What keeps a version's CHANGELOG section from being skimmable: at most one summary paragraph
 * (SUMMARY_BUDGET characters), then items only under the GROUPS headings, in that order, each
 * within its group's budget. A breaking change gets the most room because the reader must act on
 * it; a fix gets the least.
 * @param {string} changelog @param {string} version @returns {string[]}
 */
export function changelogProblems(changelog, version) {
  /** @type {string[]} */
  const problems = [];
  const order = Object.keys(GROUPS);
  /** @type {string | null} */
  let group = null;
  let summaries = 0;
  for (const b of sectionBlocks(changelog, version)) {
    if (b.startsWith("#")) {
      const name = b.replace(/^#+\s*/, "");
      if (!b.startsWith("### ") || !order.includes(name)) { problems.push(`"${b}" is not a group; use ${order.map((g) => `### ${g}`).join(", ").replace(/, (?=[^,]*$)/, " or ")}`); group = "?"; continue; }
      if (group && group !== "?" && order.indexOf(name) <= order.indexOf(group)) problems.push(`"${b}" comes after "### ${group}"; the order is ${order.join(", ")}`);
      group = name;
    } else if (b.startsWith("- ")) {
      if (!group) { problems.push(`an item before any group heading: "${b.slice(0, 60)}"`); continue; }
      if (group === "?") continue; // its heading is already reported
      const budget = GROUPS[/** @type {keyof typeof GROUPS} */ (group)];
      if (b.length - 2 > budget) problems.push(`a ${group} item is ${b.length - 2} characters; the budget is ${budget}`);
    } else if (group) problems.push(`a paragraph inside "### ${group}"; write it as an item`);
    else if (++summaries > 1) { if (summaries === 2) problems.push("more than one summary paragraph; keep one sentence or two above the groups"); }
    else if (b.length > SUMMARY_BUDGET) problems.push(`the summary is ${b.length} characters; the budget is ${SUMMARY_BUDGET}`);
  }
  return problems;
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
    const problems = changelogProblems(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
    if (problems.length) throw new Error(`CHANGELOG.md's "## ${version}" section is not release-ready (see CONTRIBUTING.md, Writing the CHANGELOG):\n  ${problems.join("\n  ")}`);
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

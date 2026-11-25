// scripts/github-release.mjs: the CHANGELOG shape the release check enforces and the notes the
// GitHub release gets. Only the pure parts are tested here; the npm, git and gh calls run on a
// real release.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changelogProblems, compareVersions, isVersion, releaseNotes } from "../scripts/github-release.mjs";
import { REPO } from "./helpers.mjs";

const SECTION = "A summary on one line.\n\n### New\n\n- First change.\n- Second change, with a table:\n\n  | A | B |\n  | - | - |\n  | x | y |\n\n### Fixed\n\n- A fix with a hard break\\\n  kept.";
const CHANGELOG = `# Changelog\n\n## 0.2.0\n\n${SECTION}\n\n## 0.1.4\n\n- Older,\n  wrapped as old entries were.\n`;

test("releaseNotes: the version's section byte for byte, then a run line", () => {
  assert.equal(releaseNotes(CHANGELOG, "0.2.0", "@chrismessina/raycast-harness"), `${SECTION}\n\nRun it: \`npx @chrismessina/raycast-harness@0.2.0 commands\`\n`);
});

test("releaseNotes: no section, or an empty one, for the version is an error; a `## ` line in a fence is code", () => {
  assert.throws(() => releaseNotes(CHANGELOG, "0.3.0", "x"), /no "## 0\.3\.0" section/);
  assert.throws(() => releaseNotes("# Changelog\n\n## 0.3.0\n\n## 0.2.0\n\n- x\n", "0.3.0", "x"), /is empty/);
  assert.throws(() => releaseNotes("# Changelog\n\n```\n## 2.0.0\n```\n", "2.0.0", "p"), /no "## 2\.0\.0" section/);
  const fenced = "# Changelog\n\n## 1.0.0\n\n### New\n\n- An item:\n\n  ```md\n  ## example\n  ```\n\n## 0.9.0\n\n- old\n";
  assert.match(releaseNotes(fenced, "1.0.0", "p"), /```md\n {2}## example\n {2}```\n\nRun it/);
});

test("changelogProblems: a grouped, unwrapped section within its budgets has none, tables and hard breaks included", () => {
  assert.deepEqual(changelogProblems(CHANGELOG, "0.2.0"), []);
});

test("changelogProblems: ungrouped items, unknown, out-of-order or empty groups, budgets, summaries, outside references, wrapped lines", () => {
  const long = (/** @type {number} */ n) => "x".repeat(n);
  const section = (/** @type {string} */ body) => `# Changelog\n\n## 1.0.0\n\n${body}\n## 0.9.0\n\n- old\n`;
  assert.deepEqual(changelogProblems(section("- ungrouped\n"), "1.0.0"), ["a list before any group heading"]);
  assert.deepEqual(changelogProblems(section("### Misc\n\n- x\n"), "1.0.0"), ['"### Misc" is not a group; use ### Breaking, ### New, ### Changed or ### Fixed']);
  assert.deepEqual(changelogProblems(section("### Fixed\n\n- x\n\n### New\n\n- y\n"), "1.0.0"), ['"### New" comes after "### Fixed"; the order is Breaking, New, Changed, Fixed']);
  assert.deepEqual(changelogProblems(section("### New\n\n### Fixed\n\n- y\n"), "1.0.0"), ['"### New" has no items; leave an empty group out']);
  assert.deepEqual(changelogProblems(section("### New\n"), "1.0.0"), ['"### New" has no items; leave an empty group out']);
  assert.deepEqual(changelogProblems(section(`### Fixed\n\n- ${long(121)}\n`), "1.0.0"), ["a Fixed item is 121 characters; the budget is 120"]);
  assert.deepEqual(changelogProblems(section(`### Breaking\n\n- ${long(240)}\n`), "1.0.0"), [], "Breaking gets the largest budget");
  assert.deepEqual(changelogProblems(section(`${long(201)}\n\n### New\n\n- x\n`), "1.0.0"), ["the summary is 201 characters; the budget is 200"]);
  assert.deepEqual(changelogProblems(section("One.\n\nTwo.\n\n### New\n\n- x\n"), "1.0.0"), ["more than one summary paragraph; keep one sentence or two above the groups"]);
  assert.deepEqual(changelogProblems(section("### New\n\n- x\n\nA stray paragraph.\n"), "1.0.0"), ['a paragraph inside "### New"; write it as an item']);
  assert.deepEqual(changelogProblems(`[guide]: https://example.com\n\n${section("### New\n\n- See [guide].\n")}`, "1.0.0"), ["a reference link or image needs a definition outside the section; write the URL inline"]);
  // GitHub shows every line break in a release body, so a soft-wrapped paragraph is refused.
  assert.deepEqual(changelogProblems(section("### New\n\n- wrapped\n  across two lines\n"), "1.0.0"), ['a line break inside a paragraph ("wrapped"); write each paragraph and item on one line']);
  assert.deepEqual(changelogProblems(section("A summary\nwrapped.\n\n### New\n\n- x\n"), "1.0.0"), ['a line break inside a paragraph ("A summary"); write each paragraph and item on one line']);
  // Codex REL4-1: a footnote's definition would be left behind too.
  assert.deepEqual(changelogProblems(`[^note]: Details.\n\n${section("### Breaking\n\n- Migrate[^note].\n")}`, "1.0.0"), ["a reference link or image needs a definition outside the section; write the URL inline"]);
});

test("changelogProblems (Codex REL4-2): every hard break is a hard break, inside emphasis, with three trailing spaces, or before CRLF", () => {
  const section = (/** @type {string} */ body) => `# Changelog\n\n## 1.0.0\n\n${body}\n## 0.9.0\n\n- old\n`;
  assert.deepEqual(changelogProblems(section("### New\n\n- *First.\\\n  second.*\n"), "1.0.0"), []);
  assert.deepEqual(changelogProblems(section("### New\n\n- First.   \n  second.\n"), "1.0.0"), []);
  assert.deepEqual(changelogProblems(section("### New\r\n\r\n- First.  \r\n  second.\r\n").replace(/\n## 0/, "\r\n## 0"), "1.0.0"), []);
  assert.deepEqual(changelogProblems(section("### New\r\n\r\n- First\r\n  second.\r\n"), "1.0.0"), ['a line break inside a paragraph ("- First"); write each paragraph and item on one line'.replace("- First", "First")]);
});

test("isVersion: only an exact release version, so `v0.2.0`, `latest` or a range never reaches a tag name (Codex REL3-1)", () => {
  assert.ok(isVersion("0.2.0") && isVersion("1.10.3"));
  for (const bad of ["v0.2.0", "latest", "^0.2.0", "0.2", "0.2.0-beta.1", "0.2.0 "]) assert.equal(isVersion(bad), false, bad);
});

test("compareVersions: numeric release order", () => {
  assert.deepEqual(["0.10.0", "0.2.0", "1.0.0", "0.9.9"].sort(compareVersions), ["0.2.0", "0.9.9", "0.10.0", "1.0.0"]);
});

test("changelogProblems: the shipped CHANGELOG's current section passes", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.deepEqual(changelogProblems(readFileSync(join(REPO, "CHANGELOG.md"), "utf8"), pkg.version), []);
});

test("postpublish under npm run release (RX_RELEASE=1) defers: it prints why and exits 0 without asking npm anything", () => {
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "github-release.mjs")], {
    encoding: "utf8",
    // A PATH with no npm, git or gh: any attempt to reach them would fail the run.
    env: { PATH: "/nonexistent", npm_lifecycle_event: "postpublish", npm_package_name: "@chrismessina/raycast-harness", npm_package_version: "9.9.9", RX_RELEASE: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /npm run release finishes this after CI and the approval/);
});

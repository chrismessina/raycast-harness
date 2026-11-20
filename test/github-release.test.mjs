// scripts/github-release.mjs: the GitHub release npm's lifecycle cuts after each npm release, and
// the CHANGELOG shape the release check enforces. Only the pure parts are tested here; the git and
// gh calls run on a real release.

import { test } from "node:test";
import assert from "node:assert/strict";
import { changelogProblems, releaseNotes } from "../scripts/github-release.mjs";

const CHANGELOG = `# Changelog

## 0.2.0

A summary that is wrapped
over two lines.

### New

- First change, wrapped
  over two lines.
- Second change.

### Fixed

- A fix.

## 0.1.4

- Older.
`;

test("releaseNotes: the version's section with its group headings, every paragraph and item unwrapped, and a run line", () => {
  assert.equal(
    releaseNotes(CHANGELOG, "0.2.0", "@chrismessina/raycast-harness"),
    "A summary that is wrapped over two lines.\n\n### New\n\n- First change, wrapped over two lines.\n- Second change.\n\n### Fixed\n\n- A fix.\n\nRun it: `npx @chrismessina/raycast-harness@0.2.0 commands`\n",
  );
});

test("releaseNotes: no section, or an empty one, for the version is an error", () => {
  assert.throws(() => releaseNotes(CHANGELOG, "0.3.0", "x"), /no "## 0\.3\.0" section/);
  assert.throws(() => releaseNotes("# Changelog\n\n## 0.3.0\n\n## 0.2.0\n\n- x\n", "0.3.0", "x"), /is empty/);
});

test("changelogProblems: a grouped section within its budgets has none", () => {
  assert.deepEqual(changelogProblems(CHANGELOG, "0.2.0"), []);
});

test("changelogProblems: ungrouped items, an unknown or out-of-order group, an over-budget item or summary, and a second summary paragraph", () => {
  const long = (/** @type {number} */ n) => "x".repeat(n);
  const section = (/** @type {string} */ body) => `# Changelog\n\n## 1.0.0\n\n${body}\n## 0.9.0\n\n- old\n`;
  assert.deepEqual(changelogProblems(section("- ungrouped\n"), "1.0.0"), ['an item before any group heading: "- ungrouped"']);
  assert.deepEqual(changelogProblems(section("### Misc\n\n- x\n"), "1.0.0"), ['"### Misc" is not a group; use ### Breaking, ### New, ### Changed or ### Fixed']);
  assert.deepEqual(changelogProblems(section("### Fixed\n\n- x\n\n### New\n\n- y\n"), "1.0.0"), ['"### New" comes after "### Fixed"; the order is Breaking, New, Changed, Fixed']);
  assert.deepEqual(changelogProblems(section(`### Fixed\n\n- ${long(121)}\n`), "1.0.0"), ["a Fixed item is 121 characters; the budget is 120"]);
  assert.deepEqual(changelogProblems(section(`### Breaking\n\n- ${long(237)}\n`), "1.0.0"), [], "Breaking gets the largest budget");
  assert.deepEqual(changelogProblems(section(`${long(201)}\n\n### New\n\n- x\n`), "1.0.0"), ["the summary is 201 characters; the budget is 200"]);
  assert.deepEqual(changelogProblems(section("One.\n\nTwo.\n\n### New\n\n- x\n"), "1.0.0"), ["more than one summary paragraph; keep one sentence or two above the groups"]);
});

test("changelogProblems: the shipped CHANGELOG's current section passes", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { REPO } = await import("./helpers.mjs");
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.deepEqual(changelogProblems(readFileSync(join(REPO, "CHANGELOG.md"), "utf8"), pkg.version), []);
});

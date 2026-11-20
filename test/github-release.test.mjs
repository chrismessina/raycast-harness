// scripts/github-release.mjs: the GitHub release npm's lifecycle cuts after each npm release.
// Only the pure part is tested here; the git and gh calls run on a real release.

import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseNotes } from "../scripts/github-release.mjs";

const CHANGELOG = `# Changelog

## 0.2.0

- First change, wrapped
  over two lines.
- Second change.

## 0.1.4

- Older.
`;

test("releaseNotes: the version's CHANGELOG section, each item unwrapped onto one line, with a run line", () => {
  assert.equal(
    releaseNotes(CHANGELOG, "0.2.0", "@chrismessina/raycast-harness"),
    "- First change, wrapped over two lines.\n- Second change.\n\nRun it: `npx @chrismessina/raycast-harness@0.2.0 commands`\n",
  );
});

test("releaseNotes: no section, or an empty one, for the version is an error", () => {
  assert.throws(() => releaseNotes(CHANGELOG, "0.3.0", "x"), /no "## 0\.3\.0" section/);
  assert.throws(() => releaseNotes("# Changelog\n\n## 0.3.0\n\n## 0.2.0\n\n- x\n", "0.3.0", "x"), /is empty/);
});

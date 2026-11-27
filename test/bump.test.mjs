// scripts/bump.mjs: the release's version goes into every file that carries it, and nothing else
// changes. Run against the repository's real files, so a moved anchor fails here, not in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, bump } from "../scripts/bump.mjs";
import { REPO } from "./helpers.mjs";

/** The CHANGELOG with any pending `## Unreleased` section removed, whatever main holds right now. */
const withoutPending = (/** @type {string} */ text) => text.replace(/\n## Unreleased\n[\s\S]*?(?=\n## )/, "");
const real = () => {
  /** @type {Record<string, string>} */
  const files = {};
  for (const f of FILES) files[f] = readFileSync(join(REPO, f), "utf8");
  // Exactly one pending section, whether or not main has one between releases.
  files["CHANGELOG.md"] = withoutPending(files["CHANGELOG.md"]).replace("# Changelog\n\n", "# Changelog\n\n## Unreleased\n\n### Fixed\n\n- x\n\n");
  return files;
};
const current = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

test("bump: on the real files it changes exactly the version lines and the Unreleased heading", () => {
  const files = real();
  const [maj, min, pat] = current.split(".").map(Number);
  const next = `${maj}.${min}.${pat + 1}`;
  const out = bump(files, next);
  for (const f of FILES) {
    const a = files[f].split("\n");
    const b = out[f].split("\n");
    assert.equal(b.length, a.length, `${f}: no line added or removed`);
    const changed = a.flatMap((l, i) => (l === b[i] ? [] : [b[i]]));
    const expected = f === "package-lock.json" ? 2 : 1;
    assert.equal(changed.length, expected, `${f}: ${changed.length} line(s) changed`);
    for (const l of changed) assert.ok(l.includes(next), `${f}: ${l}`);
  }
  assert.match(out["CHANGELOG.md"], new RegExp(`\\n## ${next.replaceAll(".", "\\.")}\\n`));
  assert.doesNotMatch(out["CHANGELOG.md"], /## Unreleased/);
});

test("bump: refuses a non-release version, one not above the current, and a CHANGELOG without Unreleased", () => {
  assert.throws(() => bump(real(), "v9.9.9"), /not a release version/);
  assert.throws(() => bump(real(), current), /not above the current/);
  assert.throws(() => bump(real(), "0.0.1"), /not above the current/);
  const files = real();
  files["CHANGELOG.md"] = withoutPending(readFileSync(join(REPO, "CHANGELOG.md"), "utf8"));
  assert.throws(() => bump(files, "99.0.0"), /CHANGELOG\.md: expected exactly one "\\n## Unreleased\\n", found 0/);
});

test("bump: a lockfile whose root version disagrees is refused rather than half-bumped", () => {
  const files = real();
  files["package-lock.json"] = files["package-lock.json"].replace(`"version": "${current}"`, '"version": "0.0.0"');
  assert.throws(() => bump(files, "99.0.0"), /package-lock\.json's root version is not/);
});

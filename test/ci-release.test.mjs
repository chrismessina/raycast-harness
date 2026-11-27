// scripts/ci-release.mjs `plan`: each release-workflow run does one phase, chosen from what main
// and npm hold, so a re-run resumes instead of bumping twice or uploading over a published version.

import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../scripts/ci-release.mjs";

const HEAD = "a".repeat(40);
const base = { version: "1.3.0", headVersion: "1.2.0", hasUnreleased: true, head: HEAD, npmGitHead: null };

test("plan: an older package.json with a pending section prepares; the release commit publishes; npm listing it from HEAD only finishes", () => {
  assert.equal(plan(base), "prepare");
  assert.equal(plan({ ...base, headVersion: "1.3.0", hasUnreleased: false }), "publish", "the dispatched run at the release commit");
  assert.equal(plan({ ...base, headVersion: "1.3.0", hasUnreleased: false, npmGitHead: HEAD }), "finish", "uploaded; only the tag and release remain");
});

test("plan: stops on a version npm lists from another commit, nothing pending, a version below package.json, or a malformed version", () => {
  assert.throws(() => plan({ ...base, headVersion: "1.3.0", npmGitHead: "b".repeat(40) }), /already lists 1\.3\.0 from bbbbbbb, which is not in/);
  // main moved after the upload: npm's commit is an ancestor of HEAD, so finish still runs (on npm's commit).
  assert.equal(plan({ ...base, headVersion: "1.3.1", npmGitHead: "b".repeat(40), npmInHistory: true }), "finish");
  assert.throws(() => plan({ ...base, hasUnreleased: false }), /no ## Unreleased section/);
  assert.throws(() => plan({ ...base, version: "1.1.0" }), /below package\.json's 1\.2\.0/);
  assert.throws(() => plan({ ...base, version: "v1.3.0" }), /not a release version/);
});

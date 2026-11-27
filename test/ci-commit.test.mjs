// scripts/ci-commit.mjs: the GraphQL input that makes GitHub create (and sign) the release commit.
// The network call itself runs only in the release workflow; the input it sends is checked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedPaths, commitInput } from "../scripts/ci-commit.mjs";
import { withTempDir } from "./helpers.mjs";

test("changedPaths: real `git status --porcelain -z` of a bump (the first record included, a path with a space) yields every path", async () => {
  await withTempDir(async (dir) => {
    const git = (/** @type {string[]} */ a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git(["init", "-q"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "root"]);
    for (const f of ["CHANGELOG.md", "package.json", "docs guide.md"]) writeFileSync(join(dir, f), "a\n");
    git(["add", "."]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "files"]);
    for (const f of ["CHANGELOG.md", "package.json", "docs guide.md"]) writeFileSync(join(dir, f), "b\n");
    const porcelain = git(["status", "--porcelain", "-z"]);
    assert.ok(porcelain.startsWith(" M "), "the first record starts with a space a trim() would eat");
    assert.deepEqual(changedPaths(porcelain), ["CHANGELOG.md", "docs guide.md", "package.json"]);
    assert.throws(() => changedPaths(porcelain.trim()), /only unstaged modifications/, "a trimmed first record is refused, not silently misread");
    git(["add", "package.json"]);
    assert.throws(() => changedPaths(git(["status", "--porcelain", "-z"])), /only unstaged modifications/, "a staged change is refused");
  });
});

const HEAD = "a".repeat(40);

test("commitInput: main, the expected head (so a moved branch is refused), the message split into headline and body, base64 contents", () => {
  const out = commitInput({ repo: "chrismessina/raycast-harness", head: HEAD, message: "Release 1.2.3\n\nBody line.", files: [{ path: "package.json", bytes: Buffer.from("{}\n") }] });
  assert.deepEqual(out, {
    input: {
      branch: { repositoryNameWithOwner: "chrismessina/raycast-harness", branchName: "main" },
      expectedHeadOid: HEAD,
      message: { headline: "Release 1.2.3", body: "Body line." },
      fileChanges: { additions: [{ path: "package.json", contents: Buffer.from("{}\n").toString("base64") }] },
    },
  });
});

test("commitInput: refuses a malformed repository, a non-SHA head, and an empty change set", () => {
  const files = [{ path: "a", bytes: Buffer.from("x") }];
  assert.throws(() => commitInput({ repo: "nope", head: HEAD, message: "m", files }), /not owner\/name/);
  assert.throws(() => commitInput({ repo: "o/r", head: "main", message: "m", files }), /not a commit SHA/);
  assert.throws(() => commitInput({ repo: "o/r", head: HEAD, message: "m", files: [] }), /nothing to commit/);
});

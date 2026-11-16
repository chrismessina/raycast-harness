// src/fingerprint.mjs (docs/commands.md §4.8; plan-review-1 #1): an untouched tree reproduces its
// fingerprint; every mutation the plan names changes it; nothing is written to git.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { combine, computeFingerprints, diffFingerprints, fileFingerprint, ignoredSwiftPMScratch, payloadFingerprint, readBaseline } from "../src/fingerprint.mjs";
import { fakeExtension, withTempDir } from "./helpers.mjs";
import { makeExt } from "./preflight-helpers.mjs";
import { commit, extensionFiles, g, initRepo } from "./upstream-fixtures.mjs";

/** @param {string} dir */
async function repo(dir) {
  const root = join(dir, "ext");
  mkdirSync(root, { recursive: true });
  await initRepo(root);
  await commit(root, { ...extensionFiles("ext"), ".gitignore": "*.local\n", "scripts/run.sh": "#!/bin/sh\necho hi\n", "docs/a.md": "a\n" }, "v1");
  const preset = join(dir, "preset.json");
  const forbidden = join(dir, "forbidden.txt");
  writeFileSync(preset, JSON.stringify({ schema: 1, owner: "x", rules: [] }));
  writeFileSync(forbidden, "AbCdEfGhIjK\n");
  const fp = () => computeFingerprints({ root, version: "0.1.0", presetPath: preset, forbiddenPath: forbidden });
  return { root, preset, forbidden, fp };
}

/** The git object count, to prove nothing was written. @param {string} root */
async function objectCount(root) {
  return (await g(root, ["count-objects", "-v"])).stdout;
}

test("fingerprint: an untouched tree reproduces every field; the combined hash covers all seven", async () => {
  await withTempDir(async (dir) => {
    const { root, fp } = await repo(dir);
    const before = await objectCount(root);
    const a = await fp();
    const b = await fp();
    assert.deepEqual(a, b);
    assert.deepEqual(diffFingerprints(a, b), []);
    assert.match(a.payload, /^[0-9a-f]{64}$/);
    assert.match(a.head, /^[0-9a-f]{40}$/);
    assert.equal(a.publishRange, "HEAD");
    assert.equal(a.baseline, "unknown");
    assert.equal(a.rxVersion, "0.1.0");
    assert.equal(a.combined, combine(a));
    for (const k of /** @type {const} */ (["payload", "head", "publishRange", "preset", "forbidden", "rxVersion", "baseline"])) {
      const changed = { ...a, [k]: `${a[k]}x` };
      assert.notEqual(combine(changed), a.combined, `combined covers ${k}`);
      assert.deepEqual(diffFingerprints(changed, a), [k, "combined"]);
    }
    assert.equal(await objectCount(root), before, "no git objects were written");
    assert.equal((await g(root, ["status", "--porcelain"])).stdout, "");
  });
});

test("fingerprint: each mutation the plan names changes the payload fingerprint", async () => {
  await withTempDir(async (dir) => {
    const { root, fp } = await repo(dir);
    const base = await fp();
    /** @type {(label: string, mutate: () => void, restore: () => void) => Promise<void>} */
    const mutation = async (label, mutate, restore) => {
      mutate();
      const after = await fp();
      assert.notEqual(after.payload, base.payload, `${label}: payload changed`);
      assert.deepEqual(diffFingerprints(base, after), ["payload", "combined"], `${label}: only the payload differs`);
      restore();
      assert.equal((await fp()).payload, base.payload, `${label}: restored`);
    };
    const src = join(root, "src", "index.tsx");
    const original = readFileSync(src);
    await mutation("unstaged tracked edit", () => writeFileSync(src, original + "// edit\n"), () => writeFileSync(src, original));
    await mutation("deletion", () => rmSync(join(root, "docs", "a.md")), () => writeFileSync(join(root, "docs", "a.md"), "a\n"));
    await mutation("rename", () => renameSync(join(root, "docs", "a.md"), join(root, "docs", "b.md")), () => renameSync(join(root, "docs", "b.md"), join(root, "docs", "a.md")));
    await mutation("mode change", () => chmodSync(join(root, "scripts", "run.sh"), 0o755), () => chmodSync(join(root, "scripts", "run.sh"), 0o644));
    await mutation("new ignored file", () => writeFileSync(join(root, "notes.local"), "ignored\n"), () => rmSync(join(root, "notes.local")));
    await mutation("new untracked file", () => writeFileSync(join(root, "untracked.txt"), "new\n"), () => rmSync(join(root, "untracked.txt")));
    await mutation("new symlink", () => symlinkSync("package.json", join(root, "link")), () => rmSync(join(root, "link")));
    // A symlink's TARGET bytes count (ray copies them), so changing the target changes the hash
    // even though the link itself did not.
    symlinkSync("docs/a.md", join(root, "link"));
    const withLink = await fp();
    writeFileSync(join(root, "docs", "a.md"), "changed target\n");
    assert.notEqual((await fp()).payload, withLink.payload, "symlink target bytes count");
    writeFileSync(join(root, "docs", "a.md"), "a\n");
    // A dangling link still fingerprints (as unreadable) and differs from a resolvable one.
    rmSync(join(root, "link"));
    symlinkSync("missing-target", join(root, "link"));
    assert.notEqual((await fp()).payload, withLink.payload);
    rmSync(join(root, "link"));
    // Ignored files are in the payload: the ignored-file case above holds only because
    // listPayload never reads .gitignore. Confirm git itself ignores it.
    writeFileSync(join(root, "notes.local"), "ignored\n");
    assert.equal((await g(root, ["status", "--porcelain"])).stdout, "", "git sees nothing (the file is ignored), yet the fingerprint changed");
    rmSync(join(root, "notes.local"));
    // node_modules and .git are ray's skip list: files there do not change the fingerprint.
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x.js"), "x");
    assert.equal((await fp()).payload, base.payload, "node_modules is skipped");
    rmSync(join(root, "node_modules"), { recursive: true });
    assert.deepEqual(await fp(), base);
  });
});

test("fingerprint: changed preset bytes, changed forbidden list, a new commit, the publish tag and the baseline each change their own field", async () => {
  await withTempDir(async (dir) => {
    const { root, preset, forbidden, fp } = await repo(dir);
    const base = await fp();

    writeFileSync(preset, JSON.stringify({ schema: 1, owner: "x", rules: [], judgments: [] }));
    const p = await fp();
    assert.deepEqual(diffFingerprints(base, p), ["preset", "combined"]);
    writeFileSync(preset, JSON.stringify({ schema: 1, owner: "x", rules: [] }));

    writeFileSync(forbidden, "AbCdEfGhIjK\nanother-value\n");
    const f = await fp();
    assert.deepEqual(diffFingerprints(base, f), ["forbidden", "combined"]);
    writeFileSync(forbidden, "AbCdEfGhIjK\n");
    assert.deepEqual(await fp(), base);

    // A missing input file hashes as `missing` (so a receipt written with it is stale).
    assert.equal(fileFingerprint(join(dir, "nope")), "missing");
    assert.equal(fileFingerprint(null), "missing");
    assert.notEqual((await computeFingerprints({ root, version: "0.1.0", presetPath: null, forbiddenPath: forbidden })).preset, base.preset);

    // rx version.
    assert.deepEqual(diffFingerprints(base, await computeFingerprints({ root, version: "0.2.0", presetPath: preset, forbiddenPath: forbidden })), ["rxVersion", "combined"]);

    // Baseline: explicit override, and what rx stale records.
    assert.deepEqual(diffFingerprints(base, await computeFingerprints({ root, version: "0.1.0", presetPath: preset, forbiddenPath: forbidden, baseline: "unpublished" })), ["baseline", "combined"]);
    const stateDir = (await g(root, ["rev-parse", "--path-format=absolute", "--git-path", "rx/stale"])).stdout;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "baseline.json"), JSON.stringify({ name: "ext", published: false, baseline: null, publishedDir: null, at: "x" }));
    assert.equal(await readBaseline(root), "unpublished");
    writeFileSync(join(stateDir, "baseline.json"), JSON.stringify({ name: "ext", published: true, baseline: "abc123", publishedDir: "/x", at: "x" }));
    assert.equal(await readBaseline(root), "abc123");
    assert.equal((await fp()).baseline, "abc123", "a first publication after the receipt changes the baseline field");
    writeFileSync(join(stateDir, "baseline.json"), "not json");
    assert.equal(await readBaseline(root), "unknown");
    rmSync(join(stateDir, "baseline.json"));

    // A commit changes head (the payload too when the commit changes files; here it does not).
    await commit(root, {}, "empty commit");
    const c = await fp();
    assert.deepEqual(diffFingerprints(base, c), ["head", "combined"]);

    // The publish tag enters publishRange with its commit, so moving the tag changes it too.
    await g(root, ["tag", "__raycast_latest_publish_ext/ext__", "HEAD~1"]);
    const t1 = await fp();
    assert.match(t1.publishRange, /^HEAD\.\.\.__raycast_latest_publish_ext\/ext__@[0-9a-f]{40}$/);
    await g(root, ["tag", "-f", "__raycast_latest_publish_ext/ext__", "HEAD"]);
    const t2 = await fp();
    assert.notEqual(t2.publishRange, t1.publishRange);
    assert.deepEqual(diffFingerprints(t1, t2), ["publishRange", "combined"]);
    // A bare legacy `__raycast_latest_publish__` is not a boundary: the publisher reads only the ext/<name>
    // tag and logs all history without it (Codex W4 r2 A1).
    await g(root, ["tag", "-d", "__raycast_latest_publish_ext/ext__"]);
    await g(root, ["tag", "__raycast_latest_publish__", "HEAD~1"]);
    assert.equal((await fp()).publishRange, "HEAD");
  });
});

test("fingerprint: outside a git work tree head and publishRange are `none`, and the payload still hashes", async () => {
  await withTempDir(async (dir) => {
    const root = fakeExtension(dir, "plain");
    const a = await computeFingerprints({ root, version: "0.1.0", presetPath: null, forbiddenPath: null });
    assert.equal(a.head, "none");
    assert.equal(a.publishRange, "none");
    assert.equal(a.baseline, "unknown");
    assert.equal(payloadFingerprint(root).entries, 1);
    writeFileSync(join(root, "extra.txt"), "x");
    assert.notEqual((await computeFingerprints({ root, version: "0.1.0", presetPath: null, forbiddenPath: null })).payload, a.payload);
    // A makeExt extension (directories included) hashes every entry ray would copy.
    const ext = makeExt(join(dir, "full"));
    assert.ok(payloadFingerprint(ext).entries > 8);
  });
});

test("fingerprint (Codex P2 #11): a symlink's target executable bit is part of the manifest", async () => {
  await withTempDir(async (dir) => {
    const { root, fp } = await repo(dir);
    // The target lives under node_modules, which listPayload skips, so the ONLY way its exec bit
    // can reach the fingerprint is through the link's dereferenced mode.
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "tool.sh"), "#!/bin/sh\necho tool\n");
    chmodSync(join(root, "node_modules", "tool.sh"), 0o644);
    symlinkSync("node_modules/tool.sh", join(root, "run-link"));
    const a = await fp();
    chmodSync(join(root, "node_modules", "tool.sh"), 0o755);
    const b = await fp();
    assert.notEqual(b.payload, a.payload, "flipping the target's exec bit changes the fingerprint even though the link and its bytes did not");
    chmodSync(join(root, "node_modules", "tool.sh"), 0o644);
    assert.equal((await fp()).payload, a.payload);
  });
});

test("fingerprint: an ignored SwiftPM scratch .build (beside Package.swift) is left out; any other .build is not", async () => {
  await withTempDir(async (dir) => {
    const { root, fp } = await repo(dir);
    writeFileSync(join(root, ".gitignore"), "*.local\n.build/\n");
    mkdirSync(join(root, "swift/.build/debug"), { recursive: true });
    writeFileSync(join(root, "swift/Package.swift"), "// swift-tools-version:5.9\n");
    writeFileSync(join(root, "swift/.build/.lock"), "111");
    const a = await fp();
    writeFileSync(join(root, "swift/.build/.lock"), "222"); // ray build writes its PID here every run
    mkdirSync(join(root, "swift/.build/release")); // and creates directories
    assert.equal((await fp()).payload, a.payload, "SwiftPM's scratch files do not change the payload");
    writeFileSync(join(root, "swift/Package.swift"), "// changed\n");
    assert.notEqual((await fp()).payload, a.payload, "Package.swift itself is still covered");
    mkdirSync(join(root, "other/.build"), { recursive: true });
    const b = await fp();
    writeFileSync(join(root, "other/.build/x"), "1");
    assert.notEqual((await fp()).payload, b.payload, "a .build with no Package.swift beside it is still covered");
  });
});

test("fingerprint (fail closed): a SwiftPM .build that no shipped .gitignore excludes stays in the payload", async () => {
  await withTempDir(async (dir) => {
    // The fork-side `git add` would commit it, so a post-gates change to it is a change to the PR.
    const { root, fp } = await repo(dir);
    mkdirSync(join(root, "swift/.build"), { recursive: true });
    writeFileSync(join(root, "swift/Package.swift"), "// swift-tools-version:5.9\n");
    writeFileSync(join(root, "swift/.build/.lock"), "111");
    const a = await fp();
    writeFileSync(join(root, "swift/.build/.lock"), "222");
    assert.notEqual((await fp()).payload, a.payload);
  });
});

test("fingerprint (fail closed): an ignored .build file the repo tracks stays in, since git stages a tracked file anyway", async () => {
  await withTempDir(async (dir) => {
    const { root, fp } = await repo(dir);
    writeFileSync(join(root, ".gitignore"), "*.local\n.build/\n");
    mkdirSync(join(root, "swift/.build"), { recursive: true });
    writeFileSync(join(root, "swift/Package.swift"), "// swift-tools-version:5.9\n");
    writeFileSync(join(root, "swift/.build/tracked.txt"), "1");
    writeFileSync(join(root, "swift/.build/.lock"), "111");
    await g(root, ["add", "-f", "swift/.build/tracked.txt"]);
    await g(root, ["commit", "-qm", "track one scratch file"]);
    const left = await ignoredSwiftPMScratch(root);
    assert.ok(left.has("swift/.build/.lock") && !left.has("swift/.build/tracked.txt"), [...left].join(", "));
    const a = await fp();
    writeFileSync(join(root, "swift/.build/tracked.txt"), "2");
    assert.notEqual((await fp()).payload, a.payload);
  });
});

test("fingerprint: a .gitignore that excludes only the contents (`swift/.build/*`) leaves the contents out, and nothing outside .build", async () => {
  await withTempDir(async (dir) => {
    const { root, fp } = await repo(dir);
    writeFileSync(join(root, ".gitignore"), "*.local\nswift/.build/*\n");
    mkdirSync(join(root, "swift/.build"), { recursive: true });
    writeFileSync(join(root, "swift/Package.swift"), "// swift-tools-version:5.9\n");
    writeFileSync(join(root, "swift/.build/.lock"), "111");
    const a = await fp();
    writeFileSync(join(root, "swift/.build/.lock"), "222");
    assert.equal((await fp()).payload, a.payload);
    writeFileSync(join(root, "swift/keep.txt"), "x");
    const left = await ignoredSwiftPMScratch(root);
    assert.ok(left.has("swift/.build/.lock") && !left.has("swift/keep.txt") && !left.has("swift/Package.swift"), [...left].join(", "));
  });
});

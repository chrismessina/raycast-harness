import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLISH_SKIPS, isSkipped, listPayload, readPayloadBytes } from "../src/payload.mjs";
import { fakeExtension, withTempDir } from "./helpers.mjs";

test("PUBLISH_SKIPS is ray's fixed copyDir list", () => {
  assert.deepEqual(
    [...PUBLISH_SKIPS].sort(),
    // The 2.9.0 publisher's copyDir skip list (Codex W4 A3: `.direnv` was missing here).
    [".direnv", ".git", ".github", ".raycast-swift-build", ".swiftpm", "compiled_raycast_rust", "compiled_raycast_swift", "node_modules", "raycast-env.d.ts"].sort(),
  );
  assert.equal(isSkipped("src/node_modules/x.js"), true);
  assert.equal(isSkipped("raycast-env.d.ts"), true);
  assert.equal(isSkipped(".direnv/flake-profile"), true);
  assert.equal(isSkipped("src/raycast-env.d.ts.bak"), false);
  assert.equal(isSkipped(".githubx/y"), false);
});

test("listPayload: ignored and untracked files are in, skipped names are out at any depth, entries are sorted", async () => {
  await withTempDir((dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "src", "deep", "node_modules"), { recursive: true });
    mkdirSync(join(ext, ".git", "objects"), { recursive: true });
    mkdirSync(join(ext, ".github", "workflows"), { recursive: true });
    mkdirSync(join(ext, ".claude"), { recursive: true });
    writeFileSync(join(ext, ".gitignore"), ".claude/\n.env\n");
    writeFileSync(join(ext, ".env"), "TOKEN=x\n");
    writeFileSync(join(ext, ".claude", "settings.json"), "{}");
    writeFileSync(join(ext, "raycast-env.d.ts"), "// generated");
    writeFileSync(join(ext, "src", "deep", "node_modules", "lib.js"), "x");
    writeFileSync(join(ext, "src", "deep", "a.ts"), "x");
    writeFileSync(join(ext, ".git", "HEAD"), "ref: refs/heads/main");
    writeFileSync(join(ext, ".github", "workflows", "ci.yml"), "x");
    symlinkSync("src/deep/a.ts", join(ext, "link.ts"));

    const entries = listPayload(ext);
    const paths = entries.map((e) => e.path);
    assert.deepEqual(paths, [".claude", ".claude/settings.json", ".env", ".gitignore", "link.ts", "package.json", "src", "src/deep", "src/deep/a.ts"]);
    assert.deepEqual([...paths].sort(), paths, "sorted");
    assert.equal(entries.find((e) => e.path === ".claude")?.type, "dir");
    assert.equal(entries.find((e) => e.path === ".env")?.type, "file");
    const link = entries.find((e) => e.path === "link.ts");
    assert.equal(link?.type, "symlink");
    assert.equal(link?.target, "src/deep/a.ts");
    for (const e of entries) {
      assert.ok(typeof e.mode === "number" && e.mode >= 0 && e.mode <= 0o7777, `mode of ${e.path}`);
      if (e.type !== "symlink") assert.equal(e.target, null);
    }
  });
});

test("readPayloadBytes: a file symlink reads its TARGET's bytes (external included), as ray's copyFileSync publishes them; dangling, directory and dir-symlink entries throw", async () => {
  await withTempDir((dir) => {
    const ext = fakeExtension(dir, "ext");
    writeFileSync(join(dir, "outside.txt"), "outside bytes");
    writeFileSync(join(ext, "inside.txt"), "inside");
    mkdirSync(join(ext, "sub"));
    symlinkSync(join(dir, "outside.txt"), join(ext, "ext-link"));
    symlinkSync("inside.txt", join(ext, "rel-link"));
    symlinkSync("nowhere", join(ext, "dangling"));
    symlinkSync("sub", join(ext, "dir-link"));
    const entries = Object.fromEntries(listPayload(ext).map((e) => [e.path, e]));
    assert.equal(readPayloadBytes(ext, entries["ext-link"]).toString(), "outside bytes");
    assert.equal(readPayloadBytes(ext, entries["rel-link"]).toString(), "inside");
    assert.equal(readPayloadBytes(ext, entries["inside.txt"]).toString(), "inside");
    assert.throws(() => readPayloadBytes(ext, entries["dangling"]), /ENOENT/);
    assert.throws(() => readPayloadBytes(ext, entries["dir-link"]), /not a file/);
    assert.throws(() => readPayloadBytes(ext, entries["sub"]), /is a directory/);
  });
});

test("listPayload throws when the root cannot be read (callers turn it into an ERROR)", async () => {
  await withTempDir((dir) => {
    assert.throws(() => listPayload(join(dir, "missing")), /ENOENT/);
  });
});

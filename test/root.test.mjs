import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExtensionDir, resolveRoot } from "../src/root.mjs";
import { RootError } from "../src/errors.mjs";
import { fakeExtension, withTempDir } from "./helpers.mjs";

test("--root wins, and must be a directory", async () => {
  await withTempDir((dir) => {
    const ext = fakeExtension(dir, "ext");
    assert.equal(resolveRoot({ root: ext, cwd: dir }), ext);
    assert.equal(resolveRoot({ root: "ext", cwd: dir }), ext);
    assert.throws(() => resolveRoot({ root: "nope", cwd: dir }), RootError);
  });
});

test("walks up from cwd to the nearest package.json with a commands array", async () => {
  await withTempDir((dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "src", "deep"), { recursive: true });
    // an inner package.json without commands is not an extension
    writeFileSync(join(ext, "src", "package.json"), JSON.stringify({ name: "inner" }));
    assert.equal(resolveRoot({ cwd: join(ext, "src", "deep") }), ext);
    assert.equal(isExtensionDir(join(ext, "src")), false);
  });
});

test("one extension one level down is found", async () => {
  await withTempDir((dir) => {
    const ext = fakeExtension(dir, "only");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    assert.equal(resolveRoot({ cwd: dir }), ext);
  });
});

test("two extensions one level down is an error asking for --root", async () => {
  await withTempDir((dir) => {
    fakeExtension(dir, "a");
    fakeExtension(dir, "b");
    assert.throws(() => resolveRoot({ cwd: dir }), (e) => e instanceof RootError && /more than one extension.*a, b.*--root/.test(e.message));
  });
});

test("no extension anywhere is an error asking for --root", async () => {
  await withTempDir((dir) => {
    assert.throws(() => resolveRoot({ cwd: dir }), (e) => e instanceof RootError && /no extension found.*--root/.test(e.message));
  });
});

test("a malformed package.json is not an extension", async () => {
  await withTempDir((dir) => {
    writeFileSync(join(dir, "package.json"), "{ not json");
    assert.equal(isExtensionDir(dir), false);
  });
});

test("a symlinked extension directory one level down is found and counted", async () => {
  await withTempDir((dir) => {
    const { symlinkSync } = require_fs();
    const real = fakeExtension(dir, "real");
    mkdirSync(join(dir, "ws"));
    symlinkSync(real, join(dir, "ws", "linked"));
    assert.equal(resolveRoot({ cwd: join(dir, "ws") }), join(dir, "ws", "linked"));
    symlinkSync(join(dir, "nowhere"), join(dir, "ws", "dangling")); // skipped, not a crash
    assert.equal(resolveRoot({ cwd: join(dir, "ws") }), join(dir, "ws", "linked"));
  });
});

function require_fs() {
  return process.getBuiltinModule("node:fs");
}

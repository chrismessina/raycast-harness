import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExtension, rx, withTempDir } from "./helpers.mjs";

// doctor is report-only: it may WARN or say N/A, it never FAILs. The gh probe is a real network
// call; these tests only assert its verdict is PASS or WARN, never its content.

test("doctor without a root: node PASS, ray N/A with reason, never FAIL", async () => {
  await withTempDir(async (dir) => {
    const r = await rx(["doctor", "--json"], { cwd: dir });
    assert.notEqual(r.code, 1, "doctor never FAILs");
    const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
    assert.equal(by.node.verdict, "PASS");
    assert.equal(by.ray.verdict, "N/A");
    assert.match(by.ray.message, /pass --root/);
    assert.ok(["PASS", "WARN"].includes(by["gh-auth"].verdict));
    assert.ok(["PASS", "WARN"].includes(by["git-signing"].verdict));
    assert.ok(["PASS", "WARN", "N/A"].includes(by["raycast-app"].verdict));
    assert.deepEqual(Object.keys(r.json.data).sort(), ["gh", "node", "ray", "raycastApp", "signing"]);
    assert.deepEqual(Object.keys(r.json.data.raycastApp).sort(), ["error", "installed", "path", "version"]);
    assert.equal(r.json.data.ray, null);
  });
});

test("doctor with a root reports ray presence and the installed @raycast/api version", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(ext, "node_modules", "@raycast", "api"), { recursive: true });
    writeFileSync(join(ext, "node_modules", ".bin", "ray"), "#!/bin/sh\n");
    writeFileSync(join(ext, "node_modules", "@raycast", "api", "package.json"), JSON.stringify({ version: "1.104.25" }));
    const r = await rx(["doctor", "--root", ext, "--json"], { cwd: dir });
    const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
    assert.equal(by.ray.verdict, "PASS");
    assert.deepEqual(r.json.data.ray, { found: true, apiVersion: "1.104.25" });
  });
});

test("doctor with a root but no ray installed is a WARN, not a FAIL", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    const r = await rx(["doctor", "--json"], { cwd: ext });
    const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
    assert.equal(by.ray.verdict, "WARN");
    assert.notEqual(r.code, 1);
  });
});

test("doctor declares every id it emits and reads commit.gpgsign as a git boolean", async () => {
  await withTempDir(async (dir) => {
    const { execFileSync } = await import("node:child_process");
    const ext = fakeExtension(dir, "ext");
    execFileSync("git", ["init", "-q"], { cwd: ext });
    execFileSync("git", ["config", "commit.gpgsign", "yes"], { cwd: ext });
    execFileSync("git", ["config", "user.signingkey", "ssh-ed25519 AAAA"], { cwd: ext });
    execFileSync("git", ["config", "gpg.format", "ssh"], { cwd: ext });
    const r = await rx(["doctor", "--root", ext, "--json"], { cwd: ext });
    const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
    assert.equal(by["git-signing"].verdict, "PASS", JSON.stringify(by["git-signing"]));
    assert.ok(!r.json.results.some((x) => x.id === "protocol"), "no undeclared ids");
  });
});

test("an installed Raycast.app whose plist cannot be read is WARN, not N/A (witness through the test hook)", async () => {
  const { _setRaycastPlist } = await import("../src/commands/doctor.mjs");
  await withTempDir(async (dir) => {
    const bad = join(dir, "Info.plist");
    writeFileSync(bad, "not a plist");
    _setRaycastPlist(bad);
    try {
      const r = await rx(["doctor", "--json"], { cwd: dir });
      const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
      assert.equal(by["raycast-app"].verdict, "WARN", JSON.stringify(by["raycast-app"]));
      assert.equal(r.json.data.raycastApp.installed, true);
      assert.match(String(r.json.data.raycastApp.error), /plutil|missing/);
      _setRaycastPlist(join(dir, "absent.plist"));
      const r2 = await rx(["doctor", "--json"], { cwd: dir });
      assert.equal(r2.json.results.find((x) => x.id === "raycast-app").verdict, "N/A");
    } finally {
      _setRaycastPlist("/Applications/Raycast.app/Contents/Info.plist");
    }
  });
});

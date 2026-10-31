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
    assert.ok(["PASS", "N/A"].includes(by["raycast-app"].verdict));
    assert.deepEqual(Object.keys(r.json.data).sort(), ["gh", "node", "ray", "raycastApp", "signing"]);
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

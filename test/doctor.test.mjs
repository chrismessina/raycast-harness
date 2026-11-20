import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _setGreptileFetcherForTests } from "../src/commands/doctor.mjs";
import { SHIPPED_DIR } from "../src/greptile/rules.mjs";
import { afterShipped, fakeExtension, rx, withConfig } from "./helpers.mjs";

// doctor is report-only: it may WARN or say N/A, it never FAILs. The gh probe is stubbed (no
// network in tests); these tests only assert its verdict is PASS or WARN, never its content. Every
// test points XDG_CONFIG_HOME at its temp dir so the attest-key check never reads the real
// ~/.config.

test("doctor without a root: node PASS, ray N/A with reason, never FAIL", async () => {
  await withConfig(async (dir) => {
    const r = await rx(["doctor", "--json"], { cwd: dir });
    assert.notEqual(r.code, 1, "doctor never FAILs");
    const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
    assert.equal(by.node.verdict, "PASS");
    assert.equal(by.ray.verdict, "N/A");
    assert.match(by.ray.message, /pass --root/);
    assert.ok(["PASS", "WARN"].includes(by["gh-auth"].verdict));
    assert.ok(["PASS", "WARN"].includes(by["git-signing"].verdict));
    assert.ok(["PASS", "WARN", "N/A"].includes(by["raycast-app"].verdict));
    assert.deepEqual(Object.keys(r.json.data).sort(), ["attestKey", "gh", "greptileRules", "node", "ray", "raycastApp", "signing"]);
    assert.deepEqual(Object.keys(r.json.data.raycastApp).sort(), ["error", "installed", "path", "version"]);
    assert.equal(r.json.data.ray, null);
  });
});

test("doctor with a root reports ray presence and the installed @raycast/api version", async () => {
  await withConfig(async (dir) => {
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
  await withConfig(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    const r = await rx(["doctor", "--json"], { cwd: ext });
    const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
    assert.equal(by.ray.verdict, "WARN");
    assert.notEqual(r.code, 1);
  });
});

test("doctor declares every id it emits and reads commit.gpgsign as a git boolean", async () => {
  await withConfig(async (dir) => {
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
  await withConfig(async (dir) => {
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

// ---- greptile-rules -----------------------------------------------------------------------------

const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const shippedFile = (/** @type {string} */ f) => readFileSync(join(SHIPPED_DIR, f), "utf8");

/**
 * Run `rx doctor` with the copy in use pinned to a cache copy of the shipped files at `sha`, and the
 * greptile-rules fetcher replaced by `fetcher` (null keeps withConfig's offline stub).
 * @param {string} sha @param {any} fetcher
 */
async function doctorWith(sha, fetcher) {
  return withConfig(async (dir) => {
    const prevCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const copy = join(dir, "cache", "raycast-harness", "greptile", "rules", "c");
    mkdirSync(copy, { recursive: true });
    for (const f of ["config.json", "files.json", "rules.md"]) writeFileSync(join(copy, f), shippedFile(f));
    writeFileSync(join(copy, "SOURCE.json"), JSON.stringify({ repo: "raycast/extensions", source: "main", sha, committed: COPY_COMMITTED, fetched: "2099-01-02T00:00:00.000Z" }));
    if (fetcher) _setGreptileFetcherForTests(fetcher);
    try {
      const r = await rx(["doctor", "--json"], { cwd: dir });
      return { r, g: r.json.results.find((/** @type {any} */ x) => x.id === "greptile-rules") };
    } finally {
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevCache;
    }
  });
}

const MOVED_HEAD = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** After the shipped copy's commit, so the cache copy is the one in use; never in the future. */
const COPY_COMMITTED = afterShipped(2);

/**
 * A fetcher whose latest commit touching .greptile/ on main is `lastTouch`, serving the given
 * .greptile/ files and recording every request. Main's own head has moved on to MOVED_HEAD (a
 * check keyed on the head would see a new SHA every time).
 * @param {string} lastTouch @param {Record<string, string>} [files]
 */
function liveMain(lastTouch, files = {}) {
  const calls = /** @type {string[]} */ ([]);
  return {
    calls,
    async getJson(/** @type {string} */ p) {
      calls.push(p);
      if (p.endsWith("/commits?path=.greptile&sha=main&per_page=1")) return [{ sha: lastTouch, commit: { committer: { date: COPY_COMMITTED } } }];
      if (p.endsWith("/commits/main")) return { sha: MOVED_HEAD };
      throw new Error(`unexpected ${p}`);
    },
    async getRaw(/** @type {string} */ p) { calls.push(p); const f = /\.greptile\/([^?]+)/.exec(p)?.[1] ?? ""; return files[f] ?? shippedFile(f); },
  };
}

test("doctor greptile-rules: main moved but .greptile/ did not → PASS after exactly one request", async () => {
  const f = liveMain(MAIN);
  const { r, g } = await doctorWith(MAIN, f);
  assert.notEqual(r.code, 1);
  assert.equal(g.verdict, "PASS", JSON.stringify(g));
  assert.equal(g.message, "current: raycast/extensions main @ aaaaaaa (2099-01-02, updated copy)");
  assert.deepEqual(f.calls, ["repos/raycast/extensions/commits?path=.greptile&sha=main&per_page=1"], "one request, no file fetched");
  assert.equal(r.json.data.greptileRules.inUse.kind, "updated");
});

test("doctor greptile-rules: a new .greptile/ commit with the same files is PASS; with changed files WARN out of date naming each change", async () => {
  const same = liveMain(OTHER);
  const { g: g1 } = await doctorWith(MAIN, same);
  assert.equal(g1.verdict, "PASS", JSON.stringify(g1));
  assert.equal(same.calls.length, 4, "one head request, then the three files");

  const config = JSON.parse(shippedFile("config.json"));
  config.rules.push({ id: "brand-new-rule", severity: "low", scope: [], rule: "New" });
  const { r, g } = await doctorWith(MAIN, liveMain(OTHER, { "config.json": JSON.stringify(config) }));
  assert.equal(g.verdict, "WARN", JSON.stringify(g));
  assert.equal(g.message, "out of date: 1 change(s) since 2099-01-02; run rx greptile update");
  assert.deepEqual(g.details.map((/** @type {any} */ d) => d.text), ["rule added brand-new-rule [low]"]);
  assert.notEqual(r.code, 1, "doctor never FAILs");
});

test("doctor greptile-rules: offline is a WARN naming the copy still in use, never an ERROR", async () => {
  const { r, g } = await doctorWith(MAIN, null);
  assert.equal(g.verdict, "WARN", JSON.stringify(g));
  assert.equal(g.message, "could not check (offline or gh unavailable): using updated copy from 2099-01-02");
  assert.match(r.json.data.greptileRules.error, /offline \(test stub\)/);
  assert.notEqual(r.code, 1);
});

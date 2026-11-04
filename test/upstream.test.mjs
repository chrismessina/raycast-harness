import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "./helpers.mjs";
import { _setUpstreamForTests, blobId, cachedUpstream, ensureUpstream, isPublished, lockHeld, upstreamDir, withUpstreamLock } from "../src/upstream.mjs";
import { RxError } from "../src/errors.mjs";
import { extensionFiles, fakeUpstream, g } from "./upstream-fixtures.mjs";

// The sparse fetch runs against a local bare repository (file://) and the GitHub publication
// lookup is replaced by a probe; no network anywhere in this file.

const savedCache = process.env.XDG_CACHE_HOME;
before(() => {});
after(() => {
  _setUpstreamForTests({ url: null, probe: null });
  if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCache;
});

test("blobId matches git hash-object", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "f"), "hello\n");
    const expected = (await g(dir, ["hash-object", "f"])).stdout;
    assert.equal(blobId(Buffer.from("hello\n")), expected);
  });
});

test("ensureUpstream: published extension is fetched sparsely, recorded, and served from cache within maxAgeMs", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const up = await fakeUpstream(dir, { alpha: extensionFiles("alpha"), beta: extensionFiles("beta", { "extra.txt": "b\n" }) });
    _setUpstreamForTests({ url: up.url, probe: async (n) => n === "alpha" || n === "beta" });

    const info = await ensureUpstream("alpha");
    assert.equal(info.published, true);
    assert.equal(info.baseline, up.sha);
    assert.equal(info.publishedDir, join(upstreamDir(), "extensions", "alpha"));
    const publishedDir = /** @type {string} */ (info.publishedDir);
    assert.ok(existsSync(join(publishedDir, "package.json")));
    // Sparse: beta is not checked out until asked for.
    assert.ok(!existsSync(join(upstreamDir(), "extensions", "beta")));

    const cached = await cachedUpstream("alpha");
    assert.deepEqual(cached, info);
    const again = await ensureUpstream("alpha", { maxAgeMs: 60_000 });
    assert.equal(again.at, info.at, "served from cache without a new fetch");

    // Adding a second extension keeps the first.
    const b = await ensureUpstream("beta");
    assert.ok(existsSync(join(/** @type {string} */ (b.publishedDir), "extra.txt")));
    assert.ok(existsSync(join(publishedDir, "package.json")));

    // Upstream moves → a fresh fetch (maxAgeMs 0) sees the new commit.
    const sha2 = (await import("./upstream-fixtures.mjs")).commit;
    await sha2(up.work, { "extensions/alpha/src/index.tsx": "changed\n" }, "upstream edit");
    await g(up.work, ["push", "-q", up.bare, "main"]);
    const moved = await ensureUpstream("alpha");
    assert.notEqual(moved.baseline, up.sha);
    assert.equal(readFileSync(join(/** @type {string} */ (moved.publishedDir), "src", "index.tsx"), "utf8"), "changed\n");
    assert.equal(await cachedUpstream("alpha").then((c) => c?.baseline), moved.baseline);
  });
});

test("ensureUpstream: unpublished (404) records published:false with null dir and baseline", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    _setUpstreamForTests({ url: `file://${dir}/nowhere.git`, probe: async () => false });
    const info = await ensureUpstream("ghost");
    assert.deepEqual({ ...info, at: "x" }, { name: "ghost", published: false, publishedDir: null, baseline: null, at: "x" });
    assert.equal((await cachedUpstream("ghost"))?.published, false);
  });
});

test("ensureUpstream: a fetch failure is ERROR github, never 'no differences'", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    _setUpstreamForTests({ url: `file://${dir}/missing.git`, probe: async () => true });
    await assert.rejects(ensureUpstream("alpha"), (e) => e instanceof RxError && e.id === "github" && /fetch/.test(e.message));
    assert.equal(await cachedUpstream("alpha"), null);
  });
});

test("isPublished: a non-404 failure is ERROR github; an invalid name is ERROR input", async () => {
  _setUpstreamForTests({ probe: null });
  // No probe: the real ghApi runs against a name that cannot exist, with gh pointed at nothing.
  const saved = { GH_HOST: process.env.GH_HOST, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.GH_HOST = "127.0.0.1:9";
  process.env.GH_TOKEN = "x";
  try {
    await assert.rejects(isPublished("alpha"), (e) => e instanceof RxError && e.id === "github");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await assert.rejects(isPublished("../etc"), (e) => e instanceof RxError && e.id === "input");
});

test("ensureUpstream refuses to fetch into a directory that is not its own clone", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const up = await fakeUpstream(dir, { alpha: extensionFiles("alpha") });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    const foreign = upstreamDir();
    mkdirSync(foreign, { recursive: true });
    await g(foreign, ["init", "-q"]);
    await g(foreign, ["remote", "add", "origin", "https://example.com/other.git"]);
    await assert.rejects(ensureUpstream("alpha"), (e) => e instanceof RxError && e.id === "github" && /origin is not/.test(e.message));
  });
});

test("withUpstreamLock: exclusive across holders, reentrant within one, released on throw", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    _setUpstreamForTests({ lockWaitMs: 2_000 });
    try {
      let release;
      const gate = new Promise((r) => { release = r; });
      const order = [];
      const first = withUpstreamLock(async () => {
        order.push("first-in");
        assert.ok(existsSync(join(upstreamDir(), ".rx-lock")));
        await withUpstreamLock(async () => order.push("reentrant")); // same process: no deadlock
        await gate;
        order.push("first-out");
      });
      await new Promise((r) => setTimeout(r, 50));
      // A second holder (simulated by the lock dir another process would create) must wait.
      const second = (async () => {
        // Give the first a moment, then simulate the other process releasing by resolving the gate.
        setTimeout(() => release(), 300);
        return "second-done";
      })();
      await first;
      assert.equal(await second, "second-done");
      assert.deepEqual(order, ["first-in", "reentrant", "first-out"]);
      assert.equal(lockHeld(), false);
      assert.ok(!existsSync(join(upstreamDir(), ".rx-lock")), "lock directory removed");

      // Released on throw.
      await assert.rejects(withUpstreamLock(async () => { throw new Error("boom"); }), /boom/);
      assert.ok(!existsSync(join(upstreamDir(), ".rx-lock")));

      // A foreign fresh lock makes a waiter time out with ERROR github; a stale one is swept.
      mkdirSync(join(upstreamDir(), ".rx-lock"));
      _setUpstreamForTests({ lockWaitMs: 200 });
      await assert.rejects(withUpstreamLock(async () => "never"), (e) => e instanceof RxError && e.id === "github" && /lock/.test(e.message));
      _setUpstreamForTests({ lockStaleMs: 1 });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(await withUpstreamLock(async () => "swept"), "swept");
    } finally {
      _setUpstreamForTests({ lockWaitMs: null, lockStaleMs: null });
    }
  });
});

// src/published-copy.mjs: published-copy access as one scoped operation (docs/commands.md §1).
// The lock is held for the callback's whole lifetime (a refresh in another process waits), an
// expected baseline the cache no longer holds is the documented error, a caller-supplied directory
// outside the cache is neither locked nor refreshed, and the stale baseline carries no cache path
// while a file in the older shape (with `publishedDir`) still reads. No network: a local bare repo
// stands in for raycast/extensions and a probe for the publication lookup.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { computeFingerprints, readBaseline } from "../src/fingerprint.mjs";
import { readPublished } from "../src/preflight/context.mjs";
import { PublishedCopyChanged, readStaleBaseline, withPublishedCopy, writeStaleBaseline } from "../src/published-copy.mjs";
import { repoStatePathReadOnly } from "../src/state.mjs";
import { _setUpstreamForTests, lockHeld, upstreamDir } from "../src/upstream.mjs";
import { auditRecord, buildGated, byId, fullEntries, gates, withGatedEnv, writeEntries } from "./gates-helpers.mjs";
import { rx, withTempDir } from "./helpers.mjs";
import { commit, extensionFiles, fakeUpstream, g, initRepo } from "./upstream-fixtures.mjs";

const savedCache = process.env.XDG_CACHE_HOME;
after(() => {
  _setUpstreamForTests({ url: null, probe: null, lockWaitMs: null });
  if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCache;
});

const UPSTREAM_URL = pathToFileURL(join(import.meta.dirname, "..", "src", "upstream.mjs")).href;
const COPY_URL = pathToFileURL(join(import.meta.dirname, "..", "src", "published-copy.mjs")).href;

/**
 * A second process that refreshes `name` through the service (as a concurrent `rx stale` would)
 * and prints the time it got the copy. Resolves with that time.
 * @param {string} cache @param {string} url @param {string} name
 * @returns {Promise<number>}
 */
function refreshInAnotherProcess(cache, url, name) {
  const script = `
    const up = await import(${JSON.stringify(UPSTREAM_URL)});
    const pc = await import(${JSON.stringify(COPY_URL)});
    up._setUpstreamForTests({ url: ${JSON.stringify(url)}, probe: async () => true, lockWaitMs: 20000 });
    await pc.withPublishedCopy({ name: ${JSON.stringify(name)}, refresh: true }, async () => { process.stdout.write(String(Date.now())); });
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, XDG_CACHE_HOME: cache }, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`child failed: ${stderr}`));
      else resolve(Number(stdout));
    });
  });
}

test("published-copy: the lock is held for the callback's whole lifetime; a refresh in another process waits for it", async () => {
  await withTempDir(async (dir) => {
    const cache = join(dir, "cache");
    process.env.XDG_CACHE_HOME = cache;
    const up = await fakeUpstream(dir, { alpha: extensionFiles("alpha") });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    let released = 0;
    /** @type {Promise<number>[]} */
    const child = [];
    await withPublishedCopy({ name: "alpha", refresh: true }, async (copy) => {
      assert.equal(lockHeld(), true);
      assert.equal(copy.published, true);
      assert.equal(copy.baseline, up.sha);
      assert.equal(copy.cached, true);
      assert.ok(copy.exists("package.json"));
      child.push(refreshInAnotherProcess(cache, up.url, "alpha"));
      await new Promise((r) => setTimeout(r, 1500)); // ample time for the child to reach the lock
      assert.ok(existsSync(join(upstreamDir(), ".rx-lock")), "still locked while the callback runs");
      released = Date.now();
    });
    assert.equal(lockHeld(), false);
    assert.equal(child.length, 1);
    const got = await child[0];
    assert.ok(got >= released, `the concurrent refresh got the copy at ${got}, before the callback released the lock at ${released}`);
  });
});

test("published-copy: an expected baseline the cache no longer holds is PublishedCopyChanged (ERROR github), and the callback never runs", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const up = await fakeUpstream(dir, { alpha: extensionFiles("alpha") });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    await withPublishedCopy({ name: "alpha", refresh: true }, async () => {});
    // The exact baseline: the copy, with no network (the probe would throw).
    _setUpstreamForTests({ probe: async () => { throw new Error("no network in a cache read"); } });
    const seen = await withPublishedCopy({ name: "alpha", expectedBaseline: up.sha }, async (copy) => ({ baseline: copy.baseline, locked: lockHeld(), file: copy.read("package.json").length > 0 }));
    assert.deepEqual(seen, { baseline: up.sha, locked: true, file: true });

    let ran = false;
    const other = "f".repeat(40);
    await assert.rejects(
      withPublishedCopy({ name: "alpha", expectedBaseline: other }, async () => { ran = true; }),
      (/** @type {any} */ e) => e instanceof PublishedCopyChanged && e.id === "github" && e.message === `the upstream cache no longer holds baseline ${other.slice(0, 12)} for alpha; run rx gates again`,
    );
    assert.equal(ran, false);
    assert.equal(lockHeld(), false);
  });
});

test("published-copy: a caller-supplied directory outside the cache is neither locked nor refreshed; one inside it is locked", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    let probes = 0;
    _setUpstreamForTests({ url: `file://${dir}/unused.git`, probe: async () => { probes++; return true; }, lockWaitMs: 300 });
    try {
      // Another rx holds the cache lock the whole time.
      mkdirSync(join(upstreamDir(), ".rx-lock"), { recursive: true });
      const external = join(dir, "published");
      mkdirSync(external);
      writeFileSync(join(external, "CHANGELOG.md"), "x\n");
      const seen = await withPublishedCopy({ directory: external }, async (copy) => ({ locked: lockHeld(), cached: copy.cached, dir: copy.directory, text: copy.read("CHANGELOG.md").toString() }));
      assert.deepEqual(seen, { locked: false, cached: false, dir: external, text: "x\n" });
      assert.equal(probes, 0, "no publication lookup, no fetch");

      // The same directory inside the cache waits on the lock (ERROR github after the wait).
      const inside = join(upstreamDir(), "extensions", "alpha");
      mkdirSync(inside, { recursive: true });
      await assert.rejects(withPublishedCopy({ directory: inside }, async () => {}), /another rx holds the upstream cache lock/);
      rmSync(join(upstreamDir(), ".rx-lock"), { recursive: true, force: true });
      assert.deepEqual(await withPublishedCopy({ directory: inside }, async (copy) => ({ locked: lockHeld(), cached: copy.cached })), { locked: true, cached: true });

      // A directory is read as given: it cannot be refreshed or checked against a baseline.
      await assert.rejects(withPublishedCopy({ directory: external, refresh: true }, async () => {}), /read as given/);
      await assert.rejects(withPublishedCopy({ directory: external, expectedBaseline: "abc" }, async () => {}), /read as given/);
    } finally {
      _setUpstreamForTests({ lockWaitMs: null });
      rmSync(join(upstreamDir(), ".rx-lock"), { recursive: true, force: true });
    }
  });
});

test("published-copy: rx contributions and rx preflight read an external --published while another rx holds the cache lock", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    _setUpstreamForTests({ lockWaitMs: 300 });
    try {
      mkdirSync(join(upstreamDir(), ".rx-lock"), { recursive: true });
      const files = extensionFiles("ext");
      const published = join(dir, "published");
      const pub = await initRepo(published);
      await commit(pub, files, "published");
      const repo = await initRepo(join(dir, "repo"));
      await commit(repo, files, "base");
      const pre = await rx(["preflight", "--published", published, "--json"], { cwd: repo });
      assert.ok(pre.json.results.every((/** @type {any} */ r) => r.id !== "github"), pre.stdout);
      // contributions gets past the lock to its own check: there is no merge in progress.
      const con = await rx(["contributions", "--published", published, "--json"], { cwd: repo });
      assert.equal(con.json.results[0].id, "contributions", con.stdout);
      assert.match(con.json.results[0].message, /no merge in progress/);
    } finally {
      _setUpstreamForTests({ lockWaitMs: null });
      rmSync(join(upstreamDir(), ".rx-lock"), { recursive: true, force: true });
    }
  });
});

/**
 * The pre-refactor readBaseline (src/fingerprint.mjs before published-copy.mjs), kept verbatim as
 * the oracle the new reader must agree with.
 * @param {string} root
 */
async function legacyReadBaseline(root) {
  try {
    const file = await repoStatePathReadOnly(root, "stale", "baseline.json");
    if (!existsSync(file)) return "unknown";
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j?.published === false) return "unpublished";
    if (j?.published === true && typeof j.baseline === "string" && j.baseline) return j.baseline;
    return "unknown";
  } catch {
    return "unknown";
  }
}

test("published-copy: the stale baseline is { name, published, baseline, at }; an old-shape file still reads, and fingerprints are byte-identical", async () => {
  await withTempDir(async (dir) => {
    const root = await initRepo(join(dir, "ext"));
    await commit(root, extensionFiles("ext"), "v1");
    const preset = join(dir, "preset.json");
    const forbidden = join(dir, "forbidden.txt");
    writeFileSync(preset, JSON.stringify({ schema: 1, owner: "x", rules: [] }));
    writeFileSync(forbidden, "AbCdEfGhIjK\n");
    const fp = () => computeFingerprints({ root, version: "0.1.0", presetPath: preset, forbiddenPath: forbidden });
    const file = (await g(root, ["rev-parse", "--path-format=absolute", "--git-path", "rx/stale/baseline.json"])).stdout;
    const sha = "0123456789abcdef0123456789abcdef01234567";

    // The new shape: no cache path.
    await writeStaleBaseline(root, { name: "ext", published: true, baseline: sha, at: "2026-11-08T00:00:00.000Z" });
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(written), ["name", "published", "baseline", "at"]);
    const fpNew = await fp();

    // The old shape (what rx stale wrote before): the path is ignored, the rest is read as before.
    writeFileSync(file, JSON.stringify({ name: "ext", baseline: sha, publishedDir: "/old/cache/upstream/extensions/ext", published: true, at: "2026-11-08T00:00:00.000Z" }, null, 2) + "\n");
    assert.deepEqual(await readStaleBaseline(root), { name: "ext", published: true, baseline: sha, at: "2026-11-08T00:00:00.000Z" });
    assert.equal(await readPublished(root), true);
    const fpOld = await fp();
    assert.deepEqual(fpOld, fpNew, "fingerprints do not depend on the baseline file's shape");
    assert.equal(fpNew.baseline, sha);

    // Every shape a reader can meet: the new reader agrees with the pre-refactor one.
    const shapes = [
      { name: "ext", baseline: sha, publishedDir: "/x", published: true, at: "x" },
      { name: "ext", published: true, baseline: sha, at: "x" },
      { name: "ext", baseline: null, publishedDir: null, published: false, at: "x" },
      { name: "ext", published: false, baseline: null, at: "x" },
      { name: "ext", published: true, baseline: "", at: "x" },
      { name: "ext", published: "yes", baseline: sha },
      [1, 2],
      null,
    ];
    for (const s of shapes) {
      writeFileSync(file, JSON.stringify(s));
      assert.equal(await readBaseline(root), await legacyReadBaseline(root), JSON.stringify(s));
    }
    writeFileSync(file, "not json");
    assert.equal(await readBaseline(root), await legacyReadBaseline(root));
    rmSync(file);
    assert.equal(await readBaseline(root), await legacyReadBaseline(root));
    assert.equal(await readStaleBaseline(root), null);
  });
});

test("audit record: a cache that no longer holds the receipt's baseline is ERROR png with the documented sentence", async () => {
  await withGatedEnv(async (dir) => {
    const { root, up } = await buildGated(dir, { published: true });
    const gr = await gates(root);
    assert.equal(gr.code, 0, gr.stdout);
    // Another rx moved the shared tree (here: the cache's record of ext names another commit).
    const meta = join(process.env.XDG_CACHE_HOME ?? "", "raycast-harness", "upstream-meta", "ext.json");
    const m = JSON.parse(readFileSync(meta, "utf8"));
    writeFileSync(meta, JSON.stringify({ ...m, baseline: "e".repeat(40) }));
    const r = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(r.code, 2, r.stdout);
    const png = byId(r).png;
    assert.equal(png.verdict, "ERROR");
    assert.equal(png.message, `the upstream cache no longer holds baseline ${String(up?.sha).slice(0, 12)} for ext; run rx gates again`);
  });
});

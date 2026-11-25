import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExtension, rx, withTempDir } from "./helpers.mjs";
import { _setUpstreamForTests, lockHeld, upstreamDir } from "../src/upstream.mjs";
import { FIXTURES, applyTree, commit, extensionFiles, fakeUpstream, g, initRepo } from "./upstream-fixtures.mjs";
import { staleDispositions } from "../src/audit/evaluate.mjs";

// `rx stale` end to end against a fake raycast/extensions (a local bare repo fetched over file://)
// with the GitHub publication lookup replaced by a probe. No network.

const FIX = join(FIXTURES, "stale", "alpha");
const EXPECTED = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8"));
const savedCache = process.env.XDG_CACHE_HOME;
after(() => {
  _setUpstreamForTests({ url: null, probe: null });
  if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCache;
});

/** Read a fixture tree into { path: Buffer }. @param {string} dir @param {string} [prefix] */
function treeOf(dir, prefix = "") {
  /** @type {Record<string, Buffer>} */
  const out = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, treeOf(join(dir, e.name), rel));
    else out[rel] = readFileSync(join(dir, e.name));
  }
  return out;
}

/**
 * Build the fixture: a fake upstream holding `published/`, and a local repo with commit-1,
 * commit-2 (+x on scripts/run.sh), then the uncommitted overlay and a symlink.
 * @param {string} dir
 */
async function buildAlpha(dir) {
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  const up = await fakeUpstream(dir, { alpha: treeOf(join(FIX, "published")) });
  _setUpstreamForTests({ url: up.url, probe: async (n) => n === "alpha" });
  const local = await initRepo(join(dir, "alpha"));
  await commit(local, treeOf(join(FIX, "local-commit-1")), "v1 as submitted");
  applyTree(join(FIX, "local-commit-2"), local);
  chmodSync(join(local, "scripts", "run.sh"), 0o755);
  await commit(local, {}, "v1.1 unpublished");
  applyTree(join(FIX, "local-uncommitted"), local);
  symlinkSync("package.json", join(local, "link.txt"));
  return { up, local };
}

test("stale: every classifier class lands on its documented verdict, and baseline.json is written", async () => {
  await withTempDir(async (dir) => {
    const { up, local } = await buildAlpha(dir);
    const r = await rx(["stale", "--json"], { cwd: local });
    assert.equal(r.code, EXPECTED.exit, r.stdout);
    const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
    for (const [id, verdict] of Object.entries(EXPECTED.results)) assert.equal(by[id]?.verdict, verdict, `${id}: ${JSON.stringify(by[id])}`);
    const classes = Object.fromEntries(r.json.data.files.map((f) => [f.path, f.class]));
    assert.deepEqual(classes, EXPECTED.files);
    // Only ray's skip list is excluded: the published .prettierrc is a real ONLY-PUB (Q18).
    assert.equal(classes[".prettierrc"], "ONLY-PUB");

    // The disposition key rx audit record matches: path + localHash + baseline, for CHECK and NEW?.
    const check = r.json.data.files.find((f) => f.path === "CHANGELOG.md");
    assert.match(check.localHash, /^[0-9a-f]{40}$/);
    assert.equal(check.localHash, (await g(local, ["hash-object", "CHANGELOG.md"])).stdout);
    assert.match(check.publishedHash, /^[0-9a-f]{40}$/);
    assert.equal(r.json.data.baseline, up.sha);
    assert.equal(r.json.data.published, true);
    assert.equal(r.json.data.name, "alpha");
    const newFile = r.json.data.files.find((f) => f.path === "src/new.ts");
    assert.equal(newFile.publishedHash, null);
    // Details carry the class and a note per path.
    assert.deepEqual(by["stale-check"].details.map((d) => d.file), ["CHANGELOG.md"]);
    assert.match(by["stale-check"].details[0].text, /^CHECK /);
    assert.match(by["stale-mine"].details.find((d) => d.file === "package.json").text, /uncommitted/);
    assert.match(by["stale-unhandled"].details.find((d) => d.file === "scripts/run.sh").text, /mode 100644 published, 100755 local/);

    // State: repo/stale/baseline.json with the exact shape rx api-floor reads, and no cache path.
    const stateDir = (await g(local, ["rev-parse", "--path-format=absolute", "--git-path", "rx"])).stdout;
    const baseline = JSON.parse(readFileSync(join(stateDir, "stale", "baseline.json"), "utf8"));
    assert.deepEqual(Object.keys(baseline).sort(), ["at", "baseline", "name", "published"]);
    assert.equal(baseline.published, true);
    assert.equal(baseline.baseline, up.sha);
    assert.equal(baseline.publishedDir, undefined);
    // `data.publishedDir` stays in the output for this run's consumers; it is only not persisted.
    assert.equal(r.json.data.publishedDir, join(upstreamDir(), "extensions", "alpha"));
    // Read-only outside the cache and the state dir: the local tree is untouched (symlink, overlay still there).
    assert.ok(existsSync(join(local, "link.txt")));
    assert.equal((await g(local, ["status", "--porcelain"])).stdout.split("\n").filter(Boolean).length, 2); // package.json modified, link.txt untracked
  });
});

test("stale: a fully identical tree is one PASS stale-mine 'identical to published'", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const files = extensionFiles("beta");
    const up = await fakeUpstream(dir, { beta: files });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    const local = await initRepo(join(dir, "beta"));
    await commit(local, files, "same as published");
    const r = await rx(["stale", "--json"], { cwd: local });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.results.length, 1);
    assert.equal(r.json.results[0].id, "stale-mine");
    assert.match(r.json.results[0].message, /identical to published \(3 files/);
    assert.ok(r.json.data.files.every((f) => f.class === "MINE"));
  });
});

test("stale: unpublished (404) → N/A stale, published:false, null dir and baseline, exit 0", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    _setUpstreamForTests({ url: `file://${dir}/unused.git`, probe: async () => false });
    const local = await initRepo(join(dir, "gamma"));
    await commit(local, extensionFiles("gamma"), "new extension");
    const r = await rx(["stale", "--json"], { cwd: local });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.json.results.map((x) => [x.id, x.verdict]), [["stale", "N/A"]]);
    assert.match(r.json.results[0].message, /not published/);
    assert.deepEqual(r.json.data, { name: "gamma", published: false, publishedDir: null, baseline: null, files: [] });
    const stateDir = (await g(local, ["rev-parse", "--path-format=absolute", "--git-path", "rx"])).stdout;
    const baseline = JSON.parse(readFileSync(join(stateDir, "stale", "baseline.json"), "utf8"));
    assert.equal(baseline.published, false);
    assert.equal(baseline.baseline, null);
  });
});

test("stale: a publication lookup that is not 404 is ERROR github (exit 2), never a pass", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const { RxError } = await import("../src/errors.mjs");
    _setUpstreamForTests({ url: `file://${dir}/unused.git`, probe: async () => { throw new RxError("gh api … failed (HTTP 403): rate limit", { id: "github" }); } });
    const local = await initRepo(join(dir, "delta"));
    await commit(local, extensionFiles("delta"), "x");
    const r = await rx(["stale", "--json"], { cwd: local });
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.results.map((x) => [x.id, x.verdict]), [["github", "ERROR"]]);
    assert.match(r.json.results[0].message, /403/);
  });
});

test("stale: a failed fetch is ERROR github, not 'no differences'", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    _setUpstreamForTests({ url: `file://${dir}/does-not-exist.git`, probe: async () => true });
    const local = await initRepo(join(dir, "eps"));
    await commit(local, extensionFiles("eps"), "x");
    const r = await rx(["stale", "--json"], { cwd: local });
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "github");
    assert.match(r.json.results[0].message, /fetch/);
  });
});

test("stale resolves the root before any lookup (Q3): an ambiguous root is ERROR root and the probe is never called", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    let probed = 0;
    _setUpstreamForTests({ url: `file://${dir}/unused.git`, probe: async () => { probed++; return true; } });
    fakeExtension(dir, "one");
    fakeExtension(dir, "two");
    const r = await rx(["stale", "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "root");
    assert.equal(probed, 0, "the network was touched before the root was known");
    // With --root the same tree runs, and the probe sees the extension's package.json name.
    mkdirSync(join(dir, "one", "src"), { recursive: true });
    const seen = [];
    _setUpstreamForTests({ probe: async (n) => { seen.push(n); return false; } });
    await initRepo(join(dir, "one"));
    await commit(join(dir, "one"), {}, "init");
    const r2 = await rx(["stale", "--root", join(dir, "one"), "--json"], { cwd: dir });
    assert.deepEqual(seen, ["one"]);
    assert.equal(r2.json.results[0].verdict, "N/A");
  });
});

test("stale from a monorepo subdirectory compares the extension's own tree (HEAD:./path, not the repo root)", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const files = extensionFiles("mono");
    const up = await fakeUpstream(dir, { mono: files });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    const repo = await initRepo(join(dir, "extensions-clone"));
    /** @type {Record<string, string>} */
    const nested = { "README.md": "# monorepo\n" };
    for (const [p, c] of Object.entries(files)) nested[`extensions/mono/${p}`] = c;
    await commit(repo, nested, "monorepo");
    const r = await rx(["stale", "--json"], { cwd: join(repo, "extensions", "mono") });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.results[0].id, "stale-mine");
    assert.match(r.json.results[0].message, /identical/);
  });
});

test("stale: an uncommitted executable-bit change on identical bytes is UNHANDLED, not MINE", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const files = extensionFiles("zeta", { "scripts/run.sh": "#!/bin/sh\necho run\n" });
    const up = await fakeUpstream(dir, { zeta: files });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    const local = await initRepo(join(dir, "zeta"));
    await commit(local, files, "same as published");
    chmodSync(join(local, "scripts", "run.sh"), 0o755); // bytes identical, mode changed, not committed
    const r = await rx(["stale", "--json"], { cwd: local });
    assert.equal(r.code, 1, r.stdout);
    const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
    assert.equal(by["stale-unhandled"].verdict, "FAIL");
    assert.match(by["stale-unhandled"].details[0].text, /mode 100644 published, 100755 local \(uncommitted\)/);
    assert.equal(r.json.data.files.find((f) => f.path === "scripts/run.sh").class, "UNHANDLED");
  });
});

test("stale: a group-only execute bit is not a mode change (git reads the owner's x bit alone)", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const files = extensionFiles("zeta", { "scripts/run.sh": "#!/bin/sh\necho run\n" });
    const up = await fakeUpstream(dir, { zeta: files });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    const local = await initRepo(join(dir, "zeta"));
    await commit(local, files, "same as published");
    chmodSync(join(local, "scripts", "run.sh"), 0o654); // git still records 100644
    const r = await rx(["stale", "--json"], { cwd: local });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.data.files.find((/** @type {any} */ f) => f.path === "scripts/run.sh").class, "MINE");
  });
});

test("stale holds the upstream cache lock from the fetch through the comparison", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const files = extensionFiles("eta");
    const up = await fakeUpstream(dir, { eta: files });
    let heldDuringLookup = null;
    _setUpstreamForTests({ url: up.url, probe: async () => { heldDuringLookup = lockHeld(); return true; } });
    const local = await initRepo(join(dir, "eta"));
    await commit(local, files, "x");
    const r = await rx(["stale", "--json"], { cwd: local });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(heldDuringLookup, true, "the lock must already be held when the comparison starts");
    assert.equal(lockHeld(), false, "released afterwards");
    assert.ok(!existsSync(join(upstreamDir(), ".rx-lock")));

    // Another process holding the lock: stale waits, then ERROR github rather than reading a moving tree.
    mkdirSync(join(upstreamDir(), ".rx-lock"));
    _setUpstreamForTests({ lockWaitMs: 300 });
    try {
      const r2 = await rx(["stale", "--json"], { cwd: local });
      assert.equal(r2.code, 2);
      assert.equal(r2.json.results[0].id, "github");
      assert.match(r2.json.results[0].message, /upstream cache lock/);
    } finally {
      _setUpstreamForTests({ lockWaitMs: null });
      rmSync(join(upstreamDir(), ".rx-lock"), { recursive: true, force: true });
    }
  });
});

test("stale --preset: a published file the preset's holdout.localOnly lists and local lacks is REMOVE (WARN); an unlisted one stays ONLY-PUB (FAIL); without --preset both are ONLY-PUB", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const files = extensionFiles("gamma");
    const up = await fakeUpstream(dir, { gamma: { ...files, "AGENTS.md": "# Agents\n", "HANDOFF.md": "# Handoff\n", ".claude/settings.json": "{}\n", "src/gone.ts": "export {};\n" } });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    const local = await initRepo(join(dir, "gamma"));
    await commit(local, files, "the four mirror files are not in this tree");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, JSON.stringify({ schema: 1, owner: "octo-author", rules: [], holdout: { localOnly: [".claude", "AGENTS.md", "CONCEPTS.md", "CLAUDE.md", "HANDOFF.md"] } }));
    // A holdout in progress names AGENTS.md (the inventory is all stale reads).
    const state = (await g(local, ["rev-parse", "--path-format=absolute", "--git-path", "rx"])).stdout;
    mkdirSync(join(state, "holdout"), { recursive: true });
    writeFileSync(join(state, "holdout", "inventory.json"), JSON.stringify({ version: 1, root: local, createdAt: "x", entries: [{ source: "AGENTS.md", destination: join(state, "holdout", "files", "AGENTS.md"), type: "file", hash: "sha256:0" }] }));

    const r = await rx(["stale", "--preset", preset, "--json"], { cwd: local });
    assert.equal(r.code, 1, r.stdout);
    const classes = Object.fromEntries(r.json.data.files.map((/** @type {any} */ f) => [f.path, f.class]));
    assert.equal(classes["AGENTS.md"], "REMOVE");
    assert.equal(classes["HANDOFF.md"], "REMOVE");
    assert.equal(classes[".claude/settings.json"], "REMOVE", "a path under a listed directory");
    assert.equal(classes["src/gone.ts"], "ONLY-PUB", "an unlisted published-only path keeps its FAIL");
    const by = Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));
    assert.equal(by["stale-remove"].verdict, "WARN");
    assert.equal(by["stale-only-pub"].verdict, "FAIL");
    assert.deepEqual(by["stale-only-pub"].details.map((/** @type {any} */ d) => d.file), ["src/gone.ts"]);
    const notes = Object.fromEntries(by["stale-remove"].details.map((/** @type {any} */ d) => [d.file, d.text]));
    assert.match(notes["AGENTS.md"], /^REMOVE local-only \(AGENTS\.md in the preset's holdout\.localOnly\), held out by rx holdout; publishing deletes the published copy$/);
    assert.match(notes["HANDOFF.md"], /absent locally/);
    const agents = r.json.data.files.find((/** @type {any} */ f) => f.path === "AGENTS.md");
    assert.equal(agents.localHash, null);
    assert.match(agents.publishedHash, /^[0-9a-f]{40}$/);

    const bare = await rx(["stale", "--json"], { cwd: local });
    assert.equal(bare.code, 1);
    assert.ok(bare.json.data.files.filter((/** @type {any} */ f) => f.path !== "src/index.tsx" && f.class !== "MINE").every((/** @type {any} */ f) => f.class === "ONLY-PUB"), "no preset, no REMOVE");
    assert.ok(!bare.json.results.some((/** @type {any} */ x) => x.id === "stale-remove"));
  });
});

test("stale: a published file the author deleted is DELETED (WARN) with or without --preset, and its required disposition is { path, \"absent\", baseline, DELETED } either way", async () => {
  await withTempDir(async (dir) => {
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const files = { ...extensionFiles("gamma"), ".eslintrc.json": "{ \"extends\": \"@raycast\" }\n" };
    const up = await fakeUpstream(dir, { gamma: files });
    _setUpstreamForTests({ url: up.url, probe: async () => true });
    const local = await initRepo(join(dir, "gamma"));
    await commit(local, files, "Initial fork commit");
    rmSync(join(local, ".eslintrc.json")); // the ESLint 9 migration, not committed yet
    const preset = join(dir, "preset.json");
    writeFileSync(preset, JSON.stringify({ schema: 1, owner: "octo-author", rules: [], holdout: { localOnly: ["AGENTS.md"] } }));
    for (const argv of [["stale", "--json"], ["stale", "--preset", preset, "--json"]]) {
      const r = await rx(argv, { cwd: local });
      assert.equal(r.code, 0, `${argv.join(" ")}: ${r.stdout}`);
      const by = Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));
      assert.equal(by["stale-deleted"].verdict, "WARN");
      assert.ok(!by["stale-only-pub"], "no FAIL");
      assert.deepEqual(staleDispositions(r.json.data).map((n) => ({ ...n })), [{ path: ".eslintrc.json", localHash: "absent", baseline: r.json.data.baseline, kind: "DELETED" }], argv.join(" "));
    }
  });
});

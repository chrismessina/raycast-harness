import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, realpathSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { PNG } from "pngjs";
import { rx, withTempDir } from "./helpers.mjs";
import { commit, fakeUpstream, g, initRepo, write } from "./upstream-fixtures.mjs";
import { setTransport } from "../src/pr/transport.mjs";
import { _setUpstreamForTests, blobId } from "../src/upstream.mjs";
import { PNG_SIGNATURE, buildChunk, insertChunk, readChunks } from "../src/png.mjs";
import { ensureSigningKey, signingKeyPaths } from "../src/signing-key.mjs";
import { writePublication } from "../src/publication.mjs";
import { _setInstallStopForTests } from "../src/post-merge/install.mjs";
import { _setBeforeSignForTests } from "../src/post-merge/commit.mjs";
import { unambiguousUrl } from "../src/post-merge/push.mjs";

// `rx post-merge` (docs/commands.md § rx post-merge), the validate phase and --dry-run. Every run
// uses a fake GitHub transport that throws on any request it does not expect, a fake
// raycast/extensions (a local bare repo fetched over file://) and temp XDG_CACHE_HOME and
// XDG_CONFIG_HOME. Nothing reaches github.com.

const NAME = "alpha";
const N = 4242;
const MERGE = "c0ffee".padEnd(40, "0");
const BASE = "d3".repeat(20);
const USER = "a1".repeat(20);
const BOT = "b2".repeat(20);
const USER2 = "f5".repeat(20);
const STEPS = ["post-merge-pr", "post-merge-rewrites", "post-merge-adopt", "post-merge-signing", "post-merge-commit", "post-merge-push"];

/** An 8-bit RGBA PNG. @param {[number, number, number, number]} [pixel] */
function png(pixel = [200, 100, 50, 255]) {
  const p = new PNG({ width: 4, height: 3 });
  for (let i = 0; i < 12; i++) p.data.set(pixel, i * 4);
  return PNG.sync.write(p, { colorType: 6, bitDepth: 8 });
}
const ICCP = buildChunk("iCCP", Buffer.concat([Buffer.from("test\0\0", "latin1"), Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])]));
const PRE_PNG = png();
// raycastbot's recompression: the same pixels, different metadata.
const POST_PNG = insertChunk(PRE_PNG, ICCP);
const PRE_CL = "# Alpha Changelog\n\n## [Initial Version] - {PR_MERGE_DATE}\n\n- First release\n";
const POST_CL = PRE_CL.replace("{PR_MERGE_DATE}", "2026-11-21");
const NEW_ENTRY = "## [Fix] - {PR_MERGE_DATE}\n\n- Fixed a thing\n\n";
const PRE = {
  "package.json": JSON.stringify({ name: NAME, title: "Alpha", commands: [{ name: "index", title: "Index", mode: "view" }] }, null, 2) + "\n",
  "CHANGELOG.md": PRE_CL,
  "metadata/x-1.png": PRE_PNG,
  "src/index.tsx": "export default function Command() {\n  return null;\n}\n",
};

/** @param {string} sha @param {string | null} login @param {string} parent */
const commitRow = (sha, login, parent) => ({ sha, author: login ? { login } : null, commit: { author: { name: login ?? "someone" } }, parents: [{ sha: parent }] });

/** Tree rows for a file map, directories included. @param {Record<string, string | Buffer>} files */
function treeRows(files) {
  /** @type {any[]} */
  const rows = [];
  const dirs = new Set();
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    rows.push({ path, mode: "100644", type: "blob", sha: blobId(Buffer.from(content)) });
  }
  for (const d of dirs) rows.push({ path: d, mode: "040000", type: "tree", sha: "e6".repeat(20) });
  return rows.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** @param {Record<string, string | Buffer | null>} files */
const present = (files) => /** @type {Record<string, string | Buffer>} */ (Object.fromEntries(Object.entries(files).filter(([, v]) => v !== null)));

/**
 * @typedef {{
 *   mono?: boolean, remote?: boolean, key?: "missing" | "registered" | "unregistered",
 *   post?: Record<string, string | Buffer | null>, upstream?: Record<string, string | Buffer | null>,
 *   bot?: Array<{ filename?: string, path?: string, status: string }>, rowSha?: Record<string, string>,
 *   commits?: any[], pull?: Record<string, unknown>, tree?: (which: "pre" | "post", body: any) => void,
 * }} FixtureOptions
 */

/**
 * The three parts: a committed local extension repo (the PR's state before raycastbot), a fake
 * upstream whose extensions/alpha holds the post state, and a fake transport.
 * @param {string} dir @param {FixtureOptions} o
 */
async function build(dir, o) {
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  const post = present({ ...PRE, "CHANGELOG.md": POST_CL, "metadata/x-1.png": POST_PNG, ...(o.post ?? {}) });
  const up = await fakeUpstream(dir, { [NAME]: present({ ...post, ...(o.upstream ?? {}) }) });
  _setUpstreamForTests({ url: up.url, probe: async (n) => n === NAME });

  const top = await initRepo(join(dir, "local"));
  const prefix = o.mono ? `extensions/${NAME}` : "";
  /** @type {Record<string, string | Buffer>} */
  const files = o.mono ? { "README.md": "# a monorepo\n" } : {};
  for (const [p, c] of Object.entries(PRE)) files[prefix ? `${prefix}/${p}` : p] = c;
  await commit(top, files, "alpha as submitted");
  // rx's own git calls read this repo's config: a fixed identity (commit-tree, allowed signers) and
  // hooks from .git/hooks whatever a global core.hooksPath says.
  await g(top, ["config", "user.name", "Fixture Author"]);
  await g(top, ["config", "user.email", "fixture@example.com"]);
  await g(top, ["config", "core.hooksPath", join(top, ".git", "hooks")]);
  const bare = join(dir, "remote.git");
  if (o.remote !== false) {
    await g(dir, ["init", "-q", "--bare", bare]);
    await g(top, ["remote", "add", "origin", bare]);
    await g(top, ["push", "-q", "-u", "origin", "main"]);
  }

  let publicKey = null;
  if (o.key === "registered" || o.key === "unregistered") publicKey = (await ensureSigningKey()).publicKey;
  const keys = o.key === "registered" ? [{ id: 1, key: `${publicKey}` }] : [{ id: 1, key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOther" }];

  const bot = o.bot ?? [{ path: "CHANGELOG.md", status: "modified" }, { path: "metadata/x-1.png", status: "modified" }];
  const preTree = { tree: treeRows(present(PRE)), truncated: false };
  const postTree = { tree: treeRows(post), truncated: false };
  o.tree?.("pre", preTree);
  o.tree?.("post", postTree);
  const R = "repos/raycast/extensions";
  /** @type {Record<string, unknown>} */
  const json = {
    [`${R}/pulls/${N}`]: { number: N, state: "closed", merged_at: "2026-11-21T18:04:00Z", merge_commit_sha: MERGE, head: { ref: `ext/${NAME}`, sha: BOT }, ...(o.pull ?? {}) },
    [`${R}/commits/${BOT}`]: {
      sha: BOT,
      files: bot.map((f) => ({ filename: f.filename ?? `extensions/${NAME}/${f.path}`, status: f.status, sha: o.rowSha?.[f.path ?? ""] ?? (f.path && post[f.path] !== undefined ? blobId(Buffer.from(post[f.path])) : "00".repeat(20)) })),
    },
    [`${R}/git/trees/${USER}:extensions/${NAME}?recursive=1`]: preTree,
    [`${R}/git/trees/${BOT}:extensions/${NAME}?recursive=1`]: postTree,
    user: { login: "chris" },
  };
  /** @type {Record<string, unknown[]>} */
  const pages = {
    [`${R}/pulls/${N}/commits?per_page=100`]: o.commits ?? [commitRow(USER, "chris", BASE), commitRow(BOT, "raycastbot", USER)],
    "users/chris/ssh_signing_keys?per_page=100": keys,
  };
  /** @type {string[]} */
  const calls = [];
  const unexpected = (/** @type {string} */ what) => async () => { throw new Error(`unexpected ${what}`); };
  const t = {
    /** @param {string} path */
    async getJson(path) {
      calls.push(path);
      if (path in json) return structuredClone(json[path]);
      throw new Error(`unexpected GET ${path}`);
    },
    /** @param {string} path */
    async getJsonPages(path) {
      calls.push(path);
      if (path in pages) return structuredClone(pages[path]);
      throw new Error(`unexpected paginated GET ${path}`);
    },
    getRaw: unexpected("RAW"),
    getConditional: unexpected("conditional GET"),
    graphql: unexpected("graphql"),
    patch: unexpected("PATCH"),
  };
  return { dir, top, prefix, root: prefix ? join(top, prefix) : top, post, up, bare, t, calls, publicKey };
}

/**
 * @template T
 * @param {FixtureOptions} o @param {(fx: Awaited<ReturnType<typeof build>>) => Promise<T>} fn
 */
async function withFixture(o, fn) {
  return withTempDir(async (dir) => {
    const saved = { cache: process.env.XDG_CACHE_HOME, config: process.env.XDG_CONFIG_HOME, agent: process.env.SSH_AUTH_SOCK };
    delete process.env.SSH_AUTH_SOCK;
    /** @type {any} */
    let prev = null;
    try {
      const fx = await build(dir, o);
      prev = setTransport(/** @type {any} */ (fx.t));
      return await fn(fx);
    } finally {
      if (prev) setTransport(prev);
      _setUpstreamForTests({ url: null, probe: null });
      _setInstallStopForTests(null);
      _setBeforeSignForTests(null);
      for (const [k, v] of /** @type {const} */ ([["XDG_CACHE_HOME", saved.cache], ["XDG_CONFIG_HOME", saved.config], ["SSH_AUTH_SOCK", saved.agent]])) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
}

/** @param {{ root: string }} fx @param {string[]} [argv] */
async function pm(fx, argv = [String(N), "--dry-run"]) {
  const r = await rx(["post-merge", ...argv, "--json"], { cwd: fx.root });
  assert.ok(r.json, `no JSON: ${r.stdout}${r.stderr}`);
  /** @type {Record<string, any>} */
  const by = Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));
  // Every run reports each of the six step ids exactly once; the only other id is an ERROR before
  // step 1 (args, input or root).
  const ids = r.json.results.map((/** @type {any} */ x) => x.id);
  for (const id of STEPS) assert.equal(ids.filter((/** @type {string} */ i) => i === id).length, 1, `${id} reported once: ${r.stdout}`);
  for (const x of r.json.results.filter((/** @type {any} */ x) => !STEPS.includes(x.id))) {
    assert.equal(x.verdict, "ERROR", r.stdout);
    assert.ok(["args", "input", "root"].includes(x.id), r.stdout);
  }
  return { ...r, by, data: r.json.data };
}

/**
 * The ERROR a step reports when it throws: under its own id, the message led by the underlying id.
 * @param {any} r @param {string} step @param {string} cause
 */
function stepError(r, step, cause) {
  const err = r.by[step];
  assert.equal(err?.verdict, "ERROR", `${step}: ${JSON.stringify(err)}`);
  assert.ok(err.message.startsWith(`${cause}: `), err.message);
  return err;
}

/** @param {any} by @param {string[]} ids @param {string} why */
function assertNotReached(by, ids, why) {
  for (const id of ids) {
    assert.equal(by[id]?.verdict, "N/A", `${id}: ${JSON.stringify(by[id])}`);
    assert.equal(by[id].message, `not reached: ${why}`);
  }
}

/** @param {any} r @param {string} path */
const fileRow = (r, path) => r.data.files.find((/** @type {any} */ f) => f.path === path);

/** Everything a dry run must leave as it was. @param {string} top */
async function snapshot(top) {
  /** @type {Record<string, string>} */
  const files = {};
  const walk = (/** @type {string} */ rel) => {
    for (const e of readdirSync(join(top, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (p === ".git") continue;
      const st = lstatSync(join(top, p));
      if (st.isDirectory()) walk(p);
      else files[p] = `${st.mode.toString(8)} ${st.isSymbolicLink() ? readlinkSync(join(top, p)) : readFileSync(join(top, p)).toString("base64")}`;
    }
  };
  walk("");
  return {
    files,
    gitDir: readdirSync(join(top, ".git")).sort(),
    index: readFileSync(join(top, ".git", "index")).toString("base64"),
    refs: (await g(top, ["for-each-ref", "--format=%(refname) %(objectname)"])).stdout,
    head: `${(await g(top, ["symbolic-ref", "-q", "HEAD"], { allowFail: true })).stdout} ${(await g(top, ["rev-parse", "HEAD"])).stdout}`,
    objects: (await g(top, ["count-objects", "-v"])).stdout,
  };
}

// ---- --dry-run end to end ----------------------------------------------------------------------

test("dry run, standalone: ADOPT both files, the planned commit and push, and nothing in the checkout changes", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const before = await snapshot(fx.top);
    const r = await pm(fx);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["post-merge-pr"].verdict, "PASS");
    assert.equal(r.by["post-merge-pr"].message, `#${N} merged 2026-11-21T18:04:00Z as c0ffee0`);
    assert.equal(r.by["post-merge-rewrites"].message, "raycastbot's 1 commit(s) rewrote 2 file(s)");
    assert.deepEqual(r.by["post-merge-rewrites"].details.map((/** @type {any} */ d) => d.text), [
      `${blobId(Buffer.from(PRE_CL)).slice(0, 7)} → ${blobId(Buffer.from(POST_CL)).slice(0, 7)}`,
      `${blobId(PRE_PNG).slice(0, 7)} → ${blobId(POST_PNG).slice(0, 7)}`,
    ]);
    assert.equal(r.by["post-merge-adopt"].verdict, "PASS");
    assert.equal(r.by["post-merge-adopt"].message, "2 to adopt, 0 to stamp, 0 already adopted");
    assert.equal(fileRow(r, "metadata/x-1.png").outcome, "ADOPT");
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "ADOPT");
    assert.equal(r.by["post-merge-signing"].verdict, "PASS");
    assert.equal(r.by["post-merge-signing"].message, `signing with ${signingKeyPaths().publicKey} (registered on GitHub as chris's signing key)`);
    assert.equal(r.by["post-merge-commit"].verdict, "PASS");
    assert.equal(r.by["post-merge-commit"].message, "would commit on main: 2 file(s)");
    assert.deepEqual(r.by["post-merge-commit"].details.map((/** @type {any} */ d) => d.text), [
      `Adopt raycastbot's merge-time rewrites of #${N}`,
      "",
      "raycastbot rewrote these files on ext/alpha before the squash (c0ffee0):",
      "- CHANGELOG.md",
      "- metadata/x-1.png",
    ]);
    assert.equal(r.by["post-merge-push"].verdict, "PASS");
    assert.equal(r.by["post-merge-push"].message, `would push to ${fx.bare} refs/heads/main`);
    assert.equal(r.data.dryRun, true);
    assert.equal(r.data.commit, null);
    assert.equal(r.data.pushed, null);
    assert.equal(r.data.branch, "main");
    assert.equal(r.data.mergeCommit, MERGE);
    assert.deepEqual(r.data.rewrites, [{ sha: BOT, files: ["CHANGELOG.md", "metadata/x-1.png"] }]);
    assert.deepEqual(r.data.signingKey, { path: signingKeyPaths().privateKey, created: false, registered: true });
    assert.deepEqual(await snapshot(fx.top), before);
  });
});

test("dry run, monorepo: STAMP keeps an unstaged new entry, paths are repository-relative, and nothing changes", async () => {
  await withFixture({ mono: true, key: "registered" }, async (fx) => {
    write(fx.root, { "CHANGELOG.md": PRE_CL.replace("## [Initial", `${NEW_ENTRY}## [Initial`) });
    const before = await snapshot(fx.top);
    const r = await pm(fx);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "STAMP");
    assert.equal(fileRow(r, "metadata/x-1.png").outcome, "ADOPT");
    assert.equal(r.by["post-merge-adopt"].message, "1 to adopt, 1 to stamp, 0 already adopted");
    assert.deepEqual(r.by["post-merge-commit"].details.slice(3).map((/** @type {any} */ d) => d.text), ["- extensions/alpha/CHANGELOG.md", "- extensions/alpha/metadata/x-1.png"]);
    assert.equal(r.by["post-merge-push"].message, `would push to ${fx.bare} refs/heads/main`);
    assert.deepEqual(await snapshot(fx.top), before);
  });
});

test("post-merge-push: no upstream branch is N/A; a branch ahead of its tip is WARN with each other commit", async () => {
  await withFixture({ remote: false }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.by["post-merge-push"].verdict, "N/A");
    assert.equal(r.by["post-merge-push"].message, "main has no upstream branch; push it yourself");
  });
  await withFixture({}, async (fx) => {
    await commit(fx.top, { "src/other.ts": "export {};\n" }, "unpushed work");
    const r = await pm(fx);
    assert.equal(r.by["post-merge-push"].verdict, "WARN");
    assert.equal(r.by["post-merge-push"].message, "main has 1 other unpushed commit(s); not pushed, so nothing else leaves without you");
    assert.match(r.by["post-merge-push"].details[0].text, /^[0-9a-f]{7} unpushed work$/);
  });
});

// ---- post-merge-pr -----------------------------------------------------------------------------

test("post-merge-pr: open → N/A, exit 0, every later check not reached", async () => {
  await withFixture({ pull: { state: "open", merged_at: null, merge_commit_sha: null } }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.code, 0);
    assert.equal(r.by["post-merge-pr"].verdict, "N/A");
    assert.equal(r.by["post-merge-pr"].message, `#${N} is open, not merged; nothing to clean up`);
    assertNotReached(r.by, STEPS.slice(1), "post-merge-pr found no merge");
    assert.equal(r.data.merged, false);
  });
});

test("post-merge-pr: closed without merging → N/A", async () => {
  await withFixture({ pull: { state: "closed", merged_at: null, merge_commit_sha: null } }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.code, 0);
    assert.equal(r.by["post-merge-pr"].message, `#${N} was closed without merging`);
    assertNotReached(r.by, STEPS.slice(1), "post-merge-pr found no merge");
  });
});

test("post-merge-pr: another extension's head ref → FAIL", async () => {
  await withFixture({ pull: { head: { ref: "ext/beta", sha: BOT } } }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.code, 1);
    assert.equal(r.by["post-merge-pr"].verdict, "FAIL");
    assert.equal(r.by["post-merge-pr"].message, `#${N} is ext/beta, not this extension's PR`);
    assertNotReached(r.by, STEPS.slice(1), "post-merge-pr did not pass");
  });
});

test("the pull request number: none and no record → ERROR input; a raycast/extensions record supplies it; a bad positional → ERROR args", async () => {
  await withFixture({}, async (fx) => {
    let r = await pm(fx, ["--dry-run"]);
    assert.equal(r.code, 2);
    const err = r.json.results.find((/** @type {any} */ x) => x.verdict === "ERROR");
    assert.equal(err.id, "input");
    assert.equal(err.message, "no pull request given and no publication record for raycast/extensions; pass the number");
    assertNotReached(r.by, STEPS, "input did not pass");

    await writePublication(fx.root, { repo: "someone/extensions", pr: N, remoteSha: USER, at: "2026-11-20T10:00:00Z" });
    r = await pm(fx, ["--dry-run"]);
    assert.equal(r.json.results.find((/** @type {any} */ x) => x.verdict === "ERROR").id, "input");

    await writePublication(fx.root, { repo: "raycast/extensions", pr: N, remoteSha: USER, at: "2026-11-20T10:00:00Z" });
    r = await pm(fx, ["--dry-run"]);
    assert.equal(r.data.pr, N);
    assert.equal(r.by["post-merge-pr"].verdict, "PASS");
    assert.equal(r.by["post-merge-rewrites"].verdict, "PASS");

    for (const bad of ["abc", "0", "007"]) {
      r = await pm(fx, [bad, "--dry-run"]);
      assert.equal(r.code, 2);
      assert.equal(r.json.results[0].id, "args", bad);
      assertNotReached(r.by, STEPS, "args did not pass");
    }
    // "-3" is an unknown flag to the argument parser, which rejects it before the command runs:
    // the one ERROR args line is all there is.
    const flag = await rx(["post-merge", "-3", "--dry-run", "--json"], { cwd: fx.root });
    assert.equal(flag.code, 2);
    assert.deepEqual(flag.json.results.map((/** @type {any} */ x) => [x.verdict, x.id]), [["ERROR", "args"]]);
  });
});

// ---- post-merge-rewrites -----------------------------------------------------------------------

test("post-merge-rewrites: no raycastbot commits → PASS with an empty set, then nothing to adopt, after the cache refresh", async () => {
  await withFixture({ commits: [commitRow(USER, "chris", BASE)] }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["post-merge-rewrites"].verdict, "PASS");
    assert.equal(r.by["post-merge-rewrites"].message, `raycastbot rewrote nothing on #${N}`);
    assert.equal(r.by["post-merge-adopt"].verdict, "PASS");
    assert.equal(r.by["post-merge-adopt"].message, "nothing to adopt");
    assert.equal(r.by["post-merge-signing"].message, "nothing to commit");
    assert.equal(r.by["post-merge-commit"].message, "nothing to commit");
    assert.equal(r.by["post-merge-push"].message, "nothing committed");
    assert.deepEqual(r.data.files, []);
    assert.equal(existsSync(join(fx.dir, "cache", "raycast-harness", "upstream", "extensions", NAME)), true, "the published copy was refreshed");
  });
});

test("post-merge-adopt: with an empty set, a failed refresh of the published copy is ERROR post-merge-adopt", async () => {
  await withFixture({ commits: [commitRow(USER, "chris", BASE)] }, async (fx) => {
    _setUpstreamForTests({ url: `file://${join(fx.dir, "no-such-upstream.git")}` });
    const r = await pm(fx);
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.by["post-merge-rewrites"].verdict, "PASS");
    stepError(r, "post-merge-adopt", "github");
    assertNotReached(r.by, STEPS.slice(3), "post-merge-adopt did not pass");
  });
});

test("post-merge-rewrites: the record's remoteSha is not the commit before raycastbot's → FAIL", async () => {
  await withFixture({}, async (fx) => {
    await writePublication(fx.root, { repo: "raycast/extensions", pr: N, remoteSha: "e4".repeat(20), at: "2026-11-20T10:00:00Z" });
    const r = await pm(fx);
    assert.equal(r.code, 1);
    assert.equal(r.by["post-merge-rewrites"].verdict, "FAIL");
    assert.equal(r.by["post-merge-rewrites"].message, `#${N}'s last commit before raycastbot's is a1a1a1a, but rx recorded e4e4e4e: something else pushed to ext/alpha`);
    assertNotReached(r.by, STEPS.slice(2), "post-merge-rewrites did not pass");
  });
});

test("post-merge-rewrites: a raycastbot commit followed by someone else's → FAIL", async () => {
  await withFixture({ commits: [commitRow(USER, "chris", BASE), commitRow(BOT, "raycastbot", USER), commitRow(USER2, "chris", BOT)] }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.by["post-merge-rewrites"].verdict, "FAIL");
    assert.equal(r.by["post-merge-rewrites"].message, "raycastbot's b2b2b2b is followed by f5f5f5f from chris; adopt by hand");
  });
});

test("post-merge-rewrites: a file outside the extension, or a removed file → FAIL, one detail per row", async () => {
  await withFixture({ bot: [{ path: "CHANGELOG.md", status: "modified" }, { filename: "extensions/beta/CHANGELOG.md", status: "modified" }] }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.by["post-merge-rewrites"].verdict, "FAIL");
    assert.deepEqual(r.by["post-merge-rewrites"].details.map((/** @type {any} */ d) => d.text), ["modified: rx adopts only files raycastbot modified or added inside the extension"]);
  });
  await withFixture({ bot: [{ path: "CHANGELOG.md", status: "removed" }] }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.by["post-merge-rewrites"].verdict, "FAIL");
    assert.deepEqual(r.by["post-merge-rewrites"].details.map((/** @type {any} */ d) => d.text), ["removed: rx adopts only files raycastbot modified or added inside the extension"]);
  });
});

test("post-merge-rewrites: a truncated tree listing → ERROR github", async () => {
  await withFixture({ tree: (which, body) => { if (which === "post") body.truncated = true; } }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.code, 2);
    const err = stepError(r, "post-merge-rewrites", "github");
    assert.match(err.message, /truncated/);
    assertNotReached(r.by, STEPS.slice(2), "post-merge-rewrites did not pass");
  });
});

test("post-merge-rewrites: a post blob that differs from raycastbot's row sha → ERROR github", async () => {
  await withFixture({ rowSha: { "CHANGELOG.md": "9a".repeat(20) } }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.code, 2);
    const err = stepError(r, "post-merge-rewrites", "github");
    assert.match(err.message, /CHANGELOG\.md is [0-9a-f]{7} in the PR head's tree but 9a9a9a9/);
  });
});

// ---- post-merge-adopt --------------------------------------------------------------------------

/** @param {any} r @param {string} path @param {RegExp} reason */
function assertAdoptFail(r, path, reason) {
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.by["post-merge-adopt"].verdict, "FAIL");
  assert.equal(fileRow(r, path).outcome, "FAIL");
  assert.match(fileRow(r, path).reason, reason);
  assert.ok(r.by["post-merge-adopt"].details.some((/** @type {any} */ d) => d.file === path && d.text.startsWith("FAIL: ") && !d.text.startsWith(`FAIL: ${path} FAIL`)));
  assertNotReached(r.by, STEPS.slice(3), "post-merge-adopt did not pass");
}

test("post-merge-adopt: pub ≠ post → FAIL changed upstream after the merge", async () => {
  await withFixture({ upstream: { "CHANGELOG.md": `${POST_CL}\n- a later upstream edit\n` } }, async (fx) => {
    const r = await pm(fx);
    assertAdoptFail(r, "CHANGELOG.md", /^changed upstream after the merge$/);
    assert.deepEqual(r.by["post-merge-adopt"].details.filter((/** @type {any} */ d) => d.file === "CHANGELOG.md").map((/** @type {any} */ d) => d.text), ["FAIL: changed upstream after the merge", "run rx stale, then pull-contributions"]);
  });
});

test("post-merge-adopt: head = post → ALREADY, and nothing to commit", async () => {
  await withFixture({}, async (fx) => {
    await commit(fx.top, { "CHANGELOG.md": POST_CL, "metadata/x-1.png": POST_PNG }, "adopted by hand");
    const r = await pm(fx);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["post-merge-adopt"].message, "0 to adopt, 0 to stamp, 2 already adopted");
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "ALREADY");
    assert.equal(r.by["post-merge-signing"].message, "nothing to commit");
    assert.equal(r.by["post-merge-commit"].message, "nothing to commit");
  });
});

test("post-merge-adopt: ADOPT with index = pre and work = pre", async () => {
  await withFixture({}, async (fx) => {
    const r = await pm(fx);
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "ADOPT");
    assert.equal(fileRow(r, "CHANGELOG.md").work, blobId(Buffer.from(PRE_CL)));
  });
});

test("post-merge-adopt: ADOPT with index = pre and work = post", async () => {
  await withFixture({}, async (fx) => {
    write(fx.top, { "CHANGELOG.md": POST_CL });
    const r = await pm(fx);
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "ADOPT");
    assert.equal(fileRow(r, "CHANGELOG.md").work, blobId(Buffer.from(POST_CL)));
  });
});

test("post-merge-adopt: ADOPT with index = post and work = post", async () => {
  await withFixture({}, async (fx) => {
    write(fx.top, { "CHANGELOG.md": POST_CL });
    await g(fx.top, ["add", "CHANGELOG.md"]);
    const r = await pm(fx);
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "ADOPT");
    assert.equal(fileRow(r, "CHANGELOG.md").index, blobId(Buffer.from(POST_CL)));
  });
});

test("post-merge-adopt: index = post with work = pre (a deliberate unstaged revert) → FAIL", async () => {
  await withFixture({}, async (fx) => {
    write(fx.top, { "CHANGELOG.md": POST_CL });
    await g(fx.top, ["add", "CHANGELOG.md"]);
    write(fx.top, { "CHANGELOG.md": PRE_CL });
    assertAdoptFail(await pm(fx), "CHANGELOG.md", /^changed here since the merge: head 100644 [0-9a-f]{7}, index 100644 [0-9a-f]{7}, work 100644 [0-9a-f]{7}; adopt the published file by hand$/);
  });
});

test("post-merge-adopt: STAMP with an unstaged new top entry", async () => {
  await withFixture({}, async (fx) => {
    write(fx.top, { "CHANGELOG.md": PRE_CL.replace("## [Initial", `${NEW_ENTRY}## [Initial`) });
    const r = await pm(fx);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "STAMP");
  });
});

test("post-merge-adopt: STAMP on a re-run (stamped once, unstamped absent, index = pre)", async () => {
  await withFixture({}, async (fx) => {
    write(fx.top, { "CHANGELOG.md": POST_CL.replace("## [Initial", `${NEW_ENTRY}## [Initial`) });
    const r = await pm(fx);
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "STAMP");
  });
});

test("post-merge-adopt: HEAD at a third blob → FAIL changed here since the merge", async () => {
  await withFixture({}, async (fx) => {
    await commit(fx.top, { "CHANGELOG.md": `${PRE_CL}- Another line\n` }, "a later local edit");
    assertAdoptFail(await pm(fx), "CHANGELOG.md", /^changed here since the merge: head 100644 [0-9a-f]{7}, index 100644 [0-9a-f]{7}, work 100644 [0-9a-f]{7}; adopt/);
  });
});

test("post-merge-adopt: an executable bit on the work file → FAIL (neither ADOPT nor STAMP overwrites it)", async () => {
  await withFixture({}, async (fx) => {
    chmodSync(join(fx.top, "CHANGELOG.md"), 0o755);
    assertAdoptFail(await pm(fx), "CHANGELOG.md", /work 100755 /);
  });
});

test("post-merge-adopt: the work mode follows git (owner execute bit only), so group/other execute bits stay 100644", async () => {
  await withFixture({}, async (fx) => {
    chmodSync(join(fx.top, "CHANGELOG.md"), 0o654);
    const r = await pm(fx);
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "ADOPT", r.stdout);
  });
});

test("post-merge-adopt: an unreadable work file is ERROR git, and every check id is still reported", async () => {
  await withFixture({}, async (fx) => {
    chmodSync(join(fx.top, "CHANGELOG.md"), 0o000);
    try {
      const r = await pm(fx);
      assert.equal(r.code, 2);
      const err = stepError(r, "post-merge-adopt", "git");
      assert.match(err.message, /CHANGELOG\.md/);
      assertNotReached(r.by, STEPS.slice(3), "post-merge-adopt did not pass");
    } finally {
      chmodSync(join(fx.top, "CHANGELOG.md"), 0o644);
    }
  });
});

test("post-merge-adopt: a symlink, or a symlinked parent directory → FAIL", async () => {
  await withFixture({}, async (fx) => {
    rmSync(join(fx.top, "metadata", "x-1.png"));
    symlinkSync("../CHANGELOG.md", join(fx.top, "metadata", "x-1.png"));
    assertAdoptFail(await pm(fx), "metadata/x-1.png", /^metadata\/x-1\.png is a symlink; rx adopts only regular files$/);
  });
  await withFixture({}, async (fx) => {
    renameSync(join(fx.top, "metadata"), join(fx.top, "real-metadata"));
    symlinkSync("real-metadata", join(fx.top, "metadata"));
    assertAdoptFail(await pm(fx), "metadata/x-1.png", /parent directory metadata is a symlink/);
  });
});

test("post-merge-adopt: a git filter on the path → FAIL", async () => {
  await withFixture({}, async (fx) => {
    write(fx.top, { ".gitattributes": "CHANGELOG.md filter=upper\n" });
    await g(fx.top, ["config", "filter.upper.clean", "tr a-z A-Z"]);
    assertAdoptFail(await pm(fx), "CHANGELOG.md", /^CHANGELOG\.md has a git filter or line-ending conversion \(gitattributes or core\.autocrlf\); adopt it by hand$/);
  });
});

test("post-merge-adopt: raycastbot changed a PNG's pixels → FAIL", async () => {
  const changed = png([10, 20, 30, 255]);
  await withFixture({ post: { "metadata/x-1.png": changed } }, async (fx) => {
    assertAdoptFail(await pm(fx), "metadata/x-1.png", /^raycastbot changed the pixels of metadata\/x-1\.png$/);
  });
});

test("post-merge-adopt: a PNG raycastbot added (pre absent) is ADOPT when it decodes", async () => {
  await withFixture({ post: { "metadata/x-2.png": POST_PNG }, bot: [{ path: "CHANGELOG.md", status: "modified" }, { path: "metadata/x-2.png", status: "added" }] }, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(fileRow(r, "metadata/x-2.png").outcome, "ADOPT");
    assert.equal(fileRow(r, "metadata/x-2.png").pre, null);
    assert.match(r.by["post-merge-rewrites"].details.find((/** @type {any} */ d) => d.file === "metadata/x-2.png").text, /^new → [0-9a-f]{7}$/);
  });
});

test("post-merge-adopt: a PNG raycastbot added that does not decode → FAIL", async () => {
  // Well-formed chunks (readPngInfo accepts it) around an IDAT that does not inflate: only the
  // decode can catch it.
  const ihdr = readChunks(POST_PNG)[0].data;
  const broken = Buffer.concat([PNG_SIGNATURE, buildChunk("IHDR", ihdr), buildChunk("IDAT", Buffer.from("not deflate data")), buildChunk("IEND", Buffer.alloc(0))]);
  await withFixture({ post: { "metadata/x-2.png": broken }, bot: [{ path: "CHANGELOG.md", status: "modified" }, { path: "metadata/x-2.png", status: "added" }] }, async (fx) => {
    const r = await pm(fx);
    assertAdoptFail(r, "metadata/x-2.png", /^metadata\/x-2\.png: /);
    assert.equal(fileRow(r, "metadata/x-2.png").pre, null);
  });
});

test("post-merge-adopt: a merge in progress → FAIL", async () => {
  await withFixture({}, async (fx) => {
    writeFileSync(join(fx.top, ".git", "MERGE_HEAD"), `${(await g(fx.top, ["rev-parse", "HEAD"])).stdout}\n`);
    const r = await pm(fx);
    assert.equal(r.by["post-merge-adopt"].verdict, "FAIL");
    assert.equal(r.by["post-merge-adopt"].message, "a merge is in progress; finish it first");
    assertNotReached(r.by, STEPS.slice(3), "post-merge-adopt did not pass");
  });
});

test("post-merge-adopt: a detached HEAD → FAIL", async () => {
  await withFixture({}, async (fx) => {
    await g(fx.top, ["checkout", "-q", "--detach"]);
    const r = await pm(fx);
    assert.equal(r.by["post-merge-adopt"].verdict, "FAIL");
    assert.equal(r.by["post-merge-adopt"].message, "HEAD is detached; check out the branch to clean up");
  });
});

// ---- post-merge-signing ------------------------------------------------------------------------

test("post-merge-signing: --dry-run with no key → WARN would create, and no file is created", async () => {
  await withFixture({}, async (fx) => {
    const r = await pm(fx);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["post-merge-signing"].verdict, "WARN");
    assert.equal(r.by["post-merge-signing"].message, `would create the rx signing key at ${signingKeyPaths().privateKey}`);
    assert.equal(r.by["post-merge-commit"].verdict, "PASS");
    assert.deepEqual(r.data.signingKey, { path: signingKeyPaths().privateKey, created: false, registered: null });
    assert.equal(existsSync(join(fx.dir, "config")), false);
    assert.ok(!fx.calls.includes("user"), "no registration lookup for a key that does not exist");
  });
});

test("post-merge-signing: a key GitHub does not list → FAIL with the two gh commands and the allowed-signers line", async () => {
  await withFixture({ key: "unregistered" }, async (fx) => {
    await g(fx.top, ["config", "user.email", "me@example.com"]);
    const r = await pm(fx);
    assert.equal(r.code, 1);
    assert.equal(r.by["post-merge-signing"].verdict, "FAIL");
    assert.equal(r.by["post-merge-signing"].message, "the rx signing key is not registered on GitHub as a signing key; run these yourself in a terminal (an agent cannot: the first is interactive, and rx guard blocks commands that name the key's path)");
    assert.deepEqual(r.by["post-merge-signing"].details.map((/** @type {any} */ d) => d.text), [
      "gh auth refresh -h github.com -s admin:ssh_signing_key",
      `gh ssh-key add ${signingKeyPaths().publicKey} --type signing --title "rx post-merge signing"`,
      `optional, so git log --show-signature verifies it locally: add "me@example.com ${fx.publicKey}" to the file gpg.ssh.allowedSignersFile names`,
    ]);
    assertNotReached(r.by, STEPS.slice(4), "post-merge-signing did not pass");
  });
});

test("signing-key: one of the two key files missing → ERROR signing-key", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    rmSync(signingKeyPaths().publicKey);
    const r = await pm(fx);
    assert.equal(r.code, 2);
    const err = stepError(r, "post-merge-signing", "signing-key");
    assert.match(err.message, /fix or remove it by hand/);
    assertNotReached(r.by, STEPS.slice(4), "post-merge-signing did not pass");
  });
});

// ---- without --dry-run: Sign, Install, push -----------------------------------------------------

const APPLY = [String(N)];
const STAMPED_DISK = PRE_CL.replace("## [Initial", `${NEW_ENTRY}## [Initial`).replace("[Initial Version] - {PR_MERGE_DATE}", "[Initial Version] - 2026-11-21");

/** @param {{ top: string }} fx @param {string} rev */
const rev = async (fx, rev) => (await g(fx.top, ["rev-parse", rev])).stdout;
/** @param {{ bare: string }} fx */
const remoteMain = async (fx) => (await g(fx.bare, ["rev-parse", "refs/heads/main"])).stdout;
/** The parts of a snapshot that must stay byte-identical when objects may be added. @param {string} top */
async function checkout(top) {
  const { objects: _objects, ...rest } = await snapshot(top);
  return rest;
}
/** What a finished install leaves: HEAD's tree, the index entries, the adopted files' bytes. @param {{ top: string }} fx */
async function endState(fx) {
  return {
    tree: await rev(fx, "HEAD^{tree}"),
    index: (await g(fx.top, ["ls-files", "-s"])).stdout,
    disk: ["CHANGELOG.md", "metadata/x-1.png"].map((p) => readFileSync(join(fx.top, p)).toString("base64")),
  };
}
/** @param {string} path @param {string} body */
function script(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test("apply: the commit is rx-signed and verifies despite a broken gpg.ssh.program and another user.signingkey; the push sends no tag and moves no tracking ref", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    script(join(fx.dir, "broken-signer"), "exit 1");
    await g(fx.top, ["config", "gpg.ssh.program", join(fx.dir, "broken-signer")]);
    await g(fx.top, ["config", "user.signingkey", join(fx.dir, "not-a-key")]);
    await g(fx.top, ["config", "gpg.format", "openpgp"]);
    await g(fx.top, ["tag", "-a", "v1", "-m", "a local tag"]);
    await g(fx.top, ["config", "push.followTags", "true"]);
    const oldHead = await rev(fx, "HEAD");
    const tracking = await rev(fx, "refs/remotes/origin/main");

    const r = await pm(fx, APPLY);
    assert.equal(r.code, 0, r.stdout);
    const sha = await rev(fx, "HEAD");
    assert.equal(r.data.commit, sha);
    assert.equal(r.by["post-merge-commit"].message, `committed ${sha.slice(0, 7)} on main: 2 file(s)`);
    assert.deepEqual(r.by["post-merge-commit"].details.map((/** @type {any} */ d) => [d.file, d.text]), [["CHANGELOG.md", "ADOPT"], ["metadata/x-1.png", "ADOPT"]]);
    assert.equal(r.by["post-merge-push"].message, `pushed ${sha.slice(0, 7)} to ${fx.bare} refs/heads/main`);
    assert.deepEqual(r.data.pushed, { remote: "origin", branch: "refs/heads/main" });
    assert.equal(await rev(fx, "HEAD^"), oldHead);
    assert.equal((await g(fx.top, ["log", "-1", "--format=%s"])).stdout, `Adopt raycastbot's merge-time rewrites of #${N}`);
    assert.equal((await g(fx.top, ["cat-file", "blob", "HEAD:CHANGELOG.md"])).stdout, POST_CL.replace(/\n$/, ""));
    assert.equal(blobId(readFileSync(join(fx.top, "metadata", "x-1.png"))), blobId(POST_PNG));

    const allowed = join(fx.dir, "allowed_signers");
    writeFileSync(allowed, `fixture@example.com ${fx.publicKey}\n`);
    const verify = await g(fx.top, ["-c", `gpg.ssh.allowedSignersFile=${allowed}`, "-c", "gpg.ssh.program=ssh-keygen", "verify-commit", sha], { allowFail: true });
    assert.equal(verify.code, 0, verify.stderr);

    assert.equal(await remoteMain(fx), sha);
    assert.equal((await g(fx.bare, ["tag", "-l"])).stdout, "", "no tag was sent");
    // rx moves no remote-tracking ref itself. Some git versions (Homebrew's on GitHub's runners, not
    // Apple's 2.54) update it to the pushed commit when the push URL is the remote's own URL; that
    // records where the remote now is. Anything else would be wrong.
    const after = await rev(fx, "refs/remotes/origin/main");
    assert.ok(after === tracking || after === sha, `the tracking ref is unchanged or at the pushed commit, not ${after}`);
  });
});

test("apply: a signing failure is ERROR git and leaves the working tree, the index and every ref byte-identical", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const before = await checkout(fx.top);
    _setBeforeSignForTests(() => writeFileSync(signingKeyPaths().privateKey, "not a key\n"));
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 2);
    const err = stepError(r, "post-merge-commit", "git");
    assert.match(err.message, /commit-tree/);
    assertNotReached(r.by, ["post-merge-push"], "post-merge-commit did not pass");
    assert.deepEqual(await checkout(fx.top), before);
  });
});

test("apply: a dirty tree is preserved: staged, unstaged and untracked work stay exactly so", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    write(fx.top, { "src/staged.ts": "export const staged = 1;\n" });
    await g(fx.top, ["add", "src/staged.ts"]);
    write(fx.top, { "src/index.tsx": "// an unstaged edit\n", "notes.txt": "untracked\n" });
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 0, r.stdout);
    assert.equal((await g(fx.top, ["diff", "--cached", "--name-only"])).stdout, "src/staged.ts");
    assert.equal((await g(fx.top, ["diff", "--name-only"])).stdout, "src/index.tsx");
    assert.equal((await g(fx.top, ["ls-files", "--others", "--exclude-standard"])).stdout, "notes.txt");
    assert.equal((await g(fx.top, ["ls-tree", "--name-only", "HEAD", "src/"])).stdout, "src/index.tsx");
    assert.equal(readFileSync(join(fx.top, "src", "index.tsx"), "utf8"), "// an unstaged edit\n");
    // Exact bytes, not just paths: the staged blob, the staged file on disk, the untracked file.
    assert.equal((await g(fx.top, ["cat-file", "blob", ":src/staged.ts"])).stdout, "export const staged = 1;");
    assert.equal((await g(fx.top, ["rev-parse", ":src/staged.ts"])).stdout, blobId(Buffer.from("export const staged = 1;\n")));
    assert.equal(readFileSync(join(fx.top, "src", "staged.ts"), "utf8"), "export const staged = 1;\n");
    assert.equal(readFileSync(join(fx.top, "notes.txt"), "utf8"), "untracked\n");
    assert.equal((await g(fx.top, ["rev-parse", ":src/index.tsx"])).stdout, blobId(Buffer.from(PRE["src/index.tsx"])), "the unstaged edit stays out of the index");
  });
});

test("apply: STAMP commits post exactly, stages post, and keeps the new entry unstaged on disk with the heading stamped", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    write(fx.top, { "CHANGELOG.md": PRE_CL.replace("## [Initial", `${NEW_ENTRY}## [Initial`) });
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(fileRow(r, "CHANGELOG.md").outcome, "STAMP");
    assert.equal((await g(fx.top, ["rev-parse", "HEAD:CHANGELOG.md"])).stdout, blobId(Buffer.from(POST_CL)));
    assert.equal((await g(fx.top, ["rev-parse", ":CHANGELOG.md"])).stdout, blobId(Buffer.from(POST_CL)));
    assert.equal(readFileSync(join(fx.top, "CHANGELOG.md"), "utf8"), STAMPED_DISK);
    assert.equal((await g(fx.top, ["diff", "--name-only"])).stdout, "CHANGELOG.md");
  });
});

test("apply: a run stopped at install step 3, 4, 5 or 6 converges on re-run to the uninterrupted end state", async () => {
  const stamp = (/** @type {any} */ fx) => write(fx.top, { "CHANGELOG.md": PRE_CL.replace("## [Initial", `${NEW_ENTRY}## [Initial`) });
  const expected = await withFixture({ key: "registered" }, async (fx) => {
    stamp(fx);
    assert.equal((await pm(fx, APPLY)).code, 0);
    return endState(fx);
  });
  for (const step of /** @type {const} */ ([3, 4, 5, 6])) {
    await withFixture({ key: "registered" }, async (fx) => {
      stamp(fx);
      _setInstallStopForTests(step);
      const first = await rx(["post-merge", ...APPLY, "--json"], { cwd: fx.root });
      assert.equal(first.code, 2, `step ${step}: ${first.stdout}`);
      _setInstallStopForTests(null);
      const lock = join(fx.top, ".git", "index.lock");
      // A killed run leaves git's lock behind until step 5 renames it; the user removes it.
      assert.equal(existsSync(lock), step !== 6, `step ${step}: index.lock`);
      rmSync(lock, { force: true });
      const again = await pm(fx, APPLY);
      assert.equal(again.code, 0, `step ${step}: ${again.stdout}`);
      assert.deepEqual(await endState(fx), expected, `step ${step}`);
    });
  }
});

test("apply: a failure rx catches during install removes its lock and is ERROR git; the index is unchanged", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const index = readFileSync(join(fx.top, ".git", "index"));
    _setInstallStopForTests(4, () => { throw new Error("disk full (test)"); });
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 2);
    assert.match(stepError(r, "post-merge-commit", "git").message, /^git: install failed before writing any file: disk full/);
    assert.equal(existsSync(join(fx.top, ".git", "index.lock")), false);
    assert.ok(readFileSync(join(fx.top, ".git", "index")).equals(index));
    assert.equal(readdirSync(join(fx.top, ".git")).filter((n) => n.startsWith("rx-post-merge-")).length, 0);
  });
});

test("apply: an existing index.lock → FAIL, nothing written, and the lock is left alone", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const lock = join(realpathSync(fx.top), ".git", "index.lock");
    writeFileSync(lock, "held by someone else\n");
    const before = await checkout(fx.top);
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 1);
    assert.equal(r.by["post-merge-commit"].verdict, "FAIL");
    assert.equal(r.by["post-merge-commit"].message, `another git process holds the index lock (${lock}); run again when it finishes`);
    assertNotReached(r.by, ["post-merge-push"], "post-merge-commit did not pass");
    assert.equal(readFileSync(lock, "utf8"), "held by someone else\n");
    assert.deepEqual(await checkout(fx.top), before);
  });
});

test("apply: a change between validation and install → FAIL, nothing written", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const head = await rev(fx, "HEAD");
    const index = readFileSync(join(fx.top, ".git", "index"));
    _setInstallStopForTests("before-1", () => write(fx.top, { "CHANGELOG.md": `${PRE_CL}- an edit while rx ran\n` }));
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 1);
    assert.equal(r.by["post-merge-commit"].message, "CHANGELOG.md changed while rx ran; nothing was written");
    assert.equal(await rev(fx, "HEAD"), head);
    assert.ok(readFileSync(join(fx.top, ".git", "index")).equals(index));
    assert.equal(readFileSync(join(fx.top, "metadata", "x-1.png")).equals(PRE_PNG), true);
    assert.equal(existsSync(join(fx.top, ".git", "index.lock")), false);
  });
});

test("apply: update-ref refuses when the branch moved → FAIL", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    _setInstallStopForTests(6, async () => {
      const moved = (await g(fx.top, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "moved meanwhile"])).stdout;
      await g(fx.top, ["update-ref", "refs/heads/main", moved]);
    });
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 1);
    assert.equal(r.by["post-merge-commit"].message, "main moved while rx ran");
    assert.equal((await g(fx.top, ["log", "-1", "--format=%s"])).stdout, "moved meanwhile");
  });
});

test("apply: update-ref failing on a held ref lock, with the ref unmoved, is ERROR git, not the moved FAIL", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const head = await rev(fx, "HEAD");
    const refLock = join(fx.top, ".git", "refs", "heads", "main.lock");
    _setInstallStopForTests(6, () => writeFileSync(refLock, ""));
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 2, r.stdout);
    const err = stepError(r, "post-merge-commit", "git");
    assert.match(JSON.stringify(err), /update-ref refs\/heads\/main failed: .*main\.lock/);
    assert.ok(!r.json.results.some((/** @type {any} */ x) => x.message === "main moved while rx ran"));
    assert.equal(await rev(fx, "HEAD"), head);
    rmSync(refLock);
  });
});

test("apply: a failure after the first file is written names it, removes the lock, keeps the index; a re-run converges", async () => {
  const expected = await withFixture({ key: "registered" }, async (fx) => {
    assert.equal((await pm(fx, APPLY)).code, 0);
    return endState(fx);
  });
  await withFixture({ key: "registered" }, async (fx) => {
    const index = readFileSync(join(fx.top, ".git", "index"));
    _setInstallStopForTests(4, (path) => { if (path === "metadata/x-1.png") throw new Error("disk full (test)"); });
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 2);
    const err = stepError(r, "post-merge-commit", "git");
    assert.match(err.message, /^git: install failed after writing CHANGELOG\.md \(.*\): disk full \(test\)$/);
    assert.equal(existsSync(join(fx.top, ".git", "index.lock")), false);
    assert.ok(readFileSync(join(fx.top, ".git", "index")).equals(index));
    assert.equal(readFileSync(join(fx.top, "CHANGELOG.md"), "utf8"), POST_CL);

    _setInstallStopForTests(null);
    const again = await pm(fx, APPLY);
    assert.equal(again.code, 0, again.stdout);
    assert.deepEqual(await endState(fx), expected);
  });
});

test("apply: signing does not ask an SSH agent: a socket that never answers does not stall the commit", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const socketPath = join(fx.dir, "agent.sock");
    /** @type {Set<import("node:net").Socket>} */
    const held = new Set();
    const server = createServer((s) => held.add(s)); // accepts, never answers
    await new Promise((ok) => server.listen(socketPath, () => ok(undefined)));
    process.env.SSH_AUTH_SOCK = socketPath;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    try {
      const bound = new Promise((_, no) => { timer = setTimeout(() => no(new Error("the signed commit did not finish within 20 s")), 20_000); });
      const r = /** @type {any} */ (await Promise.race([pm(fx, APPLY), bound]));
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.by["post-merge-commit"].verdict, "PASS");
    } finally {
      clearTimeout(timer);
      delete process.env.SSH_AUTH_SOCK;
      for (const s of held) s.destroy();
      await new Promise((ok) => server.close(() => ok(undefined)));
    }
  });
});

test("apply, push: other unpushed commits, a remote that moved, two push URLs → WARN; no upstream → N/A; nothing is pushed", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    await commit(fx.top, { "src/other.ts": "export {};\n" }, "unpushed work");
    const remote = await remoteMain(fx);
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["post-merge-push"].verdict, "WARN");
    assert.equal(r.by["post-merge-push"].message, "main has 1 other unpushed commit(s); not pushed, so nothing else leaves without you");
    assert.equal(await remoteMain(fx), remote);
    assert.equal(r.data.pushed, null);
  });
  await withFixture({ key: "registered" }, async (fx) => {
    const other = join(fx.dir, "other");
    await g(fx.dir, ["clone", "-q", fx.bare, other]);
    const moved = await commit(other, { "elsewhere.txt": "x\n" }, "pushed from elsewhere");
    await g(other, ["push", "-q", "origin", "main"]);
    const r = await pm(fx, APPLY);
    assert.equal(r.by["post-merge-push"].verdict, "WARN");
    assert.equal(r.by["post-merge-push"].message, "origin refs/heads/main has moved past this branch; not pushed");
    assert.equal(await remoteMain(fx), moved);
  });
  await withFixture({ key: "registered" }, async (fx) => {
    await g(fx.top, ["remote", "set-url", "--add", "--push", "origin", fx.bare]);
    await g(fx.top, ["remote", "set-url", "--add", "--push", "origin", join(fx.dir, "elsewhere.git")]);
    const remote = await remoteMain(fx);
    const r = await pm(fx, APPLY);
    assert.equal(r.by["post-merge-push"].verdict, "WARN");
    assert.equal(r.by["post-merge-push"].message, "origin pushes to 2 URLs; not pushed");
    assert.equal(await remoteMain(fx), remote);
  });
  await withFixture({ key: "registered", remote: false }, async (fx) => {
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["post-merge-commit"].verdict, "PASS");
    assert.equal(r.by["post-merge-push"].verdict, "N/A");
    assert.equal(r.by["post-merge-push"].message, "main has no upstream branch; push it yourself");
  });
});

/** Three bare clones of the fixture's remote, all at the cleanup parent. @param {{ dir: string, bare: string }} fx */
async function threeRemotes(fx) {
  /** @type {string[]} */
  const out = [];
  for (const n of ["a", "b", "c"]) {
    const p = join(fx.dir, `${n}.git`);
    await g(fx.dir, ["clone", "-q", "--bare", fx.bare, p]);
    out.push(p);
  }
  return out;
}

test("apply, push: a pushInsteadOf rule that rewrites the push URL → WARN, and no repository moves", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const [a, b, c] = await threeRemotes(fx);
    await g(fx.top, ["config", "remote.origin.pushurl", a]);
    await g(fx.top, ["config", `url.${b}.insteadOf`, a]);
    await g(fx.top, ["config", `url.${c}.pushInsteadOf`, b]);
    const before = await Promise.all([a, b, c, fx.bare].map((p) => g(p, ["rev-parse", "refs/heads/main"]).then((x) => x.stdout)));
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["post-merge-commit"].verdict, "PASS");
    assert.equal(r.by["post-merge-push"].verdict, "WARN");
    assert.equal(r.by["post-merge-push"].message, `a pushInsteadOf rule rewrites ${b}; not pushed`);
    const after = await Promise.all([a, b, c, fx.bare].map((p) => g(p, ["rev-parse", "refs/heads/main"]).then((x) => x.stdout)));
    assert.deepEqual(after, before);
  });
});

test("apply, push: a plain insteadOf alone still pushes, into the repository ls-remote read", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const [a, b] = await threeRemotes(fx);
    await g(fx.top, ["config", "remote.origin.pushurl", a]);
    await g(fx.top, ["config", `url.${b}.insteadOf`, a]);
    const aBefore = (await g(a, ["rev-parse", "refs/heads/main"])).stdout;
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 0, r.stdout);
    const sha = await rev(fx, "HEAD");
    assert.equal(r.by["post-merge-push"].message, `pushed ${sha.slice(0, 7)} to ${b} refs/heads/main`);
    assert.equal((await g(b, ["rev-parse", "refs/heads/main"])).stdout, sha);
    assert.equal((await g(a, ["rev-parse", "refs/heads/main"])).stdout, aBefore);
  });
});

test("apply, push: a push URL that could name a remote → WARN, and no ref moves anywhere", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const [x, y, z] = await threeRemotes(fx);
    await g(fx.top, ["config", "remote.origin.pushurl", "backup"]);
    await g(fx.top, ["remote", "add", "backup", x]);
    await g(fx.top, ["config", "--add", "remote.backup.pushurl", y]);
    await g(fx.top, ["config", "--add", "remote.backup.pushurl", z]);
    const repos = [fx.bare, x, y, z];
    const before = await Promise.all(repos.map((p) => g(p, ["rev-parse", "refs/heads/main"]).then((r) => r.stdout)));
    const r = await pm(fx, APPLY);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["post-merge-commit"].verdict, "PASS");
    assert.equal(r.by["post-merge-push"].verdict, "WARN");
    assert.equal(r.by["post-merge-push"].message, "backup could name a remote; not pushed");
    assert.deepEqual(await Promise.all(repos.map((p) => g(p, ["rev-parse", "refs/heads/main"]).then((r) => r.stdout))), before);
  });
});

test("apply, push: an absolute-path pushurl and a file:// pushurl still push", async () => {
  for (const form of /** @type {const} */ (["absolute", "file"])) {
    await withFixture({ key: "registered" }, async (fx) => {
      const [d] = await threeRemotes(fx);
      const url = form === "absolute" ? d : `file://${d}`;
      await g(fx.top, ["config", "remote.origin.pushurl", url]);
      const r = await pm(fx, APPLY);
      assert.equal(r.code, 0, r.stdout);
      const sha = await rev(fx, "HEAD");
      assert.equal(r.by["post-merge-push"].message, `pushed ${sha.slice(0, 7)} to ${url} refs/heads/main`, form);
      assert.equal((await g(d, ["rev-parse", "refs/heads/main"])).stdout, sha, form);
    });
  }
});

test("unambiguousUrl: scheme URLs, scp-style and absolute paths go on; anything a remote name could be does not", () => {
  for (const ok of ["https://github.com/o/r.git", "ssh://git@github.com/o/r.git", "file:///tmp/r.git", "git@github.com:o/r.git", "/tmp/r.git"]) assert.equal(unambiguousUrl(ok), true, ok);
  for (const no of ["backup", "origin", "../r.git", "r.git", "dir/r.git", "./r", "a/b@c:d"]) assert.equal(unambiguousUrl(no), false, no);
});

test("apply, push retry: a refused push leaves the commit; a re-run pushes it; an amended cleanup commit is WARN and not pushed", async () => {
  await withFixture({ key: "registered" }, async (fx) => {
    const hook = join(fx.top, ".git", "hooks", "pre-push");
    script(hook, "echo 'rejected by the test hook' >&2\nexit 1");
    const remote = await remoteMain(fx);
    const first = await pm(fx, APPLY);
    assert.equal(first.code, 2);
    const err = stepError(first, "post-merge-push", "git");
    assert.match(JSON.stringify(err), /rejected by the test hook/);
    const sha = await rev(fx, "HEAD");
    assert.equal(first.data.commit, sha);
    assert.equal(await remoteMain(fx), remote);

    rmSync(hook);
    const again = await pm(fx, APPLY);
    assert.equal(again.code, 0, again.stdout);
    assert.equal(again.by["post-merge-adopt"].message, "0 to adopt, 0 to stamp, 2 already adopted");
    assert.equal(again.by["post-merge-commit"].message, "nothing to commit");
    assert.equal(again.by["post-merge-push"].message, `pushed ${sha.slice(0, 7)} to ${fx.bare} refs/heads/main`);
    assert.equal(await remoteMain(fx), sha);
  });
  await withFixture({ key: "registered" }, async (fx) => {
    const hook = join(fx.top, ".git", "hooks", "pre-push");
    script(hook, "exit 1");
    const remote = await remoteMain(fx);
    assert.equal((await pm(fx, APPLY)).code, 2);
    rmSync(hook);
    write(fx.top, { "src/extra.ts": "export const extra = 1;\n" });
    await g(fx.top, ["add", "src/extra.ts"]);
    await g(fx.top, ["commit", "-q", "--amend", "--no-edit"]);
    const r = await pm(fx, APPLY);
    assert.equal(r.by["post-merge-push"].verdict, "WARN");
    assert.equal(r.by["post-merge-push"].message, "HEAD carries the cleanup subject but changes more than raycastbot's files; not pushed");
    assert.equal(await remoteMain(fx), remote);
  });
});

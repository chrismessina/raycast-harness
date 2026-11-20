// The stale classifier's history evidence: when may a published file that local lacks be DELETED
// (the published blob sits at this exact path in a commit reachable from HEAD) instead of the
// ONLY-PUB FAIL, and when does CHECK hold? Calls `classify` and `blobInHistory` directly against
// throwaway repositories; no network, no upstream cache.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withTempDir } from "./helpers.mjs";
import { commit, g, initRepo, write } from "./upstream-fixtures.mjs";
import { blobId } from "../src/upstream.mjs";
import { blobInHistory, classify } from "../src/commands/stale.mjs";

const A = "{\n  \"extends\": \"@raycast\"\n}\n";
const B = "{\n  \"extends\": \"@raycast\",\n  \"rules\": {}\n}\n";
const C = "a third version\n";
const id = (/** @type {string} */ s) => blobId(Buffer.from(s));

/** A published copy: a git work tree holding `files` at HEAD. @param {string} dir @param {Record<string, string>} files */
async function published(dir, files) {
  const pub = await initRepo(join(dir, "published"));
  await commit(pub, files, "published");
  return pub;
}

/** classify, keyed by path. @param {string} local @param {string} pub @param {string[]} [localOnly] */
async function classes(local, pub, localOnly = []) {
  const rows = await classify(local, pub, { localOnly, heldOut: new Set() });
  return Object.fromEntries(rows.map((r) => [r.path, r]));
}

test("DELETED: a published file local deleted, uncommitted or committed, whose published blob is in this path's history; WARN with localHash null", async () => {
  await withTempDir(async (dir) => {
    const files = { "package.json": "{}\n", ".eslintrc.json": A };
    const pub = await published(dir, files);
    const local = await initRepo(join(dir, "local"));
    await commit(local, files, "Initial fork commit");
    rmSync(join(local, ".eslintrc.json"));
    let row = (await classes(local, pub))[".eslintrc.json"];
    assert.equal(row.class, "DELETED", "an uncommitted deletion");
    assert.equal(row.localHash, null);
    assert.equal(row.publishedHash, id(A));
    assert.match(row.note, /present at this path in this checkout's reachable history/);
    await commit(local, {}, "move to eslint.config.js");
    row = (await classes(local, pub))[".eslintrc.json"];
    assert.equal(row.class, "DELETED", "a committed deletion");
  });
});

test("ONLY-PUB stays a FAIL when local history never held the published blob at that path: a file upstream added, or an upstream edit local never pulled", async () => {
  await withTempDir(async (dir) => {
    const pub = await published(dir, { "package.json": "{}\n", ".eslintrc.json": B, "src/contrib.ts": "export {};\n" });
    const local = await initRepo(join(dir, "local"));
    await commit(local, { "package.json": "{}\n", ".eslintrc.json": A }, "fork before the upstream edit");
    await commit(local, { ".eslintrc.json": null }, "delete it");
    const rows = await classes(local, pub);
    assert.equal(rows["src/contrib.ts"].class, "ONLY-PUB", "never in local history");
    assert.equal(rows[".eslintrc.json"].class, "ONLY-PUB", "local held an older version only");
  });
});

test("REMOVE keeps precedence over DELETED for a path the preset's holdout.localOnly lists", async () => {
  await withTempDir(async (dir) => {
    const files = { "package.json": "{}\n", "AGENTS.md": "# Agents\n" };
    const pub = await published(dir, files);
    const local = await initRepo(join(dir, "local"));
    await commit(local, files, "x");
    await commit(local, { "AGENTS.md": null }, "mirror only");
    assert.equal((await classes(local, pub, ["AGENTS.md"]))["AGENTS.md"].class, "REMOVE");
    assert.equal((await classes(local, pub))["AGENTS.md"].class, "DELETED", "unlisted, the same path is DELETED");
  });
});

/**
 * The config test's fixture: the published blobs exist only in the root commit, under config that
 * misled the old `git log` helper. With a `signingKey`, every commit is SSH-signed with it.
 * @param {string} dir @param {string | null} signingKey
 */
async function configFixture(dir, signingKey) {
  const pub = await published(dir, { "package.json": "{}\n", ".eslintrc.json": A, "CHANGELOG.md": A });
  const local = await initRepo(join(dir, "local"));
  for (const [k, v] of [["log.showRoot", "false"], ["log.follow", "true"], ["diff.renames", "true"], ["log.showSignature", "true"]]) await g(local, ["config", k, v]);
  if (signingKey) {
    await g(local, ["config", "gpg.format", "ssh"]);
    // The private key file itself, and no agent: a .pub key would make ssh-keygen ask the
    // machine's SSH agent, which can wait on a prompt.
    await g(local, ["config", "user.signingkey", signingKey]);
  }
  const step = async (/** @type {Record<string, string | null>} */ files, /** @type {string} */ msg) => {
    write(local, files);
    await g(local, ["add", "-A"]);
    await g(local, [...(signingKey ? ["-c", "commit.gpgsign=true"] : []), "commit", "-q", "-m", msg], { env: { SSH_AUTH_SOCK: "" } });
  };
  await step({ "package.json": "{}\n", ".eslintrc.json": A, "CHANGELOG.md": A }, "Initial fork commit");
  await step({ ".eslintrc.json": null, "CHANGELOG.md": B }, "migrate and release");
  return { pub, local };
}

test("history evidence does not depend on git config: log.showRoot, log.follow, diff.renames, log.showSignature (DELETED and CHECK)", async () => {
  await withTempDir(async (dir) => {
    const { pub, local } = await configFixture(dir, null);
    const rows = await classes(local, pub);
    assert.equal(rows[".eslintrc.json"].class, "DELETED");
    assert.equal(rows["CHANGELOG.md"].class, "CHECK");
  });
});

test("history evidence does not depend on git config with SSH-signed commits and log.showSignature (DELETED and CHECK)", async (t) => {
  const probe = spawnSync("ssh-keygen", ["-?"]);
  if (/** @type {NodeJS.ErrnoException | undefined} */ (probe.error)?.code === "ENOENT") { t.skip("ssh-keygen is not installed"); return; }
  await withTempDir(async (dir) => {
    const key = join(dir, "key");
    const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    assert.equal(made.status, 0, `ssh-keygen failed: ${made.stderr}`);
    const { pub, local } = await configFixture(dir, key);
    for (const ref of ["HEAD", "HEAD~1"]) assert.match((await g(local, ["cat-file", "commit", ref])).stdout, /^gpgsig /m, `${ref} is really signed`);
    const rows = await classes(local, pub);
    assert.equal(rows[".eslintrc.json"].class, "DELETED");
    assert.equal(rows["CHANGELOG.md"].class, "CHECK");
  });
});

test("exact path only: a blob from a file's earlier name, or from a former directory's descendant, is no witness (CHECK and DELETED)", async () => {
  await withTempDir(async (dir) => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
    const pub = await published(dir, { "package.json": "{}\n", "new-name.md": long, "gone-name.md": long, config: A, "config-gone": A });
    const local = await initRepo(join(dir, "local"));
    for (const [k, v] of [["log.follow", "true"], ["diff.renames", "true"]]) await g(local, ["config", k, v]);
    await commit(local, { "package.json": "{}\n", "old-name.md": long, "old-gone.md": long, "config/default.json": A, "config-gone/default.json": A }, "first");
    await g(local, ["mv", "old-name.md", "new-name.md"]);
    await g(local, ["mv", "old-gone.md", "gone-name.md"]);
    await commit(local, { "new-name.md": long + "edited\n", "gone-name.md": long + "edited\n", config: null, "config-gone": null }, "rename and edit; drop the config directories");
    await commit(local, { "gone-name.md": null, config: C }, "delete one renamed file; config becomes a file");
    const rows = await classes(local, pub);
    assert.equal(rows["new-name.md"].class, "UPSTREAM", "the published blob was only ever at old-name.md");
    assert.equal(rows["gone-name.md"].class, "ONLY-PUB");
    assert.equal(rows.config.class, "UPSTREAM", "config/default.json held it, config never did");
    assert.equal(rows["config-gone"].class, "ONLY-PUB");
  });
});

test("witnesses that count: a filename with a newline, a blob only a merged branch held, and a delete-then-re-add cycle", async () => {
  await withTempDir(async (dir) => {
    const odd = "notes\nold.txt";
    const pub = await published(dir, { "package.json": "{}\n", [odd]: A, "merged.json": A, "cycle.json": A });
    const local = await initRepo(join(dir, "local"));
    await commit(local, { "package.json": "{}\n", [odd]: A, "cycle.json": A }, "first");
    await g(local, ["checkout", "-q", "-b", "side"]);
    await commit(local, { "merged.json": A }, "side adds it");
    await commit(local, { "merged.json": B }, "side edits it");
    await g(local, ["checkout", "-q", "main"]);
    await commit(local, { "cycle.json": null }, "delete");
    await g(local, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    await commit(local, { "cycle.json": B, [odd]: B }, "re-add with other content");
    assert.equal((await classes(local, pub))[odd].class, "CHECK", "a newline name is still found");
    await commit(local, { "cycle.json": null, "merged.json": null, [odd]: null }, "delete again");
    const rows = await classes(local, pub);
    assert.equal(rows[odd].class, "DELETED");
    assert.equal(rows["merged.json"].class, "DELETED");
    assert.equal(rows["cycle.json"].class, "DELETED");
  });
});

test("monorepo: the extension's own path frame; a sibling extension's same relative path is no witness", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(join(dir, "mono"));
    await commit(repo, { "extensions/one/shared.json": A, "extensions/two/package.json": "{}\n", "extensions/two/own.json": B }, "two extensions");
    await commit(repo, { "extensions/two/own.json": null }, "two drops own.json");
    const pub = await published(dir, { "package.json": "{}\n", "shared.json": A, "own.json": B });
    const rows = await classes(join(repo, "extensions", "two"), pub);
    assert.equal(rows["shared.json"].class, "ONLY-PUB");
    assert.equal(rows["own.json"].class, "DELETED");
  });
});

test("shallow clone: history cut before the blob is no witness; a boundary commit that holds it is", async () => {
  await withTempDir(async (dir) => {
    const origin = await initRepo(join(dir, "origin"));
    await commit(origin, { "package.json": "{}\n", "old.json": A, "kept.json": A }, "first");
    await commit(origin, { "old.json": null }, "drop old.json");
    const shallow = join(dir, "shallow");
    await g(dir, ["clone", "-q", "--depth", "1", `file://${origin}`, shallow]);
    rmSync(join(shallow, "kept.json"));
    const pub = await published(dir, { "package.json": "{}\n", "old.json": A, "kept.json": A });
    const rows = await classes(shallow, pub);
    assert.equal(rows["old.json"].class, "ONLY-PUB", "outside the shallow history");
    assert.equal(rows["kept.json"].class, "DELETED", "the boundary commit holds it");
  });
});

test("blobInHistory equals an oracle over every reachable commit: TREESAME and octopus merges, a file↔directory switch, a gitlink", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(join(dir, "repo"));
    const base = await commit(repo, { "package.json": "{}\n", "x.json": A }, "base");
    for (const [branch, content] of [["b1", B], ["b2", C], ["b3", "b3\n"]]) {
      await g(repo, ["checkout", "-q", "-b", branch, base]);
      // Only b1 touches x.json: the "ours" merge below keeps main's tree, so b1's x.json is reachable
      // only through a merge TREESAME to its first parent.
      await commit(repo, { [`${branch}.json`]: content, ...(branch === "b1" ? { "x.json": content } : {}) }, branch);
    }
    await g(repo, ["checkout", "-q", "main"]);
    await g(repo, ["merge", "-q", "-s", "ours", "-m", "ours merge: TREESAME to main", "b1"]);
    await g(repo, ["merge", "-q", "-m", "octopus", "b2", "b3"]);
    assert.equal((await g(repo, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.split(" ").length, 4, "a real octopus merge");
    await commit(repo, { "x.json": null, "switch/inner.json": A }, "x.json gone; switch is a directory");
    await commit(repo, { switch: null }, "drop switch/");
    await commit(repo, { switch: B }, "switch is a file");
    await g(repo, ["update-index", "--add", "--cacheinfo", `160000,${base},link`]);
    await g(repo, ["commit", "-q", "-m", "a gitlink"]);

    const commits = (await g(repo, ["rev-list", "HEAD"])).stdout.split("\n");
    /** @type {Set<string>} */
    const oracle = new Set();
    /** @type {Set<string>} */
    const paths = new Set(["x.json", "switch", "link", "b1.json", "b2.json", "b3.json", "switch/inner.json", "package.json"]);
    for (const c of commits) {
      for (const rec of (await g(repo, ["ls-tree", "-r", "-z", c])).stdout.split("\0")) {
        if (!rec) continue;
        const [meta, name] = [rec.slice(0, rec.indexOf("\t")), rec.slice(rec.indexOf("\t") + 1)];
        const [, type, oid] = meta.split(" ");
        if (type === "blob") oracle.add(`${name}\0${oid}`);
      }
    }
    const blobs = [A, B, C, "b3\n", "{}\n"].map(id).concat([base]);
    for (const path of paths) for (const blob of blobs) {
      assert.equal(await blobInHistory(repo, path, blob), oracle.has(`${path}\0${blob}`), `${JSON.stringify(path)} @ ${blob.slice(0, 7)}`);
    }
  });
});

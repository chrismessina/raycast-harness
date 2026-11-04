import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { rx, withTempDir } from "./helpers.mjs";
import { _setUpstreamForTests, upstreamDir } from "../src/upstream.mjs";
import { FIXTURES, applyTree, commit, extensionFiles, g, initRepo, startMerge } from "./upstream-fixtures.mjs";

// `rx contributions` during a real `git merge` left in progress inside a temp repository, against
// a published directory copied from the fixture. Both real-data fixtures (Phase 3.4) are
// `test/fixtures/real/contributions-*/` with base/ours/theirs/published trees and expected.json.

const REAL = join(FIXTURES, "real");
const by = (/** @type {any} */ r) => Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));

/**
 * Build a merge in progress from a fixture. With `prefix`, the extension lives at `<prefix>/`
 * inside a larger repository (monorepo layout) next to another extension.
 * @param {string} dir @param {string} fixture @param {{ prefix?: string }} [opts]
 */
async function buildMerge(dir, fixture, { prefix = "" } = {}) {
  const fix = join(REAL, fixture);
  const expected = JSON.parse(readFileSync(join(fix, "expected.json"), "utf8"));
  const repo = await initRepo(join(dir, "repo"));
  const ext = prefix ? join(repo, prefix) : repo;
  if (prefix) await commit(repo, { "README.md": "# monorepo\n", ...Object.fromEntries(Object.entries(extensionFiles("other")).map(([p, c]) => [`extensions/other/${p}`, c])) }, "monorepo root");
  applyTree(join(fix, "base"), ext);
  await commit(repo, {}, "base: the published version");
  await g(repo, ["branch", "theirs"]);
  applyTree(join(fix, "ours"), ext);
  await commit(repo, {}, "ours: local work");
  await g(repo, ["checkout", "-q", "theirs"]);
  applyTree(join(fix, "theirs"), ext);
  await commit(repo, {}, expected.theirsMessage, { author: expected.theirsAuthor, committer: expected.theirsAuthor });
  await g(repo, ["checkout", "-q", "main"]);
  const code = await startMerge(repo, "theirs");
  assert.equal(code, 1, `${fixture}: the fixture must conflict`);
  return { repo, ext, published: join(fix, "published"), expected };
}

for (const fixture of readdirSync(REAL).filter((d) => d.startsWith("contributions-"))) {
  test(`contributions: ${fixture} (standalone checkout) matches expected.json`, async () => {
    await withTempDir(async (dir) => {
      const { ext, published, expected } = await buildMerge(dir, fixture);
      const r = await rx(["contributions", "--published", published, "--json"], { cwd: ext });
      assert.equal(r.code, expected.exit, r.stdout);
      const got = Object.fromEntries(r.json.data.conflicted.map((/** @type {any} */ c) => [c.path, c.outcome]));
      assert.deepEqual(got, expected.conflicts);
      assert.equal(by(r)["contribution-branch"].verdict, expected["contribution-branch"]);
      const t = r.json.data.incomingTree;
      assert.equal(!t.onlyIncoming.length && !t.onlyPublished.length && !t.differing.length, expected.incomingEqualsPublished, JSON.stringify(t));
      assert.equal(r.json.data.extension, "");
      for (const c of r.json.data.conflicted) {
        assert.match(c.incoming, /^[0-9a-f]{40}$/);
        assert.match(c.ours, /^[0-9a-f]{40}$/);
        const detail = r.json.results.find((/** @type {any} */ x) => x.id === "contribution" && x.details[0].file === c.path).details[0];
        assert.ok(detail.text.startsWith(c.outcome + " incoming " + c.incoming), detail.text);
      }
      // Read-only: the merge is still in progress and the index still holds the conflicts.
      assert.equal((await g(ext, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true })).code, 0);
      assert.ok((await g(ext, ["ls-files", "-u"])).stdout.length > 0);
    });
  });

  test(`contributions: ${fixture} from a monorepo checkout (extensions/<name>) decides only the extension subtree (T2)`, async () => {
    await withTempDir(async (dir) => {
      const { ext, published, expected } = await buildMerge(dir, fixture, { prefix: "extensions/example-downloader" });
      const r = await rx(["contributions", "--published", published, "--json"], { cwd: ext });
      assert.equal(r.code, expected.exit, r.stdout);
      const got = Object.fromEntries(r.json.data.conflicted.map((/** @type {any} */ c) => [c.path, c.outcome]));
      assert.deepEqual(got, expected.conflicts, "paths are extension-relative, never repo-root");
      assert.equal(r.json.data.extension, "extensions/example-downloader");
      const t = r.json.data.incomingTree;
      assert.ok(!t.onlyIncoming.some((/** @type {string} */ p) => p.startsWith("extensions/")), "the other extension and README are outside the subtree");
      assert.equal(!t.onlyIncoming.length && !t.onlyPublished.length && !t.differing.length, expected.incomingEqualsPublished, JSON.stringify(t));
    });
  });
}

test("T1: the code fix is REAL-CONTRIBUTION even though the CHANGELOG containment test passes", async () => {
  await withTempDir(async (dir) => {
    const { ext, published } = await buildMerge(dir, "contributions-older-changelog-plus-code");
    const r = await rx(["contributions", "--published", published, "--json"], { cwd: ext });
    const rows = r.json.results.filter((/** @type {any} */ x) => x.id === "contribution");
    const changelog = rows.find((/** @type {any} */ x) => x.details[0].file === "CHANGELOG.md");
    const code = rows.find((/** @type {any} */ x) => x.details[0].file === "src/download.ts");
    assert.equal(changelog.verdict, "PASS");
    assert.match(changelog.details[0].text, /contained in ours/);
    assert.equal(code.verdict, "FAIL");
    assert.match(code.details[0].text, /^REAL-CONTRIBUTION incoming [0-9a-f]{40} != published [0-9a-f]{40}$/);
    assert.equal(r.code, 1);
  });
});

test("the local (ours) blob never enters the decision: ours == published and incoming != published is REAL-CONTRIBUTION", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(join(dir, "repo"));
    const base = extensionFiles("ext", { "src/a.ts": "export const a = 1;\n" });
    await commit(repo, base, "base");
    await g(repo, ["branch", "theirs"]);
    await commit(repo, { "src/a.ts": "export const a = 1; // ours\n" }, "ours");
    await g(repo, ["checkout", "-q", "theirs"]);
    await commit(repo, { "src/a.ts": "export const a = 2; // contributor\n" }, "theirs");
    await g(repo, ["checkout", "-q", "main"]);
    assert.equal(await startMerge(repo, "theirs"), 1);
    // Published == OURS (the published copy is the local side), not the incoming side.
    const published = join(dir, "published");
    const { write } = await import("./upstream-fixtures.mjs");
    write(published, { ...base, "src/a.ts": "export const a = 1; // ours\n" });
    const r = await rx(["contributions", "--published", published, "--json"], { cwd: repo });
    assert.equal(r.code, 1);
    assert.equal(r.json.data.conflicted[0].outcome, "REAL-CONTRIBUTION");
    assert.equal(r.json.data.conflicted[0].ours, r.json.data.conflicted[0].published);
  });
});

test("contributions: no merge in progress, a missing --published, and a delete/modify conflict are each ERROR contributions", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(join(dir, "repo"));
    await commit(repo, extensionFiles("ext"), "x");
    const published = join(dir, "published");
    const { write } = await import("./upstream-fixtures.mjs");
    write(published, extensionFiles("ext"));
    let r = await rx(["contributions", "--published", published, "--json"], { cwd: repo });
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.results.map((/** @type {any} */ x) => [x.id, x.verdict]), [["contributions", "ERROR"]], "exactly one ERROR, no protocol complaint");
    assert.match(r.json.results[0].message, /no merge in progress/);

    r = await rx(["contributions", "--published", join(dir, "nope"), "--json"], { cwd: repo });
    assert.equal(r.code, 2);
    assert.equal(r.json.results.length, 1);
    assert.match(r.json.results[0].message, /missing or empty/);

    // delete/modify: theirs deletes src/index.tsx, ours edits it → no incoming object.
    await g(repo, ["branch", "theirs"]);
    await commit(repo, { "src/index.tsx": "edited\n" }, "ours");
    await g(repo, ["checkout", "-q", "theirs"]);
    await commit(repo, { "src/index.tsx": null }, "theirs deletes");
    await g(repo, ["checkout", "-q", "main"]);
    assert.equal(await startMerge(repo, "theirs"), 1);
    r = await rx(["contributions", "--published", published, "--json"], { cwd: repo });
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.results.map((/** @type {any} */ x) => x.id), ["contributions"]);
    assert.match(r.json.results[0].message, /no incoming \(MERGE_HEAD\) object/);
  });
});

test("contributions: a merge with no conflicts under the extension is N/A, and says whether the incoming tree equals published", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(join(dir, "repo"));
    const files = extensionFiles("ext");
    await commit(repo, files, "base");
    await g(repo, ["branch", "theirs"]);
    await commit(repo, { "src/b.ts": "ours\n" }, "ours");
    await g(repo, ["checkout", "-q", "theirs"]);
    await commit(repo, { "src/c.ts": "theirs\n" }, "theirs");
    await g(repo, ["checkout", "-q", "main"]);
    assert.equal(await startMerge(repo, "theirs"), 0);
    const published = join(dir, "published");
    const { write } = await import("./upstream-fixtures.mjs");
    write(published, { ...files, "src/c.ts": "theirs\n" });
    const r = await rx(["contributions", "--published", published, "--json"], { cwd: repo });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(by(r).contribution.verdict, "N/A");
    assert.match(by(r).contribution.message, /no conflicted paths.*equals the published copy/);
    assert.equal(by(r)["contribution-branch"].verdict, "PASS");
  });
});

test("contribution-branch: a leftover ext/<name> ref whose only new commit is raycastbot's stamp is a WARN", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(join(dir, "repo"));
    // The submitted state carries the placeholder; the bot's stamp turns it into the merge date.
    const files = extensionFiles("ext", { "CHANGELOG.md": "# Example Changelog\n\n## [Initial Version] - {PR_MERGE_DATE}\n\n- First release\n" });
    await commit(repo, files, "base");
    await g(repo, ["branch", "ext/ext"]);
    await g(repo, ["branch", "theirs"]);
    await commit(repo, { "src/b.ts": "ours\n" }, "ours");
    await g(repo, ["checkout", "-q", "ext/ext"]);
    await commit(repo, { "CHANGELOG.md": files["CHANGELOG.md"].replace("{PR_MERGE_DATE}", "2026-01-11") }, "Update CHANGELOG.md", { author: "raycastbot <raycastbot@users.noreply.github.com>" });
    await g(repo, ["checkout", "-q", "theirs"]);
    await commit(repo, { "src/c.ts": "theirs\n" }, "theirs");
    await g(repo, ["checkout", "-q", "main"]);
    assert.equal(await startMerge(repo, "theirs"), 0);
    const published = join(dir, "published");
    const { write } = await import("./upstream-fixtures.mjs");
    write(published, files);
    const r = await rx(["contributions", "--published", published, "--json"], { cwd: repo });
    assert.equal(by(r)["contribution-branch"].verdict, "WARN");
    assert.match(by(r)["contribution-branch"].message, /ext\/ext adds only raycastbot/);
    assert.equal(r.json.data.leftoverBranch.name, "ext/ext");
  });
});

/**
 * A CHANGELOG-only conflict: ours vs theirs text, published copy given. Returns the rx result.
 * @param {string} dir @param {{ base: string, ours: string, theirs: string, published: string }} t
 */
async function changelogConflict(dir, t) {
  const repo = await initRepo(join(dir, "repo"));
  const files = extensionFiles("ext");
  await commit(repo, { ...files, "CHANGELOG.md": t.base }, "base");
  await g(repo, ["branch", "theirs"]);
  await commit(repo, { "CHANGELOG.md": t.ours }, "ours");
  await g(repo, ["checkout", "-q", "theirs"]);
  await commit(repo, { "CHANGELOG.md": t.theirs }, "theirs");
  await g(repo, ["checkout", "-q", "main"]);
  assert.equal(await startMerge(repo, "theirs"), 1);
  const published = join(dir, "published");
  const { write } = await import("./upstream-fixtures.mjs");
  write(published, { ...files, "CHANGELOG.md": t.published });
  return rx(["contributions", "--published", published, "--json"], { cwd: repo });
}

const INIT = "## [Initial Version] - 2026-08-01\n\n- First release\n";

test("CHANGELOG containment uses one entry identity throughout: stamped local history contains the incoming placeholder form", async () => {
  await withTempDir(async (dir) => {
    const r = await changelogConflict(dir, {
      base: `# C\n\n## [Fix] - {PR_MERGE_DATE}\n\n- Fixed\n\n${INIT}`,
      ours: `# C\n\n## [New] - {PR_MERGE_DATE}\n\n- New\n\n## [Fix] - 2026-09-14\n\n- Fixed\n- Also fixed\n\n${INIT}`, // already stamped locally
      theirs: `# C\n\n## [Fix] - {PR_MERGE_DATE} \n\n- Fixed\n- Also fixed\n\n${INIT}`, // placeholder form (trailing space forces the same-line conflict), same body
      published: `# C\n\n## [Fix] - 2026-09-14\n\n- Fixed (edited upstream)\n\n${INIT}`, // so incoming != published
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.data.conflicted[0].outcome, "OURS-SAFE");
    assert.match(by(r).contribution.details[0].text, /contained in ours/);
  });
});

test("CHANGELOG containment compares bodies byte for byte: a CRLF incoming copy of an LF history is not contained", async () => {
  await withTempDir(async (dir) => {
    const lf = `# C\n\n## [Fix] - 2026-09-14\n\n- Fixed\n\n${INIT}`;
    const r = await changelogConflict(dir, {
      base: lf,
      ours: `# C\n\n## [New] - {PR_MERGE_DATE}\n\n- New\n\n` + lf.slice(5),
      theirs: lf.replace(/\n/g, "\r\n"),
      published: lf,
    });
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.json.data.conflicted[0].outcome, "REAL-CONTRIBUTION");
  });
});

test("contribution-branch inspects the patch: a raycastbot 'Update CHANGELOG.md' commit that also touches src is not a date stamp", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(join(dir, "repo"));
    const files = extensionFiles("ext");
    await commit(repo, files, "base");
    await g(repo, ["branch", "ext/ext"]);
    await g(repo, ["branch", "theirs"]);
    await commit(repo, { "src/b.ts": "ours\n" }, "ours");
    await g(repo, ["checkout", "-q", "ext/ext"]);
    await commit(repo, { "CHANGELOG.md": files["CHANGELOG.md"].replace("2026-01-10", "2026-01-11"), "src/sneaky.ts": "x\n" }, "Update CHANGELOG.md", { author: "raycastbot <raycastbot@users.noreply.github.com>" });
    await g(repo, ["checkout", "-q", "theirs"]);
    await commit(repo, { "src/c.ts": "theirs\n" }, "theirs");
    await g(repo, ["checkout", "-q", "main"]);
    assert.equal(await startMerge(repo, "theirs"), 0);
    const published = join(dir, "published");
    const { write } = await import("./upstream-fixtures.mjs");
    write(published, files);
    const r = await rx(["contributions", "--published", published, "--json"], { cwd: repo });
    assert.equal(by(r)["contribution-branch"].verdict, "PASS");
    assert.equal(r.json.data.leftoverBranch, null);
    assert.match(by(r)["contribution-branch"].details.find((/** @type {any} */ d) => d.text.startsWith("ext/ext")).text, /touches CHANGELOG\.md, src\/sneaky\.ts, not only CHANGELOG\.md/);
  });
});

test("contribution-branch proves the stamp by content: a CHANGELOG-only raycastbot commit that adds a bullet or stamps two headings is real work (PASS, reason in details)", async () => {
  for (const variant of ["bullet", "two-headings", "stamp"]) {
    await withTempDir(async (dir) => {
      const repo = await initRepo(join(dir, "repo"));
      const base = "# C\n\n## [Fix] - {PR_MERGE_DATE}\n\n- Fixed\n\n## [Old] - {PR_MERGE_DATE}\n\n- Old\n";
      const files = extensionFiles("ext", { "CHANGELOG.md": base });
      await commit(repo, files, "base");
      await g(repo, ["branch", "ext/ext"]);
      await g(repo, ["branch", "theirs"]);
      await commit(repo, { "src/b.ts": "ours\n" }, "ours");
      await g(repo, ["checkout", "-q", "ext/ext"]);
      const edited = variant === "bullet"
        ? base.replace("## [Fix] - {PR_MERGE_DATE}", "## [Fix] - 2026-09-14").replace("- Fixed\n", "- Fixed\n- And more\n")
        : variant === "two-headings"
          ? base.replace(/\{PR_MERGE_DATE\}/g, "2026-09-14")
          : base.replace("## [Fix] - {PR_MERGE_DATE}", "## [Fix] - 2026-09-14");
      await commit(repo, { "CHANGELOG.md": edited }, "Update CHANGELOG.md", { author: "raycastbot <raycastbot@users.noreply.github.com>" });
      await g(repo, ["checkout", "-q", "theirs"]);
      await commit(repo, { "src/c.ts": "theirs\n" }, "theirs");
      await g(repo, ["checkout", "-q", "main"]);
      assert.equal(await startMerge(repo, "theirs"), 0);
      const published = join(dir, "published");
      const { write } = await import("./upstream-fixtures.mjs");
      write(published, files);
      const r = await rx(["contributions", "--published", published, "--json"], { cwd: repo });
      const cb = by(r)["contribution-branch"];
      if (variant === "stamp") {
        assert.equal(cb.verdict, "WARN", `${variant}: ${JSON.stringify(cb)}`);
        assert.equal(r.json.data.leftoverBranch.name, "ext/ext");
      } else {
        assert.equal(cb.verdict, "PASS", `${variant}: ${JSON.stringify(cb)}`);
        assert.equal(r.json.data.leftoverBranch, null);
        const reason = cb.details.find((/** @type {any} */ d) => d.text.startsWith("ext/ext")).text;
        if (variant === "bullet") assert.match(reason, /changes the line count of CHANGELOG\.md/);
        else assert.match(reason, /changes 2 lines of CHANGELOG\.md, not just a date/);
      }
    });
  }
});

test("contributions holds the upstream cache lock while comparing: a foreign lock makes it ERROR github, never a read of a moving tree", async () => {
  await withTempDir(async (dir) => {
    const saved = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    mkdirSync(upstreamDir(), { recursive: true });
    mkdirSync(join(upstreamDir(), ".rx-lock"));
    _setUpstreamForTests({ lockWaitMs: 300 });
    try {
      const { ext, published } = await buildMerge(dir, "contributions-equal");
      const r = await rx(["contributions", "--published", published, "--json"], { cwd: ext });
      assert.equal(r.code, 2, r.stdout);
      assert.equal(r.json.results[0].id, "github");
      assert.match(r.json.results[0].message, /upstream cache lock/);
    } finally {
      _setUpstreamForTests({ lockWaitMs: null });
      rmSync(join(upstreamDir(), ".rx-lock"), { recursive: true, force: true });
      if (saved === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = saved;
    }
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hitsIn, isBinary, parseForbidden } from "../src/commands/scan.mjs";
import { publishTag, publishTagCandidates } from "../src/publish-tag.mjs";
import { REPO, fakeExtension, rx, withTempDir } from "./helpers.mjs";

const FIXTURE = join(REPO, "test", "fixtures", "scan", "leaky");

/** @param {string} dir */
function gitInit(dir) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}
/** @param {string} dir @param {string} msg */
function gitCommit(dir, msg) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], { cwd: dir });
}
/** @param {any} json */
const by = (json) => Object.fromEntries(json.results.map((/** @type {any} */ x) => [x.id, x]));

test("parseForbidden drops blank lines and # comments and trims; hitsIn is literal, 1-based, per literal", () => {
  assert.deepEqual(parseForbidden("# c\n\n  AbCdEfGhIjK \nexample_user\r\n\n"), ["AbCdEfGhIjK", "example_user"]);
  assert.deepEqual(hitsIn("a\nsee AbCdEfGhIjK and example_user\n.*", ["AbCdEfGhIjK", "example_user", ".*"]), [
    { line: 2, text: "AbCdEfGhIjK" },
    { line: 2, text: "example_user" },
    { line: 3, text: ".*" },
  ]);
  assert.equal(isBinary(Buffer.from("plain text\n")), false);
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1])), true);
  // The publisher builds the tag from its branch `ext/<name>` (Codex W4 A4; verified against real repos:
  // `__raycast_latest_publish_ext/otty__`). It reads ONLY that tag and logs all history when it is absent, so
  // a bare legacy `__raycast_latest_publish__` is never a boundary (Codex W4 r2 A1).
  assert.equal(publishTag("my-ext"), "__raycast_latest_publish_ext/my-ext__");
  assert.deepEqual(publishTagCandidates("my-ext"), ["__raycast_latest_publish_ext/my-ext__"]);
});

test("fixture leaky: contents, names and PR text leak; commits are clean; the icon is binary", async () => {
  await withTempDir(async (dir) => {
    const expected = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8"));
    const ext = join(dir, "ext");
    cpSync(join(FIXTURE, "extension"), ext, { recursive: true });
    gitInit(ext);
    gitCommit(ext, "feat: clean subject\n\nclean body");
    const forbidden = join(FIXTURE, "forbidden.txt");
    const r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--pr-text", join(FIXTURE, "pr-body.md"), "--json"], { cwd: dir });
    assert.equal(r.code, expected.exit, r.stdout);
    const b = by(r.json);
    for (const [id, verdict] of Object.entries(expected.verdicts)) assert.equal(b[id]?.verdict, verdict, `${id}: ${JSON.stringify(b[id])}`);
    assert.ok(!b.protocol, "no undeclared ids");

    assert.deepEqual(b["scan-files"].details, [{ file: "src/index.ts", line: 1, text: "AbCdEfGhIjK" }]);
    assert.deepEqual(b["scan-names"].details, [{ file: "docs/example_user.md", text: "example_user" }]);
    assert.deepEqual(b["scan-pr-text"].details, [
      { file: join(FIXTURE, "pr-body.md"), line: 1, text: "AbCdEfGhIjK" },
      { file: join(FIXTURE, "pr-body.md"), line: 1, text: "example_user" },
    ]);
    assert.deepEqual(b["scan-binary"].details, [{ file: "assets/icon.png", text: "binary, not scanned" }]);
    assert.match(b["scan-commits"].message, /1 commit message\(s\) clean \(HEAD\)/);

    const hash = createHash("sha256").update(readFileSync(forbidden)).digest("hex");
    assert.equal(r.json.data.forbiddenHash, `sha256:${hash}`);
    assert.equal(r.json.data.forbiddenCount, 2);
    assert.equal(r.json.data.range, "HEAD");
    assert.equal(r.json.data.hits, 4);
    assert.deepEqual(r.json.data.binaries, ["assets/icon.png"]);
  });
});

test("the payload is what ray copies: gitignored and untracked files are scanned, node_modules and .git are not", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    mkdirSync(join(ext, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(ext, ".github"));
    writeFileSync(join(ext, ".gitignore"), "notes.local\n");
    writeFileSync(join(ext, "notes.local"), "ignored but copied: AbCdEfGhIjK\n");
    writeFileSync(join(ext, "untracked.md"), "AbCdEfGhIjK\n");
    writeFileSync(join(ext, "node_modules", "dep", "x.js"), "AbCdEfGhIjK");
    writeFileSync(join(ext, ".github", "AbCdEfGhIjK.yml"), "AbCdEfGhIjK");
    writeFileSync(join(ext, "raycast-env.d.ts"), "AbCdEfGhIjK");
    gitCommit(ext, "init");
    const forbidden = join(dir, "forbidden.txt");
    writeFileSync(forbidden, "AbCdEfGhIjK\n");
    const r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--json"], { cwd: dir });
    const b = by(r.json);
    assert.equal(b["scan-files"].verdict, "FAIL");
    assert.deepEqual(b["scan-files"].details.map((/** @type {any} */ d) => d.file).sort(), ["notes.local", "untracked.md"]);
    assert.equal(b["scan-names"].verdict, "PASS", "the .github name is skipped like ray does");
    assert.equal(b["scan-pr-text"].verdict, "N/A");
    assert.match(b["scan-pr-text"].message, /no --pr-text given/);
    assert.equal(b["scan-binary"].verdict, "PASS");
  });
});

test("a file symlink is scanned through to its target (external too); a dangling target is ERROR scan-files", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    writeFileSync(join(dir, "outside.md"), "line one\nleaks AbCdEfGhIjK via a link\n");
    symlinkSync(join(dir, "outside.md"), join(ext, "linked.md"));
    const forbidden = join(dir, "forbidden.txt");
    writeFileSync(forbidden, "AbCdEfGhIjK\n");
    let r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--json"], { cwd: dir });
    let b = by(r.json);
    assert.equal(b["scan-files"].verdict, "FAIL", JSON.stringify(b["scan-files"]));
    assert.deepEqual(b["scan-files"].details, [{ file: "linked.md", line: 2, text: "AbCdEfGhIjK" }]);

    symlinkSync(join(dir, "gone.md"), join(ext, "dangling.md"));
    r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--json"], { cwd: dir });
    assert.equal(r.code, 2, r.stdout);
    b = by(r.json);
    assert.equal(b["scan-files"].verdict, "ERROR");
    assert.match(b["scan-files"].message, /could not be read/);
    assert.equal(b["scan-files"].details[0].file, "dangling.md");
    assert.match(b["scan-files"].details[0].text, /symlink to .*gone\.md: .*ENOENT/);
    assert.deepEqual(b["scan-files"].details[1], { file: "linked.md", line: 2, text: "AbCdEfGhIjK" }, "hits in the readable files are still listed");
    assert.equal(b["scan-names"].verdict, "PASS");
  });
});

test("commit range: all history without the publish tag; HEAD...<tag> once ray has published", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "first: mentions AbCdEfGhIjK in the subject");
    gitCommit(ext, "second\n\nbody line\nAbCdEfGhIjK in the body");
    const forbidden = join(dir, "forbidden.txt");
    writeFileSync(forbidden, "AbCdEfGhIjK\n");
    let r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--json"], { cwd: dir });
    let b = by(r.json);
    assert.equal(b["scan-commits"].verdict, "FAIL");
    assert.equal(b["scan-commits"].details.length, 2, JSON.stringify(b["scan-commits"].details));
    assert.ok(b["scan-commits"].details.every((/** @type {any} */ d) => /^commit:[0-9a-f]{7}$/.test(d.file)));
    assert.deepEqual(b["scan-commits"].details.map((/** @type {any} */ d) => d.line).sort(), [1, 4], "subject line 1, body line 4");
    assert.equal(r.json.data.range, "HEAD");

    // Tag the second commit as published; a third clean commit is the only one in range.
    execFileSync("git", ["tag", publishTag("ext"), "HEAD"], { cwd: ext });
    gitCommit(ext, "third: clean");
    r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--json"], { cwd: dir });
    b = by(r.json);
    assert.equal(r.json.data.range, `HEAD...${publishTag("ext")}`);
    assert.equal(b["scan-commits"].verdict, "PASS", JSON.stringify(b["scan-commits"]));
    assert.match(b["scan-commits"].message, /1 commit message\(s\) clean/);
  });
});

test("an empty forbidden list makes every check N/A (every example approved), never PASS, exit 0", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    const forbidden = join(dir, "forbidden.txt");
    writeFileSync(forbidden, "# only a comment\n\n");
    const r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--pr-text", forbidden, "--json"], { cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(r.json.results.length, 5);
    for (const x of r.json.results) {
      assert.equal(x.verdict, "N/A", x.id);
      assert.match(x.message, /every example approved \(forbidden list is empty\)/);
    }
    assert.equal(r.json.data.forbiddenCount, 0);
    assert.match(r.json.data.forbiddenHash, /^sha256:[0-9a-f]{64}$/);
  });
});

test("inputs that cannot be read are ERROR input (exit 2): missing --forbidden, missing --pr-text", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    let r = await rx(["scan", "--root", ext, "--forbidden", join(dir, "nope.txt"), "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "input");
    const forbidden = join(dir, "forbidden.txt");
    writeFileSync(forbidden, "x\n");
    r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--pr-text", join(dir, "missing.md"), "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.json.results[0].message, /--pr-text .*missing\.md/);
    r = await rx(["scan", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 2, "--forbidden is required");
    assert.match(r.json.results[0].message, /missing --forbidden/);
  });
});

test("outside a git work tree the commit scan is ERROR scan-commits while the other scans still run", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    writeFileSync(join(ext, "a.txt"), "clean\n");
    const forbidden = join(dir, "forbidden.txt");
    writeFileSync(forbidden, "AbCdEfGhIjK\n");
    const r = await rx(["scan", "--root", ext, "--forbidden", forbidden, "--json"], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } });
    assert.equal(r.code, 2);
    const b = by(r.json);
    assert.equal(b["scan-commits"].verdict, "ERROR");
    assert.equal(b["scan-files"].verdict, "PASS");
    assert.equal(r.json.data.range, null);
  });
});

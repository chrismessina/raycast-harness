import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LOCAL_ONLY, expandForKeep, fingerprint, keepPathsFor, move, performMoves, readPresetFields } from "../src/commands/holdout.mjs";
import { REPO, fakeExtension, rx, withTempDir } from "./helpers.mjs";
import { computeFingerprints } from "../src/fingerprint.mjs";
import { listPayload } from "../src/payload.mjs";

const FIXTURE = join(REPO, "test", "fixtures", "holdout", "basic");

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
/** @param {string} dir */
function gitStatus(dir) {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" });
}
/** @param {any} json */
const by = (json) => Object.fromEntries(json.results.map((/** @type {any} */ x) => [x.id, x]));

/** Plant the local-only files the fixture test expects. @param {string} ext */
function plantLocalOnly(ext) {
  writeFileSync(join(ext, ".env"), "TOKEN=secret\n");
  mkdirSync(join(ext, ".claude"));
  writeFileSync(join(ext, ".claude", "settings.json"), "{ \"a\": 1 }\n");
  mkdirSync(join(ext, ".superpowers", "deep"), { recursive: true });
  writeFileSync(join(ext, ".superpowers", "deep", "state"), "s\n");
  symlinkSync("deep/state", join(ext, ".superpowers", "link"));
}

test("readPresetFields: defaults when holdout.localOnly is absent, reads ship.keep paths, rejects bad shapes and escaping paths", async () => {
  await withTempDir((dir) => {
    const p = join(dir, "p.json");
    writeFileSync(p, JSON.stringify({ anything: 1 }));
    assert.deepEqual(readPresetFields(p), { localOnly: [...DEFAULT_LOCAL_ONLY], keep: [] });
    writeFileSync(p, JSON.stringify({ holdout: { localOnly: [".claude/", "./x"] }, ship: { keep: [{ path: "TODO.md", extensions: ["brew"], reason: "r" }] }, other: {} }));
    assert.deepEqual(readPresetFields(p), { localOnly: [".claude", "x"], keep: [{ path: "TODO.md", extensions: ["brew"] }] });
    assert.deepEqual(keepPathsFor(readPresetFields(p).keep, "brew"), ["TODO.md"]);
    assert.deepEqual(keepPathsFor(readPresetFields(p).keep, "other"), [], "a keep for another extension never applies here");
    assert.deepEqual(keepPathsFor(readPresetFields(p).keep, null), []);
    writeFileSync(p, JSON.stringify({ ship: { keep: [{ path: "TODO.md", reason: "no extensions list" }] } }));
    assert.throws(() => readPresetFields(p), /ship\.keep must be an array of \{ path, extensions: string\[\]/);
    writeFileSync(p, JSON.stringify({ holdout: { localOnly: "nope" } }));
    assert.throws(() => readPresetFields(p), /holdout\.localOnly must be an array/);
    writeFileSync(p, JSON.stringify({ holdout: { localOnly: ["../escape"] } }));
    assert.throws(() => readPresetFields(p), /inside the root/);
    writeFileSync(p, "{ not json");
    assert.throws(() => readPresetFields(p), /--preset/);
    assert.throws(() => readPresetFields(join(dir, "missing.json")), /ENOENT/);
  });
});

test("expandForKeep: equal path is kept, a kept file inside a local-only dir splits the dir, a kept ancestor does not protect a descendant", async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}");
    writeFileSync(join(dir, ".claude", "commands", "release.md"), "r");
    writeFileSync(join(dir, ".claude", "commands", "other.md"), "o");
    writeFileSync(join(dir, ".env"), "x");
    assert.deepEqual(expandForKeep(dir, ".env", [".env"]), { move: [], kept: [".env"] });
    assert.deepEqual(expandForKeep(dir, ".env", []), { move: [".env"], kept: [] });
    assert.deepEqual(expandForKeep(dir, ".claude", [".claude/commands/release.md"]), { move: [".claude/commands/other.md", ".claude/settings.json"], kept: [".claude/commands/release.md"] });
    assert.deepEqual(expandForKeep(dir, ".claude/settings.json", [".claude"]), { move: [".claude/settings.json"], kept: [] }, "a local-only descendant of a kept directory moves");
    assert.deepEqual(expandForKeep(dir, ".claude", [".claude/nothing-here"]), { move: [".claude/commands", ".claude/settings.json"], kept: [] });
  });
});

test("fingerprint: file by bytes, symlink by target, directory by its sorted tree; location does not matter", async () => {
  await withTempDir((dir) => {
    mkdirSync(join(dir, "a", "sub"), { recursive: true });
    writeFileSync(join(dir, "a", "sub", "f"), "x");
    symlinkSync("sub/f", join(dir, "a", "l"));
    cpSync(join(dir, "a"), join(dir, "b"), { recursive: true, verbatimSymlinks: true });
    const fa = fingerprint(join(dir, "a"));
    assert.equal(fa.type, "dir");
    assert.deepEqual(fingerprint(join(dir, "b")), fa);
    assert.equal(fingerprint(join(dir, "a", "l")).type, "symlink");
    assert.equal(fingerprint(join(dir, "a", "sub", "f")).type, "file");
    writeFileSync(join(dir, "b", "sub", "f"), "y");
    assert.notEqual(fingerprint(join(dir, "b")).hash, fa.hash);
  });
});

test("fixture basic: out moves the three untracked entries, in restores and verifies them; the tree ends byte-identical", async () => {
  await withTempDir(async (dir) => {
    const expected = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8"));
    const ext = join(dir, "ext");
    cpSync(join(FIXTURE, "extension"), ext, { recursive: true });
    gitInit(ext);
    gitCommit(ext, "init");
    plantLocalOnly(ext);
    const before = gitStatus(ext);
    const beforeFp = { env: fingerprint(join(ext, ".env")), claude: fingerprint(join(ext, ".claude")), sp: fingerprint(join(ext, ".superpowers")) };

    const out = await rx(["holdout", "out", "--root", ext, "--preset", join(FIXTURE, "preset.json"), "--json"], { cwd: dir });
    assert.equal(out.code, expected.out.exit, out.stdout);
    let b = by(out.json);
    for (const id of ["holdout-out", "holdout-tracked", "holdout-inventory"]) assert.equal(b[id]?.verdict, expected.out[id], `${id}: ${JSON.stringify(b[id])}`);
    assert.ok(!b.protocol);
    assert.deepEqual(out.json.data.moved.map((/** @type {any} */ m) => m.source), [".env", ".claude", ".superpowers"]);
    assert.deepEqual(out.json.data.moved.map((/** @type {any} */ m) => m.type), ["file", "dir", "dir"]);
    assert.deepEqual(out.json.data.skipped, [{ path: "TODO.md", reason: "ship.keep: the preset ships it for basic" }], "TODO.md is tracked AND kept; keep wins and it is never a FAIL; the other-ext keep for .env did not apply");
    assert.equal(JSON.parse(readFileSync(join(ext, ".git", "rx", "holdout", "inventory.json"), "utf8")).root, realpathSync(ext), "inventory records the extension root");
    assert.deepEqual(out.json.data.restored, []);
    for (const p of [".env", ".claude", ".superpowers"]) assert.ok(!existsSync(join(ext, p)), `${p} moved out`);
    assert.ok(existsSync(join(ext, "TODO.md")));
    const inventory = join(ext, ".git", "rx", "holdout", "inventory.json");
    assert.ok(existsSync(inventory), "inventory under .git/rx/holdout");
    const inv = JSON.parse(readFileSync(inventory, "utf8"));
    assert.equal(inv.entries.length, 3);
    for (const e of inv.entries) {
      assert.ok(existsSync(e.destination), e.destination);
      assert.ok(e.destination.startsWith(realpathSync(join(ext, ".git", "rx", "holdout", "files"))), e.destination);
      assert.deepEqual(Object.keys(e).sort(), ["destination", "hash", "source", "type"]);
    }
    assert.equal(gitStatus(ext), "", "the tree is clean for ray publish");

    const back = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(back.code, expected.in.exit, back.stdout);
    b = by(back.json);
    for (const id of ["holdout-inventory", "holdout-in"]) assert.equal(b[id]?.verdict, expected.in[id], `${id}: ${JSON.stringify(b[id])}`);
    assert.equal(back.json.data.restored.length, 3);
    assert.deepEqual(back.json.data.moved, []);
    assert.equal(gitStatus(ext), before, "byte-identical status");
    assert.deepEqual(fingerprint(join(ext, ".env")), beforeFp.env);
    assert.deepEqual(fingerprint(join(ext, ".claude")), beforeFp.claude);
    assert.deepEqual(fingerprint(join(ext, ".superpowers")), beforeFp.sp);
    assert.ok(lstatSync(join(ext, ".superpowers", "link")).isSymbolicLink(), "symlink restored as a symlink");
    assert.ok(!existsSync(inventory), "inventory cleared after a full restore");
    assert.ok(!existsSync(join(ext, ".git", "rx", "holdout", "files")), "files dir pruned");
  });
});

test("out never moves a tracked local-only path: FAIL holdout-tracked, the file stays, the tree stays clean", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    mkdirSync(join(ext, ".claude"));
    writeFileSync(join(ext, ".claude", "settings.json"), "{}");
    writeFileSync(join(ext, ".gitignore"), ".claude/\n"); // tracked-and-ignored, the mirror case
    execFileSync("git", ["add", "-f", ".claude", ".gitignore", "package.json"], { cwd: ext });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: ext });
    writeFileSync(join(ext, ".env"), "x\n");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, "{}");
    const r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    const b = by(r.json);
    assert.equal(b["holdout-tracked"].verdict, "FAIL");
    assert.deepEqual(b["holdout-tracked"].details.map((/** @type {any} */ d) => d.file), [".claude"]);
    assert.equal(b["holdout-out"].verdict, "PASS", "the untracked .env still moves");
    assert.equal(b["holdout-inventory"].verdict, "PASS");
    assert.ok(existsSync(join(ext, ".claude", "settings.json")), "tracked file untouched");
    assert.ok(!existsSync(join(ext, ".env")));
    assert.equal(gitStatus(ext), "");
    assert.deepEqual(r.json.data.skipped, [{ path: ".claude", reason: "tracked" }]);
    const back = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(back.code, 0, back.stdout);
  });
});

test("following the holdout-tracked remedy as written ends in a clean holdout", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    writeFileSync(join(ext, "AGENTS.md"), "# Agents\n");
    gitCommit(ext, "init: AGENTS.md committed in the mirror");
    writeFileSync(join(ext, ".env"), "x\n");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, JSON.stringify({ holdout: { localOnly: [".env", "AGENTS.md"] } }));
    const args = ["holdout", "out", "--root", ext, "--preset", preset, "--json"];
    let r = await rx(args, { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    assert.equal(by(r.json)["holdout-out"].verdict, "PASS", "the untracked .env moved");
    // The remedy, step by step: untrack, ignore, commit, restore, hold out again.
    execFileSync("git", ["rm", "-q", "--cached", "AGENTS.md"], { cwd: ext });
    writeFileSync(join(ext, ".gitignore"), "AGENTS.md\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: ext });
    execFileSync("git", ["commit", "-q", "-m", "untrack AGENTS.md"], { cwd: ext });
    const back = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(back.code, 0, back.stdout);
    r = await rx(args, { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    const b = by(r.json);
    assert.equal(b["holdout-tracked"].verdict, "PASS");
    assert.deepEqual(r.json.data.moved.map((/** @type {any} */ m) => m.source).sort(), [".env", "AGENTS.md"]);
    assert.ok(!existsSync(join(ext, "AGENTS.md")) && !existsSync(join(ext, ".env")));
  });
});

test("out with nothing to move: N/A holdout-out and a PASS inventory when no listed path exists; ERROR when one exists but was not moved", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, "{}");
    let r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    let b = by(r.json);
    assert.equal(b["holdout-out"].verdict, "N/A");
    assert.match(b["holdout-out"].message, /nothing untracked matches/);
    assert.equal(b["holdout-inventory"].verdict, "PASS");

    // A listed path exists but is tracked: not movable, so no ERROR (FAIL holdout-tracked instead).
    writeFileSync(join(ext, ".env"), "x\n");
    execFileSync("git", ["add", "-f", ".env"], { cwd: ext });
    execFileSync("git", ["commit", "-q", "-m", "oops"], { cwd: ext });
    r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    b = by(r.json);
    assert.equal(b["holdout-inventory"].verdict, "PASS");
    assert.equal(b["holdout-tracked"].verdict, "FAIL");

    // A movable path exists and nothing moved (the move itself failed because the files dir is
    // occupied by a regular file): the #32975 shape, ERROR.
    writeFileSync(join(ext, ".claude"), "untracked file named .claude\n");
    mkdirSync(join(ext, ".git", "rx", "holdout"), { recursive: true });
    writeFileSync(join(ext, ".git", "rx", "holdout", "files"), "not a directory");
    r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 2, r.stdout);
    b = by(r.json);
    assert.equal(b["holdout-inventory"].verdict, "ERROR");
    assert.match(b["holdout-inventory"].message, /inventory is empty while movable local-only path\(s\) exist.*\.claude/);
    assert.match(b["holdout-inventory"].details[0].text, /move failed/);
    assert.ok(existsSync(join(ext, ".claude")), "nothing lost");
    assert.deepEqual(JSON.parse(readFileSync(join(ext, ".git", "rx", "holdout", "inventory.json"), "utf8")).entries, [], "no phantom entries");
  });
});

test("ship.keep is ancestor/descendant aware and per extension: the kept file stays, the rest of .claude moves, and in restores it", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    mkdirSync(join(ext, ".claude", "commands"), { recursive: true });
    writeFileSync(join(ext, ".claude", "settings.json"), "{}");
    writeFileSync(join(ext, ".claude", "commands", "release.md"), "kept");
    writeFileSync(join(ext, ".claude", "commands", "scratch.md"), "moves");
    const preset = join(dir, "preset.json");
    const keep = (/** @type {string[]} */ extensions) =>
      writeFileSync(preset, JSON.stringify({ holdout: { localOnly: [".claude"] }, ship: { keep: [{ path: ".claude/commands/release.md", extensions, reason: "shipped command" }] } }));
    keep(["ext"]);
    let r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.json.data.moved.map((/** @type {any} */ m) => m.source), [".claude/commands/scratch.md", ".claude/settings.json"]);
    assert.deepEqual(r.json.data.skipped, [{ path: ".claude/commands/release.md", reason: "ship.keep: the preset ships it for ext" }]);
    assert.equal(readFileSync(join(ext, ".claude", "commands", "release.md"), "utf8"), "kept");
    assert.ok(!existsSync(join(ext, ".claude", "settings.json")));
    r = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(readFileSync(join(ext, ".claude", "commands", "scratch.md"), "utf8"), "moves");

    // The same keep entry for a different extension does not protect this one.
    keep(["some-other-extension"]);
    r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.json.data.moved.map((/** @type {any} */ m) => m.source), [".claude"]);
    assert.deepEqual(r.json.data.skipped, []);
    assert.ok(!existsSync(join(ext, ".claude")));
    r = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(readFileSync(join(ext, ".claude", "commands", "release.md"), "utf8"), "kept");
  });
});

test("monorepo: in refuses to restore into a different extension root than the inventory records", async () => {
  await withTempDir(async (dir) => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    gitInit(repo);
    const a = fakeExtension(repo, "a");
    const b = fakeExtension(repo, "b");
    gitCommit(repo, "init");
    writeFileSync(join(a, ".env"), "a-secret\n");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, "{}");
    let r = await rx(["holdout", "out", "--root", a, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    r = await rx(["holdout", "in", "--root", b, "--json"], { cwd: dir });
    assert.equal(r.code, 2, r.stdout);
    assert.equal(by(r.json)["holdout-inventory"].verdict, "ERROR");
    assert.match(by(r.json)["holdout-inventory"].message, /inventory belongs to .*\/a, not .*\/b/);
    assert.ok(!existsSync(join(b, ".env")), "nothing landed in b");
    r = await rx(["holdout", "in", "--root", a, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(readFileSync(join(a, ".env"), "utf8"), "a-secret\n");
  });
});

test("in refuses to overwrite a destination that changed, keeps the held-out copy, leaves the entry in the inventory; identical content is accepted", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    writeFileSync(join(ext, ".env"), "original\n");
    mkdirSync(join(ext, ".claude"));
    writeFileSync(join(ext, ".claude", "s.json"), "{}");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, "{}");
    let r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    // ray left a placeholder with other content at .env; .claude reappeared byte-identical.
    writeFileSync(join(ext, ".env"), "placeholder\n");
    mkdirSync(join(ext, ".claude"));
    writeFileSync(join(ext, ".claude", "s.json"), "{}");

    r = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    let b = by(r.json);
    assert.equal(b["holdout-in"].verdict, "FAIL");
    assert.deepEqual(b["holdout-in"].details.map((/** @type {any} */ d) => d.file), [".env"]);
    assert.match(b["holdout-in"].details[0].text, /destination changed since the holdout/);
    assert.equal(readFileSync(join(ext, ".env"), "utf8"), "placeholder\n", "not overwritten");
    assert.deepEqual(r.json.data.restored.map((/** @type {any} */ e) => e.source), [".claude"]);
    const inventory = join(ext, ".git", "rx", "holdout", "inventory.json");
    const inv = JSON.parse(readFileSync(inventory, "utf8"));
    assert.deepEqual(inv.entries.map((/** @type {any} */ e) => e.source), [".env"], "only the refused entry remains");
    assert.equal(readFileSync(inv.entries[0].destination, "utf8"), "original\n", "held-out copy kept");

    // Running out again while an entry is still held out is refused.
    r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(by(r.json)["holdout-inventory"].message, /already in progress/);

    // Chris removes the placeholder; in now completes.
    execFileSync("rm", [join(ext, ".env")]);
    r = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    b = by(r.json);
    assert.equal(b["holdout-in"].verdict, "PASS");
    assert.equal(readFileSync(join(ext, ".env"), "utf8"), "original\n");
    assert.ok(!existsSync(inventory));
  });
});

test("in never destroys an edited held-out copy: it is verified against the inventory before being deleted as redundant or moved back", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    writeFileSync(join(ext, ".env"), "original\n");
    mkdirSync(join(ext, ".claude"));
    writeFileSync(join(ext, ".claude", "s.json"), "{}");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, "{}");
    let r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    const inventory = join(ext, ".git", "rx", "holdout", "inventory.json");
    const entries = JSON.parse(readFileSync(inventory, "utf8")).entries;
    const envHeld = entries.find((/** @type {any} */ e) => e.source === ".env").destination;
    const claudeHeld = entries.find((/** @type {any} */ e) => e.source === ".claude").destination;
    // Chris edits the held .env at the state path; ray leaves an identical placeholder at the source.
    writeFileSync(envHeld, "original plus an edit\n");
    writeFileSync(join(ext, ".env"), "original\n");
    // The held .claude is edited too, and nothing sits at its source: must not be moved back blindly.
    writeFileSync(join(claudeHeld, "s.json"), "{ edited: true }");

    r = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    const b = by(r.json);
    assert.equal(b["holdout-in"].verdict, "FAIL");
    assert.deepEqual(b["holdout-in"].details.map((/** @type {any} */ d) => d.file).sort(), [".claude", ".env"]);
    for (const d of b["holdout-in"].details) {
      assert.match(d.text, /held-out copy changed since the holdout/);
      assert.match(d.text, /reconcile by hand/);
      assert.match(d.text, /sha256:[0-9a-f]{64}.*inventory sha256:[0-9a-f]{64}/, "both hashes named");
    }
    const envDetail = b["holdout-in"].details.find((/** @type {any} */ d) => d.file === ".env").text;
    assert.ok(envDetail.includes(envHeld), "held path named");
    assert.match(envDetail, /destination .*\.env also present/, "destination path named");
    assert.equal(readFileSync(envHeld, "utf8"), "original plus an edit\n", "edited held copy survives");
    assert.equal(readFileSync(join(ext, ".env"), "utf8"), "original\n", "destination untouched");
    assert.equal(readFileSync(join(claudeHeld, "s.json"), "utf8"), "{ edited: true }", "edited held dir survives, not moved");
    assert.ok(!existsSync(join(ext, ".claude")), "not moved back blindly");
    assert.equal(JSON.parse(readFileSync(inventory, "utf8")).entries.length, 2, "inventory kept for both");
    assert.deepEqual(r.json.data.restored, []);
  });
});

test("in without an inventory is ERROR holdout-inventory; a missing held-out copy is FAIL holdout-in", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    let r = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 2, r.stdout);
    assert.equal(by(r.json)["holdout-inventory"].verdict, "ERROR");
    assert.match(by(r.json)["holdout-inventory"].message, /no inventory/);

    writeFileSync(join(ext, ".env"), "x\n");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, "{}");
    r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 0);
    execFileSync("rm", ["-r", join(ext, ".git", "rx", "holdout", "files")]);
    r = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    assert.match(by(r.json)["holdout-in"].details[0].text, /held-out copy missing/);
    assert.ok(existsSync(join(ext, ".git", "rx", "holdout", "inventory.json")), "entry stays recorded");
  });
});

test("arguments: out needs --preset, in takes none, an unknown subcommand and a non-repo root are exit 2", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    let r = await rx(["holdout", "out", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.json.results[0].message, /missing --preset/);
    r = await rx(["holdout", "in", "--root", ext, "--preset", "x", "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.json.results[0].message, /unknown argument "--preset"/);
    r = await rx(["holdout", "sideways", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    const plain = fakeExtension(dir, "plain");
    r = await rx(["holdout", "in", "--root", plain, "--json"], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } });
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "git");
    assert.ok(readdirSync(plain).includes("package.json"));
  });
});

// The 2026-11-03 ruling: AGENTS.md, CONCEPTS.md, CLAUDE.md and HANDOFF.md never ship. A preset that
// lists them in holdout.localOnly keeps them in the mirror and out of the payload ray publish copies.
const RULED = ["AGENTS.md", "CONCEPTS.md", "CLAUDE.md", "HANDOFF.md"];

test("the four ruled files: out moves each one out of the payload (and out of the payload fingerprint), in restores each byte for byte", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    gitCommit(ext, "init");
    for (const f of RULED) writeFileSync(join(ext, f), `# ${f}\n`);
    const preset = join(dir, "preset.json");
    writeFileSync(preset, JSON.stringify({ holdout: { localOnly: [".env", ...RULED] } }));
    const forbidden = join(dir, "forbidden.txt");
    writeFileSync(forbidden, "nothing-forbidden-here\n");
    const before = await computeFingerprints({ root: ext, version: "0.0.0", presetPath: preset, forbiddenPath: forbidden });
    assert.deepEqual(listPayload(ext).map((e) => e.path).filter((p) => RULED.includes(p)), RULED.slice().sort(), "before: all four would ship");

    const out = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(out.code, 0, out.stdout);
    assert.deepEqual(out.json.data.moved.map((/** @type {any} */ m) => m.source), RULED);
    assert.deepEqual(listPayload(ext).map((e) => e.path).filter((p) => RULED.includes(p)), [], "after out: none is in the payload");
    const held = await computeFingerprints({ root: ext, version: "0.0.0", presetPath: preset, forbiddenPath: forbidden });
    assert.notEqual(held.payload, before.payload, "the receipt's payload fingerprint reflects the holdout");

    const back = await rx(["holdout", "in", "--root", ext, "--json"], { cwd: dir });
    assert.equal(back.code, 0, back.stdout);
    for (const f of RULED) assert.equal(readFileSync(join(ext, f), "utf8"), `# ${f}\n`);
    const after = await computeFingerprints({ root: ext, version: "0.0.0", presetPath: preset, forbiddenPath: forbidden });
    assert.equal(after.payload, before.payload, "restored: the payload is what it was");
  });
});

test("holdout-tracked names the fix for a tracked AGENTS.md: git rm --cached it and list it in the extension's .gitignore", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    gitInit(ext);
    writeFileSync(join(ext, "AGENTS.md"), "# Agents\n");
    mkdirSync(join(ext, ".claude"));
    writeFileSync(join(ext, ".claude", "settings.json"), "{}");
    gitCommit(ext, "init: AGENTS.md and .claude committed in the mirror");
    const preset = join(dir, "preset.json");
    writeFileSync(preset, JSON.stringify({ holdout: { localOnly: [".claude", "AGENTS.md"] } }));
    const r = await rx(["holdout", "out", "--root", ext, "--preset", preset, "--json"], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    const t = by(r.json)["holdout-tracked"];
    assert.equal(t.verdict, "FAIL");
    assert.match(t.message, /tracked in this checkout's index; untrack each with git rm --cached and list it in the extension's \.gitignore/);
    const detail = Object.fromEntries(t.details.map((/** @type {any} */ d) => [d.file, d.text]));
    const q = (/** @type {string} */ v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(detail["AGENTS.md"], new RegExp(`run \`git -C ${q(ext)} rm --cached -- AGENTS\\.md\` \\(the file stays on disk\\), list AGENTS\\.md in that checkout's \\.gitignore`));
    assert.match(detail[".claude"], new RegExp(`run \`git -C ${q(ext)} rm -r --cached -- \\.claude\` \\(the file stays on disk\\), list \\.claude/ in that checkout's \\.gitignore`));
    for (const text of Object.values(detail)) assert.match(text, new RegExp(`then run \`rx holdout in --root ${q(ext)}\` to restore anything this run moved, and run \`rx holdout out\` again with the same arguments$`), "the remedy is bound to the root, restores first, and needs no commit");
    assert.ok(existsSync(join(ext, "AGENTS.md")), "a tracked file is never moved");
  });
});

test("move: a cross-device copy that fails leaves no partial destination; a copy that lands but cannot delete its source says it is held", async () => {
  await withTempDir((dir) => {
    const exdev = () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
    writeFileSync(join(dir, "src"), "secret\n");
    const dest = join(dir, "held", "src");
    assert.throws(() => move(join(dir, "src"), dest, {
      renameSync: exdev,
      cpSync: (/** @type {string} */ _f, /** @type {string} */ t) => { writeFileSync(t, "sec"); throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
      rmSync: (/** @type {string} */ p, /** @type {any} */ o) => rmSync(p, o),
    }), (/** @type {any} */ e) => e.code === "ENOSPC" && !e.held);
    assert.ok(!existsSync(dest), "the partial copy is removed, so a retry is not refused");
    assert.ok(existsSync(join(dir, "src")), "the source is untouched");

    assert.throws(() => move(join(dir, "src"), dest, {
      renameSync: exdev,
      cpSync: (/** @type {string} */ f, /** @type {string} */ t) => cpSync(f, t),
      rmSync: (/** @type {string} */ p) => { if (p === join(dir, "src")) throw Object.assign(new Error("busy"), { code: "EBUSY" }); rmSync(p, { recursive: true, force: true }); },
    }), (/** @type {any} */ e) => e.code === "EBUSY" && e.held === true);
    assert.equal(readFileSync(dest, "utf8"), "secret\n", "the complete copy stays held, for the inventory to record");
  });
});

test("performMoves: a held copy is recorded for the inventory but never reported as moved", () => {
  const entry = (/** @type {string} */ source) => ({ source, destination: `/held/${source}`, type: /** @type {const} */ ("file"), hash: "sha256:x" });
  const mover = (/** @type {string} */ from) => {
    if (from.endsWith("held")) throw Object.assign(new Error("busy"), { held: true });
    if (from.endsWith("bad")) throw new Error("denied");
  };
  const r = performMoves([entry("ok"), entry("held"), entry("bad")], "/root", mover, () => {});
  assert.deepEqual(r.moved.map((e) => e.source), ["ok"], "only a completed move counts as moved");
  assert.deepEqual(r.held.map((e) => e.source), ["held"], "a complete copy whose source remains is held, for the inventory");
  assert.deepEqual(r.failures.map((d) => d.file), ["held", "bad"]);
  assert.match(r.failures[0].text, /^copied, but the source could not be removed: busy$/);
});

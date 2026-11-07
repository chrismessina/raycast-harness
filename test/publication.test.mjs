// `rx publication record` and the shared publication-record validator (src/publication.mjs): the
// writer produces exactly { repo, pr, remoteSha, at }, and the writer and `rx greptile can-reply
// --claims-fix` refuse the same malformed records. No network: nothing here reaches GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spec } from "../src/commands/publication.mjs";
import { PUBLICATION_KEYS, publicationProblem, readPublication, recordFromOperands } from "../src/publication.mjs";
import { RxError } from "../src/errors.mjs";
import { REPO, fakeExtension, rx, rxProcess, withTempDir } from "./helpers.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const GOOD = Object.freeze({ repo: "raycast/extensions", pr: 31000, remoteSha: SHA, at: "2026-11-07T10:00:00.000Z" });

/** Malformed records, each with the part of the problem it must name. */
const MALFORMED = /** @type {[string, unknown, RegExp][]} */ ([
  ["not an object", "x", /JSON object/],
  ["an array", [], /JSON object/],
  ["a missing key", { repo: GOOD.repo, pr: GOOD.pr, remoteSha: GOOD.remoteSha }, /exactly the keys/],
  ["an extra key", { ...GOOD, attestation: "sig" }, /exactly the keys/],
  ["a repo without an owner", { ...GOOD, repo: "extensions" }, /owner\/name/],
  ["a string pr", { ...GOOD, pr: "31000" }, /positive integer/],
  ["a zero pr", { ...GOOD, pr: 0 }, /positive integer/],
  ["a short sha", { ...GOOD, remoteSha: "abc1234" }, /40-hex/],
  ["an uppercase sha", { ...GOOD, remoteSha: SHA.toUpperCase() }, /40-hex/],
  ["a non-ISO at", { ...GOOD, at: "x" }, /ISO-8601/],
  ["an impossible date", { ...GOOD, at: "2026-13-45T10:00:00Z" }, /ISO-8601/],
]);

/** @param {string} dir */
function gitExtension(dir) {
  const ext = fakeExtension(dir, "sample-ext");
  execFileSync("git", ["init", "-q"], { cwd: ext });
  return ext;
}

test("publicationProblem accepts exactly the record shape and names what is wrong with anything else", () => {
  assert.equal(publicationProblem({ ...GOOD }), null);
  assert.equal(publicationProblem({ ...GOOD, at: "2026-10-02T10:00:00Z" }), null, "seconds precision without millis is ISO-8601 too");
  assert.deepEqual([...PUBLICATION_KEYS], ["repo", "pr", "remoteSha", "at"]);
  for (const [what, value, why] of MALFORMED) assert.match(String(publicationProblem(value)), why, what);
});

test("recordFromOperands turns operand text into the record or throws ERROR args", () => {
  assert.deepEqual(recordFromOperands({ repo: GOOD.repo, pr: "31000", remoteSha: SHA, at: GOOD.at }), GOOD);
  for (const pr of ["0", "-1", "1.5", "031000", "x"]) {
    assert.throws(() => recordFromOperands({ repo: GOOD.repo, pr, remoteSha: SHA, at: GOOD.at }), (e) => e instanceof RxError && e.id === "args", pr);
  }
  assert.throws(() => recordFromOperands({ repo: GOOD.repo, pr: "1", remoteSha: "deadbeef", at: GOOD.at }), /40-hex/);
});

test("rx publication record writes exactly { repo, pr, remoteSha, at } to the extension's repo state", async () => {
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    mkdirSync(join(ext, "src"));
    const before = Date.now();
    const out = await rx(["publication", "record", "raycast/extensions", "31000", SHA, "--json"], { cwd: join(ext, "src") });
    assert.equal(out.code, 0, out.stdout);
    assert.deepEqual(out.json.results.map((/** @type {any} */ r) => [r.verdict, r.id]), [["PASS", "publication-record"]]);
    const file = join(ext, ".git", "rx", "publication.json");
    assert.equal(realpathSync(out.json.data.file), realpathSync(file));
    const text = readFileSync(file, "utf8");
    const rec = JSON.parse(text);
    assert.deepEqual(Object.keys(rec), ["repo", "pr", "remoteSha", "at"], "exactly these keys, in this order");
    assert.deepEqual({ ...rec, at: "?" }, { repo: "raycast/extensions", pr: 31000, remoteSha: SHA, at: "?" });
    assert.equal(typeof rec.pr, "number");
    assert.ok(Date.parse(rec.at) >= before - 1000 && Date.parse(rec.at) <= Date.now() + 1000, rec.at);
    assert.ok(text.endsWith("}\n"), "indented JSON with a trailing newline");
    assert.deepEqual(out.json.data.record, rec);
    assert.equal(readPublication(file)?.pr, 31000, "the reader accepts what the writer wrote");
  });
});

test("rx publication record: malformed operands are ERROR args and leave the previous record in place", async () => {
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    const file = join(ext, ".git", "rx", "publication.json");
    assert.equal((await rx(["publication", "record", "raycast/extensions", "31000", SHA], { cwd: ext })).code, 0);
    const kept = readFileSync(file, "utf8");
    for (const argv of [
      ["raycast/extensions", "31000", "deadbeef"],
      ["extensions", "31000", SHA],
      ["raycast/extensions", "0", SHA],
      ["raycast/extensions", "31000", SHA.toUpperCase()],
      ["raycast/extensions", "31000"],
    ]) {
      const out = await rx(["publication", "record", ...argv, "--json"], { cwd: ext });
      assert.equal(out.code, 2, argv.join(" "));
      assert.deepEqual(out.json.results.map((/** @type {any} */ r) => [r.verdict, r.id]), [["ERROR", "args"]], argv.join(" "));
      assert.equal(readFileSync(file, "utf8"), kept, `${argv.join(" ")} must not touch the record`);
    }
  });
});

test("rx publication record needs no extension: it records from a multi-extension repository root, from cwd or --root", async () => {
  await withTempDir(async (dir) => {
    const repo = join(dir, "checkout");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fakeExtension(repo, "ext-a");
    fakeExtension(repo, "ext-b"); // extension discovery from the root would be ambiguous
    const file = join(repo, ".git", "rx", "publication.json");
    const fromCwd = await rx(["publication", "record", "raycast/extensions", "31000", SHA, "--json"], { cwd: repo });
    assert.equal(fromCwd.code, 0, fromCwd.stdout);
    assert.equal(realpathSync(fromCwd.json.data.file), realpathSync(file));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pr, 31000);
    // --root names the repository from anywhere, including a directory outside any repository.
    const outside = join(dir, "elsewhere");
    mkdirSync(outside);
    const fromFlag = await rx(["publication", "record", "raycast/extensions", "31001", SHA, "--root", repo, "--json"], { cwd: outside });
    assert.equal(fromFlag.code, 0, fromFlag.stdout);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pr, 31001);
    assert.ok(!existsSync(join(outside, ".git")), "nothing is created in the working directory");
  });
});

test("rx publication record outside a git repository, or with a --root that is not a directory, is ERROR root and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const out = await rx(["publication", "record", "raycast/extensions", "31000", SHA, "--json"], { cwd: plain });
    assert.equal(out.code, 2, out.stdout);
    assert.deepEqual(out.json.results.map((/** @type {any} */ r) => [r.verdict, r.id]), [["ERROR", "root"]]);
    assert.match(out.json.results[0].message, /not inside a git repository/);
    const missing = await rx(["publication", "record", "raycast/extensions", "31000", SHA, "--root", join(dir, "nowhere"), "--json"], { cwd: plain });
    assert.equal(missing.code, 2);
    assert.match(missing.json.results[0].message, /^--root .* is not a directory/);
    assert.ok(!existsSync(join(plain, ".git")));
  });
});

test("the spec declares the contract: no extension root, no network, the state it writes, its one check", async () => {
  const sub = /** @type {any} */ (spec.subcommands).record;
  assert.equal(spec.root, "none");
  assert.equal(sub.root, "none");
  assert.equal(spec.network, "none");
  assert.equal(sub.network, "none");
  assert.match(sub.state, /repo\/publication\.json/);
  assert.deepEqual(Object.keys(sub.checks), ["publication-record"]);
  assert.deepEqual(sub.positionals.map((/** @type {any} */ p) => p.name), ["repo", "pr", "sha"]);
  const reg = await rx(["commands", "--json"]);
  const listed = reg.json.data.commands.find((/** @type {any} */ c) => c.name === "publication");
  assert.ok(listed, "rx commands --json lists publication");
  assert.equal(listed.subcommands.record.root, "none");
  assert.ok("--root" in listed.subcommands.record.flags);
});

test("readPublication: missing is null; unreadable or malformed is ERROR input (the reader refuses what the writer refuses)", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "publication.json");
    assert.equal(readPublication(file), null);
    writeFileSync(file, "{not json");
    assert.throws(() => readPublication(file), (e) => e instanceof RxError && e.id === "input" && /unreadable/.test(e.message));
    for (const [what, value, why] of MALFORMED) {
      writeFileSync(file, JSON.stringify(value));
      assert.throws(() => readPublication(file), (e) => e instanceof RxError && e.id === "input" && why.test(e.message), what);
    }
  });
});

test("rx publication record: git that cannot start is reported as git missing, not as a directory outside a repository", async () => {
  await withTempDir(async (dir) => {
    const empty = join(dir, "empty-path");
    mkdirSync(empty);
    const r = await rxProcess(["publication", "record", "raycast/extensions", "31000", "a".repeat(40), "--root", REPO, "--json"], { cwd: dir, env: { ...process.env, PATH: empty } });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    const res = JSON.parse(r.stdout).results[0];
    assert.notEqual(res.id, "root", res.message);
    assert.match(res.message, /git is not installed or not on PATH/);
  });
});

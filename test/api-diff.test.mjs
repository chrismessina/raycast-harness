// rx api-diff (plan 4.14; Q15–Q17, Q22): the npm side is a fake packer that tars fixture
// directories from test/fixtures/api-diff/, so no test touches the network. Extraction, the
// inventory and the declarations diff run for real.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { _setPacker } from "../src/commands/api-diff.mjs";
import { cliDiff, countDiff, isVersionOnly } from "../src/api-diff/compare.mjs";
import { REPO, rx, withTempDir } from "./helpers.mjs";

const FIX = join(REPO, "test", "fixtures", "api-diff");

/** Publish dates in this order (oldest first). @param {string[]} versions */
const timeMap = (versions) => ({
  created: "2020-01-01T00:00:00.000Z",
  modified: "2030-01-01T00:00:00.000Z",
  ...Object.fromEntries(versions.map((v, i) => [v, new Date(Date.UTC(2026, 0, 1 + i)).toISOString()])),
});

/**
 * @typedef {{ time: Record<string, unknown>, map: Record<string, string>, packed: { version: string, dest: string }[], timeCalls: number, onTime?: () => void }} Fake
 * `map` sends a version to a fixture dir name (or an absolute dir holding package/), or to "corrupt" (garbage .tgz) or "fail" (pack throws).
 */
/** @param {Record<string, string>} map @param {string[] | Record<string, unknown>} order @returns {Fake} */
function fake(map, order) {
  /** @type {Fake} */
  const f = { time: Array.isArray(order) ? timeMap(order) : order, map, packed: [], timeCalls: 0 };
  _setPacker({
    async time() { f.timeCalls++; if (f.onTime) f.onTime(); return f.time; },
    async pack(version, dest) {
      f.packed.push({ version, dest });
      const what = f.map[version];
      if (what === "fail") throw new Error(`npm error 404 No match found for version ${version}`);
      const tgz = join(dest, `raycast-api-${version}.tgz`);
      if (what === "corrupt") { writeFileSync(tgz, "this is not a gzip stream"); return tgz; }
      execFileSync("tar", ["-czf", tgz, "-C", isAbsolute(what) ? what : join(FIX, what), "package"]);
      return tgz;
    },
  });
  return f;
}
afterEach(() => _setPacker(null));

const by = (/** @type {any} */ r) => Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));
const texts = (/** @type {any} */ res) => res.details.map((/** @type {any} */ d) => d.text);

test("arguments: a range, a tag, latest and a partial version are ERROR args before npm is asked; a version not in time is ERROR args", async () => {
  const f = fake({ "1.0.0": "base-1.0.0", "1.0.1": "bump-1.0.1" }, ["1.0.0", "1.0.1"]);
  for (const bad of ["^1.0.0", "latest", "1.0", "v1.0.0", "next"]) {
    const r = await rx(["api-diff", bad, "1.0.1", "--json"]);
    assert.equal(r.code, 2, bad);
    assert.equal(r.json.results[0].id, "args");
    assert.match(r.json.results[0].message, /not an exact version/);
  }
  assert.equal(f.timeCalls, 0, "syntax is checked before the network");
  const missing = await rx(["api-diff", "1.0.0", "9.9.9", "--json"]);
  assert.equal(missing.code, 2);
  assert.equal(missing.json.results[0].id, "args");
  assert.match(missing.json.results[0].message, /9\.9\.9 is not a published @raycast\/api version/);
  assert.equal(f.packed.length, 0);
  const same = await rx(["api-diff", "1.0.0", "1.0.0", "--json"]);
  assert.equal(same.code, 2);
  assert.match(same.json.results[0].message, /same version/);
});

test("window: adjacent in publish order PASSes; others between WARN, in publish order not semver; either argument order", async () => {
  // 0.9.9 was published between 1.0.0 and 1.1.0; 1.0.1 (semver-between) was published after both.
  fake({ "1.0.0": "base-1.0.0", "1.1.0": "feature-1.1.0", "1.0.1": "bump-1.0.1" }, ["1.0.0", "0.9.9", "1.1.0", "1.0.1"]);
  const warn = await rx(["api-diff", "1.1.0", "1.0.0", "--json"]);
  assert.equal(warn.code, 0, warn.stdout);
  assert.equal(by(warn)["api-diff-window"].verdict, "WARN");
  assert.equal(by(warn)["api-diff-window"].message, "1 intermediate version(s): 0.9.9");
  assert.deepEqual(warn.json.data.window, ["0.9.9"]);
  assert.equal(warn.json.data.from, "1.0.0", "the earlier-published one is the baseline");
  assert.equal(warn.json.data.to, "1.1.0");
  assert.deepEqual(warn.json.data.published, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" });

  const adj = await rx(["api-diff", "1.1.0", "1.0.1", "--json"]);
  assert.equal(by(adj)["api-diff-window"].verdict, "PASS");
  assert.deepEqual(adj.json.data.window, []);
  assert.equal(adj.json.data.from, "1.1.0", "publish order, not semver order");
});

test("inventory: added, removed and changed paths with sizes; dist/types split out; summary and details", async () => {
  fake({ "1.0.0": "base-1.0.0", "1.1.0": "feature-1.1.0" }, ["1.0.0", "1.1.0"]);
  const r = await rx(["api-diff", "1.0.0", "1.1.0", "--json"]);
  assert.equal(r.code, 0, r.stdout);
  const d = r.json.data;
  assert.equal(d.package, "@raycast/api");
  assert.deepEqual(d.files.added, ["dist/types/new.d.ts", "dist/utils/skills.js"]);
  assert.deepEqual(d.files.removed, ["dist/types/gone.d.ts"]);
  assert.deepEqual(d.files.changed.map((/** @type {any} */ c) => c.path), [
    "dist/commands/version/index.js", "dist/index.js", "dist/types/a.d.ts", "oclif.manifest.json", "package.json", "types/index.d.ts",
  ]);
  const a = d.files.changed.find((/** @type {any} */ c) => c.path === "dist/types/a.d.ts");
  assert.deepEqual(a, { path: "dist/types/a.d.ts", fromBytes: 24, toBytes: 33, fromMode: "0644", toMode: "0644", versionOnly: false });
  assert.equal(d.versionOnly, false);
  assert.deepEqual(d.distTypes, { added: ["dist/types/new.d.ts"], removed: ["dist/types/gone.d.ts"], changed: ["dist/types/a.d.ts"] });
  assert.equal(d.dirs, null);
  const res = by(r)["api-diff"];
  assert.equal(res.verdict, "PASS");
  assert.equal(res.message, "2 added, 1 removed, 6 changed; types/index.d.ts +1 −1");
  const t = texts(res);
  assert.deepEqual(t.slice(0, 4), ["+ dist/types/new.d.ts", "+ dist/utils/skills.js", "- dist/types/gone.d.ts", "~ dist/commands/version/index.js 36→36"]);
  assert.ok(t.includes("~ dist/types/a.d.ts 24→33"));
});

test("declarations: unified diff of types/index.d.ts with labels and three lines of context; counts exclude the headers", async () => {
  fake({ "1.0.0": "base-1.0.0", "1.1.0": "feature-1.1.0" }, ["1.0.0", "1.1.0"]);
  const r = await rx(["api-diff", "1.0.0", "1.1.0", "--json"]);
  const decl = r.json.data.declarations;
  assert.equal(decl.path, "types/index.d.ts");
  assert.equal(decl.changed, true);
  assert.equal(decl.added, 1);
  assert.equal(decl.removed, 1);
  const lines = decl.diff.split("\n");
  assert.equal(lines[0], "--- a/types/index.d.ts");
  assert.equal(lines[1], "+++ b/types/index.d.ts");
  assert.match(lines[2], /^@@ /);
  assert.ok(lines.includes("-export declare function closeMainWindow(): Promise<void>;"));
  assert.ok(lines.includes("+export declare function showFailureToast(error: unknown): Promise<void>;"));
  assert.ok(lines.includes(" export declare function showHUD(title: string): Promise<void>;"), "three lines of context");
  // The diff follows the inventory in the details.
  const t = texts(by(r)["api-diff"]);
  assert.equal(t[t.indexOf("--- a/types/index.d.ts") + 1], "+++ b/types/index.d.ts");

  // A content line that reads like a header is content.
  assert.deepEqual(countDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- removed comment\n+++ added comment\n same\n"), { added: 1, removed: 1 });
  assert.deepEqual(countDiff(""), { added: 0, removed: 0 });
});

test("versionOnly: a version-string-only release is N/A; a same-length non-version digit edit is a real change (Q17)", async () => {
  fake({ "1.0.0": "base-1.0.0", "1.0.1": "bump-1.0.1" }, ["1.0.0", "1.0.1"]);
  const bump = await rx(["api-diff", "1.0.0", "1.0.1", "--json"]);
  assert.equal(bump.code, 0, bump.stdout);
  assert.equal(by(bump)["api-diff"].verdict, "N/A");
  assert.equal(by(bump)["api-diff"].message, "only version fields changed");
  assert.equal(bump.json.data.versionOnly, true);
  assert.ok(bump.json.data.files.changed.length > 0);
  assert.ok(bump.json.data.files.changed.every((/** @type {any} */ c) => c.versionOnly));
  assert.deepEqual(bump.json.data.declarations, { path: "types/index.d.ts", changed: false, added: 0, removed: 0, diff: "" });

  fake({ "1.0.0": "base-1.0.0", "1.0.1": "digit-1.0.1" }, ["1.0.0", "1.0.1"]);
  const digit = await rx(["api-diff", "1.0.0", "1.0.1", "--json"]);
  assert.equal(by(digit)["api-diff"].verdict, "PASS");
  assert.equal(digit.json.data.versionOnly, false);
  const idx = digit.json.data.files.changed.find((/** @type {any} */ c) => c.path === "dist/index.js");
  assert.equal(idx.fromBytes, idx.toBytes, "same length: equal sizes prove nothing");
  assert.equal(idx.versionOnly, false);
  assert.ok(digit.json.data.files.changed.filter((/** @type {any} */ c) => c.path !== "dist/index.js").every((/** @type {any} */ c) => c.versionOnly));

  assert.equal(isVersionOnly("x.js", Buffer.from('v="1.0.0";t=3000'), Buffer.from('v="1.0.1";t=3000'), "1.0.0", "1.0.1"), true);
  assert.equal(isVersionOnly("x.js", Buffer.from('v="1.0.0";t=3000'), Buffer.from('v="1.0.1";t=3001'), "1.0.0", "1.0.1"), false);
});

test("versionOnly is narrow: a dependency range that moves with the version, or a bundle holding the version twice, is a real change", async () => {
  fake({ "1.0.0": "base-1.0.0", "1.0.1": "deprange-1.0.1" }, ["1.0.0", "1.0.1"]);
  const r = await rx(["api-diff", "1.0.0", "1.0.1", "--json"]);
  assert.equal(by(r)["api-diff"].verdict, "PASS", r.stdout);
  assert.equal(r.json.data.versionOnly, false);
  const pj = r.json.data.files.changed.find((/** @type {any} */ c) => c.path === "package.json");
  assert.equal(pj.versionOnly, false, "package.json: version AND a dependency range moved");
  assert.ok(r.json.data.files.changed.filter((/** @type {any} */ c) => c.path !== "package.json").every((/** @type {any} */ c) => c.versionOnly));

  const j = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o));
  // .json: only the top-level version may differ; key order is ignored.
  assert.equal(isVersionOnly("package.json", j({ name: "a", version: "2.3.0", dependencies: { x: "2.3.0" } }), j({ dependencies: { x: "2.3.0" }, version: "2.3.1", name: "a" }), "2.3.0", "2.3.1"), true);
  assert.equal(isVersionOnly("package.json", j({ version: "2.3.0", dependencies: { x: "^2.3.0" } }), j({ version: "2.3.1", dependencies: { x: "^2.3.1" } }), "2.3.0", "2.3.1"), false);
  assert.equal(isVersionOnly("package.json", Buffer.from("{ not json"), j({ version: "2.3.1" }), "2.3.0", "2.3.1"), false);
  // Anything else: exactly one occurrence of the baseline version.
  assert.equal(isVersionOnly("dist/index.js", Buffer.from('a="2.3.0";b="2.3.0"'), Buffer.from('a="2.3.1";b="2.3.1"'), "2.3.0", "2.3.1"), false);
  assert.equal(isVersionOnly("dist/index.js", Buffer.from('a="2.3.0";b=1'), Buffer.from('a="2.3.1";b=1'), "2.3.0", "2.3.1"), true);
  assert.equal(isVersionOnly("dist/index.js", Buffer.from("no version here"), Buffer.from("no version here!"), "2.3.0", "2.3.1"), false);
});

test("pack failure for either version, or a corrupt tarball, is ERROR api-diff naming the version, never an empty diff (Q16)", async () => {
  for (const [map, version, re] of /** @type {[Record<string, string>, string, RegExp][]} */ ([
    [{ "1.0.0": "fail", "1.0.1": "bump-1.0.1" }, "1.0.0", /^1\.0\.0: pack failed: npm error 404/],
    [{ "1.0.0": "base-1.0.0", "1.0.1": "fail" }, "1.0.1", /^1\.0\.1: pack failed: npm error 404/],
    [{ "1.0.0": "corrupt", "1.0.1": "bump-1.0.1" }, "1.0.0", /^1\.0\.0: extraction failed: /],
    [{ "1.0.0": "base-1.0.0", "1.0.1": "corrupt" }, "1.0.1", /^1\.0\.1: extraction failed: /],
  ])) {
    fake(map, ["1.0.0", "1.0.1"]);
    const r = await rx(["api-diff", "1.0.0", "1.0.1", "--json"]);
    assert.equal(r.code, 2, `${version}: ${r.stdout}`);
    const err = r.json.results.find((/** @type {any} */ x) => x.verdict === "ERROR");
    assert.equal(err.id, "api-diff");
    assert.match(err.message, re);
    assert.ok(!r.json.results.some((/** @type {any} */ x) => x.id === "api-diff" && x.verdict !== "ERROR"), "no diff verdict beside the ERROR");
  }
});

test("cli: oclif.manifest.json commands and flags compared on both sides; a missing manifest gives empty lists and a detail line", async () => {
  fake({ "1.0.0": "base-1.0.0", "1.1.0": "feature-1.1.0", "1.2.0": "nomanifest-1.2.0" }, ["1.0.0", "1.1.0", "1.2.0"]);
  const r = await rx(["api-diff", "1.0.0", "1.1.0", "--json"]);
  assert.deepEqual(r.json.data.cli, {
    commandsAdded: ["evals"],
    commandsRemoved: ["legacy"],
    flagsAdded: [{ command: "build", flag: "emoji" }],
    flagsRemoved: [{ command: "build", flag: "output" }],
    changed: [{ path: "commands.lint.flags.fix.default", kind: "changed", from: false, to: true }],
  });
  const none = await rx(["api-diff", "1.1.0", "1.2.0", "--json"]);
  assert.deepEqual(none.json.data.cli, { commandsAdded: [], commandsRemoved: [], flagsAdded: [], flagsRemoved: [], changed: [] });
  assert.ok(texts(by(none)["api-diff"]).includes("oclif.manifest.json missing in 1.2.0; cli lists are empty"));
});

test("--out leaves both packages at <dir>/<version>/package/ and refuses to overwrite either", async () => {
  await withTempDir(async (dir) => {
    fake({ "1.0.0": "base-1.0.0", "1.1.0": "feature-1.1.0" }, ["1.0.0", "1.1.0"]);
    const out = join(dir, "out");
    const r = await rx(["api-diff", "1.0.0", "1.1.0", "--out", out, "--json"]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(r.json.data.dirs, { from: join(out, "1.0.0", "package"), to: join(out, "1.1.0", "package") });
    assert.ok(existsSync(join(out, "1.0.0", "package", "types", "index.d.ts")));
    assert.ok(existsSync(join(out, "1.1.0", "package", "dist", "utils", "skills.js")));

    const again = await rx(["api-diff", "1.0.0", "1.1.0", "--out", out, "--json"]);
    assert.equal(again.code, 2);
    assert.equal(again.json.results[0].id, "args");
    assert.match(again.json.results[0].message, /already exists; --out never overwrites/);

    const one = join(dir, "one");
    mkdirSync(join(one, "1.1.0"), { recursive: true });
    const half = await rx(["api-diff", "1.0.0", "1.1.0", "--out", one, "--json"]);
    assert.equal(half.code, 2);
    assert.match(half.json.results[0].message, /1\.1\.0 already exists/);
    assert.ok(!existsSync(join(one, "1.0.0")), "nothing extracted when either target exists");
  });
});

test("temp dirs are removed after a PASS and after an ERROR midway; an ERROR also removes what --out extracted", async () => {
  const f = fake({ "1.0.0": "base-1.0.0", "1.0.1": "bump-1.0.1" }, ["1.0.0", "1.0.1"]);
  const ok = await rx(["api-diff", "1.0.0", "1.0.1", "--json"]);
  assert.equal(ok.code, 0);
  const okRoot = dirname(dirname(f.packed[0].dest));
  assert.ok(!existsSync(okRoot), `${okRoot} removed after a PASS`);

  const g = fake({ "1.0.0": "base-1.0.0", "1.0.1": "fail" }, ["1.0.0", "1.0.1"]);
  const bad = await rx(["api-diff", "1.0.0", "1.0.1", "--json"]);
  assert.equal(bad.code, 2);
  assert.equal(g.packed.length, 2, "1.0.0 was packed and extracted before 1.0.1 failed");
  const badRoot = dirname(dirname(g.packed[0].dest));
  assert.ok(!existsSync(badRoot), `${badRoot} removed after an ERROR`);

  await withTempDir(async (dir) => {
    fake({ "1.0.0": "base-1.0.0", "1.0.1": "corrupt" }, ["1.0.0", "1.0.1"]);
    const out = join(dir, "out");
    const r = await rx(["api-diff", "1.0.0", "1.0.1", "--out", out, "--json"]);
    assert.equal(r.code, 2);
    assert.ok(!existsSync(join(out, "1.0.0")), "a partial --out extraction does not block the retry");
    assert.ok(!existsSync(join(out, "1.0.1")));
  });
});

test("text output: verdict lines with the inventory and diff indented beneath", async () => {
  fake({ "1.0.0": "base-1.0.0", "1.1.0": "feature-1.1.0" }, ["1.0.0", "1.1.0"]);
  const r = await rx(["api-diff", "1.0.0", "1.1.0"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^PASS {3}api-diff-window {2}1\.0\.0 → 1\.1\.0 are adjacent in publish order$/m);
  assert.match(r.stdout, /^PASS {3}api-diff {9}2 added, 1 removed, 6 changed; types\/index\.d\.ts \+1 −1$/m);
  assert.match(r.stdout, /^ {7}\+ dist\/utils\/skills\.js$/m);
  assert.match(r.stdout, /^ {7}\+\+\+ b\/types\/index\.d\.ts$/m);
});

/** Copy a fixture's parent dir to a temp location for a planted variant. @param {string} dir @param {string} name */
const variant = (dir, name) => { const d = join(dir, name); cpSync(join(FIX, name), d, { recursive: true }); return d; };

test("versionOnly outside JSON: only a whole quoted literal, in text, exactly once (substrings, URLs, prereleases and binary never qualify)", () => {
  const vo = (/** @type {string|Buffer} */ x, /** @type {string|Buffer} */ y, /** @type {string} */ f, /** @type {string} */ t) =>
    isVersionOnly("dist/index.js", Buffer.isBuffer(x) ? x : Buffer.from(x), Buffer.isBuffer(y) ? y : Buffer.from(y), f, t);
  assert.equal(vo('version:"1.0.0"', 'version:"1.0.1"', "1.0.0", "1.0.1"), true);
  assert.equal(vo("version:'1.0.0'", "version:'1.0.1'", "1.0.0", "1.0.1"), true);
  assert.equal(vo("url=2.1.1/model", "url=2.1.2/model", "2.1.1", "2.1.2"), false);
  assert.equal(vo("dep=2.1.10", "dep=2.1.20", "2.1.1", "2.1.2"), false);
  assert.equal(vo('dep="2.1.10"', 'dep="2.1.20"', "2.1.1", "2.1.2"), false);
  assert.equal(vo('dep="2.1.1-beta.10"', 'dep="2.1.1-beta.20"', "2.1.1-beta.1", "2.1.1-beta.2"), false);
  assert.equal(vo("v=\"1.0.0'", "v=\"1.0.1'", "1.0.0", "1.0.1"), false, "mismatched quotes");
  const bin = (/** @type {string} */ v) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x00, 0x01]), Buffer.from(`"${v}"`)]);
  assert.equal(vo(bin("2.1.1"), bin("2.1.2"), "2.1.1", "2.1.2"), false, "binary bytes with a match");
});

test("cli.changed records presence: absent → null is kind added with to: null and no from key; removal is kind removed", () => {
  const m = (/** @type {object} */ fix) => ({ commands: { lint: { id: "lint", flags: { fix } } } });
  const added = cliDiff(m({}), m({ default: null }));
  assert.deepEqual(added.changed, [{ path: "commands.lint.flags.fix.default", kind: "added", to: null }]);
  assert.ok(!("from" in added.changed[0]));
  const removed = cliDiff(m({ default: null }), m({}));
  assert.deepEqual(removed.changed, [{ path: "commands.lint.flags.fix.default", kind: "removed", from: null }]);
  assert.ok(!("to" in removed.changed[0]));
  assert.deepEqual(cliDiff(m({ default: null }), m({ default: null })).changed, []);
});

test("a timestamp tie on either endpoint is ERROR api-diff naming the tie, never a lexical order", async () => {
  const t = { created: "2020-01-01T00:00:00.000Z", modified: "2030-01-01T00:00:00.000Z", "2.1.1": "2026-01-01T00:00:00.000Z", "2.1.2": "2026-01-02T00:00:00.000Z", "2.1.10": "2026-01-02T00:00:00.000Z", "2.1.11": "2026-01-03T00:00:00.000Z" };
  const f = fake({ "2.1.1": "base-1.0.0", "2.1.2": "bump-1.0.1", "2.1.10": "bump-1.0.1", "2.1.11": "bump-1.0.1" }, t);
  const r = await rx(["api-diff", "2.1.1", "2.1.10", "--json"]);
  assert.equal(r.code, 2, r.stdout);
  const err = r.json.results.find((/** @type {any} */ x) => x.verdict === "ERROR");
  assert.equal(err.id, "api-diff");
  assert.equal(err.message, "2.1.10 has the same npm time as 2.1.2; the publish order is ambiguous");
  assert.equal(f.packed.length, 0);
  const other = await rx(["api-diff", "2.1.1", "2.1.11", "--json"]);
  assert.equal(other.code, 0, "a tie between two intermediate versions does not touch the endpoints");
});

test("a symlink inside an extracted package is ERROR api-diff naming the version and path; the host file never enters the diff", async () => {
  await withTempDir(async (dir) => {
    const v = variant(dir, "bump-1.0.1");
    const decl = join(v, "package", "types", "index.d.ts");
    rmSync(decl);
    const host = join(dir, "host-secret.d.ts");
    writeFileSync(host, "export declare const HOST_SECRET: string;\n");
    symlinkSync(host, decl);
    fake({ "1.0.0": "base-1.0.0", "1.0.1": v }, ["1.0.0", "1.0.1"]);
    const r = await rx(["api-diff", "1.0.0", "1.0.1", "--json"]);
    assert.equal(r.code, 2, r.stdout);
    const err = r.json.results.find((/** @type {any} */ x) => x.verdict === "ERROR");
    assert.equal(err.id, "api-diff");
    assert.equal(err.message, "1.0.1: read failed: types/index.d.ts is a symlink");
    assert.ok(!r.stdout.includes("HOST_SECRET"));
  });
});

test("a mode change with identical bytes is a change and never versionOnly; files.changed carries both modes", async () => {
  await withTempDir(async (dir) => {
    const v = variant(dir, "base-1.0.0");
    chmodSync(join(v, "package", "README.md"), 0o755);
    fake({ "1.0.0": v, "1.0.1": "bump-1.0.1" }, ["1.0.0", "1.0.1"]);
    const r = await rx(["api-diff", "1.0.0", "1.0.1", "--json"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(by(r)["api-diff"].verdict, "PASS", "not N/A: the mode moved");
    assert.equal(r.json.data.versionOnly, false);
    assert.deepEqual(r.json.data.files.changed.find((/** @type {any} */ c) => c.path === "README.md"),
      { path: "README.md", fromBytes: 15, toBytes: 15, fromMode: "0755", toMode: "0644", versionOnly: false });
  });
});

test("--out reserves <out>/<version> before any npm call; a file or dangling symlink there is refused; an ERROR removes only what this run reserved", async () => {
  await withTempDir(async (dir) => {
    // Reserved before npm: the time lookup already sees both directories.
    const out = join(dir, "out");
    const f = fake({ "1.0.0": "base-1.0.0", "1.0.1": "fail" }, ["1.0.0", "1.0.1"]);
    /** @type {boolean[]} */
    const seen = [];
    f.onTime = () => seen.push(existsSync(join(out, "1.0.0")), existsSync(join(out, "1.0.1")));
    mkdirSync(join(out, "keep"), { recursive: true });
    writeFileSync(join(out, "keep", "marker"), "theirs");
    const r = await rx(["api-diff", "1.0.0", "1.0.1", "--out", out, "--json"]);
    assert.equal(r.code, 2);
    assert.deepEqual(seen, [true, true], "both reserved before the first npm call");
    assert.ok(!existsSync(join(out, "1.0.0")) && !existsSync(join(out, "1.0.1")), "owned directories removed after the pack failure");
    assert.equal(readFileSync(join(out, "keep", "marker"), "utf8"), "theirs", "a pre-existing sibling is never removed");

    // A dangling symlink at <out>/1.0.1: refused; the 1.0.0 reservation is undone; the link stays.
    const dang = join(dir, "dang");
    mkdirSync(dang);
    symlinkSync(join(dir, "nowhere"), join(dang, "1.0.1"));
    fake({ "1.0.0": "base-1.0.0", "1.0.1": "bump-1.0.1" }, ["1.0.0", "1.0.1"]);
    const d = await rx(["api-diff", "1.0.0", "1.0.1", "--out", dang, "--json"]);
    assert.equal(d.code, 2);
    assert.equal(d.json.results[0].id, "args");
    assert.match(d.json.results[0].message, /1\.0\.1 already exists; --out never overwrites/);
    assert.ok(lstatSync(join(dang, "1.0.1")).isSymbolicLink(), "the pre-existing link is left alone");
    assert.ok(!existsSync(join(dang, "1.0.0")));

    // A plain file at <out>/1.0.0: refused before anything is reserved.
    const file = join(dir, "file");
    mkdirSync(file);
    writeFileSync(join(file, "1.0.0"), "not a dir");
    const g = fake({ "1.0.0": "base-1.0.0", "1.0.1": "bump-1.0.1" }, ["1.0.0", "1.0.1"]);
    const fr = await rx(["api-diff", "1.0.0", "1.0.1", "--out", file, "--json"]);
    assert.equal(fr.code, 2);
    assert.equal(fr.json.results[0].id, "args");
    assert.equal(readFileSync(join(file, "1.0.0"), "utf8"), "not a dir");
    assert.ok(!existsSync(join(file, "1.0.1")));
    assert.equal(g.timeCalls, 0, "refused before npm");
  });
});

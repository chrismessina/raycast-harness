// rx api-floor (plan 4.7, Q8): policy only from the preset; lockfile and manifest checked
// independently; publication only from rx stale's baseline; npm currency injected, never live.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { _setRegistry, rangeLowerBound } from "../src/commands/api-floor.mjs";
import { compareSemver } from "../src/preset/applies.mjs";
import { rx, withTempDir } from "./helpers.mjs";
import { LOCK, makeExt, HOUSE_PRESET } from "./preflight-helpers.mjs";

/** @type {string | null} */
let latest = null;
_setRegistry(async () => latest);

const by = (/** @type {any} */ r) => Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));
/** @param {string} dir @param {string} resolved @param {string} range */
const ext = (dir, resolved, range, name = "ext") => makeExt(join(dir, name), { pkg: { dependencies: { "@raycast/api": range } }, files: { "package-lock.json": LOCK(resolved) } });
/** Write what rx stale would. @param {string} root @param {boolean} published */
function baseline(root, published) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  const dir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "rx/stale"], { cwd: root, encoding: "utf8" }).trim();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "baseline.json"), JSON.stringify({ name: "ext", baseline: published ? "abc" : null, publishedDir: published ? "/tmp/x" : null, published, at: "2026-10-30T00:00:00Z" }));
}

test("1.x existing: at the floor passes, below it fails; manifest lower bound compared independently", async () => {
  await withTempDir(async (dir) => {
    latest = "2.10.0";
    const ok = await rx(["api-floor", "--root", ext(dir, "1.104.25", "^1.104.25", "ok"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(by(ok)["api-floor-lockfile"].verdict, "PASS");
    assert.equal(by(ok)["api-floor-manifest"].verdict, "PASS");
    assert.equal(by(ok)["api-floor-new"].verdict, "N/A");
    assert.match(by(ok)["api-floor-new"].message, /run rx stale first/);
    assert.equal(by(ok)["api-currency"].verdict, "WARN");
    assert.deepEqual(ok.json.data, { policy: "existing-1x", floor: "1.104.25", resolved: "1.104.25", range: "^1.104.25", latest: "2.10.0", publication: "unknown" });

    const below = await rx(["api-floor", "--root", ext(dir, "1.103.10", "^1.103.0", "below"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(below.code, 1);
    assert.equal(by(below)["api-floor-lockfile"].verdict, "FAIL");
    assert.equal(by(below)["api-floor-manifest"].verdict, "WARN");

    // Lockfile above the floor while the range still admits below it: WARN on the manifest only.
    const loose = await rx(["api-floor", "--root", ext(dir, "1.104.25", "^1.100.0", "loose"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(by(loose)["api-floor-lockfile"].verdict, "PASS");
    assert.equal(by(loose)["api-floor-manifest"].verdict, "WARN");
    assert.match(by(loose)["api-floor-manifest"].message, /admits 1\.100\.0/);
  });
});

test("2.x: floor 2.1.0; 2.0.6 fails; npm latest equal is PASS; unreachable npm is N/A while the floor checks still run", async () => {
  await withTempDir(async (dir) => {
    latest = "2.1.0";
    const ok = await rx(["api-floor", "--root", ext(dir, "2.1.0", "^2.1.0", "ok"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(by(ok)["api-floor-lockfile"].verdict, "PASS");
    assert.equal(by(ok)["api-currency"].verdict, "PASS");
    assert.equal(ok.json.data.policy, "2x");
    latest = null;
    const old = await rx(["api-floor", "--root", ext(dir, "2.0.6", "^2.0.0", "old"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(old.code, 1);
    assert.equal(by(old)["api-floor-lockfile"].verdict, "FAIL");
    assert.equal(by(old)["api-currency"].verdict, "N/A");
    assert.equal(by(old)["api-currency"].message, "npm unreachable");
    assert.equal(old.json.data.latest, null);
  });
});

test("publication from rx stale's baseline: new on 1.x FAILs api-floor-new; new on 2.x PASSes; existing is N/A; malformed baseline is unknown", async () => {
  await withTempDir(async (dir) => {
    latest = null;
    const newOld = ext(dir, "1.104.25", "^1.104.25", "new-old");
    baseline(newOld, false);
    let r = await rx(["api-floor", "--root", newOld, "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(by(r)["api-floor-new"].verdict, "FAIL");
    assert.match(by(r)["api-floor-new"].message, /new extensions start on 2\.x/);
    assert.equal(by(r)["api-floor-lockfile"].verdict, "PASS", "the 1.x floor itself is met");
    assert.equal(r.json.data.publication, "new");

    const newNew = ext(dir, "2.1.0", "^2.1.0", "new-new");
    baseline(newNew, false);
    r = await rx(["api-floor", "--root", newNew, "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(r.code, 0);
    assert.equal(by(r)["api-floor-new"].verdict, "PASS");

    const existing = ext(dir, "1.104.25", "^1.104.25", "existing");
    baseline(existing, true);
    r = await rx(["api-floor", "--root", existing, "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(by(r)["api-floor-new"].verdict, "N/A");
    assert.equal(by(r)["api-floor-new"].message, "published extension");
    assert.equal(r.json.data.publication, "existing");

    const broken = ext(dir, "1.104.25", "^1.104.25", "broken");
    baseline(broken, true);
    const file = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "rx/stale/baseline.json"], { cwd: broken, encoding: "utf8" }).trim();
    writeFileSync(file, JSON.stringify({ name: "ext" }));
    r = await rx(["api-floor", "--root", broken, "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(r.code, 0, "no ERROR for an unreadable baseline");
    assert.equal(r.json.data.publication, "unknown");
  });
});

test("errors: no lockfile, @raycast/api not resolved, a 3.x major, missing --preset, a preset without dependencies.api", async () => {
  await withTempDir(async (dir) => {
    latest = null;
    const noLock = makeExt(join(dir, "nolock"), { files: { "package-lock.json": null } });
    let r = await rx(["api-floor", "--root", noLock, "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "api-floor-lockfile");
    const unresolved = makeExt(join(dir, "unres"), { files: { "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }) } });
    r = await rx(["api-floor", "--root", unresolved, "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(r.code, 2);
    assert.match(r.json.results[0].message, /not resolved/);
    r = await rx(["api-floor", "--root", ext(dir, "3.0.0", "^3.0.0", "three"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(r.code, 2);
    assert.match(r.json.results[0].message, /major 3/);
    r = await rx(["api-floor", "--root", ext(dir, "2.1.0", "^2.1.0", "nopreset"), "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "args");
    const bare = join(dir, "bare.json");
    writeFileSync(bare, JSON.stringify({ schema: 1, owner: "x", rules: [] }));
    r = await rx(["api-floor", "--root", ext(dir, "2.1.0", "^2.1.0", "bare"), "--preset", bare, "--json"]);
    assert.equal(r.code, 2);
    assert.match(r.json.results[0].message, /no dependencies\.api/);
  });
});

test("manifest range lower bounds: comparator semantics, prerelease kept, exclusive bounds, hyphen ranges, unions; unknown forms WARN, never a fabricated bound", async () => {
  assert.equal(rangeLowerBound("^1.104.25"), "1.104.25");
  assert.equal(rangeLowerBound("~2.1.0"), "2.1.0");
  assert.equal(rangeLowerBound("2.1.0"), "2.1.0");
  assert.equal(rangeLowerBound("=2.1.0"), "2.1.0");
  assert.equal(rangeLowerBound(">=1.104.0 <2"), "1.104.0");
  assert.equal(rangeLowerBound(">=1.104.0 >=1.104.25 <2"), "1.104.25", "a comparator set takes its highest lower bound");
  assert.equal(rangeLowerBound(">1.104.24"), "1.104.25", "exclusive: the next patch");
  assert.equal(rangeLowerBound(">1.104.24-beta.1"), null, "exclusive above a prerelease is not representable");
  assert.equal(rangeLowerBound("^1.104.25-beta.1"), "1.104.25-beta.1", "prerelease identifiers are kept");
  assert.equal(rangeLowerBound("1.104.25 - 1.200.0"), "1.104.25");
  assert.equal(rangeLowerBound("1.x"), "1.0.0");
  assert.equal(rangeLowerBound("^2"), "2.0.0");
  assert.equal(rangeLowerBound("*"), "0.0.0");
  assert.equal(rangeLowerBound("<2"), "0.0.0", "an upper bound alone admits everything below");
  assert.equal(rangeLowerBound("^1.0.0 || ^2.0.0"), "1.0.0");
  assert.equal(rangeLowerBound("^1.104.25-beta.1 || ^2.1.0"), "1.104.25-beta.1");
  assert.equal(rangeLowerBound("file:../api"), null);
  assert.equal(rangeLowerBound("workspace:*"), null);
  assert.equal(rangeLowerBound(">x"), null);
  await withTempDir(async (dir) => {
    latest = null;
    const r = await rx(["api-floor", "--root", ext(dir, "2.1.0", "file:../api", "file"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(by(r)["api-floor-manifest"].verdict, "WARN");
    assert.match(by(r)["api-floor-manifest"].message, /not understood/);
    // A prerelease lower bound is below the release floor: WARN, where the old regex dropped the suffix and passed.
    const pre = await rx(["api-floor", "--root", ext(dir, "1.104.25", "^1.104.25-beta.1", "pre"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(by(pre)["api-floor-manifest"].verdict, "WARN");
    assert.match(by(pre)["api-floor-manifest"].message, /admits 1\.104\.25-beta\.1/);
    // An exclusive bound just below the floor admits the floor itself: PASS, where the old regex read 1.104.24.
    const excl = await rx(["api-floor", "--root", ext(dir, "1.104.25", ">1.104.24", "excl"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(by(excl)["api-floor-manifest"].verdict, "PASS", by(excl)["api-floor-manifest"].message);
  });
});

test("compareSemver orders prereleases below their release and by identifier", () => {
  const sorted = ["1.104.25", "1.104.25-rc.1", "1.104.25-beta.2", "1.104.25-beta.10", "1.104.24", "2.0.0-alpha"].sort(compareSemver);
  assert.deepEqual(sorted, ["1.104.24", "1.104.25-beta.2", "1.104.25-beta.10", "1.104.25-rc.1", "1.104.25", "2.0.0-alpha"]);
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0"), 0);
});

test("api-floor is read-only: it leaves no .git/rx behind", async () => {
  await withTempDir(async (dir) => {
    latest = null;
    const root = ext(dir, "2.1.0", "^2.1.0", "ro");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const r = await rx(["api-floor", "--root", root, "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(r.code, 0, r.stdout);
    assert.ok(!existsSync(join(root, ".git", "rx")), ".git/rx was created by a read-only run");
  });
});

test("api-currency: the major-version migration note appears only when npm latest is in another major", async () => {
  await withTempDir(async (dir) => {
    latest = "2.11.1";
    const same = await rx(["api-floor", "--root", ext(dir, "2.8.2", "^2.8.2", "same"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(by(same)["api-currency"].verdict, "WARN");
    assert.equal(by(same)["api-currency"].message, "2.8.2 is behind npm latest 2.11.1");
    const cross = await rx(["api-floor", "--root", ext(dir, "1.104.25", "^1.104.25", "cross"), "--preset", HOUSE_PRESET, "--json"]);
    assert.equal(by(cross)["api-currency"].verdict, "WARN");
    assert.equal(by(cross)["api-currency"].message, "1.104.25 is behind npm latest 2.11.1 (advisory: crossing a major is a migration, not a ship-time bump)");
  });
});

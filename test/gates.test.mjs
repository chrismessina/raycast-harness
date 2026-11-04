// `rx gates` (docs/commands.md §4.8; plan-review-1 #2, plan-review-2 F3, Q1): the steps run in
// order, the receipt is written only clean, a previous receipt never survives the start of a run,
// and missing tooling is ERROR tooling. No network: the upstream is a local bare repo and the npm
// registry lookup is stubbed (test/gates-helpers.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_STEPS, firstErrorLines } from "../src/commands/gates.mjs";
import { FINGERPRINT_FIELDS } from "../src/fingerprint.mjs";
import { FIX, buildGated, byId, gates, stateDir, withGatedEnv } from "./gates-helpers.mjs";
import { rx } from "./helpers.mjs";

const EXPECTED = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8"));

test("gates: a clean unpublished run matches expected.json, runs the seven steps in order and writes the receipt", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const r = await gates(root);
    assert.equal(r.code, EXPECTED.exit, r.stdout + r.stderr);
    const by = byId(r);
    for (const [id, verdict] of Object.entries(EXPECTED.verdicts)) assert.equal(by[id]?.verdict, verdict, `${id}: ${JSON.stringify(by[id])}`);
    assert.ok(!r.json.results.some((/** @type {any} */ x) => x.verdict === "FAIL" || x.verdict === "ERROR"), JSON.stringify(r.json.results.filter((/** @type {any} */ x) => x.verdict === "FAIL" || x.verdict === "ERROR")));
    assert.deepEqual(r.json.data.steps.map((/** @type {any} */ s) => s.name), EXPECTED.steps);
    assert.deepEqual([...REQUIRED_STEPS], EXPECTED.steps);
    assert.ok(r.json.data.steps.every((/** @type {any} */ s) => s.exit === 0), JSON.stringify(r.json.data.steps));

    // The receipt: shape, fingerprints, inputs, every step, clean results, atomically written (no temp file left).
    const receiptPath = join(await stateDir(root), "receipt.json");
    assert.equal(r.json.data.receipt, receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.deepEqual(Object.keys(receipt).sort(), ["at", "data", "fingerprints", "inputs", "results", "rxVersion", "steps"]);
    assert.deepEqual(receipt.steps, EXPECTED.steps);
    assert.deepEqual(Object.keys(receipt.fingerprints).sort(), [...FINGERPRINT_FIELDS, "combined"].sort());
    assert.equal(receipt.fingerprints.baseline, "unpublished");
    assert.equal(receipt.fingerprints.combined, r.json.fingerprint);
    assert.equal(receipt.fingerprints.combined, r.json.data.fingerprints.combined);
    assert.match(receipt.fingerprints.head, /^[0-9a-f]{40}$/);
    assert.equal(receipt.fingerprints.publishRange, "HEAD");
    assert.equal(receipt.inputs.preset, join(FIX, "preset.json"));
    assert.equal(receipt.inputs.forbidden, join(FIX, "forbidden.txt"));
    assert.equal(receipt.results.length, r.json.results.length);
    assert.equal(receipt.data.stale.published, false);
    assert.ok(!existsSync(`${receiptPath}.${process.pid}.tmp`));
  });
});

test("gates: a published extension passes --published to preflight, records the baseline SHA and keeps stale's CHECK rows", async () => {
  await withGatedEnv(async (dir) => {
    const { root, up } = await buildGated(dir, { published: true });
    const r = await gates(root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const by = byId(r);
    assert.equal(by["stale-check"]?.verdict, "WARN", JSON.stringify(by["stale-check"]));
    assert.equal(by["changelog-updated"]?.verdict, "PASS", "preflight ran with --published: the comparison check is not N/A");
    assert.equal(by["api-floor-new"]?.verdict, "N/A");
    const receipt = JSON.parse(readFileSync(join(await stateDir(root), "receipt.json"), "utf8"));
    assert.equal(receipt.fingerprints.baseline, up?.sha);
    assert.deepEqual(receipt.data.stale.files.filter((/** @type {any} */ f) => f.class === "CHECK").map((/** @type {any} */ f) => f.path), ["CHANGELOG.md"]);
  });
});

test("gates: a FAIL in any step leaves no receipt and deletes the previous one before running", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir, { tooling: { lintExit: 1 } });
    const receiptPath = join(await stateDir(root), "receipt.json");
    mkdirSync(join(await stateDir(root)), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify({ stale: "receipt from an earlier run" }));
    const r = await gates(root);
    assert.equal(r.code, 1, r.stdout);
    const by = byId(r);
    assert.equal(by.lint.verdict, "FAIL");
    assert.match(by.lint.message, /npm run lint exit 1/);
    assert.ok(by.lint.details.some((/** @type {any} */ d) => /fixture lint error/.test(d.text)), JSON.stringify(by.lint.details));
    assert.equal(by.build.verdict, "PASS");
    assert.equal(by.tsc.verdict, "PASS");
    assert.equal(r.json.data.receipt, null);
    assert.ok(!existsSync(receiptPath), "the stale receipt was deleted at the start and nothing replaced it");
    assert.deepEqual(r.json.data.steps.map((/** @type {any} */ s) => [s.name, s.exit]).slice(-3), [["build", 0], ["tsc", 0], ["lint", 1]]);
  });
});

test("gates: build and tsc failures are FAIL with the tool's first error lines", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir, { tooling: { buildExit: 2, tscExit: 1 } });
    const r = await gates(root);
    assert.equal(r.code, 1, r.stdout);
    const by = byId(r);
    assert.equal(by.build.verdict, "FAIL");
    assert.ok(by.build.details.some((/** @type {any} */ d) => /fixture build error/.test(d.text)));
    assert.equal(by.tsc.verdict, "FAIL");
    assert.ok(by.tsc.details.some((/** @type {any} */ d) => /error TS0000/.test(d.text)), JSON.stringify(by.tsc.details));
    assert.equal(r.json.data.receipt, null);
  });
});

test("gates: missing local tooling is ERROR tooling (never installed), and no receipt", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir, { tooling: { tsc: false } });
    const r = await gates(root);
    assert.equal(r.code, 2, r.stdout);
    const tooling = r.json.results.filter((/** @type {any} */ x) => x.id === "tooling");
    assert.equal(tooling.length, 1);
    assert.match(tooling[0].message, /tsc: node_modules\/\.bin\/tsc is missing/);
    assert.equal(byId(r).build.verdict, "PASS");
    assert.equal(byId(r).lint.verdict, "PASS");
    assert.equal(r.json.data.receipt, null);
    assert.ok(!existsSync(join(await stateDir(root), "receipt.json")));

    // No node_modules at all: every tool step is ERROR tooling.
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const r2 = await gates(root);
    assert.equal(r2.code, 2);
    assert.equal(r2.json.results.filter((/** @type {any} */ x) => x.id === "tooling").length, 3);

    // No lint script: ERROR tooling naming the script.
    mkdirSync(join(root, "node_modules"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    delete pkg.scripts.lint;
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
    chmodSync(join(root, "package.json"), 0o644);
    const r3 = await gates(root);
    assert.ok(r3.json.results.some((/** @type {any} */ x) => x.id === "tooling" && /no "lint" script/.test(x.message)), r3.stdout);
  });
});

test("gates: a missing --preset or --forbidden file is ERROR input before any step runs", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const r = await rx(["gates", "--root", root, "--preset", join(dir, "nope.json"), "--forbidden", join(FIX, "forbidden.txt"), "--json"]);
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.results.map((/** @type {any} */ x) => [x.id, x.verdict]), [["input", "ERROR"]]);
    assert.equal(r.json.data.receipt, undefined);
  });
});

test("gates: the dispatcher lists it with every step's check ids declared", async () => {
  const r = await rx(["commands", "--json"]);
  const cmd = r.json.data.commands.find((/** @type {any} */ c) => c.name === "gates");
  assert.ok(cmd);
  for (const id of ["stale-check", "scan-files", "readme-assets", "api-floor-lockfile", "build", "tsc", "lint"]) assert.ok(id in cmd.checks, id);
  assert.equal(cmd.flags["--preset"].required, true);
  assert.equal(cmd.flags["--forbidden"].required, true);
});

test("firstErrorLines: first non-empty lines, stderr first, capped with a count", () => {
  const d = firstErrorLines("e1\n\ne2", "o1");
  assert.deepEqual(d.map((x) => x.text), ["e1", "e2", "o1"]);
  const many = firstErrorLines(Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"), "");
  assert.equal(many.length, 13);
  assert.match(many[12].text, /8 more line/);
});

// ---- Codex Wave 3 review -------------------------------------------------------------------

test("gates (Codex P1 #3): a build that writes into the payload is FAIL gates-tree-changed with no receipt; one that writes under node_modules is not", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir, { tooling: { buildScript: `node -e "require('fs').writeFileSync('generated.txt', 'built')"` } });
    const r = await gates(root);
    assert.equal(r.code, 1, r.stdout);
    const by = byId(r);
    assert.equal(by.build.verdict, "PASS");
    assert.equal(by["gates-tree-changed"].verdict, "FAIL");
    assert.match(by["gates-tree-changed"].message, /^payload changed while the steps ran/);
    assert.equal(by["gates-tree-changed"].details[0].text.split(":")[0], "payload");
    assert.equal(r.json.data.receipt, null);
    assert.ok(!existsSync(join(await stateDir(root), "receipt.json")));
    rmSync(join(root, "generated.txt"));

    const { root: root2 } = await buildGated(join(dir, "two"), { tooling: { buildScript: `node -e "require('fs').writeFileSync('node_modules/built.txt', 'built')"` } });
    const r2 = await gates(root2);
    assert.equal(r2.code, 0, r2.stdout);
    assert.equal(byId(r2)["gates-tree-changed"].verdict, "PASS");
    assert.ok(existsSync(join(root2, "node_modules", "built.txt")));
    assert.ok(existsSync(join(await stateDir(root2), "receipt.json")));
  });
});

test("gates (Codex P2 #10): the previous receipt is deleted before the inputs are validated", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const ok = await gates(root);
    assert.equal(ok.code, 0, ok.stdout);
    const receiptPath = join(await stateDir(root), "receipt.json");
    assert.ok(existsSync(receiptPath));
    const r = await rx(["gates", "--root", root, "--preset", join(dir, "nonexistent.json"), "--forbidden", join(FIX, "forbidden.txt"), "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "input");
    assert.ok(!existsSync(receiptPath), "the stale authorization did not survive an ERROR on the arguments");
    // Codex W3 r2 F7: a parse error (a missing required flag, an unknown flag) is reported by the
    // dispatcher before run() starts; the receipt must still go, via the module's invalidate().
    const again = await gates(root);
    assert.equal(again.code, 0, again.stdout);
    assert.ok(existsSync(receiptPath));
    const missing = await rx(["gates", "--root", root, "--preset", join(FIX, "preset.json"), "--json"]);
    assert.equal(missing.code, 2);
    assert.deepEqual([missing.json.results[0].id, missing.json.results[0].message], ["args", "missing --forbidden"]);
    assert.ok(!existsSync(receiptPath), "a parse error deletes the receipt too");
    const again2 = await gates(root);
    assert.equal(again2.code, 0, again2.stdout);
    const unknown = await rx(["gates", "--root", root, "--preset", join(FIX, "preset.json"), "--forbidden", join(FIX, "forbidden.txt"), "--bogus", "--json"]);
    assert.equal(unknown.code, 2);
    assert.equal(unknown.json.results[0].id, "args");
    assert.ok(!existsSync(receiptPath), "an unknown flag deletes the receipt too");
    // Pre-scanned --root=<dir> form, from an unrelated cwd.
    const again3 = await gates(root);
    assert.equal(again3.code, 0, again3.stdout);
    const eq = await rx(["gates", `--root=${root}`, "--json"], { cwd: dir });
    assert.equal(eq.code, 2);
    assert.ok(!existsSync(receiptPath), "--root=<dir> is honored by the invalidation");
    // Codex r3 #3: a duplicate --root is ambiguous; nothing is deleted (never the last one's).
    const again4 = await gates(root);
    assert.equal(again4.code, 0, again4.stdout);
    const dup = await rx(["gates", "--root", join(dir, "nowhere"), "--root", root, "--json"]);
    assert.equal(dup.code, 2);
    assert.ok(existsSync(receiptPath), "an ambiguous --root deletes nothing");
    // Codex r4 F2/F3: an explicit --root that is empty, missing or never parsed (an unknown flag
    // before it) names no repository: the cwd's receipt is NOT the fallback.
    const again5 = await gates(root);
    assert.equal(again5.code, 0, again5.stdout);
    for (const argv of [["gates", "--root=", "--json"], ["gates", "--json", "--root"], ["gates", "--bogus", "--root", join(dir, "nowhere"), "--json"]]) {
      const r = await rx(argv, { cwd: root });
      assert.equal(r.code, 2, argv.join(" "));
      assert.ok(existsSync(receiptPath), `${argv.join(" ")}: an explicit bad root deletes nothing`);
    }
    // No root resolvable: the parse error is still the only result (invalidation is best-effort, silent).
    const nowhere = await rx(["gates", "--json"], { cwd: dir });
    assert.equal(nowhere.code, 2);
    assert.equal(nowhere.json.results.length, 1);
  });
});

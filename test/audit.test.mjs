// `rx audit record` / `rx audit show` (docs/commands.md §4.9; plan-review-1 #3, plan-review-2 F4
// and F9, Q2): coverage against the preset's applicable rules and the Greptile judgment rules,
// severity from the preset, embedded shortcut and png evidence, dispositions keyed on
// { path, localHash, baseline }, destination / runtime verifications, and the receipt tie.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GREPTILE_CONFIG, GREPTILE_JUDGMENT_RULES, GREPTILE_PREFLIGHT_RULES, greptileJudgmentRules, greptileRulesStamp, unclassifiedGreptileRules } from "../src/audit/greptile.mjs";
import { CHECK_IDS } from "../src/preflight/catalog.mjs";
import { dispositionKey, parseEntries } from "../src/audit/entries.mjs";
import { _setRuntimePaths } from "../src/commands/shortcuts.mjs";
import { _setBeforeWriteHookForTests } from "../src/commands/audit.mjs";
import { SHIPPED_DIR } from "../src/greptile/rules.mjs";
import { REPO, rx, withTempDir } from "./helpers.mjs";
import { auditRecord, buildGated, byId, fullEntries, gates, stateDir, validPng, withGatedEnv, writeAttested, writeEntries } from "./gates-helpers.mjs";
import { commit } from "./upstream-fixtures.mjs";

const SHIM = join(REPO, "test", "fixtures", "shortcuts", "shim", "index.js");
const PLIST = join(REPO, "test", "fixtures", "shortcuts", "shim", "Info.plist");

/** @param {string} root */
const auditPath = async (root) => join(await stateDir(root), "audit.json");

test("audit record: no receipt → ERROR audit-receipt, nothing written", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const r = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(r.code, 2, r.stdout);
    assert.deepEqual(r.json.results.map((/** @type {any} */ x) => [x.id, x.verdict]), [["audit-receipt", "ERROR"]]);
    assert.match(r.json.results[0].message, /run rx gates first/);
    assert.equal(r.json.data.written, false);
    assert.ok(!existsSync(await auditPath(root)));
  });
});

test("audit record: a complete entries file against a clean receipt → PASS coverage, audit.json tied to the receipt, no blocking", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const gr = await gates(root);
    assert.equal(gr.code, 0, gr.stdout);
    const r = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const by = byId(r);
    assert.equal(by["audit-coverage"].verdict, "PASS");
    assert.match(by["audit-coverage"].message, /2 preset, 55 Greptile judgment/);
    assert.equal(by["audit-dispositions"].verdict, "N/A");
    assert.equal(by["audit-verification"].verdict, "N/A");
    assert.equal(by["shortcut-runtime-table"].verdict, "N/A", "the fixture declares no shortcuts");
    assert.equal(by.png.verdict, "N/A", "no --published: LOCAL-ONLY keep local");
    assert.deepEqual(r.json.data.blocking, []);
    assert.deepEqual(r.json.data.reportOnly, []);
    assert.equal(r.json.data.written, true);
    assert.deepEqual(r.json.data.applicable.slice(0, 2), ["copy-error", "kit"]);
    assert.ok(!r.json.data.applicable.includes("export-actions"), "writesFiles is false: not applicable");
    assert.ok(!r.json.data.applicable.includes("fork-only"), "self-authored: the fork rule does not apply");
    assert.ok(!r.json.data.applicable.includes("extension-root"), "build-only rules are never audited");
    const receipt = JSON.parse(readFileSync(join(await stateDir(root), "receipt.json"), "utf8"));
    assert.equal(r.json.fingerprint, receipt.fingerprints.combined);
    const audit = JSON.parse(readFileSync(await auditPath(root), "utf8"));
    assert.equal(audit.fingerprint, receipt.fingerprints.combined);
    assert.deepEqual(audit.blocking, []);
    assert.equal(audit.entries.length, 57);
    assert.deepEqual(audit.greptileRules, greptileRulesStamp(), "bound to the Greptile rules in use (W9 finding 1)");
    assert.ok(Array.isArray(audit.evidence.shortcuts) && audit.evidence.shortcuts.length === 3);
    assert.ok(audit.evidence.png.length >= 1);

    // show: PASS, tied to the current receipt.
    const s = await rx(["audit", "show", "--root", root, "--json"]);
    assert.equal(s.code, 0);
    assert.equal(byId(s)["audit-show"].verdict, "PASS");
    assert.equal(s.json.data.receipt.fingerprint, receipt.fingerprints.combined);
  });
});

test("audit record: missing entries → FAIL audit-coverage naming them; the audit is written with the blocking reason", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const r = await auditRecord(root, writeEntries(dir, fullEntries({ omit: ["copy-error", "greptile/no-silent-failure"] })));
    assert.equal(r.code, 1, r.stdout);
    const cov = byId(r)["audit-coverage"];
    assert.equal(cov.verdict, "FAIL");
    assert.deepEqual(cov.details.map((/** @type {any} */ d) => d.text.split(" ")[0]), ["copy-error", "greptile/no-silent-failure"]);
    assert.deepEqual(r.json.data.blocking, ["coverage: copy-error, greptile/no-silent-failure"]);
    const audit = JSON.parse(readFileSync(await auditPath(root), "utf8"));
    assert.equal(audit.blocking.length, 1);
    const s = await rx(["audit", "show", "--root", root, "--json"]);
    assert.equal(byId(s)["audit-show"].verdict, "WARN");
    assert.match(byId(s)["audit-show"].message, /1 blocking reason/);
  });
});

test("audit record: severity comes from the preset — a block rule's fail is FAIL audit-<id>, a report rule's fail is WARN and does not block", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const report = await auditRecord(root, writeEntries(dir, fullEntries({ overrides: { kit: { result: "fail", evidence: "hand-rolled failure toasts in src/index.tsx:12" } } })));
    assert.equal(report.code, 0, report.stdout);
    assert.equal(byId(report)["audit-kit"].verdict, "WARN");
    assert.match(byId(report)["audit-kit"].message, /report-only/);
    assert.deepEqual(report.json.data.blocking, []);
    assert.deepEqual(report.json.data.reportOnly, ["kit"]);

    const block = await auditRecord(root, writeEntries(dir, fullEntries({ overrides: { "copy-error": { result: "fail", evidence: "toast at src/index.tsx:20 has no Copy Error action" }, "greptile/store-naming": { result: "fail", evidence: "title says Raycast" } } })));
    assert.equal(block.code, 1, block.stdout);
    assert.equal(byId(block)["audit-copy-error"].verdict, "FAIL");
    assert.equal(byId(block)["audit-greptile-store-naming"].verdict, "FAIL");
    assert.deepEqual(block.json.data.blocking, ["copy-error: fail", "greptile/store-naming: fail"]);
    assert.equal(byId(block)["audit-coverage"].verdict, "PASS");
  });
});

test("audit record: a receipt whose fingerprints no longer match the tree → ERROR audit-receipt; a receipt missing a step too; a different preset too", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    writeFileSync(join(root, "src", "index.tsx"), 'import { List } from "@raycast/api";\n');
    const r = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(r.code, 2, r.stdout);
    assert.equal(byId(r)["audit-receipt"].verdict, "ERROR");
    assert.match(byId(r)["audit-receipt"].message, /stale: payload changed/);
    assert.ok(!existsSync(await auditPath(root)));

    await gates(root);
    const receiptPath = join(await stateDir(root), "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.steps = receipt.steps.filter((/** @type {string} */ s) => s !== "tsc");
    writeAttested(receiptPath, receipt); // past provenance, so the shape check is what answers
    const r2 = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(r2.code, 2);
    assert.match(byId(r2)["audit-receipt"].message, /the receipt lacks step tsc/);

    await gates(root);
    const other = join(dir, "other-preset.json");
    writeFileSync(other, readFileSync(join(REPO, "test", "fixtures", "gates", "preset.json")));
    const r3 = await rx(["audit", "record", "--root", root, "--preset", other, "--entries", writeEntries(dir, fullEntries()), "--json"]);
    assert.equal(r3.code, 2);
    assert.match(byId(r3)["audit-receipt"].message, /not the preset the receipt was written with/);
  });
});

test("audit record: a stale CHECK path needs a disposition matching { path, localHash, baseline } exactly (F9)", async () => {
  await withGatedEnv(async (dir) => {
    const { root, up } = await buildGated(dir, { published: true });
    const gr = await gates(root);
    assert.equal(gr.code, 0, gr.stdout);
    const receipt = JSON.parse(readFileSync(join(await stateDir(root), "receipt.json"), "utf8"));
    const row = receipt.data.stale.files.find((/** @type {any} */ f) => f.path === "CHANGELOG.md");
    assert.equal(row.class, "CHECK");

    // No disposition: FAIL, and the detail says exactly what key is needed.
    const none = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(none.code, 1, none.stdout);
    const d = byId(none)["audit-dispositions"];
    assert.equal(d.verdict, "FAIL");
    assert.match(d.message, /1 outcome\(s\) without a disposition; 0 disposition\(s\) match nothing/);
    assert.equal(d.details[0].file, "CHANGELOG.md");
    assert.match(d.details[0].text, new RegExp(`CHECK needs a disposition: localHash=${row.localHash} baseline=${up?.sha}`));
    assert.deepEqual(none.json.data.blocking, ["dispositions: 1 missing, 0 unmatched"]);

    // Wrong hash (the file changed since): the stale disposition is unmatched AND the outcome is still undispositioned.
    const wrong = { path: "CHANGELOG.md", localHash: "0".repeat(40), baseline: up?.sha, disposition: "keep-local", reason: "newer entry" };
    const w = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [wrong] })));
    assert.equal(w.code, 1);
    assert.match(byId(w)["audit-dispositions"].message, /1 outcome\(s\) without a disposition; 1 disposition\(s\) match nothing/);

    // The exact key: PASS, counted, recorded in audit.json, nothing blocking.
    const right = { path: "CHANGELOG.md", localHash: String(row.localHash), baseline: String(up?.sha), disposition: "keep-local", reason: "the local entry is the newer changelog; the published one is v1" };
    const ok = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [right] })));
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(byId(ok)["audit-dispositions"].verdict, "PASS");
    assert.equal(ok.json.data.dispositions, 1);
    assert.deepEqual(ok.json.data.blocking, []);
    const audit = JSON.parse(readFileSync(await auditPath(root), "utf8"));
    assert.deepEqual(audit.dispositions, [right]);
    assert.equal(dispositionKey(right), dispositionKey({ path: row.path, localHash: row.localHash, baseline: up?.sha ?? "" }));
  });
});

test("audit record: a png OLDER-SHOT image in this run needs a disposition keyed on its sha256 and provenance commit (F9)", async () => {
  await withGatedEnv(async (dir) => {
    const { root, first } = await buildGated(dir, { published: true });
    // A newer screenshot locally: the published one equals the first commit's → OLDER-SHOT.
    await commit(root, { "metadata/good-1.png": validPng(2000, 1250, 9) }, "new shot");
    const gr = await gates(root);
    assert.equal(gr.code, 0, gr.stdout);
    const receipt = JSON.parse(readFileSync(join(await stateDir(root), "receipt.json"), "utf8"));
    // stale classifies both CHANGELOG.md and the screenshot as CHECK (published == an older
    // commit); those dispositions are keyed on the git blob id and the upstream baseline. The png
    // OLDER-SHOT disposition is a separate key: sha256 of the bytes and the provenance commit.
    const checks = receipt.data.stale.files.filter((/** @type {any} */ f) => f.class === "CHECK");
    assert.deepEqual(checks.map((/** @type {any} */ f) => f.path), ["CHANGELOG.md", "metadata/good-1.png"]);
    const staleDisps = checks.map((/** @type {any} */ f) => ({ path: f.path, localHash: f.localHash, baseline: receipt.data.stale.baseline, disposition: "keep-local", reason: "newer locally" }));

    const r = await auditRecord(root, writeEntries(dir, fullEntries({ extra: staleDisps })));
    assert.equal(r.code, 1, r.stdout);
    const pngRows = r.json.results.filter((/** @type {any} */ x) => x.id === "png");
    const older = pngRows.find((/** @type {any} */ x) => /OLDER-SHOT/.test(x.message));
    assert.ok(older, JSON.stringify(pngRows));
    assert.equal(older.verdict, "WARN");
    const d = byId(r)["audit-dispositions"];
    assert.equal(d.verdict, "FAIL");
    const need = d.details.find((/** @type {any} */ x) => x.file === "metadata/good-1.png");
    assert.ok(need, JSON.stringify(d.details));
    const m = need.text.match(/localHash=(sha256:[0-9a-f]{64}) baseline=([0-9a-f]{40})/);
    assert.ok(m, need.text);
    assert.equal(m[2], first, "the baseline is the commit whose image the Store holds");

    const pngDisp = { path: "metadata/good-1.png", localHash: m[1], baseline: m[2], disposition: "keep-local", reason: "retaken after the redesign; the Store shot is v1" };
    const ok = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [...staleDisps, pngDisp] })));
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(byId(ok)["audit-dispositions"].verdict, "PASS");
    assert.equal(ok.json.data.dispositions, 3);
  });
});

test("audit record: an external effect in src/ needs a verification entry; its fail blocks; none detected is N/A", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir, {
      src: 'import { List, getPreferenceValues } from "@raycast/api";\nimport { writeFileSync } from "node:fs";\nconst p = getPreferenceValues<Preferences>();\nexport function save() { writeFileSync("/tmp/x", "y"); fetch("https://example.com"); }\n',
    });
    const gr = await gates(root);
    assert.equal(gr.code, 0, gr.stdout);
    // export-actions now applies (writesFiles): coverage needs it too.
    const missing = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(missing.code, 1);
    assert.equal(byId(missing)["audit-coverage"].verdict, "FAIL");
    assert.match(byId(missing)["audit-coverage"].details[0].text, /^export-actions/);
    const v = byId(missing)["audit-verification"];
    assert.equal(v.verdict, "FAIL");
    assert.deepEqual(v.details.map((/** @type {any} */ x) => x.text.split(":")[0]), ["writes-files", "web-requests"]);

    const exportEntry = { id: "export-actions", scope: "src/index.tsx save()", result: "pass", evidence: "Show in Finder and Copy Path both offered" };
    const partial = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [exportEntry, { verification: "writes-files", result: "pass", evidence: "ran save(); /tmp/x exists with the expected bytes" }, { verification: "web-requests", result: "fail", evidence: "example.com returned 500 in the dev loop" }] })));
    assert.equal(partial.code, 1);
    assert.match(byId(partial)["audit-verification"].message, /0 external effect\(s\) unverified, 1 failed/);
    assert.deepEqual(partial.json.data.blocking, ["verification: web-requests failed"]);
    // Finding 5: a written audit that blocks says so plainly.
    assert.match(partial.stdout + partial.stderr, /audit: written to .*audit\.json with 1 blocking reason\(s\); rx guard will refuse a publish until they are resolved/);

    // Finding 4a: an n-a verification is recorded, not verified, and counted apart from pass.
    const na = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [exportEntry, { verification: "writes-files", result: "pass", evidence: "ran save(); /tmp/x exists" }, { verification: "web-requests", result: "n-a", evidence: "the request is behind a preference this build leaves off" }] })));
    assert.equal(na.code, 0, na.stdout);
    assert.equal(byId(na)["audit-verification"].verdict, "PASS");
    assert.match(byId(na)["audit-verification"].message, /^2 external effect\(s\) recorded: 1 pass, 1 n-a$/);
    assert.doesNotMatch(byId(na)["audit-verification"].message, /verified/);

    const ok = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [exportEntry, { verification: "writes-files", result: "pass", evidence: "ran save(); /tmp/x exists" }, { verification: "web-requests", result: "pass", evidence: "200 from example.com in the dev loop" }] })));
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(byId(ok)["audit-verification"].verdict, "PASS");
    assert.match(byId(ok)["audit-verification"].message, /^2 external effect\(s\) recorded: 2 pass, 0 n-a$/);
    assert.deepEqual(ok.json.data.blocking, []);
    assert.doesNotMatch(ok.stdout + ok.stderr, /blocking reason/, "a clean audit says nothing about blocking");
  });
});

test("audit record: shortcut evidence is embedded; unavailable runtime evidence blocks and is never an accepted N/A (F4)", async () => {
  await withGatedEnv(async (dir) => {
    const src = 'import { ActionPanel, Action, List, getPreferenceValues } from "@raycast/api";\nconst p = getPreferenceValues<Preferences>();\nexport default function Command() {\n  return (\n    <List>\n      <List.Item title="x" actions={<ActionPanel><Action title="Copy" onAction={() => {}} shortcut={{ modifiers: ["cmd"], key: "c" }} /></ActionPanel>} />\n    </List>\n  );\n}\n';
    const { root } = await buildGated(dir, { src });
    const gr = await gates(root);
    assert.equal(gr.code, 0, gr.stdout);

    // No table for the installed app (the cache is this test's temp dir): ERROR shortcut-runtime-table, blocking.
    const noTable = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(noTable.code, 2, noTable.stdout);
    assert.equal(byId(noTable)["shortcut-runtime-table"].verdict, "ERROR");
    assert.match(byId(noTable)["shortcut-runtime-table"].message, /runtime evidence unavailable/);
    assert.deepEqual(noTable.json.data.blocking, ["shortcut-runtime-table: ERROR"]);
    assert.equal(noTable.json.data.written, true, "the audit records the blocked state");

    // With a table from the recorded shim fixture: PASS, embedded.
    _setRuntimePaths({ shim: SHIM, plist: PLIST });
    try {
      const rt = await rx(["shortcuts", "runtime", "--json"]);
      assert.equal(rt.code, 0, rt.stdout);
      const ok = await auditRecord(root, writeEntries(dir, fullEntries()));
      assert.equal(ok.code, 0, ok.stdout);
      assert.equal(byId(ok)["shortcut-runtime-table"].verdict, "PASS");
      assert.equal(byId(ok)["shortcut-ambiguous"].verdict, "PASS");
      assert.equal(byId(ok)["shortcut-reserved"].verdict, "PASS");
      assert.deepEqual(ok.json.data.blocking, []);
      const audit = JSON.parse(readFileSync(await auditPath(root), "utf8"));
      assert.equal(audit.evidence.shortcuts.find((/** @type {any} */ x) => x.id === "shortcut-runtime-table").verdict, "PASS");
    } finally {
      _setRuntimePaths();
    }
  });
});

test("audit record: a malformed entries file or an unknown rule id is ERROR input before any verdict", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const bad = await auditRecord(root, writeEntries(dir, [{ id: "copy-error", result: "maybe" }]));
    assert.equal(bad.code, 2);
    assert.equal(bad.json.results[0].id, "input");
    assert.ok(bad.json.results[0].details.some((/** @type {any} */ d) => /result must be one of pass, fail, n-a/.test(d.text)), JSON.stringify(bad.json.results[0]));
    const unknown = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [{ id: "not-a-rule", scope: "x", result: "pass", evidence: "y" }] })));
    assert.equal(unknown.code, 2);
    assert.match(unknown.json.results[0].message, /unknown rule id\(s\) not-a-rule/);
    const notArray = await auditRecord(root, writeEntries(dir, { entries: [] }));
    assert.equal(notArray.code, 2);
    assert.match(notArray.json.results[0].message, /expected a JSON array/);
    assert.ok(!existsSync(await auditPath(root)));
  });
});

test("audit show: N/A when nothing is recorded; WARN when the audit is tied to a different (here: superseded) receipt", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const none = await rx(["audit", "show", "--root", root, "--json"]);
    assert.equal(none.code, 0);
    assert.equal(byId(none)["audit-show"].verdict, "N/A");
    assert.equal(none.json.data.audit, null);
    await gates(root);
    await auditRecord(root, writeEntries(dir, fullEntries()));
    await commit(root, { "README.md": "# Good\n\nchanged\n\n![Shot](media/shot.png)\n" }, "edit");
    await gates(root);
    const s = await rx(["audit", "show", "--root", root, "--json"]);
    assert.equal(byId(s)["audit-show"].verdict, "WARN");
    assert.equal(byId(s)["audit-show"].message, "audit.json was recorded against an earlier receipt.json; run rx audit record again");
    assert.equal(s.json.data.audit.entries.length, 57);
  });
});

test("entries parser: three shapes, exact keys, no duplicate rule ids", () => {
  const parsed = parseEntries([
    { id: "a", scope: "s", result: "pass", evidence: "e" },
    { path: "p", localHash: "h", baseline: "b", disposition: "adopt-published", reason: "r" },
    { verification: "calls-ai", result: "n-a", evidence: "no AI call reachable" },
  ]);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.dispositions.length, 1);
  assert.equal(parsed.verifications.length, 1);
  assert.throws(() => parseEntries([{ id: "a", scope: "s", result: "pass", evidence: "e" }, { id: "a", scope: "s", result: "pass", evidence: "e" }]), /appears twice/);
  assert.throws(() => parseEntries([{ path: "p", localHash: "h", baseline: "b", disposition: "delete", reason: "r" }]), /disposition must be one of/);
  assert.throws(() => parseEntries([{ verification: "network", result: "pass", evidence: "e" }]), /verification must be one of/);
  assert.throws(() => parseEntries([{ id: "a", scope: "s", result: "pass", evidence: "e", severity: "block" }]), /unknown key "severity"/, "severity is never supplied");
  assert.throws(() => parseEntries([{ id: "a", scope: "", result: "pass", evidence: "e" }]), /non-empty "scope"/);
});

test("greptile coverage fails closed: every rule in the shipped snapshot is bound to a preflight check or listed as judgment", async () => {
  assert.deepEqual(unclassifiedGreptileRules(GREPTILE_CONFIG), [], "classify each new upstream rule in src/audit/greptile.mjs before shipping the snapshot");
  const snapshot = new Set(JSON.parse(readFileSync(GREPTILE_CONFIG, "utf8")).rules.map((/** @type {{ id: string }} */ r) => r.id));
  for (const [rule, checks] of Object.entries(GREPTILE_PREFLIGHT_RULES)) {
    assert.ok(snapshot.has(rule), `preflight binding for ${rule}, which the snapshot does not have`);
    assert.ok(checks.length > 0 && checks.every((id) => CHECK_IDS.includes(id)), `${rule} binds an unknown preflight check: ${checks.join(", ")}`);
  }
  // A snapshot carrying a rule nobody classified is named, not skipped.
  await withTempDir((dir) => {
    const config = JSON.parse(readFileSync(GREPTILE_CONFIG, "utf8"));
    config.rules.push({ id: "brand-new-upstream-rule", severity: "medium", scope: ["extensions/**"], rule: "New" });
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    assert.deepEqual(unclassifiedGreptileRules(join(dir, "config.json")), ["brand-new-upstream-rule"]);
  });
});

test("greptile judgment rules: a rule rx has not classified (an rx greptile update copy ahead of this release) is a required, blocking audit entry", async () => {
  await withTempDir((dir) => {
    const config = JSON.parse(readFileSync(GREPTILE_CONFIG, "utf8"));
    config.rules.push({ id: "brand-new-upstream-rule", severity: "medium", scope: ["extensions/**"], rule: "New rule text\nsecond line" });
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const rules = greptileJudgmentRules(join(dir, "config.json"));
    const added = rules.find((r) => r.id === "brand-new-upstream-rule");
    assert.ok(added, "an unclassified rule must not pass an audit silently");
    assert.deepEqual(added, { id: "brand-new-upstream-rule", entryId: "greptile/brand-new-upstream-rule", severity: "block", title: "New rule text" });
    assert.equal(rules.length, GREPTILE_JUDGMENT_RULES.length + 1);
  });
});

test("greptile judgment rules: 55 ids, every one present in the core snapshot, all blocking", () => {
  const rules = greptileJudgmentRules(GREPTILE_CONFIG);
  assert.equal(rules.length, 55);
  assert.deepEqual(rules.map((r) => r.id), [...GREPTILE_JUDGMENT_RULES]);
  assert.ok(rules.every((r) => r.severity === "block" && r.entryId === `greptile/${r.id}` && r.title.length > 0));
  assert.throws(() => greptileJudgmentRules(join(REPO, "test", "fixtures", "gates", "preset.json")), /absent from the snapshot/);
});

test("greptile classification (W9 finding 5): a rule preflight covers only in part is judgment too; preflight-only is reserved for whole-rule coverage", () => {
  const judgment = new Set(GREPTILE_JUDGMENT_RULES);
  const preflightRules = Object.keys(GREPTILE_PREFLIGHT_RULES);
  for (const id of ["store-screenshots", "unused-dependencies", "eslint-flat-config", "no-custom-localization", "extension-categories", "prettier-config", "npm-lockfile-registry"]) {
    assert.ok(judgment.has(id) && preflightRules.includes(id), `${id} is classified both (preflight covers part of it)`);
  }
  const preflightOnly = preflightRules.filter((id) => !judgment.has(id));
  assert.deepEqual(preflightOnly.sort(), ["native-fetch", "no-nested-review-config", "platforms-field"], "re-read the rule text before adding a preflight-only rule");
  assert.equal(preflightRules.filter((id) => judgment.has(id)).length, 22);
  assert.equal(judgment.size, 55);
  assert.equal(preflightRules.length, 25);
});

// ---- Codex Wave 3 review -------------------------------------------------------------------

test("audit record (Codex P1 #5): multiline evidence records cleanly, line by line in details; messages stay one line", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const evidence = "toast at src/index.tsx:20 has no Copy Error action\nsecond line: the catch at :31 swallows the error\nthird line";
    const r = await auditRecord(root, writeEntries(dir, fullEntries({ overrides: { "copy-error": { result: "fail", evidence }, kit: { result: "fail", evidence: "a\nb" } } })));
    assert.equal(r.code, 1, r.stdout);
    assert.ok(!r.json.results.some((/** @type {any} */ x) => x.verdict === "ERROR"), JSON.stringify(r.json.results.filter((/** @type {any} */ x) => x.verdict === "ERROR")));
    const ce = byId(r)["audit-copy-error"];
    assert.equal(ce.verdict, "FAIL");
    assert.equal(ce.message, "copy-error: fail (blocking)");
    assert.deepEqual(ce.details.map((/** @type {any} */ d) => d.text), ["scope: src/**", "evidence: toast at src/index.tsx:20 has no Copy Error action", "second line: the catch at :31 swallows the error", "third line"]);
    assert.equal(byId(r)["audit-kit"].verdict, "WARN");
    assert.equal(byId(r)["audit-kit"].details.length, 3);
    assert.deepEqual(r.json.data.blocking, ["copy-error: fail"]);
    assert.ok(existsSync(await auditPath(root)));
  });
});

test("audit record (Codex P1 #5): a recording that ERRORs on its inputs leaves no previous audit.json behind", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const ok = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(ok.code, 0, ok.stdout);
    assert.ok(existsSync(await auditPath(root)));
    const bad = await auditRecord(root, writeEntries(dir, [{ id: "copy-error", result: "maybe" }]));
    assert.equal(bad.code, 2);
    assert.ok(!existsSync(await auditPath(root)), "the clean audit from before did not survive a failed recording");
    // Codex W3 r2 F7: a parse error on `record` (missing --entries) deletes the audit too; `show` never does.
    const ok2 = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(ok2.code, 0, ok2.stdout);
    const missing = await rx(["audit", "record", "--root", root, "--preset", join(REPO, "test", "fixtures", "gates", "preset.json"), "--json"]);
    assert.equal(missing.code, 2);
    assert.deepEqual([missing.json.results[0].id, missing.json.results[0].message], ["args", "missing --entries"]);
    assert.ok(!existsSync(await auditPath(root)), "a parse error on record deletes the audit");
    const ok3 = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(ok3.code, 0, ok3.stdout);
    const showBad = await rx(["audit", "show", "--root", root, "--bogus", "--json"]);
    assert.equal(showBad.code, 2);
    assert.ok(existsSync(await auditPath(root)), "a parse error on show leaves the audit alone");
    // Codex r3 #3: the subcommand is found the way the parser finds it (a --root VALUE is not a subcommand).
    const okA = await rx(["audit", "--root", root, "record", "--preset", join(REPO, "test", "fixtures", "gates", "preset.json"), "--bogus", "--json"]);
    assert.equal(okA.code, 2);
    assert.ok(!existsSync(await auditPath(root)), "`audit --root <dir> record --bogus` invalidates record");
    const ok4 = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(ok4.code, 0, ok4.stdout);
    const valueNamedShow = await rx(["audit", "--root", "show", "record", "--bogus", "--json"], { cwd: root });
    assert.equal(valueNamedShow.code, 2);
    assert.ok(existsSync(await auditPath(root)), "`--root show record` is record with a bad root: no repository is named, nothing is deleted (never the cwd's)");
    // Codex r4 F3: the subcommand is the one the parser selected, no more, no less.
    const bogusFirst = await rx(["audit", "--bogus", "record", "--json"], { cwd: root });
    assert.equal(bogusFirst.code, 2);
    assert.ok(!existsSync(await auditPath(root)), "`audit --bogus record` is record: invalidated");
    const ok6 = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(ok6.code, 0, ok6.stdout);
    const unknownSub = await rx(["audit", "nonsense", "record", "--json"], { cwd: root });
    assert.equal(unknownSub.code, 2);
    assert.match(unknownSub.json.results[0].message, /unknown audit subcommand "nonsense"/);
    assert.ok(existsSync(await auditPath(root)), "an unknown subcommand selects nothing: the audit stays");
    const valueNamedRecord = await rx(["audit", "--root", "record", "show", "--bogus", "--json"], { cwd: root });
    assert.equal(valueNamedRecord.code, 2);
    assert.ok(existsSync(await auditPath(root)), "`--root record show` is show with a bad root: nothing deleted");
    // The same for a missing receipt: delete it, record → ERROR audit-receipt, still no audit.json.
    await auditRecord(root, writeEntries(dir, fullEntries()));
    rmSync(join(await stateDir(root), "receipt.json"));
    const noReceipt = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(noReceipt.code, 2);
    assert.ok(!existsSync(await auditPath(root)));
  });
});

test("audit record (Codex P2 #7): duplicate verification effects and duplicate disposition keys are ERROR input, never last-wins", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const dupV = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [
      { verification: "web-requests", result: "fail", evidence: "500" },
      { verification: "web-requests", result: "pass", evidence: "200 later" },
    ] })));
    assert.equal(dupV.code, 2, dupV.stdout);
    assert.equal(dupV.json.results[0].id, "input");
    assert.match(dupV.json.results[0].message, /verification "web-requests" appears twice/);
    const d = { path: "CHANGELOG.md", localHash: "a".repeat(40), baseline: "b".repeat(40), disposition: "keep-local", reason: "x" };
    const dupD = await auditRecord(root, writeEntries(dir, fullEntries({ extra: [d, { ...d, disposition: "adopt-published" }] })));
    assert.equal(dupD.code, 2);
    assert.match(dupD.json.results[0].message, /disposition for "CHANGELOG.md" .* appears twice/);
    assert.throws(() => parseEntries([d, d]), /appears twice/);
    assert.throws(() => parseEntries([{ verification: "calls-ai", result: "pass", evidence: "e" }, { verification: "calls-ai", result: "fail", evidence: "e" }]), /appears twice/);
  });
});

test("audit record (Codex P2 #9): an entries file inside the extension root is ERROR input (ray publish would copy it)", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const inside = join(root, "entries.json");
    writeFileSync(inside, JSON.stringify(fullEntries()));
    const r = await rx(["audit", "record", "--root", root, "--preset", join(REPO, "test", "fixtures", "gates", "preset.json"), "--entries", inside, "--json"]);
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.results[0].id, "input");
    assert.match(r.json.results[0].message, /is inside the extension root/);
    assert.ok(!existsSync(await auditPath(root)));
    rmSync(inside);
    // A symlink outside pointing inside is caught by the real path.
    const { symlinkSync } = await import("node:fs");
    writeFileSync(join(root, "node_modules", "e.json"), JSON.stringify(fullEntries()));
    symlinkSync(join(root, "node_modules", "e.json"), join(dir, "link-entries.json"));
    const r2 = await rx(["audit", "record", "--root", root, "--preset", join(REPO, "test", "fixtures", "gates", "preset.json"), "--entries", join(dir, "link-entries.json"), "--json"]);
    assert.equal(r2.code, 2);
    assert.match(r2.json.results[0].message, /is inside the extension root/);
  });
});

// ---- 5A (Chris, 2026-11-06): a recording that removes a valid audit says so ----------------

test("audit record: removing the previous audit is announced, on a bad input and on an argument error", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const preset = join(REPO, "test", "fixtures", "gates", "preset.json");
    const outside = join(dir, "entries.json");
    writeFileSync(outside, JSON.stringify(fullEntries()));
    const first = await rx(["audit", "record", "--root", root, "--preset", preset, "--entries", outside, "--json"]);
    assert.ok(existsSync(await auditPath(root)), first.stdout + first.stderr);
    const inside = join(root, "entries.json");
    writeFileSync(inside, JSON.stringify(fullEntries()));
    const r = await rx(["audit", "record", "--root", root, "--preset", preset, "--entries", inside, "--json"]);
    rmSync(inside);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /audit: removed the previous audit at .*audit\.json; a new one is written only when the inputs are valid/);
    await rx(["audit", "record", "--root", root, "--preset", preset, "--entries", outside, "--json"]);
    assert.ok(existsSync(await auditPath(root)));
    const bad = await rx(["audit", "record", "--root", root, "--json"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /audit: removed the previous audit at .*audit\.json \(the arguments did not parse\); run rx audit record again/);
  });
});

// ---- W9 round 2 finding A: one rules snapshot per recording ----------------------------------

test("audit record (W9 round 2 finding A): the Greptile rules change mid-recording → ERROR audit-greptile-rules, nothing written", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    await gates(root);
    const shipped = JSON.parse(readFileSync(join(SHIPPED_DIR, "SOURCE.json"), "utf8")).sha.slice(0, 7);
    // Another process finishes `rx greptile update` after the entries were judged: same ids, one
    // rule's text changed, from a later upstream commit (so it becomes the copy in use).
    _setBeforeWriteHookForTests(() => {
      const copy = join(dir, "cache", "raycast-harness", "greptile", "rules", "copy-ccccccc");
      mkdirSync(copy, { recursive: true });
      for (const f of ["files.json", "rules.md"]) writeFileSync(join(copy, f), readFileSync(join(SHIPPED_DIR, f), "utf8"));
      const config = JSON.parse(readFileSync(join(SHIPPED_DIR, "config.json"), "utf8"));
      config.rules.find((/** @type {any} */ x) => x.id === "no-silent-failure").rule += "\n\nAlso flag: a requirement the audit never read.";
      writeFileSync(join(copy, "config.json"), JSON.stringify(config));
      writeFileSync(join(copy, "SOURCE.json"), JSON.stringify({ repo: "raycast/extensions", source: "main", sha: "c".repeat(40), committed: "2026-11-05T00:00:00Z", fetched: "2026-11-05T00:00:01.000Z" }));
    });
    try {
      const r = await auditRecord(root, writeEntries(dir, fullEntries()));
      assert.equal(r.code, 2, r.stdout);
      assert.equal(byId(r)["audit-greptile-rules"].verdict, "ERROR");
      assert.equal(byId(r)["audit-greptile-rules"].message, `the Greptile rules changed while the audit was being recorded (${shipped} → ccccccc); run rx audit record again`);
      assert.equal(r.json.data.written, false);
      assert.ok(!existsSync(await auditPath(root)), "no audit.json carrying either stamp");
    } finally {
      _setBeforeWriteHookForTests(null);
    }
    // Recorded again against the new rules: written, stamped with them.
    const again = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(again.code, 0, again.stdout);
    assert.equal(JSON.parse(readFileSync(await auditPath(root), "utf8")).greptileRules.sha, "c".repeat(40));
  });
});

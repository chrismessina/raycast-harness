// `rx gates` keeps the Greptile rules current as its first step (greptile-rules), binds
// the receipt to them (`greptileRules`), `rx audit record` refuses a receipt written under other
// rules, and `rx guard` / `rx audit show` require the receipt's, the audit's and the current rules
// to agree. No network: every GitHub request goes to an injected fake (greptileFake), and the
// cache and config directories are temp dirs (withGatedEnv).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stampOf } from "../src/audit/greptile.mjs";
import { SHIPPED_DIR, loadGreptileRules, rulesDigest } from "../src/greptile/rules.mjs";
import { setTransport } from "../src/pr/transport.mjs";
import { setGreptileRulesDeadline } from "../src/commands/gates.mjs";
import { updateWithin } from "../src/greptile/update.mjs";
import { auditRecord, bashPayload, buildGated, byId, fullEntries, gates, greptileFake, guard, readJson, stateDir, withGatedEnv, writeAttested, writeEntries } from "./gates-helpers.mjs";
import { afterShipped, rx } from "./helpers.mjs";

const SHIPPED = JSON.parse(readFileSync(join(SHIPPED_DIR, "SOURCE.json"), "utf8"));
const S7 = SHIPPED.sha.slice(0, 7);
/** After the shipped copy's commit date, so a copy from it is the copy in use. */
const LATER = afterShipped(2);
const E = "e".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const PUBLISH = "npm run publish";

/** The shipped config.json with one judgment rule's text changed under the same id. */
function changedConfig() {
  const c = JSON.parse(readFileSync(join(SHIPPED_DIR, "config.json"), "utf8"));
  c.rules.find((/** @type {any} */ r) => r.id === "no-silent-failure").rule += "\n\nAlso flag: a requirement added upstream.";
  return c;
}

/** @param {string} dir */
const rulesCacheDir = (dir) => join(dir, "cache", "raycast-harness", "greptile", "rules");

/** Run `fn` with `t` as the GitHub transport, restoring the offline one after. @template T @param {import("../src/pr/transport.mjs").Transport} t @param {() => Promise<T>} fn */
async function withTransport(t, fn) {
  const prev = setTransport(t);
  try {
    return await fn();
  } finally {
    setTransport(prev);
  }
}

/** A gated extension (offline: the shipped rules) with a clean audit. @param {string} dir */
async function gatedWithAudit(dir) {
  const { root } = await buildGated(dir);
  const g = await gates(root);
  assert.equal(g.code, 0, g.stdout);
  const a = await auditRecord(root, writeEntries(dir, fullEntries()));
  assert.equal(a.code, 0, a.stdout);
  const state = await stateDir(root);
  return { root, receiptPath: join(state, "receipt.json"), auditPath: join(state, "audit.json") };
}

/** An `rx greptile update`-shaped cache copy, committed after the shipped one (so it is in use). @param {string} dir @param {string} sha */
function cacheCopy(dir, sha) {
  const copy = join(rulesCacheDir(dir), `copy-${sha.slice(0, 7)}`);
  mkdirSync(copy, { recursive: true });
  for (const f of ["files.json", "rules.md"]) writeFileSync(join(copy, f), readFileSync(join(SHIPPED_DIR, f), "utf8"));
  writeFileSync(join(copy, "config.json"), JSON.stringify(changedConfig()));
  writeFileSync(join(copy, "SOURCE.json"), JSON.stringify({ repo: "raycast/extensions", source: "main", sha, committed: LATER, fetched: "2026-11-05T00:00:01.000Z" }));
  return copy;
}

/** @param {any} r */
const guardResult = (r) => byId(r).guard;

// ---- gates: the greptile-rules step ------------------------------------------------------------

test("gates greptile-rules: a stale copy is updated from main (injected fetcher) and the receipt is bound to the new rules", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const fake = greptileFake({ sha: E, committed: LATER, files: { "config.json": JSON.stringify(changedConfig()) } });
    const r = await withTransport(fake.t, () => gates(root));
    assert.equal(r.code, 0, r.stdout);
    const step = byId(r)["greptile-rules"];
    assert.equal(step.verdict, "PASS", JSON.stringify(step));
    assert.equal(step.message, `updated: ${S7} → eeeeeee, 1 change(s)`);
    assert.deepEqual(step.details.map((/** @type {any} */ d) => d.text), ["rule changed no-silent-failure rule"]);
    // One commit request, then the three files at that commit.
    assert.equal(fake.calls.length, 4, fake.calls.join("\n"));
    assert.match(fake.calls[0], /commits\?path=\.greptile&sha=main&per_page=1$/);
    // Installed in the cache and in use.
    const copies = readdirSync(rulesCacheDir(dir)).filter((n) => !n.startsWith("."));
    assert.equal(copies.length, 1, copies.join(", "));
    assert.equal(loadGreptileRules({ warn: () => {} }).source.sha, E);
    // The receipt carries the stamp of the rules this run brought current.
    const receipt = readJson(join(await stateDir(root), "receipt.json"));
    assert.deepEqual(receipt.greptileRules, { repo: "raycast/extensions", sha: E, digest: rulesDigest({ config: changedConfig(), files: JSON.parse(readFileSync(join(SHIPPED_DIR, "files.json"), "utf8")), rules: "" }) });
    assert.deepEqual(r.json.data.greptileRules, receipt.greptileRules);
  });
});

test("gates greptile-rules: a copy at main's last .greptile/ commit is current after one request", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const fake = greptileFake({ sha: SHIPPED.sha, committed: SHIPPED.committed });
    const r = await withTransport(fake.t, () => gates(root));
    assert.equal(r.code, 0, r.stdout);
    assert.equal(byId(r)["greptile-rules"].verdict, "PASS");
    assert.equal(byId(r)["greptile-rules"].message, `current: raycast/extensions main @ ${S7} (${SHIPPED.fetched}, shipped copy)`);
    assert.equal(fake.calls.length, 1, fake.calls.join("\n"));
    assert.ok(!existsSync(rulesCacheDir(dir)), "nothing written when current");
  });
});

test("gates greptile-rules: offline → WARN in the output and the receipt; gates continues on the copy in use, after the rotation and the receipt deletion", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    assert.equal((await gates(root)).code, 0);
    const receiptPath = join(await stateDir(root), "receipt.json");
    assert.ok(existsSync(receiptPath));
    // The fake records whether the previous receipt was still there when the step ran.
    const fake = greptileFake();
    /** @type {boolean[]} */
    const receiptAtRequest = [];
    const getJson = fake.t.getJson;
    fake.t.getJson = async (path) => {
      receiptAtRequest.push(existsSync(receiptPath));
      return getJson(path);
    };
    const r = await withTransport(fake.t, () => gates(root));
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(receiptAtRequest, [false], "the step runs after the previous receipt is deleted");
    const step = byId(r)["greptile-rules"];
    assert.equal(step.verdict, "WARN");
    assert.equal(step.message, `could not check (offline or gh unavailable): using shipped copy from ${SHIPPED.fetched}`);
    assert.match(step.details[0].text, /offline \(test transport\)/);
    assert.equal(r.json.results[0].id, "greptile-rules", "the first result");
    assert.equal(r.json.data.steps[0].name, "greptile-rules", "the first step");
    const receipt = readJson(receiptPath);
    assert.equal(receipt.results.find((/** @type {any} */ x) => x.id === "greptile-rules").verdict, "WARN", "the WARN is visible in the receipt");
    assert.deepEqual(receipt.greptileRules, stampOf(loadGreptileRules({ warn: () => {} })));
    assert.equal(receipt.greptileRules.sha, SHIPPED.sha);
  });
});

test("gates greptile-rules: live rules that fail validation are never installed; WARN naming why, gates continues on the copy in use", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const bad = changedConfig();
    bad.rules[0].severity = "critical";
    /** @type {Record<string, string>[]} */
    const variants = [{ "config.json": JSON.stringify(bad) }, { "files.json": "{ not json" }];
    for (const files of variants) {
      const r = await withTransport(greptileFake({ sha: E, committed: LATER, files }).t, () => gates(root));
      assert.equal(r.code, 0, r.stdout);
      const step = byId(r)["greptile-rules"];
      assert.equal(step.verdict, "WARN", JSON.stringify(step));
      assert.equal(step.message, `the live rules failed validation and were not installed: using shipped copy from ${SHIPPED.fetched}`);
      assert.match(step.details[0].text, files["config.json"] ? /severity "critical" is not one of/ : /JSON/);
      assert.ok(!existsSync(rulesCacheDir(dir)) || readdirSync(rulesCacheDir(dir)).length === 0, "nothing installed, no temp directory left");
      assert.equal(readJson(join(await stateDir(root), "receipt.json")).greptileRules.sha, SHIPPED.sha);
    }
  });
});

// ---- the receipt ------------------------------------------------------------------------------

test("receipt: one written before rx bound receipts to the Greptile rules is not current (guard and audit record)", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath } = await gatedWithAudit(dir);
    const { greptileRules: _drop, ...legacy } = readJson(receiptPath);
    writeAttested(receiptPath, legacy);
    const g = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(g).verdict, "FAIL");
    assert.match(guardResult(g).message, /blocked: the receipt was written before rx bound receipts to the Greptile rules; run rx gates again$/);
    const a = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(byId(a)["audit-receipt"].verdict, "ERROR");
    assert.match(byId(a)["audit-receipt"].message, /^the receipt was written before rx bound receipts to the Greptile rules \(.*receipt\.json\); run rx gates again$/);
    // A malformed stamp is a shape problem too.
    writeAttested(receiptPath, { ...legacy, greptileRules: { repo: "raycast/extensions", sha: "x", digest: "y" } });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /the receipt's greptileRules is not \{ repo, sha \(40 hex\), digest \(64 hex\) \}; run rx gates again$/);
  });
});

// ---- audit record ------------------------------------------------------------------------------

test("audit record: a receipt written under other Greptile rules → ERROR audit-receipt, nothing written", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    assert.equal((await gates(root)).code, 0);
    cacheCopy(dir, C); // an rx greptile update after gates ran
    const r = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(r.code, 2, r.stdout);
    assert.equal(byId(r)["audit-receipt"].verdict, "ERROR");
    assert.equal(byId(r)["audit-receipt"].message, `the Greptile rules changed since rx gates ran (${S7} → ccccccc); run rx gates again`);
    assert.equal(r.json.data.written, false);
    assert.ok(!existsSync(join(await stateDir(root), "audit.json")));
    // rx gates under the new rules, then the audit records.
    assert.equal((await gates(root)).code, 0);
    assert.equal((await auditRecord(root, writeEntries(dir, fullEntries()))).code, 0);
  });
});

// ---- guard and audit show: receipt, audit and rules in use must agree ---------------------------

/** A stamp naming other rules. */
const OTHER = { repo: "raycast/extensions", sha: D, digest: "0".repeat(64) };

test("guard: the rules in use changed after gates and the audit (receipt = audit ≠ now) → blocks; audit show WARNs", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gatedWithAudit(dir);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
    cacheCopy(dir, C);
    const sentence = `the Greptile rules changed since the audit was recorded (${S7} → ccccccc); run rx gates, then rx audit record`;
    const g = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(g).verdict, "FAIL");
    assert.ok(guardResult(g).message.endsWith(`blocked: ${sentence}`), guardResult(g).message);
    const show = byId(await rx(["audit", "show", "--root", root, "--json"]))["audit-show"];
    assert.deepEqual([show.verdict, show.message], ["WARN", sentence]);
  });
});

test("guard: the audit alone names other rules (receipt = now ≠ audit) → blocks with its own sentence; audit show WARNs", async () => {
  await withGatedEnv(async (dir) => {
    const { root, auditPath } = await gatedWithAudit(dir);
    writeAttested(auditPath, { ...readJson(auditPath), greptileRules: OTHER });
    const sentence = `the audit was recorded against other Greptile rules than the receipt (ddddddd vs ${S7}); run rx audit record again`;
    const g = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(g).verdict, "FAIL");
    assert.ok(guardResult(g).message.endsWith(`blocked: ${sentence}`), guardResult(g).message);
    const show = byId(await rx(["audit", "show", "--root", root, "--json"]))["audit-show"];
    assert.deepEqual([show.verdict, show.message], ["WARN", sentence]);
  });
});

test("guard: the receipt alone names other rules (audit = now ≠ receipt) → blocks with its own sentence; audit show WARNs", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gatedWithAudit(dir);
    writeAttested(receiptPath, { ...readJson(receiptPath), greptileRules: OTHER });
    // Keep the audit bound to the rewritten receipt, so only the rules disagree.
    writeAttested(auditPath, { ...readJson(auditPath), receiptMac: readJson(receiptPath).attestation.mac });
    const sentence = `the Greptile rules changed since rx gates ran (ddddddd → ${S7}); run rx gates, then rx audit record`;
    const g = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(g).verdict, "FAIL");
    assert.ok(guardResult(g).message.endsWith(`blocked: ${sentence}`), guardResult(g).message);
    const show = byId(await rx(["audit", "show", "--root", root, "--json"]))["audit-show"];
    assert.deepEqual([show.verdict, show.message], ["WARN", sentence]);
  });
});

// ---- greptile-rules races, deadlines and disagreement -------------------------------------------

test("gates greptile-rules: rules installed by another update while the step's request is pending → FAIL gates-rules-changed, no receipt; the stamp is the snapshot the step reported", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const receiptPath = join(await stateDir(root), "receipt.json");
    // The request answers "current" for the shipped copy (A), but another `rx greptile update`
    // installs B (cacheCopy C) while it is pending.
    const fake = greptileFake({ sha: SHIPPED.sha, committed: SHIPPED.committed });
    const getJson = fake.t.getJson;
    fake.t.getJson = async (path) => {
      cacheCopy(dir, C);
      return getJson(path);
    };
    const r = await withTransport(fake.t, () => gates(root));
    const step = byId(r)["greptile-rules"];
    assert.equal(step.verdict, "PASS", JSON.stringify(step));
    assert.equal(step.message, `current: raycast/extensions main @ ${S7} (${SHIPPED.fetched}, shipped copy)`);
    assert.equal(r.json.data.greptileRules.sha, SHIPPED.sha, "the stamp is the snapshot the step reported, never a reload");
    const check = byId(r)["gates-rules-changed"];
    assert.equal(check?.verdict, "FAIL", r.stdout);
    assert.equal(check.message, `the Greptile rules changed while rx gates ran (${S7} → ccccccc); run rx gates again`);
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.json.data.receipt, null);
    assert.ok(!existsSync(receiptPath), "no receipt");
    // Rerun: the step reports B, the receipt is stamped B.
    const again = await gates(root);
    assert.equal(again.code, 0, again.stdout);
    assert.equal(byId(again)["gates-rules-changed"].verdict, "PASS");
    assert.equal(again.json.results.at(-1).id, "gates-rules-changed", "the last check before the receipt is written");
    assert.equal(readJson(receiptPath).greptileRules.sha, C);
  });
});

test("gates greptile-rules: the step's deadline expires → WARN, gates continues on the copy in use, and the late answer installs nothing", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const fake = greptileFake({ sha: E, committed: LATER, files: { "config.json": JSON.stringify(changedConfig()) } });
    /** @type {(v?: unknown) => void} */
    let release = () => {};
    const held = new Promise((r) => (release = r));
    const getJson = fake.t.getJson;
    /** @type {(AbortSignal | undefined)[]} */
    const signals = [];
    fake.t.getJson = async (path, o) => {
      signals.push(o?.signal);
      await held;
      return getJson(path);
    };
    const prev = setGreptileRulesDeadline(50);
    /** @type {any} */
    let r;
    try {
      r = await withTransport(fake.t, () => gates(root));
    } finally {
      setGreptileRulesDeadline(prev);
    }
    assert.equal(r.code, 0, r.stdout);
    const step = byId(r)["greptile-rules"];
    assert.equal(step.verdict, "WARN", JSON.stringify(step));
    assert.equal(step.message, `could not check within 0.05 s: using shipped copy from ${SHIPPED.fetched}`);
    assert.equal(readJson(join(await stateDir(root), "receipt.json")).greptileRules.sha, SHIPPED.sha);
    // The request carried the step's signal, and the deadline aborted it (the real transport kills
    // the gh child then: test/exec.test.mjs).
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, true, "the pending request's signal was aborted at the deadline");
    // The answer arrives after gates moved on: the abandoned routine must install nothing, and no
    // staged directory may be left behind.
    release();
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(fake.calls.length, 4, `the late routine ran to the write: ${fake.calls.join("\n")}`);
    assert.ok(!existsSync(rulesCacheDir(dir)) || readdirSync(rulesCacheDir(dir)).length === 0, "nothing installed, no temp directory left");
    assert.equal(loadGreptileRules({ warn: () => {} }).source.sha, SHIPPED.sha);
  });
});

test("guard: receipt, audit and rules in use all differ → blocks and prescribes rx gates, then rx audit record; audit show WARNs", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gatedWithAudit(dir);
    writeAttested(receiptPath, { ...readJson(receiptPath), greptileRules: OTHER });
    writeAttested(auditPath, { ...readJson(auditPath), receiptMac: readJson(receiptPath).attestation.mac, greptileRules: { ...OTHER, sha: E } });
    const sentence = `the Greptile rules changed since the audit was recorded (eeeeeee → ${S7}); run rx gates, then rx audit record`;
    const g = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(g).verdict, "FAIL");
    assert.ok(guardResult(g).message.endsWith(`blocked: ${sentence}`), guardResult(g).message);
    const show = byId(await rx(["audit", "show", "--root", root, "--json"]))["audit-show"];
    assert.deepEqual([show.verdict, show.message], ["WARN", sentence]);
  });
});

test("updateWithin (W10 round 2): one file fetch failing fast cancels its stalled siblings when the routine returns, not at the deadline", async () => {
  await withGatedEnv(async () => {
    const fake = greptileFake({ sha: E, committed: LATER });
    /** @type {AbortSignal[]} */
    const pending = [];
    fake.t.getRaw = async (path, o) => {
      if (/config\.json/.test(path)) throw Object.assign(new Error("Not Found"), { status: 404 });
      const signal = /** @type {AbortSignal} */ (o?.signal);
      pending.push(signal);
      // A stalled request: it settles only when its signal aborts.
      await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
      return "";
    };
    const started = Date.now();
    const o = await updateWithin({ fetcher: fake.t, warn: () => {}, deadlineMs: 60_000 });
    assert.notEqual(o.status, "timed-out", "the routine settled on its own, long before the deadline");
    assert.ok(Date.now() - started < 5_000);
    assert.equal(pending.length, 2, "both sibling file requests were in flight");
    assert.ok(pending.every((s) => s.aborted), "every request still in flight is cancelled when the routine returns");
  });
});

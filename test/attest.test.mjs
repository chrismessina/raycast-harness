// src/attest.mjs: the per-machine attestation key and the receipt / audit MAC (plan §9 item 4).
// Every test points XDG_CONFIG_HOME at a temp dir; none reads or writes the real ~/.config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attest, canonicalJson, inspectKey, keyIdOf, keyPaths, loadOrCreateKey, macOf, verifyAttestation } from "../src/attest.mjs";
import { RxError } from "../src/errors.mjs";
import { REPO, rx, withConfig } from "./helpers.mjs";
import { auditRecord, buildGated, byId, fullEntries, gates, stateDir, withGatedEnv, writeEntries } from "./gates-helpers.mjs";

test("attest: canonical JSON sorts keys recursively, keeps array order, has no whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson([2, 1]), "[2,1]");
  assert.equal(canonicalJson({ u: undefined, n: null }), '{"n":null}');
  assert.equal(canonicalJson("é\n"), JSON.stringify("é\n"));
});

test("attest: the MAC is stable across key order and formatting, and changes with any value", async () => {
  await withConfig(() => {
    const k = loadOrCreateKey();
    const a = { fingerprints: { payload: "p", head: "h" }, results: [{ id: "x", verdict: "PASS" }], at: "t" };
    const b = JSON.parse(JSON.stringify({ at: "t", results: [{ verdict: "PASS", id: "x" }], fingerprints: { head: "h", payload: "p" } }, null, 4));
    assert.equal(macOf(k.key, a), macOf(k.key, b));
    // The attestation field itself is excluded, so re-attesting is idempotent.
    const signed = attest(a, k);
    assert.equal(macOf(k.key, signed), macOf(k.key, a));
    assert.equal(verifyAttestation(JSON.parse(JSON.stringify(signed, null, 2)), inspectKey(), { name: "receipt.json", rerun: "rx gates" }), null);
    assert.notEqual(macOf(k.key, { ...a, at: "u" }), macOf(k.key, a));
    assert.notEqual(macOf(k.key, { ...a, results: [...a.results].reverse().concat([{ id: "y", verdict: "PASS" }]) }), macOf(k.key, a));
    assert.deepEqual(Object.keys(signed.attestation).sort(), ["alg", "keyId", "mac"]);
    assert.equal(signed.attestation.alg, "hmac-sha256");
    assert.match(signed.attestation.mac, /^[0-9a-f]{64}$/);
    assert.equal(signed.attestation.keyId, keyIdOf(k.key));
    assert.match(signed.attestation.keyId, /^[0-9a-f]{16}$/);
  });
});

test("attest: the key is created on first need at XDG_CONFIG_HOME, dir 0700, file 0600, 32 bytes, and then reused", async () => {
  await withConfig((dir) => {
    const { dir: keyDir, file } = keyPaths();
    assert.equal(file, join(dir, "config", "raycast-harness", "attest.key"));
    assert.equal(inspectKey().status, "missing");
    const k = loadOrCreateKey();
    assert.equal(k.created, true);
    assert.equal(statSync(keyDir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file).length, 32);
    assert.deepEqual(readdirSync(keyDir), ["attest.key"], "no temp file left behind");
    const again = loadOrCreateKey();
    assert.equal(again.created, false);
    assert.equal(again.keyId, k.keyId);
  });
});

test("attest: racing first runs agree on one key (exactly one creates it; the losers read the winner's)", async () => {
  await withConfig(async (dir) => {
    const url = pathToFileURL(join(REPO, "src", "attest.mjs")).href;
    const script = `const m = await import(${JSON.stringify(url)}); const k = m.loadOrCreateKey(); console.log(JSON.stringify({ keyId: k.keyId, created: k.created }));`;
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, "config") };
    const runs = await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
      execFile(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
    })));
    const ids = new Set(runs.map((/** @type {any} */ r) => r.keyId));
    assert.equal(ids.size, 1, JSON.stringify(runs));
    assert.equal(runs.filter((/** @type {any} */ r) => r.created).length, 1, JSON.stringify(runs));
    const after = inspectKey();
    assert.equal(after.status === "ok" ? after.keyId : null, [...ids][0]);
    assert.deepEqual(readdirSync(join(dir, "config", "raycast-harness")), ["attest.key"]);
  });
});

test("attest: a key that is group/other-accessible, the wrong size, not a regular file or a symlink is an ERROR naming the path, never regenerated", async () => {
  await withConfig((dir) => {
    const { dir: keyDir, file } = keyPaths();
    loadOrCreateKey();
    const bytes = readFileSync(file);
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      chmodSync(file, mode);
      const s = inspectKey();
      assert.equal(s.status, "bad", mode.toString(8));
      assert.throws(() => loadOrCreateKey(), (e) => e instanceof RxError && e.id === "attest-key" && e.message.includes(file) && /mode 0\d\d\d.*group or other/.test(e.message), mode.toString(8));
      assert.deepEqual(readFileSync(file), bytes, "an existing key is never replaced");
    }
    chmodSync(file, 0o600);
    writeFileSync(file, bytes.subarray(0, 31));
    assert.throws(() => loadOrCreateKey(), /is 31 bytes, not 32/);
    assert.equal(readFileSync(file).length, 31, "not regenerated");
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => loadOrCreateKey(), /is not a regular file/);
    rmSync(file, { recursive: true });
    const real = join(dir, "elsewhere.key");
    writeFileSync(real, bytes, { mode: 0o600 });
    symlinkSync(real, file);
    assert.throws(() => loadOrCreateKey(), /is not a regular file/);
    assert.ok(existsSync(keyDir));
  });
});

test("attest: verifyAttestation names each failure in its own sentence", async () => {
  await withConfig(() => {
    const p = { name: "receipt.json", rerun: "rx gates" };
    const doc = { a: 1 };
    assert.match(String(verifyAttestation(doc, inspectKey(), p)), /^receipt\.json cannot be verified: this machine has no rx attestation key at .*attest\.key/);
    const k = loadOrCreateKey();
    const signed = attest(doc, k);
    assert.equal(verifyAttestation(signed, inspectKey(), p), null);
    assert.equal(verifyAttestation(doc, inspectKey(), p), "receipt.json is not attested by this machine's rx key: re-run rx gates");
    assert.match(String(verifyAttestation({ ...signed, attestation: { alg: "sha1", keyId: k.keyId, mac: "00" } }, inspectKey(), p)), /malformed attestation/);
    assert.match(String(verifyAttestation({ ...signed, a: 2 }, inspectKey(), p)), /attestation does not verify against this machine's rx key/);
    assert.match(String(verifyAttestation({ ...signed, attestation: { ...signed.attestation, mac: "0".repeat(64) } }, inspectKey(), p)), /does not verify/);
    assert.match(String(verifyAttestation({ ...signed, attestation: { ...signed.attestation, mac: "zz" } }, inspectKey(), p)), /does not verify/);
    assert.equal(verifyAttestation({ ...signed, attestation: { ...signed.attestation, keyId: "0123456789abcdef" } }, inspectKey(), p), `receipt.json was attested by rx key 0123456789abcdef, not this machine's key ${k.keyId}: re-run rx gates`);
    chmodSync(keyPaths().file, 0o644);
    assert.match(String(verifyAttestation(signed, inspectKey(), p)), /cannot be verified: the rx attestation key .* has mode 0644/);
  });
});

test("attest: rx gates and rx audit record ERROR attest-key on a bad key and write nothing; with a good key both files are attested", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const g = await gates(root);
    assert.equal(g.code, 0, g.stdout);
    const k = inspectKey();
    assert.equal(k.status, "ok", "rx gates created the key under the temp XDG_CONFIG_HOME");
    const state = await stateDir(root);
    const receipt = JSON.parse(readFileSync(join(state, "receipt.json"), "utf8"));
    assert.equal(verifyAttestation(receipt, k, { name: "receipt.json", rerun: "rx gates" }), null);
    const a = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(a.code, 0, a.stdout);
    const audit = JSON.parse(readFileSync(join(state, "audit.json"), "utf8"));
    assert.equal(verifyAttestation(audit, k, { name: "audit.json", rerun: "rx audit record" }), null);

    chmodSync(keyPaths().file, 0o644);
    const bad = await gates(root);
    assert.equal(bad.code, 2);
    assert.equal(byId(bad)["attest-key"]?.verdict, "ERROR", bad.stdout);
    assert.match(byId(bad)["attest-key"].message, /attest\.key has mode 0644/);
    assert.ok(!existsSync(join(state, "receipt.json")), "the old receipt is gone and no new one was written");
    const badAudit = await auditRecord(root, writeEntries(dir, fullEntries()));
    assert.equal(badAudit.code, 2);
    assert.equal(byId(badAudit)["attest-key"]?.verdict, "ERROR", badAudit.stdout);
    assert.ok(!existsSync(join(state, "audit.json")));
  });
});

test("doctor attest-key: WARN not created yet, PASS with keyId, ERROR on a bad key; doctor never creates it", async () => {
  await withConfig(async (dir) => {
    const by = async () => Object.fromEntries((await rx(["doctor", "--json"], { cwd: dir })).json.results.map((/** @type {any} */ x) => [x.id, x]));
    const missing = await by();
    assert.equal(missing["attest-key"].verdict, "WARN");
    assert.match(missing["attest-key"].message, /not created yet; rx gates creates it$/);
    assert.equal(inspectKey().status, "missing", "doctor did not create the key");
    const k = loadOrCreateKey();
    const ok = await by();
    assert.equal(ok["attest-key"].verdict, "PASS");
    assert.match(ok["attest-key"].message, new RegExp(`mode 0600, 32 bytes, keyId ${k.keyId}`));
    chmodSync(keyPaths().file, 0o640);
    const r = await rx(["doctor", "--json"], { cwd: dir });
    const bad = r.json.results.find((/** @type {any} */ x) => x.id === "attest-key");
    assert.equal(bad.verdict, "ERROR");
    assert.match(bad.message, /mode 0640/);
    assert.deepEqual(r.json.data.attestKey, { path: keyPaths().file, present: true, keyId: null, error: bad.message.replace(/^the rx attestation key \S+ /, "").replace(/; rx never replaces.*$/, "") });
    assert.equal(r.code, 2);
  });
});

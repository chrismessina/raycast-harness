// Codex round W7: an authorization is bound to the place and the attempt it was made for
// (src/binding.mjs), the Bash state rule is path-aware (src/audit/publish-command.mjs), protected
// paths resolve `..` in filesystem order (src/audit/protected-paths.mjs), `rx audit record`
// checks the receipt's provenance before it consumes it, and the key directory's mode is enforced
// (src/attest.mjs). Every test points XDG_CONFIG_HOME at a temp dir (withGatedEnv / withConfig).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspectKey, keyPaths, loadOrCreateKey } from "../src/attest.mjs";
import { currentGeneration, generationPaths, rotateGeneration, subjectOf } from "../src/binding.mjs";
import { _setGhForTests } from "../src/commands/doctor.mjs";
import { RxError } from "../src/errors.mjs";
import { checkProtectedPath, resolveFsOrder } from "../src/audit/protected-paths.mjs";
import { classifyCommand, collapseSeparators, mentionsProtectedPath, mentionsState, pathWords, shellWords } from "../src/audit/publish-command.mjs";
import { FORBIDDEN, PRESET, auditRecord, bashPayload, buildGated, byId, fullEntries, gates, guard, stateDir, withGatedEnv, writeAttested, writeEntries } from "./gates-helpers.mjs";
import { rx, withTempDir } from "./helpers.mjs";

const PUBLISH = "npm run publish";
const STATE_SENTENCE = "rx state is written only by rx: this command mentions .git/rx or the rx attestation key; use rx gates / rx audit record to write it and rx audit show to read it";

/** @param {any} r */
const guardResult = (r) => byId(r).guard;

/** A fully gated extension at dir/ext: clean receipt and clean audit. @param {string} dir */
async function gated(dir) {
  const { root } = await buildGated(dir);
  const g = await gates(root);
  assert.equal(g.code, 0, g.stdout);
  const a = await auditRecord(root, writeEntries(dir, fullEntries()));
  assert.equal(a.code, 0, a.stdout);
  const state = await stateDir(root);
  return { root, state, receiptPath: join(state, "receipt.json"), auditPath: join(state, "audit.json") };
}

// ---- 1a. Identity ---------------------------------------------------------------------------

test("binding 1a: a receipt and audit copied into an identical clone block there, naming the checkout they were written for", async () => {
  await withGatedEnv(async (dir) => {
    const { root, state } = await gated(dir);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
    const receipt = JSON.parse(readFileSync(join(state, "receipt.json"), "utf8"));
    assert.deepEqual(receipt.subject, await subjectOf(root), "the receipt names its physical root and git common dir");
    const audit = JSON.parse(readFileSync(join(state, "audit.json"), "utf8"));
    assert.deepEqual(audit.subject, receipt.subject);
    assert.equal(audit.receiptGeneration, receipt.generation);
    assert.equal(audit.receiptMac, receipt.attestation.mac);

    // Codex's trace: an identical clone B, the state files copied in, and (so that only the
    // subject stands in the way) B's generation file set to the receipt's generation.
    const b = join(dir, "clone", "ext");
    mkdirSync(dirname(b), { recursive: true });
    execFileSync("git", ["clone", "-q", root, b]);
    cpSync(join(root, "node_modules"), join(b, "node_modules"), { recursive: true });
    const bState = await stateDir(b);
    mkdirSync(bState, { recursive: true });
    cpSync(state, bState, { recursive: true });
    const { dir: genDir, file: genFile } = generationPaths(b);
    mkdirSync(genDir, { recursive: true, mode: 0o700 });
    writeFileSync(genFile, JSON.stringify({ root: realpathSync(b), generation: receipt.generation }), { mode: 0o600 });

    const r = await guard(bashPayload(PUBLISH, b));
    assert.equal(guardResult(r).verdict, "FAIL", guardResult(r).message);
    assert.equal(guardResult(r).message, `publish of ${realpathSync(b)} blocked: receipt.json was written for another checkout: ${realpathSync(root)}; run rx gates here`);
    assert.deepEqual(r.json.data.receipt, { present: true, fresh: false, complete: false });
    // The original checkout is untouched by any of this.
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
  });
});

// ---- 1b. Generation -------------------------------------------------------------------------

test("binding 1b: gates rotates the generation on every attempt (args ERROR and failed runs included), 0600 in a 0700 directory", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    assert.equal(currentGeneration(root), null);
    assert.equal((await gates(root)).code, 0);
    const g1 = currentGeneration(root);
    assert.match(String(g1), /^[0-9a-f]{64}$/);
    const { dir: genDir, file } = generationPaths(root);
    assert.equal(statSync(genDir).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(genDir)).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(genDir), [file.slice(genDir.length + 1)], "no temp file left behind");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).root, realpathSync(root));
    const receipt = JSON.parse(readFileSync(join(await stateDir(root), "receipt.json"), "utf8"));
    assert.equal(receipt.generation, g1);

    // An argument error (missing --forbidden) rotates it too.
    const bad = await rx(["gates", "--root", root, "--preset", PRESET, "--json"]);
    assert.equal(bad.code, 2);
    const g2 = currentGeneration(root);
    assert.notEqual(g2, g1);
    // A run that ERRORs on its tooling rotates it.
    rmSync(join(root, "node_modules"), { recursive: true });
    assert.equal((await gates(root)).code, 2);
    assert.notEqual(currentGeneration(root), g2);
  });
});

test("binding 1b: a receipt and audit saved, then restored after a later gates attempt that failed (tooling, or arguments), block", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gated(dir);
    const savedReceipt = readFileSync(receiptPath);
    const savedAudit = readFileSync(auditPath);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");

    // Codex's trace: gates with broken local tooling deletes the receipt and fails; the saved pair
    // comes back.
    cpSync(join(root, "node_modules"), join(dir, "nm-saved"), { recursive: true });
    rmSync(join(root, "node_modules"), { recursive: true });
    const broken = await gates(root);
    assert.equal(broken.code, 2);
    assert.ok(!existsSync(receiptPath));
    cpSync(join(dir, "nm-saved"), join(root, "node_modules"), { recursive: true });
    writeFileSync(receiptPath, savedReceipt);
    writeFileSync(auditPath, savedAudit);
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(r).verdict, "FAIL", guardResult(r).message);
    assert.equal(guardResult(r).message, `publish of ${realpathSync(root)} blocked: receipt.json is from an earlier rx gates attempt; run rx gates again`);

    // The same after an attempt that ERRORs on its arguments.
    assert.equal((await gates(root)).code, 0);
    assert.equal((await auditRecord(root, writeEntries(dir, fullEntries()))).code, 0);
    const again = readFileSync(receiptPath);
    const againAudit = readFileSync(auditPath);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
    assert.equal((await rx(["gates", "--root", root, "--forbidden", FORBIDDEN, "--bogus", "--json"])).code, 2);
    writeFileSync(receiptPath, again);
    writeFileSync(auditPath, againAudit);
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /receipt\.json is from an earlier rx gates attempt; run rx gates again$/);

    // A missing generation file blocks the same way.
    assert.equal((await gates(root)).code, 0);
    assert.equal((await auditRecord(root, writeEntries(dir, fullEntries()))).code, 0);
    rmSync(generationPaths(root).file);
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /receipt\.json is from an earlier rx gates attempt/);
  });
});

test("binding 1b: an audit recorded against a superseded receipt blocks, even when the tree (and so the fingerprint) is unchanged", async () => {
  await withGatedEnv(async (dir) => {
    const { root, auditPath } = await gated(dir);
    const oldAudit = readFileSync(auditPath);
    assert.equal((await gates(root)).code, 0);
    assert.equal((await auditRecord(root, writeEntries(dir, fullEntries()))).code, 0);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
    writeFileSync(auditPath, oldAudit);
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(r).verdict, "FAIL", guardResult(r).message);
    assert.equal(guardResult(r).message, `publish of ${realpathSync(root)} blocked: audit.json was recorded against an earlier receipt.json; run rx audit record again`);
    assert.deepEqual(r.json.data.audit, { present: true, fresh: false, blocking: true });
  });
});

// ---- 2. Bash mentions -----------------------------------------------------------------------

test("Bash state rule: `/./` and repeated `/` collapse before the .git/rx text rule", () => {
  assert.equal(collapseSeparators(".git/./rx"), ".git/rx");
  assert.equal(collapseSeparators(".git//rx"), ".git/rx");
  assert.equal(collapseSeparators(".git/././/./rx///receipt.json"), ".git/rx/receipt.json");
  assert.ok(mentionsState("cp saved-receipt.json .git/./rx/receipt.json"));
  assert.ok(mentionsState("cp saved-audit.json .git//rx/audit.json"));
  assert.ok(!mentionsState("cp a .git/./rx-old/b"));
});

test("Bash state rule: Codex's three spellings, the config directory, and redirects or `=` targets block through the guard", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir);
    execFileSync("git", ["worktree", "add", "-q", join(dir, "wt")], { cwd: root });
    const wtState = join(root, ".git", "worktrees", "wt", "rx", "receipt.json");
    const cfg = join(dir, "config", "raycast-harness");
    /** @type {string[]} */
    const notBlocked = [];
    for (const cmd of [
      "cp saved-receipt.json .git/./rx/receipt.json",
      "cp saved-audit.json .git//rx/audit.json",
      `cp saved-receipt.json ${wtState}`,
      `cp saved-receipt.json "${wtState}"`,
      `cat saved > ${wtState}`,
      `node tool.mjs --out=${wtState}`,
      `cp saved.json ${join(cfg, "generations", "x.json")}`,
      `rm -rf ${cfg}`,
      "cp saved.json ./src/../.git/rx/receipt.json",
    ]) {
      const r = await guard(bashPayload(cmd, root));
      if (guardResult(r).message !== STATE_SENTENCE || r.json.data.receipt !== null) notBlocked.push(`${cmd} → ${guardResult(r).verdict} ${guardResult(r).message}`);
    }
    assert.deepEqual(notBlocked, [], "every spelling blocks with the state sentence before any state is read");
    // The path layer on its own (the text rule cannot see a worktree's state or the config dir).
    assert.ok(!mentionsState(`cp saved-receipt.json ${wtState}`));
    assert.ok(await mentionsProtectedPath(`cp saved-receipt.json ${wtState}`, root));
    assert.ok(await mentionsProtectedPath(`touch ${join(cfg, "generations", "y.json")}`, root));
  });
});

test("Bash state rule: rx's own runner calls, in the shapes the plugin's skills use, still pass", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir);
    const plugin = join(dir, "plugin");
    const runner = `node "${plugin}/scripts/rx.mjs"`;
    const work = join(dir, "work");
    for (const cmd of [
      `${runner} holdout out`,
      `${runner} gates --forbidden "${join(dir, "scratch", "forbidden.txt")}"`,
      `${runner} gates --preset "${plugin}/presets/chrismessina.json" --forbidden "${join(dir, "scratch", "forbidden.txt")}"`,
      `${runner} gates --forbidden "$FORBID"`,
      `${runner} audit record --entries "${join(work, "entries.json")}"`,
      `${runner} audit record --entries "$ENTRIES"`,
      `${runner} audit show`,
      `${runner} --record-publication raycast/extensions "$PR" "$REMOTE_SHA"`,
      `${runner} --record-publication raycast/extensions 123 0123abc`,
      `${runner} holdout in`,
      `${runner} stale`,
      `${runner} scan --forbidden "${join(dir, "scratch", "forbidden.txt")}" --pr-text "${join(work, "body.md")}"`,
      "git rev-parse --git-path rx",
      "ls .git/rx-old",
      "cat ./src/index.tsx",
      "cat ~/.config/raycast-harness-other/x",
      'gh api "repos/raycast/extensions/issues/$PR/timeline?per_page=100" --jq \'.[] | select(.event=="ready_for_review")\'',
    ]) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(guardResult(r).verdict, "N/A", `${cmd}: ${guardResult(r).message}`);
    }
    assert.deepEqual(await classifyCommand(`cd ${root} && npm run publish`, root), { kind: "publish", dir: root, program: "npm" });
  });
});

// ---- 3. `..` in filesystem order ------------------------------------------------------------

test("protected paths: `..` after a symlink goes to the link target's parent, as the kernel walks it (Codex's /tmp/.. case, own symlink)", async () => {
  await withTempDir(async (dir) => {
    const saved = process.env.XDG_CONFIG_HOME;
    const d = realpathSync(dir);
    mkdirSync(join(d, "real", "sub"), { recursive: true });
    symlinkSync(join(d, "real", "sub"), join(d, "lnk"));
    process.env.XDG_CONFIG_HOME = join(d, "real"); // the key dir is d/real/raycast-harness
    try {
      const target = `${d}/lnk/../raycast-harness/attest.key`;
      assert.equal(resolveFsOrder(target, "/"), join(d, "real", "raycast-harness", "attest.key"));
      const p = await checkProtectedPath(target, d);
      assert.equal(p.protected, true, JSON.stringify(p));
      assert.equal(p.protected && p.what, "key");
      // Relative, from the payload cwd.
      assert.equal((await checkProtectedPath("lnk/../raycast-harness/generations/x.json", d)).protected, true);
      // The lexical reading alone would have said d/raycast-harness, which is not protected.
      assert.equal((await checkProtectedPath(join(d, "raycast-harness", "attest.key"), d)).protected, false);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

test("protected paths: alias/../receipt.json, where alias → repo/.git/rx/child, is rx state", async () => {
  await withGatedEnv(async (dir) => {
    const { root, state } = await gated(dir);
    mkdirSync(join(state, "child"));
    symlinkSync(join(state, "child"), join(dir, "alias"));
    const p = await checkProtectedPath("alias/../receipt.json", dir);
    assert.equal(p.protected, true, JSON.stringify(p));
    assert.equal(p.path, join(realpathSync(state), "receipt.json"));
    const w = await guard(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "alias/../receipt.json", content: "{}" }, cwd: dir }));
    assert.equal(guardResult(w).verdict, "FAIL", guardResult(w).message);
    const b = await guard(bashPayload("cp saved.json alias/../receipt.json", dir));
    assert.equal(guardResult(b).verdict, "FAIL", guardResult(b).message);
    void root;
  });
});

// ---- 4. audit record checks the receipt's provenance ----------------------------------------

test("audit record: an unattested, unbound or FAIL-recording receipt is ERROR audit-receipt with the guard's sentence; audit show WARNs with it", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gated(dir);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const entries = writeEntries(dir, fullEntries());

    // Unattested (an older rx, or by hand), current fingerprints and the same rxVersion.
    const { attestation: _a, ...bare } = receipt;
    writeFileSync(receiptPath, JSON.stringify(bare));
    const r1 = await auditRecord(root, entries);
    assert.equal(r1.code, 2, r1.stdout);
    assert.equal(byId(r1)["audit-receipt"].verdict, "ERROR");
    assert.equal(byId(r1)["audit-receipt"].message, "receipt.json is not attested by this machine's rx key: re-run rx gates, then rx audit record");
    assert.ok(!existsSync(auditPath), "no audit is written over an unattested receipt");

    // Attested but recording a FAIL.
    writeAttested(receiptPath, { ...receipt, results: receipt.results.map((/** @type {any} */ x) => (x.id === "lint" ? { ...x, verdict: "FAIL" } : x)) });
    const r2 = await auditRecord(root, entries);
    assert.equal(r2.code, 2);
    assert.match(byId(r2)["audit-receipt"].message, /^the receipt records 1 FAIL\/ERROR result\(s\) \(lint\); a receipt is only written clean, so this one was edited: run rx gates again$/);

    // Restored after a later gates attempt.
    writeFileSync(receiptPath, JSON.stringify(receipt));
    rotateGeneration(root);
    const r3 = await auditRecord(root, entries);
    assert.equal(r3.code, 2);
    assert.equal(byId(r3)["audit-receipt"].message, "receipt.json is from an earlier rx gates attempt; run rx gates again");

    // show: provenance failures are WARN with the sentence.
    assert.equal((await gates(root)).code, 0);
    assert.equal((await auditRecord(root, entries)).code, 0);
    const ok = await rx(["audit", "show", "--root", root, "--json"]);
    assert.equal(byId(ok)["audit-show"].verdict, "PASS");
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    const { attestation: _b, ...bareAudit } = audit;
    writeFileSync(auditPath, JSON.stringify(bareAudit));
    const s1 = await rx(["audit", "show", "--root", root, "--json"]);
    assert.equal(byId(s1)["audit-show"].verdict, "WARN");
    assert.equal(byId(s1)["audit-show"].message, "audit.json is not attested by this machine's rx key: re-run rx audit record");
    writeFileSync(auditPath, JSON.stringify(audit));
    rotateGeneration(root);
    const s2 = await rx(["audit", "show", "--root", root, "--json"]);
    assert.equal(byId(s2)["audit-show"].verdict, "WARN");
    assert.equal(byId(s2)["audit-show"].message, "receipt.json is from an earlier rx gates attempt; run rx gates again");
  });
});

// ---- 6. key directory mode ------------------------------------------------------------------

/**
 * withTempDir with XDG_CONFIG_HOME at <dir>/config and the doctor's gh probe stubbed.
 * @template T
 * @param {(dir: string) => Promise<T> | T} fn
 */
async function withConfig(fn) {
  return withTempDir(async (dir) => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    _setGhForTests(async () => ({ code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." }));
    try {
      return await fn(dir);
    } finally {
      _setGhForTests(null);
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
}

test("key directory: an existing directory open to group or other is ERROR attest-key naming it and the chmod 700 fix, never chmodded; doctor reports the same", async () => {
  await withConfig(async (dir) => {
    const { dir: keyDir, file } = keyPaths();
    mkdirSync(keyDir, { recursive: true });
    chmodSync(keyDir, 0o755);
    const want = `the rx attestation key directory ${keyDir} has mode 0755; it must not be accessible to group or other, and rx does not change a directory it did not create: run chmod 700 ${keyDir}`;
    assert.throws(() => loadOrCreateKey(), (e) => e instanceof RxError && e.id === "attest-key" && e.message === want);
    assert.ok(!existsSync(file), "no key is created inside it");
    assert.equal(statSync(keyDir).mode & 0o777, 0o755, "the user's directory is not chmodded");
    const doc = await rx(["doctor", "--json"], { cwd: dir });
    const k = doc.json.results.find((/** @type {any} */ x) => x.id === "attest-key");
    assert.equal(k.verdict, "ERROR");
    assert.equal(k.message, want);
    assert.equal(doc.code, 2);
    assert.throws(() => rotateGeneration(dir), (e) => e instanceof RxError && e.id === "attest-key" && e.message === want);

    // Fixed by hand: the key is created, and a later loosening of an existing key's directory is caught too.
    chmodSync(keyDir, 0o700);
    loadOrCreateKey();
    chmodSync(keyDir, 0o750);
    assert.throws(() => loadOrCreateKey(), (e) => e instanceof RxError && e.message.includes("has mode 0750"));
    assert.equal(inspectKey().status, "bad");
    chmodSync(keyDir, 0o700);
    assert.equal(inspectKey().status, "ok");
  });
});

test("key directory: a directory rx creates is exactly 0700 whatever the umask", async () => {
  await withConfig(() => {
    const old = process.umask(0o000);
    try {
      loadOrCreateKey();
    } finally {
      process.umask(old);
    }
    assert.equal(statSync(keyPaths().dir).mode & 0o777, 0o700);
  });
});

// ---- Codex round W7r2 -------------------------------------------------------------------------

/**
 * Run fn with PATH pointing at an empty directory, so every git (and npm) lookup fails with ENOENT
 * while root resolution, which reads the filesystem, still succeeds.
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} fn
 */
async function withoutGit(dir, fn) {
  const empty = join(dir, "empty-bin");
  mkdirSync(empty, { recursive: true });
  const saved = process.env.PATH;
  process.env.PATH = empty;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test("W7r2 #1: gates whose git lookup throws still rotates first, so the saved receipt/audit pair blocks (run and invalidate)", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gated(dir);
    const savedReceipt = readFileSync(receiptPath);
    const savedAudit = readFileSync(auditPath);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");

    // Codex's trace: a gates attempt from a shell where git cannot be found ERRORs at the state
    // lookup; with PATH restored and the pair untouched, the guard must block.
    const r = await withoutGit(dir, () => gates(root));
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stdout, /git is not installed or not on PATH/);
    writeFileSync(receiptPath, savedReceipt);
    writeFileSync(auditPath, savedAudit);
    const g = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(g).verdict, "FAIL", guardResult(g).message);
    assert.equal(guardResult(g).message, `publish of ${realpathSync(root)} blocked: receipt.json is from an earlier rx gates attempt; run rx gates again`);

    // The same through the argument-error path (invalidate).
    assert.equal((await gates(root)).code, 0);
    assert.equal((await auditRecord(root, writeEntries(dir, fullEntries()))).code, 0);
    const again = readFileSync(receiptPath);
    const againAudit = readFileSync(auditPath);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
    const bad = await withoutGit(dir, () => rx(["gates", "--root", root, "--forbidden", FORBIDDEN, "--json"]));
    assert.equal(bad.code, 2);
    writeFileSync(receiptPath, again);
    writeFileSync(auditPath, againAudit);
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /receipt\.json is from an earlier rx gates attempt; run rx gates again$/);
  });
});

test("W7r2 #2: a generations/ directory open to group or other invalidates the stored generation; gates revokes it; the guard names the directory and chmod 700", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gated(dir);
    const savedReceipt = readFileSync(receiptPath);
    const savedAudit = readFileSync(auditPath);
    const { dir: genDir, file: genFile } = generationPaths(root);

    // Codex's trace: save the pair, loosen generations/, gates fails, restore the pair.
    chmodSync(genDir, 0o755);
    const r = await gates(root);
    assert.equal(r.code, 2, r.stdout);
    assert.equal(byId(r)["attest-key"].verdict, "ERROR");
    assert.ok(!existsSync(genFile), "the failed rotation revoked the stored generation");
    writeFileSync(receiptPath, savedReceipt);
    writeFileSync(auditPath, savedAudit);
    const want = `the rx attestation key directory ${genDir} has mode 0755; it must not be accessible to group or other, and rx does not change a directory it did not create: run chmod 700 ${genDir}`;
    const g = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(g).verdict, "FAIL", guardResult(g).message);
    assert.equal(guardResult(g).message, `publish of ${realpathSync(root)} blocked: ${want}`);

    // The reader check on its own: a valid generation file in a loosened directory is invalid.
    chmodSync(genDir, 0o700);
    assert.equal((await gates(root)).code, 0);
    assert.equal((await auditRecord(root, writeEntries(dir, fullEntries()))).code, 0);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
    chmodSync(genDir, 0o750);
    assert.equal(currentGeneration(root), null);
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /generations has mode 0750; .*run chmod 700 /);
    chmodSync(genDir, 0o700);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
  });
});

test("W7r2 #3: shellWords splits like a POSIX shell before removing quotes", () => {
  assert.deepEqual(shellWords(`cp a "/x y/z" '/p q' /r\\ s`), ["cp", "a", "/x y/z", "/p q", "/r s"]);
  assert.deepEqual(shellWords(`echo "a\\"b\\\\c\\$d\\\`e\\nf"`), ["echo", 'a"b\\c$d`e\\nf']);
  assert.deepEqual(shellWords(`echo 'a\\b' x;y|z&w<v>u(t)s`), ["echo", "a\\b", "x", "y", "z", "w", "v", "u", "t", "s"]);
  assert.deepEqual(shellWords("a\\\nb \"c\\\nd\""), ["ab", "cd"]);
  assert.deepEqual(shellWords(`x --out="/a b/c"`), ["x", "--out=/a b/c"]);
  assert.deepEqual(shellWords(`'' ""`), ["", ""]);
});

test("W7r2 #3: a config path with a space, quoted or backslash-escaped, is protected (Codex's two spellings)", async () => {
  await withTempDir(async (dir) => {
    const saved = process.env.XDG_CONFIG_HOME;
    const cfg = join(realpathSync(dir), "rx config");
    process.env.XDG_CONFIG_HOME = cfg;
    try {
      const target = join(cfg, "raycast-harness", "generations", "x.json");
      assert.equal((await checkProtectedPath(target, dir)).protected, true, "the intact pathname is protected");
      for (const cmd of [`cp saved.json "${target}"`, `cp saved.json ${target.replace(/ /g, "\\ ")}`, `cp saved.json '${target}'`, `node t.mjs --out="${target}"`]) {
        assert.ok(pathWords(cmd).includes(target), `${cmd}: ${JSON.stringify(pathWords(cmd))}`);
        assert.ok(await mentionsProtectedPath(cmd, dir), cmd);
        assert.deepEqual(await classifyCommand(cmd, dir), { kind: "state" }, cmd);
      }
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

// `rx guard` (docs/commands.md §4.9): the eight recorded-payload cases the plan names, plus the
// hook transport (allow is silent, block is one JSON deny document, exit 0) and the command
// classifiers. Receipts and audits are produced by the real `rx gates` / `rx audit record`, then
// mutated on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { denyDocument, run as guardRun } from "../src/commands/guard.mjs";
import { mentionsPublish, mentionsReady, readCommand } from "../src/audit/publish-command.mjs";
import { Results } from "../src/verdict.mjs";
import { auditRecord, bashPayload, buildGated, byId, fullEntries, gates, guard, stateDir, withGatedEnv, writeEntries } from "./gates-helpers.mjs";
import { rx } from "./helpers.mjs";

const PUBLISH = "npm run publish";

/** A fully gated extension: clean receipt and clean audit. @param {string} dir */
async function gated(dir) {
  const { root } = await buildGated(dir);
  const g = await gates(root);
  assert.equal(g.code, 0, g.stdout);
  const a = await auditRecord(root, writeEntries(dir, fullEntries()));
  assert.equal(a.code, 0, a.stdout);
  const state = await stateDir(root);
  return { root, receiptPath: join(state, "receipt.json"), auditPath: join(state, "audit.json") };
}

/** @param {any} r */
const guardResult = (r) => byId(r).guard;
/** Roots are reported physically (the directory bash would publish from). @param {string} p */
const phys = (p) => realpathSync(p);

test("guard payload 1: no receipt → block", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(r.code, 1, r.stdout);
    assert.equal(guardResult(r).verdict, "FAIL");
    assert.match(guardResult(r).message, /^publish of .* blocked: no gates receipt at .*receipt\.json; run rx gates, then rx audit record$/);
    assert.deepEqual(r.json.data.receipt, { present: false, fresh: false, complete: false });
    assert.equal(r.json.data.decision, "block");
    assert.equal(r.json.data.command, PUBLISH);
  });
});

test("guard payload 2: a current receipt that records a FAIL → block", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath } = await gated(dir);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.results.find((/** @type {any} */ x) => x.id === "lint").verdict = "FAIL";
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(r.code, 1);
    assert.match(guardResult(r).message, /records 1 FAIL\/ERROR result\(s\) \(lint\)/);
    assert.deepEqual(r.json.data.roots, [phys(root)]);
    assert.deepEqual(r.json.data.receipt, { present: true, fresh: true, complete: false });
  });
});

test("guard payload 3: a receipt missing a required step → block", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath } = await gated(dir);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.steps = receipt.steps.filter((/** @type {string} */ s) => s !== "scan" && s !== "tsc");
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(r.code, 1);
    assert.match(guardResult(r).message, /the receipt lacks step scan; run rx gates again/);
    assert.deepEqual(r.json.data.receipt, { present: false, fresh: false, complete: false }, "a receipt without every step is malformed, not merely incomplete");
  });
});

test("guard payload 4: a stale fingerprint (the tree changed after gates) → block naming the field", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir);
    writeFileSync(join(root, "untracked-note.txt"), "added after gates\n");
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(r.code, 1);
    assert.match(guardResult(r).message, /the receipt is stale: payload changed since rx gates ran/);
    assert.deepEqual(r.json.data.receipt, { present: true, fresh: false, complete: false });
    rmSync(join(root, "untracked-note.txt"));
    // The preset file changing also stales it (re-read from the receipt's recorded input path).
    const receipt = JSON.parse(readFileSync(join(await stateDir(root), "receipt.json"), "utf8"));
    receipt.fingerprints.preset = "0".repeat(64);
    writeFileSync(join(await stateDir(root), "receipt.json"), JSON.stringify(receipt));
    const r2 = await guard(bashPayload(PUBLISH, root));
    assert.match(guardResult(r2).message, /stale: preset changed/);
  });
});

test("guard payload 5: a valid receipt without an audit → block", async () => {
  await withGatedEnv(async (dir) => {
    const { root, auditPath } = await gated(dir);
    rmSync(auditPath);
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(r.code, 1);
    assert.match(guardResult(r).message, /no audit at .*audit\.json; run rx audit record/);
    assert.deepEqual(r.json.data.receipt, { present: true, fresh: true, complete: true });
    assert.deepEqual(r.json.data.audit, { present: false, fresh: false, blocking: true });
  });
});

test("guard payload 6: a valid receipt and an audit with a blocking failure → block naming it; an audit from another receipt → block", async () => {
  await withGatedEnv(async (dir) => {
    const { root, auditPath } = await gated(dir);
    const a = await auditRecord(root, writeEntries(dir, fullEntries({ overrides: { "copy-error": { result: "fail", evidence: "no Copy Error on the failure toast" } } })));
    assert.equal(a.code, 1);
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(r.code, 1);
    assert.match(guardResult(r).message, /the audit carries 1 blocking reason\(s\): copy-error: fail/);
    assert.deepEqual(r.json.data.audit, { present: true, fresh: true, blocking: true });
    // A report-only fail does not block.
    const rep = await auditRecord(root, writeEntries(dir, fullEntries({ overrides: { kit: { result: "fail", evidence: "hand-rolled toasts" } } })));
    assert.equal(rep.code, 0);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
    // An audit tied to a different receipt.
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    audit.fingerprint = "f".repeat(64);
    writeFileSync(auditPath, JSON.stringify(audit));
    const r3 = await guard(bashPayload(PUBLISH, root));
    assert.match(guardResult(r3).message, /tied to a different receipt/);
    assert.deepEqual(r3.json.data.audit, { present: true, fresh: false, blocking: true });
  });
});

test("guard payload 7: everything valid → allow, for every publish spelling; the hook transport is silent", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir);
    for (const cmd of [PUBLISH, "ray publish", "  npm run publish  ", "ray publish>/tmp/rx-guard-test.log", "ray publish >> /tmp/rx-guard-test.log 2>&1", "npm run publish 2>/dev/null", "npm run publish &>/tmp/rx-guard-test.log", "cd . && npm run publish", `cd ${root} && ray publish`, `cd "${root}" && npm run publish`, `cd '${root}' && npm run publish`]) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(r.code, 0, `${cmd}: ${r.stdout}`);
      assert.equal(guardResult(r).verdict, "PASS", `${cmd}: ${guardResult(r).message}`);
      assert.equal(r.json.data.decision, "allow");
      assert.deepEqual(r.json.data.roots, [phys(root)], cmd);
      assert.deepEqual(r.json.data.receipt, { present: true, fresh: true, complete: true });
      assert.deepEqual(r.json.data.audit, { present: true, fresh: true, blocking: false });
      assert.match(r.json.fingerprint, /^[0-9a-f]{64}$/);
    }
    // The payload's cwd may be a subdirectory of the extension: the root resolves upward.
    const sub = await guard(bashPayload(PUBLISH, join(root, "src")));
    assert.equal(guardResult(sub).verdict, "PASS");

    // Hook transport (no --json): allow prints nothing, exit 0.
    const results = new Results();
    const out = /** @type {any} */ (await guardRun({ args: { subcommand: null, positionals: {}, flags: {}, json: false, help: false }, root: null, cwd: root, env: process.env, results, stdin: async () => bashPayload(PUBLISH, root), log: () => {}, version: "0.1.0" }));
    assert.deepEqual(out.transport, { stdout: "", exit: 0 });
    assert.equal(results.items[0].verdict, "PASS");
  });
});

test("guard payload 8: `gh pr ready` in any form → block, whatever the receipt and audit say", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir);
    for (const cmd of ["gh pr ready", "gh pr ready 12345", "gh pr ready --repo raycast/extensions 12345", "cd x; gh pr ready", "gh api -X PATCH repos/raycast/extensions/pulls/1 -f draft=false", "gh api graphql -f query='mutation { markPullRequestReadyForReview(input: {pullRequestId: \"x\"}) { clientMutationId } }'", "gh --repo owner/repo pr ready", "gh pr \"ready\"", "gh -R owner/repo pr ready 7", "gh api repos/o/r/pulls/1 -f ready_for_review=true"]) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(r.code, 1, cmd);
      assert.equal(guardResult(r).verdict, "FAIL", cmd);
      assert.match(guardResult(r).message, /marking a PR ready for review is Chris's click/);
      assert.equal(r.json.data.receipt, null, "no state is read for a ready command");
    }
    // Hook transport: one JSON deny document on stdout, exit 0.
    const results = new Results();
    let logged = "";
    const out = /** @type {any} */ (await guardRun({ args: { subcommand: null, positionals: {}, flags: {}, json: false, help: false }, root: null, cwd: root, env: process.env, results, stdin: async () => bashPayload("gh pr ready", root), log: (s) => (logged += s), version: "0.1.0" }));
    assert.equal(out.transport.exit, 0);
    const doc = JSON.parse(out.transport.stdout);
    assert.equal(doc.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(doc.hookSpecificOutput.permissionDecision, "deny");
    assert.match(doc.hookSpecificOutput.permissionDecisionReason, /Chris's click/);
    assert.equal(out.transport.stdout, denyDocument(doc.hookSpecificOutput.permissionDecisionReason));
    assert.match(logged, /rx guard: /);
  });
});

test("guard: other tools and other commands are N/A (allowed) without reading any state; a bad payload is ERROR input", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await buildGated(dir);
    const other = await guard(bashPayload("npm test && git status", root));
    assert.equal(other.code, 0);
    assert.equal(guardResult(other).verdict, "N/A");
    assert.equal(other.json.data.decision, "allow");
    assert.equal(other.json.data.receipt, null);
    // `gh pr view` is not ready; `--published`, `publishRange` and `--record-publication` are not the word publish.
    for (const cmd of ["gh pr view 1 --json isDraft", "node scripts/rx.mjs preflight --published", "node scripts/rx.mjs --record-publication o/r 1 abc", "echo already published; npm run publishing"]) {
      assert.equal(guardResult(await guard(bashPayload(cmd, root))).verdict, "N/A", cmd);
    }
    // Any other mention of the word publish blocks without reading state (the allowlist is the rule).
    for (const cmd of ["npm publish", "echo 'ray publish' > notes.txt", "git commit -m 'ray publish'"]) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(guardResult(r).verdict, "FAIL", cmd);
      assert.match(guardResult(r).message, /allows a publish only as the whole command/, cmd);
      assert.equal(r.json.data.receipt, null, cmd);
    }
    const write = await guard(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x", content: "ray publish" }, cwd: root }));
    assert.equal(guardResult(write).verdict, "N/A");
    assert.match(guardResult(write).message, /not a Bash command/);
    const bad = await rx(["guard", "--json"], { stdin: "not json" });
    assert.equal(bad.code, 2);
    assert.deepEqual(bad.json.results.map((/** @type {any} */ x) => [x.id, x.verdict]), [["input", "ERROR"]]);
    // A publish from a cwd with no extension root (above, here, or one level down) blocks with
    // that reason (never a silent allow).
    mkdirSync(join(dir, "empty"));
    const nowhere = await guard(bashPayload(PUBLISH, join(dir, "empty")));
    assert.equal(guardResult(nowhere).verdict, "FAIL");
    assert.match(guardResult(nowhere).message, /no extension root resolves from/);
  });
});

test("guard classifiers: the exact-shape allowlist", () => {
  const cwd = "/work/ext";
  for (const c of ["npm run publish", "ray publish", " npm run publish ", "ray publish>/tmp/log", "npm run publish 2>&1", "npm run publish > out.log 2>&1", "ray publish &> out.log"]) {
    assert.deepEqual(readCommand(c, cwd), { kind: "publish", dir: cwd, program: c.trim().startsWith("npm") ? "npm" : "ray" }, c);
  }
  assert.deepEqual(readCommand("cd ../other && npm run publish", cwd), { kind: "publish", dir: "/work/other", program: "npm" });
  assert.deepEqual(readCommand('cd "/abs/dir" && ray publish', cwd), { kind: "publish", dir: "/abs/dir", program: "ray" });
  assert.deepEqual(readCommand("cd './sub dir' && ray publish", cwd), { kind: "publish", dir: "/work/ext/sub dir", program: "ray" });
  assert.deepEqual(readCommand("cd ./src && ray publish", cwd), { kind: "publish", dir: "/work/ext/src", program: "ray" });
  assert.deepEqual(readCommand("cd .. && ray publish", cwd), { kind: "publish", dir: "/work", program: "ray" });
  assert.deepEqual(readCommand("cd . && ray publish", cwd), { kind: "publish", dir: "/work/ext", program: "ray" });
  assert.equal(readCommand("cd ~/x && ray publish", cwd).kind, "publish");
  assert.equal(readCommand("cd ~ && ray publish", cwd).kind, "publish");
  // Codex r4 F1: the explicit forms with a trailing slash or quoted dots are safe and allowed.
  for (const [c, dir] of /** @type {[string, string][]} */ ([["cd ./ && npm run publish", cwd], ["cd ../ && npm run publish", "/work"], ['cd "." && npm run publish', cwd], ['cd ".." && npm run publish', "/work"], ["cd ~/ && npm run publish", homedir()], ['cd "../other/" && ray publish', "/work/other"], ["cd / && ray publish", "/"]])) {
    assert.deepEqual(readCommand(c, cwd), { kind: "publish", dir, program: c.includes("npm") ? "npm" : "ray" }, c);
  }
  assert.equal(readCommand('cd ".hidden" && ray publish', cwd).kind, "unknown");
  // The cd target must say where it points without the shell: no bare names (CDPATH), no ~user, no tilde targets.
  for (const c of ["cd src && npm run publish", "cd other && ray publish", "cd ~chris && ray publish", "cd ~- && ray publish", "cd ~+ && ray publish", 'cd "~" && ray publish', "cd '~/x' && ray publish", 'cd "-" && npm run publish', 'cd "--" && ray publish', "cd 'src' && ray publish", 'cd "~chris/x" && ray publish', "cd .hidden && ray publish", "ray publish > ~chris/log", "ray publish > ~/log", "npm run publish\r", "npm run publish\u00a0", "npm run publish #comment", "npm run publish &", "npm run publish >file;"]) {
    assert.equal(readCommand(c, cwd).kind, "unknown", c);
  }
  // Every other spelling that mentions the word publish is unknown — including the ones a shell parser would accept.
  for (const c of ["npm run-script publish", "npx ray publish", "npx -y @raycast/api@2 ray publish", "(cd ext && ray publish)", 'npm run "publish"', "ray 'publish'", "npm --prefix ../other run publish", "npm run --silent publish", "FOO=1 npm run publish", 'FOO="1" npm run publish', "env FOO=1 npm run publish", "time npm run publish", "./node_modules/.bin/ray publish", "npm run publish && echo ok", "npm run publish; npm run publish", "ray publish 2>&1 | tee log", "! npm run publish", "if true; then npm run publish; fi", "npm run pub\\\nlish", "npm run publish\n", "cd $DIR && npm run publish", "cd ../a && cd ../b && npm run publish", "(cd ../B); npm run publish", "cd ../B | cat; npm run publish", "npm run --prefix ../B publish", "npm --workspace=B run publish", 'npx -c "ray publish"', '"$(printf ray)" publish', "npm publish", "npm run publish-docs", "echo ray publish", "yarn publish", 'git commit -m "ray publish"', "ray publish > $LOG", "ray publish > 'a b'", "ray publish > a*", "rayx publish", "echo $(date) publish", "echo ok # mention; ray publish", "$CMD publish", 'eval "npm run publish"', 'bash -c "ray publish"', "cat <<EOF\nray publish\nEOF"]) {
    const r = readCommand(c, cwd);
    assert.equal(r.kind, "unknown", c);
    assert.ok(mentionsPublish(c), c);
  }
  // Not a mention: the word must stand alone.
  for (const c of ["ray build", "ray publishing", "node rx.mjs preflight --published", "node rx.mjs --record-publication o/r 1 abc", "echo publishRange", "npm test && git status", "echo $(date)", 'bash -c "ls"', "eval ls", "cat <<EOF\nhello\nEOF", "$EDITOR notes.md", "gh pr view", "gh api repos/x/pulls/1 --jq .draft", "echo already"]) {
    assert.deepEqual(readCommand(c, cwd), { kind: "other" }, c);
    assert.ok(!mentionsPublish(c), c);
  }
  // Ready: any mention, any quoting, wins over everything else.
  for (const c of ["gh pr ready", "gh pr ready 1 --undo", "gh api repos/x/pulls/1 -X PATCH -f draft=false", "gh api graphql -f query='markPullRequestReadyForReview'", "gh --repo owner/repo pr ready", 'gh pr "ready"', 'gh pr "re""ady"', "gh pr re\\ady", "gh pr re\\\nady", "gh api repos/o/r/pulls/1 -f ready_for_review=true", "ray publish && gh pr ready", "echo gh pr ready", "echo draft=false", "curl -d '{\"query\":\"mutation{markPullRequestReadyForReview\"}'"]) {
    assert.deepEqual(readCommand(c, cwd), { kind: "ready" }, c);
    assert.ok(mentionsReady(c), c);
  }
  // The ship skill's attribution query reads timeline events named ready_for_review: a read, not a mention.
  const timeline = 'gh api "repos/raycast/extensions/issues/$PR/timeline?per_page=100" \\\n  -H "Accept: application/vnd.github+json" \\\n  --jq \'.[] | select(.event=="ready_for_review" or .event=="convert_to_draft")\\\n        | {event, actor:.actor.login, at:.created_at}\'';
  assert.deepEqual(readCommand(timeline, cwd), { kind: "other" });
  for (const c of ["gh pr view", "gh pr ready-check", "echo already", "gh pr checks", timeline, "gh pr view 1 --json isDraft"]) assert.ok(!mentionsReady(c), c);
});

// ---- Codex Wave 3 review -------------------------------------------------------------------

test("guard (Codex rounds 1–2): every bypass spelling from both reviews blocks under the allowlist, before any state is read", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir); // fully gated: a shape that were recognized would be ALLOWED
    const rows = [
      // round 1: quotes, redirections to a pipe, options, prefixes, wrappers
      'npm run "publish"', 'ray "publish"', "ray publish 2>&1 | tee /tmp/rx-guard-test.log", "npm --prefix . run publish", "npm run --silent publish", "FOO=1 npm run publish", "env FOO=1 npm run publish", "time npm run publish", "npx ray publish", "npx @raycast/api ray publish", "./node_modules/.bin/ray publish && echo ok", "(npm run publish)", "npm run publish; npm run publish",
      // round 2: control words, continuations, quoted assignments and substitutions, npm option grammar, directory leaks, comments
      "! npm run publish", "if true; then npm run publish; fi", "npm run pub\\\nlish", 'FOO="1" npm run publish', '"$(printf ray)" publish', "npm run --prefix ../B publish", "npm run publish --prefix ../B", "npm --workspace=B run publish", 'npx -c "ray publish"', "(cd ../B); npm run publish", "cd ../B | cat; npm run publish", "echo ok # mention; ray publish", "echo $(date) publish",
      // undeterminable forms
      "$(echo npm) run publish", "`cat cmd` publish", 'eval "npm run publish"', 'bash -c "ray publish"', "cat <<EOF\nray publish\nEOF", "$CMD publish", "npm run $SCRIPT # publish", "npm --prefix $DIR run publish", "cd $DIR && npm run publish", "cd - && npm run publish", "cd -P .. && npm run publish", "cd ../ot* && npm run publish", "cd ../other && cd ../ext && npm run publish", "pushd ../other; popd; npm run publish",
    ];
    for (const cmd of rows) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(r.code, 1, cmd);
      assert.equal(guardResult(r).verdict, "FAIL", cmd);
      assert.match(guardResult(r).message, /^cannot determine what this command runs: the guard allows a publish only as the whole command `npm run publish` or `ray publish`/, cmd);
      assert.equal(r.json.data.receipt, null, `${cmd}: no state is read`);
      assert.deepEqual(r.json.data.roots, [], cmd);
    }
    // Ready mentions in any quoting block with the ready sentence, also beside an allowed shape.
    for (const cmd of ["gh --repo owner/repo pr ready", 'gh pr "ready"', 'gh pr "re""ady"', "gh pr re\\\nady", "gh pr ready>/dev/null", "npm run publish && gh pr ready", "sh -c 'gh pr ready'"]) {
      assert.match(guardResult(await guard(bashPayload(cmd, root))).message, /Chris's click/, cmd);
    }
    // Without the word publish or a ready mention, the same constructs are ordinary commands.
    for (const cmd of ["echo $(date)", 'bash -c "ls"', "eval ls", "cat <<EOF\nhello\nEOF", "$EDITOR notes.md", "rg 'published' docs/", "npm run build && npm run lint"]) {
      assert.equal(guardResult(await guard(bashPayload(cmd, root))).verdict, "N/A", cmd);
    }
  });
});

test("guard (Codex P1 #2): the `cd` directory of an allowed shape decides which extension's receipt counts", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir); // dir/ext, fully gated
    const other = join(dir, "other");
    const { makeExt } = await import("./preflight-helpers.mjs");
    const { initRepo } = await import("./upstream-fixtures.mjs");
    makeExt(other, { pkg: { name: "other" } });
    await initRepo(other);
    // A publish directory outside any git repository has no rx state: blocked, never an internal error.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "loose"));
    writeFileSync(join(dir, "loose", "package.json"), JSON.stringify({ name: "loose", commands: [] }));
    const loose = await guard(bashPayload("cd ../loose && npm run publish", root));
    assert.equal(guardResult(loose).verdict, "FAIL");
    assert.match(guardResult(loose).message, /has no rx state .*not inside a git repository/);
    for (const cmd of ["cd ../other && npm run publish", `cd ${other} && ray publish`, `cd "${other}" && npm run publish`]) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(guardResult(r).verdict, "FAIL", cmd);
      assert.match(guardResult(r).message, /no gates receipt at .*\/other\//, `${cmd}: ${guardResult(r).message}`);
      assert.deepEqual(r.json.data.roots, [phys(other)], cmd);
    }
    // Codex r3 #2: a cd target that is a symlink into another extension is resolved physically, so
    // the root is the one bash would publish from; a target that does not exist blocks (bash would
    // not run the publish either).
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(other, "src"), { recursive: true });
    symlinkSync(join(other, "src"), join(root, "link"));
    const viaLink = await guard(bashPayload("cd ./link && npm run publish", root));
    assert.equal(guardResult(viaLink).verdict, "FAIL");
    assert.deepEqual(viaLink.json.data.roots, [phys(other)], "the physical directory decides, not the lexical parent");
    rmSync(join(root, "link"));
    const missing = await guard(bashPayload("cd ./nowhere && npm run publish", root));
    assert.equal(guardResult(missing).verdict, "FAIL");
    assert.match(guardResult(missing).message, /does not exist/);
    assert.deepEqual(missing.json.data.roots, []);
    // The gated root, reached by cd from elsewhere.
    for (const cmd of ["cd ../ext && npm run publish", `cd ${root} && ray publish`]) {
      const r = await guard(bashPayload(cmd, other));
      assert.equal(guardResult(r).verdict, "PASS", `${cmd}: ${guardResult(r).message}`);
      assert.deepEqual(r.json.data.roots, [phys(root)], cmd);
    }
    // From a subdirectory of the extension the root resolves upward; `cd src && npm run publish` likewise.
    assert.equal(guardResult(await guard(bashPayload("cd ./src && npm run publish", root))).verdict, "PASS");
    const bare = await guard(bashPayload("cd src && npm run publish", root));
    assert.equal(guardResult(bare).verdict, "FAIL", "a bare cd target is refused (CDPATH)");
    assert.equal(bare.json.data.receipt, null);
  });
});

test("guard (Codex P1 #4): hand-written or truncated artifacts never authorize; the audit decision is recomputed", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gated(dir);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));

    // Codex's exact bypass: fingerprints + step names, no results; audit { fingerprint, blocking: [] }.
    writeFileSync(receiptPath, JSON.stringify({ fingerprints: receipt.fingerprints, steps: receipt.steps }));
    writeFileSync(auditPath, JSON.stringify({ fingerprint: receipt.fingerprints.combined, blocking: [] }));
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(r).verdict, "FAIL");
    assert.match(guardResult(r).message, /the receipt lacks inputs\.preset \/ inputs\.forbidden; run rx gates again/);
    assert.deepEqual(r.json.data.receipt, { present: false, fresh: false, complete: false });

    // A truncated receipt: every field present but lint's results gone.
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, results: receipt.results.filter((/** @type {any} */ x) => x.id !== "lint") }));
    const t = await guard(bashPayload(PUBLISH, root));
    assert.match(guardResult(t).message, /lists step lint but holds none of its results/);
    for (const [field, value] of /** @type {[string, unknown][]} */ ([["results", []], ["rxVersion", "0.0.1"], ["data", {}], ["at", undefined]])) {
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, [field]: value }));
      assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "FAIL", field);
    }
    writeFileSync(receiptPath, JSON.stringify(receipt));

    // The minimal audit against a good receipt: every missing field is named.
    writeFileSync(auditPath, JSON.stringify({ fingerprint: receipt.fingerprints.combined, blocking: [] }));
    const a = await guard(bashPayload(PUBLISH, root));
    assert.match(guardResult(a).message, /the audit was written by rx undefined, not the running/);
    // `blocking: []` is not believed: a block-rule fail inside the stored entries blocks.
    const lying = { ...audit, entries: audit.entries.map((/** @type {any} */ e) => (e.id === "copy-error" ? { ...e, result: "fail" } : e)), blocking: [] };
    writeFileSync(auditPath, JSON.stringify(lying));
    const l = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(l).verdict, "FAIL");
    assert.match(guardResult(l).message, /the audit carries 1 blocking reason\(s\): copy-error: fail/);
    // Dropping an entry, the shortcut evidence, or a required disposition is caught the same way.
    writeFileSync(auditPath, JSON.stringify({ ...audit, entries: audit.entries.filter((/** @type {any} */ e) => e.id !== "kit") }));
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /coverage: kit/);
    writeFileSync(auditPath, JSON.stringify({ ...audit, evidence: { shortcuts: [], png: audit.evidence.png } }));
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /shortcut evidence missing/);
    writeFileSync(auditPath, JSON.stringify({ ...audit, applicable: audit.applicable.filter((/** @type {any} */ x) => x.id !== "kit") }));
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /applicable rules differ/);
    writeFileSync(auditPath, JSON.stringify({ ...audit, required: [{ path: "x.png", localHash: "sha256:0", baseline: "0", kind: "OLDER-SHOT" }] }));
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /OLDER-SHOT dispositions do not match its png evidence/);
    writeFileSync(auditPath, JSON.stringify(audit));
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
  });
});

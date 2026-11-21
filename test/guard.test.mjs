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
import { VERSION } from "../src/cli.mjs";
import { commit, g as gitIn } from "./upstream-fixtures.mjs";
import { FORBIDDEN, PRESET, auditRecord, bashPayload, buildGated, byId, fullEntries, gates, guard, readJson as readJsonFile, stateDir, withGatedEnv, writeAttested, writeEntries } from "./gates-helpers.mjs";
import { afterShipped, rx } from "./helpers.mjs";
import { SHIPPED_DIR } from "../src/greptile/rules.mjs";

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
    writeAttested(receiptPath, receipt);
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
    writeAttested(receiptPath, receipt);
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
    writeAttested(join(await stateDir(root), "receipt.json"), receipt);
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
    writeAttested(auditPath, audit);
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
    const out = /** @type {any} */ (await guardRun({ args: { subcommand: null, positionals: {}, flags: {}, json: false, help: false }, root: null, cwd: root, env: process.env, results, stdin: async () => bashPayload(PUBLISH, root), log: () => {}, version: VERSION }));
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
    const out = /** @type {any} */ (await guardRun({ args: { subcommand: null, positionals: {}, flags: {}, json: false, help: false }, root: null, cwd: root, env: process.env, results, stdin: async () => bashPayload("gh pr ready", root), log: (s) => (logged += s), version: VERSION }));
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
    assert.match(guardResult(write).message, /Write of a path outside rx state/);
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

test("readCommand (Codex P2): gh's inherited flags between `pr` and `ready` still read as ready; other gh pr subcommands do not", () => {
  const cwd = "/tmp";
  // gh accepts -R/--repo (and --repo=) on `pr` itself; an unknown flag, or a flag whose value is
  // the word ready, is ambiguous and reads as ready (fail closed).
  for (const c of ["gh pr --repo owner/repo ready 42", "gh pr -R owner/repo ready 42", "gh pr --repo=owner/repo ready 42", "gh pr -R owner/repo --hostname x ready", "gh pr --repo 'owner/repo' \"ready\" 42", "gh pr\t-R\towner/repo\tready", "gh pr --unknown-flag ready", "gh pr -R ready ready", "cd x && gh pr --repo o/r ready 1"]) {
    assert.deepEqual(readCommand(c, cwd), { kind: "ready" }, c);
    assert.ok(mentionsReady(c), c);
  }
  for (const c of ["gh pr view 1 --json isDraft", "gh pr list", "gh pr --repo owner/repo view 42", "gh pr -R owner/repo list --label ready", "gh pr list --search ready", "gh pr --repo owner/repo ready-check", "gh pr -R o/r checks 42", "gh pr view 1; echo ready"]) {
    assert.deepEqual(readCommand(c, cwd), { kind: "other" }, c);
    assert.ok(!mentionsReady(c), c);
  }
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
  // Every forgery here is written WITH this machine's attestation (writeAttested), as if the key
  // had been stolen: the checks after provenance must still hold on their own.
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gated(dir);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));

    // Codex's exact bypass: fingerprints + step names, no results; audit { fingerprint, blocking: [] }.
    writeAttested(receiptPath, { fingerprints: receipt.fingerprints, steps: receipt.steps });
    writeAttested(auditPath, { fingerprint: receipt.fingerprints.combined, blocking: [] });
    const r = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(r).verdict, "FAIL");
    assert.match(guardResult(r).message, /the receipt lacks inputs\.preset \/ inputs\.forbidden; run rx gates again/);
    assert.deepEqual(r.json.data.receipt, { present: false, fresh: false, complete: false });

    // A truncated receipt: every field present but lint's results gone.
    writeAttested(receiptPath, { ...receipt, results: receipt.results.filter((/** @type {any} */ x) => x.id !== "lint") });
    const t = await guard(bashPayload(PUBLISH, root));
    assert.match(guardResult(t).message, /lists step lint but holds none of its results/);
    for (const [field, value] of /** @type {[string, unknown][]} */ ([["results", []], ["rxVersion", "0.0.1"], ["data", {}], ["at", undefined]])) {
      writeAttested(receiptPath, { ...receipt, [field]: value });
      assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "FAIL", field);
    }
    writeAttested(receiptPath, receipt);

    // The minimal audit against a good receipt: every missing field is named.
    writeAttested(auditPath, { fingerprint: receipt.fingerprints.combined, blocking: [] });
    const a = await guard(bashPayload(PUBLISH, root));
    assert.match(guardResult(a).message, /the audit was written by rx undefined, not the running/);
    // `blocking: []` is not believed: a block-rule fail inside the stored entries blocks.
    const lying = { ...audit, entries: audit.entries.map((/** @type {any} */ e) => (e.id === "copy-error" ? { ...e, result: "fail" } : e)), blocking: [] };
    writeAttested(auditPath, lying);
    const l = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(l).verdict, "FAIL");
    assert.match(guardResult(l).message, /the audit carries 1 blocking reason\(s\): copy-error: fail/);
    // Dropping an entry, the shortcut evidence, or a required disposition is caught the same way.
    writeAttested(auditPath, { ...audit, entries: audit.entries.filter((/** @type {any} */ e) => e.id !== "kit") });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /coverage: kit/);
    writeAttested(auditPath, { ...audit, evidence: { shortcuts: [], png: audit.evidence.png } });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /shortcut evidence missing/);
    writeAttested(auditPath, { ...audit, applicable: audit.applicable.filter((/** @type {any} */ x) => x.id !== "kit") });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /applicable rules differ/);
    writeAttested(auditPath, { ...audit, required: [{ path: "x.png", localHash: "sha256:0", baseline: "0", kind: "OLDER-SHOT" }] });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /png OLDER-SHOT \/ UNDECIDED dispositions do not match its png evidence/);
    // An UNDECIDED requirement is a png row too: it is checked against the png evidence, never
    // counted as a stale row.
    writeAttested(auditPath, { ...audit, required: [{ path: "x.png", localHash: "sha256:0", baseline: "sha256:1", kind: "UNDECIDED" }] });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /png OLDER-SHOT \/ UNDECIDED dispositions do not match its png evidence/);
    // The kind must agree with the evidence: an UNDECIDED WARN does not license an OLDER-SHOT row.
    const undecidedEvidence = { id: "png", verdict: "WARN", message: "x.png: UNDECIDED; color metadata differs: sRGB; compare by eye, then record an audit disposition", details: [{ file: "x.png", text: "UNDECIDED color metadata differs: sRGB" }] };
    writeAttested(auditPath, { ...audit, evidence: { ...audit.evidence, png: [...audit.evidence.png, undecidedEvidence] }, required: [{ path: "x.png", localHash: "sha256:0", baseline: "sha256:1", kind: "OLDER-SHOT" }] });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /png OLDER-SHOT \/ UNDECIDED dispositions do not match its png evidence/);
    // And an UNDECIDED WARN in the evidence with no required row is refused the same way.
    writeAttested(auditPath, { ...audit, evidence: { ...audit.evidence, png: [...audit.evidence.png, undecidedEvidence] } });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /png OLDER-SHOT \/ UNDECIDED dispositions do not match its png evidence/);
    writeAttested(auditPath, audit);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
  });
});

// ---- Plan §9 item 3: the two guard P3s ------------------------------------------------------

test("guard P3 (a): a cd target that exists but is not a directory blocks with that sentence, before any root or receipt lookup", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir); // fully gated: reaching the receipt check would ALLOW
    for (const cmd of ["cd ./package.json && npm run publish", `cd ${join(root, "package.json")} && ray publish`]) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(guardResult(r).verdict, "FAIL", cmd);
      assert.equal(guardResult(r).message, `publish blocked: the cd target ${join(root, "package.json")} is not a directory`, cmd);
      assert.deepEqual(r.json.data.roots, [], cmd);
      assert.equal(r.json.data.receipt, null, `${cmd}: no state is read`);
    }
  });
});

test("guard P3 (b): an extension found one level down through a symlinked child is reported and checked at its physical root", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir);
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(dir, "ws"));
    symlinkSync(root, join(dir, "ws", "linked"));
    const r = await guard(bashPayload(PUBLISH, join(dir, "ws")));
    assert.equal(guardResult(r).verdict, "PASS", guardResult(r).message);
    assert.deepEqual(r.json.data.roots, [phys(root)]);
    assert.ok(guardResult(r).message.endsWith(`for ${phys(root)}`), guardResult(r).message);
    // A block names the physical root too.
    rmSync(join(await stateDir(root), "audit.json"));
    const b = await guard(bashPayload(PUBLISH, join(dir, "ws")));
    assert.match(guardResult(b).message, new RegExp(`^publish of ${phys(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} blocked: no audit`));
    assert.deepEqual(b.json.data.roots, [phys(root)]);
  });
});

// ---- Plan §9 item 4: provenance ---------------------------------------------------------------

test("guard provenance: a receipt or audit without this machine's attestation blocks before any other check", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath, auditPath } = await gated(dir);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
    const { attestation: _r, ...bareReceipt } = receipt;
    const { attestation: _a, ...bareAudit } = audit;

    // A receipt written before attestation existed (or forged with a valid shape): no attestation.
    writeFileSync(receiptPath, JSON.stringify(bareReceipt, null, 2));
    const pre = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(pre).verdict, "FAIL");
    assert.equal(guardResult(pre).message, `publish of ${phys(root)} blocked: receipt.json is not attested by this machine's rx key: re-run rx gates, then rx audit record`);
    assert.deepEqual(pre.json.data.receipt, { present: false, fresh: false, complete: false });

    // A forged receipt with a valid shape and a copied attestation, one value changed: bad MAC.
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, results: receipt.results.map((/** @type {any} */ x) => (x.id === "lint" ? { ...x, message: "edited" } : x)) }));
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /blocked: receipt\.json's attestation does not verify against this machine's rx key \(the file changed after rx wrote it\): re-run rx gates/);
    // Reformatted and key-reordered, the genuine receipt still verifies (canonical JSON).
    const reordered = Object.fromEntries(Object.entries(receipt).reverse());
    writeFileSync(receiptPath, JSON.stringify(reordered, null, 4));
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");

    // A forged audit: valid shape, no attestation; then a changed value under the copied one.
    writeFileSync(auditPath, JSON.stringify(bareAudit));
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /blocked: audit\.json is not attested by this machine's rx key: re-run rx audit record$/);
    writeFileSync(auditPath, JSON.stringify({ ...audit, blocking: ["x"] }));
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /blocked: audit\.json's attestation does not verify/);
    writeFileSync(auditPath, JSON.stringify(audit));
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");

    // The audit's attestation is checked before the receipt's other checks: a receipt with a
    // stale fingerprint and a forged audit reports the audit's provenance first.
    writeFileSync(auditPath, JSON.stringify(bareAudit));
    writeFileSync(join(root, "late.txt"), "x\n");
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /audit\.json is not attested/);
    rmSync(join(root, "late.txt"));
    writeFileSync(auditPath, JSON.stringify(audit));

    // A rotated key: the reason names both key ids. A missing key: its own sentence; never created.
    const { keyPaths, loadOrCreateKey } = await import("../src/attest.mjs");
    rmSync(keyPaths().file);
    const missing = await guard(bashPayload(PUBLISH, root));
    assert.match(guardResult(missing).message, /blocked: receipt\.json cannot be verified: this machine has no rx attestation key at .*attest\.key \(rx gates creates it\)/);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(keyPaths().file), "the guard never creates the key");
    const rotated = loadOrCreateKey();
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).message, `publish of ${phys(root)} blocked: receipt.json was attested by rx key ${receipt.attestation.keyId}, not this machine's key ${rotated.keyId}: re-run rx gates, then rx audit record`);
  });
});

test("guard write protection: Write / Edit / MultiEdit / NotebookEdit into .git/rx or onto the attestation key block; other targets pass without reading state", async () => {
  await withGatedEnv(async (dir) => {
    const { root, receiptPath } = await gated(dir);
    const { keyPaths } = await import("../src/attest.mjs");
    const { symlinkSync } = await import("node:fs");
    /** @param {string} tool @param {Record<string, unknown>} input @param {string} [cwd] */
    const tp = (tool, input, cwd = root) => JSON.stringify({ session_id: "fixture", cwd, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "toolu_fixture" });
    const state = await stateDir(root);
    const blocked = [
      ["Write", { file_path: receiptPath, content: "{}" }],
      ["Write", { file_path: ".git/rx/receipt.json", content: "{}" }], // relative to the payload cwd
      ["Write", { file_path: "./src/../.git/rx/audit.json", content: "{}" }],
      ["Write", { file_path: join(root, ".GIT", "RX", "receipt.json"), content: "{}" }], // case-insensitive volume
      ["Write", { file_path: join(state, "new", "deep.json"), content: "{}" }], // not yet existing
      ["Write", { file_path: join(dir, "not-a-repo", ".git", "rx", "receipt.json"), content: "{}" }], // no repository: the segment rule alone
      ["Edit", { file_path: receiptPath, old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: join(state, "audit.json"), edits: [] }],
      ["NotebookEdit", { notebook_path: join(state, "x.ipynb"), new_source: "" }],
      ["Write", { file_path: keyPaths().file, content: "x" }],
      ["Write", { file_path: join(keyPaths().dir, "other"), content: "x" }],
    ];
    for (const [tool, input] of /** @type {[string, Record<string, unknown>][]} */ (blocked)) {
      const r = await guard(tp(tool, input));
      assert.equal(guardResult(r).verdict, "FAIL", `${tool} ${JSON.stringify(input)}`);
      assert.match(guardResult(r).message, new RegExp(`^rx state is written only by rx: ${tool} of `), JSON.stringify(input));
      assert.equal(r.json.data.decision, "block");
      assert.equal(r.json.data.receipt, null);
      assert.equal(typeof r.json.data.path, "string");
    }
    assert.match(guardResult(await guard(tp("Write", { file_path: keyPaths().file, content: "x" }))).message, /targets the rx attestation key or its directory/);
    assert.match(guardResult(await guard(tp("Write", { file_path: receiptPath, content: "x" }))).message, /targets the rx state directory .*\.git\/rx; run the rx command that owns it/);

    // Physical resolution: a symlink into .git/rx, and a dangling one whose target would be created.
    symlinkSync(receiptPath, join(dir, "innocent.json"));
    symlinkSync(join(state, "not-yet.json"), join(dir, "dangling.json"));
    symlinkSync(state, join(dir, "statelink"));
    for (const f of [join(dir, "innocent.json"), join(dir, "dangling.json"), join(dir, "statelink", "receipt.json")]) {
      const r = await guard(tp("Write", { file_path: f, content: "{}" }, dir));
      assert.equal(guardResult(r).verdict, "FAIL", f);
      assert.equal(r.json.data.path.toLowerCase().includes(`${"/.git/rx/"}`), true, r.json.data.path);
    }

    // A repository whose git dir is not named .git: recognized through `git rev-parse --git-path rx`.
    const { execFileSync } = await import("node:child_process");
    const sep = join(dir, "sep");
    mkdirSync(sep);
    execFileSync("git", ["init", "-q", `--separate-git-dir=${join(dir, "sep-gitdir")}`], { cwd: sep });
    const sepState = join(dir, "sep-gitdir", "rx", "receipt.json");
    const viaGit = await guard(tp("Write", { file_path: sepState, content: "{}" }, sep));
    assert.equal(guardResult(viaGit).verdict, "FAIL", guardResult(viaGit).message);
    assert.match(guardResult(viaGit).message, /sep-gitdir\/rx/);

    // Allowed, silently: ordinary files, git's own files, look-alike names, other tools, no path.
    for (const [tool, input] of /** @type {[string, Record<string, unknown>][]} */ ([
      ["Write", { file_path: join(root, "src", "index.tsx"), content: "x" }],
      ["Edit", { file_path: join(root, "package.json"), old_string: "a", new_string: "b" }],
      ["Write", { file_path: join(root, ".git", "rx-old", "receipt.json"), content: "x" }],
      ["Write", { file_path: join(root, "docs", "rx", "receipt.json"), content: "x" }],
      ["Write", { file_path: join(dir, "config", "raycast-harness-other", "attest.key"), content: "x" }],
      ["NotebookEdit", { notebook_path: join(root, "n.ipynb"), new_source: "" }],
      ["Write", { content: "x" }],
      ["Read", { file_path: receiptPath }],
    ])) {
      const r = await guard(tp(tool, input));
      assert.equal(guardResult(r).verdict, "N/A", `${tool} ${JSON.stringify(input)}: ${guardResult(r).message}`);
      assert.equal(r.json.data.decision, "allow");
      assert.equal(r.json.data.receipt, null);
    }
    // The hook transport for a blocked write: one deny document, exit 0.
    const results = new Results();
    const out = /** @type {any} */ (await guardRun({ args: { subcommand: null, positionals: {}, flags: {}, json: false, help: false }, root: null, cwd: root, env: process.env, results, stdin: async () => tp("Write", { file_path: receiptPath, content: "{}" }), log: () => {}, version: VERSION }));
    assert.equal(out.transport.exit, 0);
    assert.match(JSON.parse(out.transport.stdout).hookSpecificOutput.permissionDecisionReason, /^rx state is written only by rx/);
  });
});

test("guard state mentions: a Bash command that mentions .git/rx or the attestation key blocks; rx's own calls pass", async () => {
  await withGatedEnv(async (dir) => {
    const { root } = await gated(dir);
    for (const cmd of ["echo x > .git/rx/receipt.json", "cat .git/rx/receipt.json", "cp /tmp/r.json ./.git/rx/receipt.json", 'echo "{}" > ".git/rx/audit.json"', "rm -rf .git/rx", "ls .git/rx/", "echo x >.git/r\\x/receipt.json", "cat ~/.config/raycast-harness/attest.key", "cp k ~/.config/raycast-harness/attest.key", "node -e \"require('fs').writeFileSync('.GIT/RX/receipt.json','{}')\""]) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(guardResult(r).verdict, "FAIL", cmd);
      assert.match(guardResult(r).message, /^rx state is written only by rx: this command mentions \.git\/rx or the rx attestation key/, cmd);
      assert.equal(r.json.data.receipt, null, cmd);
    }
    for (const cmd of ["node scripts/rx.mjs gates --preset presets/chrismessina.json --forbidden ../forbidden.txt", "node scripts/rx.mjs audit record --preset p.json --entries ../e.json", "node scripts/rx.mjs audit show", "git rev-parse --git-path rx", "ls .git/rx-old", "cat .git/config", "ls ~/.config/raycast-harness-other"]) {
      const r = await guard(bashPayload(cmd, root));
      assert.equal(guardResult(r).verdict, "N/A", `${cmd}: ${guardResult(r).message}`);
    }
  });
});

// ---- The audit is bound to the Greptile rules it judged -----------------------------------------

/**
 * Write an `rx greptile update`-shaped cache copy of the shipped rules under the test's cache,
 * committed after the shipped copy so it is the copy in use; `change` edits config.json.
 * @param {string} dir @param {string} sha @param {(c: any) => void} change
 */
function cachedRules(dir, sha, change) {
  const copy = join(dir, "cache", "raycast-harness", "greptile", "rules", `copy-${sha.slice(0, 7)}`);
  mkdirSync(copy, { recursive: true });
  for (const f of ["files.json", "rules.md"]) writeFileSync(join(copy, f), readFileSync(join(SHIPPED_DIR, f), "utf8"));
  const config = JSON.parse(readFileSync(join(SHIPPED_DIR, "config.json"), "utf8"));
  change(config);
  writeFileSync(join(copy, "config.json"), JSON.stringify(config));
  writeFileSync(join(copy, "SOURCE.json"), JSON.stringify({ repo: "raycast/extensions", source: "main", sha, committed: afterShipped(2), fetched: "2026-11-05T00:00:01.000Z" }));
  return copy;
}

test("guard (W9 finding 1): changed rule text under the same ids blocks a recorded audit; a legacy audit without greptileRules blocks with the same sentence", async () => {
  await withGatedEnv(async (dir) => {
    const { root, auditPath } = await gated(dir);
    const shipped = JSON.parse(readFileSync(join(SHIPPED_DIR, "SOURCE.json"), "utf8")).sha.slice(0, 7);
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    assert.equal(audit.greptileRules.sha.slice(0, 7), shipped);
    assert.match(audit.greptileRules.digest, /^[0-9a-f]{64}$/);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");

    // Same ids, one judgment rule's text changed: the applicable-id set is unchanged, so only the
    // rules binding can catch it. The receipt names the old rules too, so the recovery is
    // rx gates, then rx audit record.
    const copy = cachedRules(dir, "cccccccccccccccccccccccccccccccccccccccc", (c) => {
      const r = c.rules.find((/** @type {any} */ x) => x.id === "no-silent-failure");
      r.rule += "\n\nAlso flag: a new requirement the audit never read.";
    });
    const blocked = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(blocked).verdict, "FAIL");
    assert.match(guardResult(blocked).message, new RegExp(`the Greptile rules changed since the audit was recorded \\(${shipped} → ccccccc\\); run rx gates, then rx audit record$`));
    const show = await rx(["audit", "show", "--root", root, "--json"]);
    assert.equal(byId(show)["audit-show"].verdict, "WARN");
    assert.equal(byId(show)["audit-show"].message, `the Greptile rules changed since the audit was recorded (${shipped} → ccccccc); run rx gates, then rx audit record`);

    // The digest decides, not the sha: the same sha with different text still blocks.
    rmSync(copy, { recursive: true, force: true });
    cachedRules(dir, JSON.parse(readFileSync(join(SHIPPED_DIR, "SOURCE.json"), "utf8")).sha, (c) => { c.rules[0].rule += " (edited)"; });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, new RegExp(`\\(${shipped} → ${shipped}\\); run rx gates, then rx audit record$`));
    rmSync(join(dir, "cache", "raycast-harness", "greptile", "rules"), { recursive: true, force: true });
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS", "the shipped rules again: the audit matches");

    // An audit written before the field existed blocks with the same sentence.
    const { greptileRules: _drop, ...legacy } = audit;
    writeAttested(auditPath, legacy);
    const old = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(old).verdict, "FAIL");
    assert.match(guardResult(old).message, new RegExp(`the Greptile rules changed since the audit was recorded \\(unrecorded → ${shipped}\\); run rx audit record again$`));
    // A malformed field is a shape problem.
    writeAttested(auditPath, { ...audit, greptileRules: { repo: "raycast/extensions", sha: "x", digest: "y" } });
    assert.match(guardResult(await guard(bashPayload(PUBLISH, root))).message, /greptileRules is not \{ repo, sha \(40 hex\), digest \(64 hex\) \}/);
    writeAttested(auditPath, audit);
    assert.equal(guardResult(await guard(bashPayload(PUBLISH, root))).verdict, "PASS");
  });
});

test("guard: a published file the author deleted (DELETED) blocks the release until a remove-published disposition answers it", async () => {
  await withGatedEnv(async (dir) => {
    const { root, up } = await buildGated(dir, { published: true, files: { ".eslintrc.json": "{ \"extends\": \"@raycast\" }\n" } });
    rmSync(join(root, ".eslintrc.json")); // deleted in the working tree, as in an ESLint 9 migration
    const g = await rx(["gates", "--root", root, "--preset", PRESET, "--forbidden", FORBIDDEN, "--json"]);
    assert.equal(g.code, 0, g.stdout);
    assert.ok(g.json.data.receipt, "a receipt is written: DELETED is a WARN, not the ONLY-PUB FAIL");
    assert.equal(byId(g)["stale-deleted"].verdict, "WARN");
    const baseline = String(up?.sha);
    const record = (/** @type {unknown[]} */ extra) => rx(["audit", "record", "--root", root, "--preset", PRESET, "--entries", writeEntries(dir, fullEntries({ extra })), "--json"]);
    const remove = { path: ".eslintrc.json", localHash: "absent", baseline, disposition: "remove-published", reason: "replaced by eslint.config.js" };
    // The fixture's release commit edits CHANGELOG.md after the published copy: a CHECK row.
    const changelogHash = readJsonFile(join(await stateDir(root), "receipt.json")).data.stale.files.find((/** @type {any} */ f) => f.path === "CHANGELOG.md").localHash;
    const changelog = { path: "CHANGELOG.md", localHash: changelogHash, baseline, disposition: "keep-local", reason: "the local entry is this release" };

    const none = await record([changelog]);
    assert.equal(none.code, 1, none.stdout);
    assert.deepEqual(readJsonFile(join(await stateDir(root), "audit.json")).required, [
      { path: ".eslintrc.json", localHash: "absent", baseline, kind: "DELETED" },
      { path: "CHANGELOG.md", localHash: changelogHash, baseline, kind: "CHECK" },
    ]);
    assert.match(byId(none)["audit-dispositions"].details[0].text, /^DELETED needs a disposition remove-published/);
    assert.equal((await guard(bashPayload(PUBLISH, root))).json.data.decision, "block");

    const keep = await record([changelog, { ...remove, disposition: "keep-local" }]);
    assert.equal(keep.code, 1, keep.stdout);
    assert.ok(byId(keep)["audit-dispositions"].details.some((/** @type {any} */ d) => d.file === ".eslintrc.json" && d.text.startsWith("keep-local does not answer")));
    assert.equal((await guard(bashPayload(PUBLISH, root))).json.data.decision, "block");

    const ok = await record([changelog, remove]);
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(byId(ok)["audit-dispositions"].details.find((/** @type {any} */ d) => d.file === ".eslintrc.json").text, /^DELETED: remove-published/);
    const allowed = await guard(bashPayload(PUBLISH, root));
    assert.equal(guardResult(allowed).verdict, "PASS", guardResult(allowed).message);
    assert.equal(allowed.json.data.decision, "allow");
  });
});

test("guard (2026-11-03 ruling): a publish that deletes a published AGENTS.md, held out of the mirror, is allowed end to end through gates, a remove-published disposition and the guard", async () => {
  await withGatedEnv(async (dir) => {
    // Published copy: the first commit, AGENTS.md included. The mirror then untracks it and lists it
    // in .gitignore (holdout-tracked's fix), and rx holdout out moves it aside before gates.
    const { root, up } = await buildGated(dir, { published: true, files: { "AGENTS.md": "# Agents\n\nMirror notes.\n" } });
    await gitIn(root, ["rm", "-q", "--cached", "AGENTS.md"]);
    await commit(root, { ".gitignore": "node_modules/\n*.local\nAGENTS.md\n" }, "keep AGENTS.md in the mirror only");
    const preset = join(dir, "preset-ruling.json");
    const base = JSON.parse(readFileSync(PRESET, "utf8"));
    writeFileSync(preset, JSON.stringify({ ...base, holdout: { localOnly: [".env", "AGENTS.md", "CONCEPTS.md", "CLAUDE.md", "HANDOFF.md"] } }, null, 2));

    const held = await rx(["holdout", "out", "--root", root, "--preset", preset, "--json"]);
    assert.equal(held.code, 0, held.stdout);
    assert.deepEqual(held.json.data.moved.map((/** @type {any} */ m) => m.source), ["AGENTS.md"]);

    const g = await rx(["gates", "--root", root, "--preset", preset, "--forbidden", FORBIDDEN, "--json"]);
    assert.equal(g.code, 0, g.stdout);
    assert.ok(g.json.data.receipt, "a receipt is written: REMOVE is a WARN, not the ONLY-PUB FAIL");
    const rows = Object.fromEntries(readJsonFile(join(await stateDir(root), "receipt.json")).data.stale.files.map((/** @type {any} */ f) => [f.path, f]));
    assert.equal(rows["AGENTS.md"].class, "REMOVE");
    assert.equal(byId(g)["stale-remove"].verdict, "WARN");

    const baseline = String(up?.sha);
    const changelog = { path: "CHANGELOG.md", localHash: rows["CHANGELOG.md"].localHash, baseline, disposition: "keep-local", reason: "the local entry is this release" };
    const gitignore = { path: ".gitignore", localHash: rows[".gitignore"].localHash, baseline, disposition: "keep-local", reason: "AGENTS.md is now listed" };
    const remove = { path: "AGENTS.md", localHash: "absent", baseline, disposition: "remove-published", reason: "Chris's 2026-11-03 ruling: AGENTS.md stays in the mirror and is deleted from raycast/extensions" };
    const record = (/** @type {unknown[]} */ extra) => rx(["audit", "record", "--root", root, "--preset", preset, "--entries", writeEntries(dir, fullEntries({ extra })), "--json"]);

    // keep-local does not answer a REMOVE row, and remove-published answers nothing but one.
    const wrongKind = await record([changelog, gitignore, { ...remove, disposition: "keep-local" }]);
    assert.equal(wrongKind.code, 1, wrongKind.stdout);
    assert.match(byId(wrongKind)["audit-dispositions"].message, /1 outcome\(s\) without a disposition; 1 disposition\(s\) match nothing/);
    const misfit = byId(wrongKind)["audit-dispositions"].details.find((/** @type {any} */ d) => d.text.startsWith("keep-local does not answer"));
    assert.equal(misfit?.file, "AGENTS.md");
    assert.equal((await guard(bashPayload(PUBLISH, root))).json.data.decision, "block");
    const elsewhere = await record([{ ...changelog, disposition: "remove-published" }, gitignore, remove]);
    assert.equal(elsewhere.code, 1, elsewhere.stdout);
    assert.deepEqual(elsewhere.json.data.blocking, ["dispositions: 1 missing, 1 unmatched"]);

    // The right dispositions: the audit is clean and the guard allows the publish.
    const ok = await record([changelog, gitignore, remove]);
    assert.equal(ok.code, 0, ok.stdout);
    assert.deepEqual(ok.json.data.blocking, []);
    assert.match(byId(ok)["audit-dispositions"].details.find((/** @type {any} */ d) => d.file === "AGENTS.md").text, /^REMOVE: remove-published/);
    const allowed = await guard(bashPayload(PUBLISH, root));
    assert.equal(allowed.code, 0, allowed.stdout);
    assert.equal(guardResult(allowed).verdict, "PASS", guardResult(allowed).message);
    assert.equal(allowed.json.data.decision, "allow");

    const back = await rx(["holdout", "in", "--root", root, "--json"]);
    assert.equal(back.code, 0, back.stdout);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Agents\n\nMirror notes.\n", "the mirror keeps it");
  });
});

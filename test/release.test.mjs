// scripts/release.mjs (`npm run release`): the order is the point. Nothing is approved before CI
// is green on the exact commit whose tarball was uploaded, because a rejected or wrongly approved
// version burns its number; and a re-run resumes from what npm already holds instead of uploading
// twice. The fake `deps` records every call, so each test asserts exactly what ran.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ciRun, pickStaged, release, stagedFor } from "../scripts/release.mjs";

const NAME = "@chrismessina/raycast-harness";
const VERSION = "9.9.9";
const SHA = "a".repeat(40);
const OTHER = "c".repeat(40);
const SUM = "d".repeat(40);
const ID = "11111111-2222-3333-4444-555555555555";
const ENTRY = { id: ID, packageName: NAME, version: VERSION, shasum: SUM };

/**
 * @param {{ ci?: string[], stage?: unknown[][], listed?: (string | null)[], originMain?: string, upload?: number, approve?: number, headAfterUpload?: string, dirty?: string }} o
 *   `stage` and `listed` are consumed one answer per call (the last answer repeats); `listed` is the
 *   gitHead npm reports for the version, or null when npm does not list it.
 */
function fake(o = {}) {
  /** @type {string[]} */
  const calls = [];
  const ci = [...(o.ci ?? ["success"])];
  const stage = [...(o.stage ?? [[], [ENTRY]])];
  const listed = [...(o.listed ?? [null])];
  let clock = 0;
  let uploaded = false;
  /** @type {string | null} */
  let finishedWith = null;
  const next = (/** @type {any[]} */ q) => (q.length > 1 ? q.shift() : q[0]);
  const deps = {
    log: () => {},
    now: () => clock,
    sleep: async (/** @type {number} */ ms) => { clock += ms; },
    finish: async (/** @type {string} */ _n, /** @type {string} */ _v, /** @type {string} */ expected) => { finishedWith = expected; calls.push("finish"); },
    run(/** @type {string} */ cmd, /** @type {string[]} */ args) {
      const line = `${cmd} ${args.join(" ")}`;
      calls.push(line);
      if (line === "git status --porcelain") return o.dirty ?? "";
      if (line.includes("github-release.mjs --check")) return "ready\n";
      if (line === "git rev-parse HEAD") return `${uploaded && o.headAfterUpload ? o.headAfterUpload : SHA}\n`;
      if (line === "git rev-parse origin/main") return `${o.originMain ?? "b".repeat(40)}\n`;
      if (cmd === "git") return "";
      if (line === "npm pack --dry-run --json") return JSON.stringify([{ shasum: SUM }]);
      if (line.startsWith("npm view")) {
        const head = next(listed);
        return head ? JSON.stringify(head) : "";
      }
      if (line.includes("stage list")) return JSON.stringify(next(stage));
      if (cmd === "gh" && args[1] === "list") {
        const state = next(ci);
        if (state === "none") return "[]";
        const status = state === "in_progress" ? "in_progress" : "completed";
        return JSON.stringify([{ databaseId: 42, headSha: SHA, status, conclusion: status === "completed" ? state : null }]);
      }
      throw new Error(`unexpected run: ${line}`);
    },
    interactive(/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {Record<string,string>} */ env = {}) {
      calls.push(`! ${cmd} ${args.join(" ")}${env.RX_RELEASE ? " [RX_RELEASE=1]" : ""}`);
      if (cmd === "npm") { uploaded = true; return o.upload ?? 0; }
      if (args.includes("approve")) return o.approve ?? 0;
      return 0;
    },
  };
  return { deps, calls, finishedWith: () => finishedWith };
}

const go = (/** @type {ReturnType<typeof fake>} */ f, /** @type {Partial<{ argv: string[], env: Record<string, string> }>} */ extra = {}) =>
  release({ name: NAME, version: VERSION, ...extra }, f.deps, { ciAppearMs: 60_000, stageAppearMs: 30_000 });
const ran = (/** @type {ReturnType<typeof fake>} */ f, /** @type {RegExp} */ re) => f.calls.some((c) => re.test(c));

test("release: check → upload (postpublish deferred) → push → CI green → approve the staged id whose bytes are HEAD's → finish(HEAD)", async () => {
  const f = fake();
  await go(f);
  assert.deepEqual(f.calls.filter((c) => /--check|! npm|git push|gh run list|stage approve|^finish/.test(c)), [
    "node scripts/github-release.mjs --check",
    "! npm publish [RX_RELEASE=1]",
    `git push origin ${SHA}:refs/heads/main`,
    `gh run list --workflow ci.yml --commit ${SHA} --json databaseId,headSha,status,conclusion`,
    `gh run list --workflow ci.yml --commit ${SHA} --json databaseId,headSha,status,conclusion`,
    `! npx -y npm@11.19.1 stage approve ${ID}`,
    "finish",
  ]);
  assert.equal(f.finishedWith(), SHA, "finish is told which commit was uploaded and tested");
});

test("release: CI red, unfinished, or never started stops before any approval", async () => {
  const red = fake({ ci: ["failure"] });
  await assert.rejects(go(red), /CI failed .*NOT approved.*cannot be reused/);
  assert.ok(!ran(red, /stage approve/));
  assert.equal(red.finishedWith(), null);

  const pending = fake({ ci: ["in_progress"] });
  await assert.rejects(go(pending), /has not finished.*NOT approved/);
  assert.ok(!ran(pending, /stage approve/));

  const none = fake({ ci: ["none"] });
  await assert.rejects(go(none), /no CI run appeared .*NOT approved/);
  assert.ok(!ran(none, /stage approve/));

  const watched = fake({ ci: ["none", "in_progress", "success"] });
  await go(watched);
  assert.ok(watched.calls.includes("! gh run watch 42 --exit-status"));
  assert.ok(ran(watched, /stage approve/));
});

test("release: a staged upload whose bytes are not HEAD's tarball is never approved", async () => {
  const f = fake({ stage: [[], [{ ...ENTRY, shasum: "e".repeat(40) }]] });
  await assert.rejects(go(f), /0 match HEAD's tarball/);
  assert.ok(!ran(f, /stage approve|git push/));
});

test("release: HEAD moving during the upload stops before the push and the approval", async () => {
  const f = fake({ headAfterUpload: OTHER });
  await assert.rejects(go(f), /HEAD moved during the upload; nothing was approved/);
  assert.ok(!ran(f, /stage approve|git push/));
});

test("release (resume): an upload already staged with HEAD's bytes is not uploaded again; CI and approval still run", async () => {
  const f = fake({ stage: [[ENTRY]] });
  await go(f);
  assert.ok(!ran(f, /^! npm publish/), "no second upload");
  assert.ok(ran(f, /gh run list/) && ran(f, /stage approve/));
});

test("release (resume): a version already on npm from HEAD skips upload, CI and approval and only finishes; from another commit it stops", async () => {
  const f = fake({ listed: [SHA] });
  await go(f);
  assert.ok(!ran(f, /^! npm publish|stage approve|gh run/));
  assert.equal(f.finishedWith(), SHA);

  const g = fake({ listed: [OTHER] });
  await assert.rejects(go(g), /already lists .* not HEAD/);
  assert.equal(g.finishedWith(), null);
});

test("release: an upload that skipped staging is listed from HEAD, so nothing is approved and it finishes", async () => {
  const f = fake({ stage: [[]], listed: [null, SHA] });
  await go(f);
  assert.ok(!ran(f, /stage approve/));
  assert.equal(f.finishedWith(), SHA);
});

test("release: a dry run is refused before anything runs; a failed upload or approval stops there", async () => {
  for (const extra of [{ argv: ["--dry-run"] }, { env: { npm_config_dry_run: "true" } }]) {
    const f = fake();
    await assert.rejects(go(f, extra), /does not rehearse/);
    assert.deepEqual(f.calls, [], "nothing ran");
  }
  const up = fake({ upload: 1 });
  await assert.rejects(go(up), /upload failed; nothing was pushed or approved/);
  assert.ok(!ran(up, /git push/));

  const ap = fake({ approve: 1 });
  await assert.rejects(go(ap), /approving .* failed/);
  assert.equal(ap.finishedWith(), null);

  const same = fake({ originMain: SHA });
  await go(same);
  assert.ok(!ran(same, /git push/), "origin/main already at HEAD is not pushed again");
});

test("release: uncommitted changes (a version bump not yet committed) stop it first, saying to commit the release", async () => {
  const f = fake({ dirty: " M package.json\n" });
  await assert.rejects(go(f), /commit the release first/);
  assert.deepEqual(f.calls, ["git status --porcelain"], "nothing else ran");
});

test("stagedFor / pickStaged / ciRun: exact name and version; only a lone entry with HEAD's bytes is picked; the run is matched by commit", () => {
  const items = [{ ...ENTRY, version: "9.9.8" }, ENTRY, { ...ENTRY, packageName: "other" }];
  assert.deepEqual(stagedFor(items, NAME, VERSION), [{ id: ID, shasum: SUM }]);
  assert.throws(() => stagedFor({}, NAME, VERSION), /did not print a list/);
  assert.equal(pickStaged([], SUM, "x"), null);
  assert.deepEqual(pickStaged([{ id: ID, shasum: SUM }], SUM, "x"), { id: ID, shasum: SUM });
  assert.throws(() => pickStaged([{ id: ID, shasum: SUM }, { id: "z", shasum: SUM }], SUM, "x"), /2 staged upload/);
  assert.equal(ciRun([{ databaseId: 1, headSha: OTHER, status: "completed", conclusion: "success" }], SHA), null);
  assert.deepEqual(ciRun([{ databaseId: 7, headSha: SHA, status: "completed", conclusion: "failure" }], SHA), { id: 7, done: true, ok: false });
});

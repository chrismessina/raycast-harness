import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { REPO, withTempDir } from "./helpers.mjs";

const HOOK = join(REPO, "scripts", "commit-msg");

/** @param {string} message */
function runHook(message) {
  return withTempDir(
    (dir) =>
      new Promise((resolve) => {
        const file = join(dir, "COMMIT_EDITMSG");
        writeFileSync(file, message);
        execFile(process.execPath, [HOOK, file], { encoding: "utf8" }, (err, stdout, stderr) => {
          const code = err && typeof (/** @type {any} */ (err).code) === "number" ? /** @type {any} */ (err).code : err ? 1 : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
  );
}

test("rejects a message containing a claude.ai/code/session URL", async () => {
  const r = await runHook("fix: thing\n\nClaude-Session: https://claude.ai/code/session_x\n");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /contains a claude\.ai\/code\/session URL/);
});

test("accepts a message with only a Co-Authored-By: Claude trailer", async () => {
  const r = await runHook("fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
});

test("accepts an ordinary message", async () => {
  assert.equal((await runHook("docs: readme\n")).code, 0);
});

test("exits 2 without a message file argument", async () => {
  const r = await new Promise((resolve) =>
    execFile(process.execPath, [HOOK], { encoding: "utf8" }, (err) => resolve(err && /** @type {any} */ (err).code)),
  );
  assert.equal(r, 2);
});

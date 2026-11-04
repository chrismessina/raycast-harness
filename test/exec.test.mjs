import { test } from "node:test";
import assert from "node:assert/strict";
import { run, runOk } from "../src/exec.mjs";
import { RxError } from "../src/errors.mjs";

const node = process.execPath;

test("a normal non-zero exit resolves with its code", async () => {
  const r = await run(node, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
  assert.deepEqual(r, { code: 3, stdout: "out", stderr: "err" });
});

test("a missing program rejects with RxError tooling", async () => {
  await assert.rejects(run("rx-definitely-not-installed", []), (e) => e instanceof RxError && e.id === "tooling" && /not installed/.test(e.message));
});

test("a timeout rejects instead of resolving as exit 1", async () => {
  await assert.rejects(run(node, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 200 }), (e) => e instanceof RxError && /timed out after 200 ms/.test(e.message));
});

test("a signal death rejects", async () => {
  await assert.rejects(run(node, ["-e", "process.kill(process.pid, 'SIGKILL')"]), (e) => e instanceof RxError && /killed by SIGKILL/.test(e.message));
});

test("exceeding maxBuffer rejects with a diagnostic", async () => {
  await assert.rejects(run(node, ["-e", "process.stdout.write('x'.repeat(5000))"], { maxBuffer: 1024 }), (e) => e instanceof RxError && /exceeded 1024 bytes/.test(e.message));
});

test("input to a child that exits without reading it does not crash the process", async () => {
  const r = await run(node, ["-e", "process.exit(0)"], { input: "y".repeat(512 * 1024) });
  assert.equal(r.code, 0);
});

test("runOk throws on non-zero exit with the first stderr line", async () => {
  await assert.rejects(runOk(node, ["-e", "console.error('bad thing\\nmore'); process.exit(1)"]), /failed: bad thing/);
});

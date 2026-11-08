import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run, runOk } from "../src/exec.mjs";
import { gh } from "../src/gh.mjs";
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

// ---- AbortSignal (W10: the greptile-rules step's deadline kills its gh child) -------------------

/** A script that sleeps 10 s. @param {string} dir */
function sleeper(dir) {
  const f = join(dir, "sleep10.mjs");
  writeFileSync(f, "setTimeout(() => {}, 10_000);\n");
  return f;
}

test("an aborted signal kills the child promptly and rejects (aborted, not timed out or a negative result)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rx-exec-"));
  try {
    const t0 = Date.now();
    await assert.rejects(run(node, [sleeper(dir)], { signal: AbortSignal.timeout(50) }), (e) => e instanceof RxError && /: aborted$/.test(e.message));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2_000, `run returned after ${elapsed} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a process whose child was aborted does not stay alive: a driver aborting a 10 s child at 50 ms exits promptly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rx-exec-"));
  try {
    const driver = join(dir, "driver.mjs");
    const exec = pathToFileURL(join(import.meta.dirname, "..", "src", "exec.mjs")).href;
    writeFileSync(driver, `import { run } from ${JSON.stringify(exec)};\nawait run(process.execPath, [${JSON.stringify(sleeper(dir))}], { signal: AbortSignal.timeout(50) }).catch((e) => console.log(e.message));\n`);
    const t0 = Date.now();
    const r = await run(node, [driver], { timeoutMs: 15_000 });
    const elapsed = Date.now() - t0;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /: aborted$/m);
    assert.ok(elapsed < 3_000, `the driver stayed alive ${elapsed} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gh(): the signal reaches the 1Password fallback child (op plugin run -- gh), which is killed on abort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rx-gh-"));
  const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  try {
    // A plain gh that is not logged in, and an op whose `plugin run` hangs.
    const bin = (/** @type {string} */ name, /** @type {string} */ body) => {
      const f = join(dir, name);
      writeFileSync(f, `#!${node}\n${body}\n`);
      chmodSync(f, 0o755);
    };
    bin("gh", "process.stderr.write('You are not logged into any GitHub hosts\\n'); process.exit(4);");
    const started = join(dir, "op-plugin-started");
    bin("op", `if (process.argv[2] === '--version') { console.log('2.0.0'); } else { require('node:fs').writeFileSync(${JSON.stringify(started)}, ''); setTimeout(() => {}, 10_000); }`);
    process.env.PATH = `${dir}:${saved.PATH}`;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    // Abort once the fallback child is running (deterministic: no race with node start-up).
    const ac = new AbortController();
    const poll = setInterval(() => {
      if (existsSync(started)) {
        clearInterval(poll);
        ac.abort();
      }
    }, 10);
    const t0 = Date.now();
    try {
      await assert.rejects(gh(["api", "x"], { signal: ac.signal }), (e) => e instanceof RxError && /^op plugin run -- gh api x: aborted$/.test(e.message));
    } finally {
      clearInterval(poll);
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 6_000, `gh() returned after ${elapsed} ms; the op child slept 10 s`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a signal, run behaves as before (a child is never aborted)", async () => {
  const r = await run(node, ["-e", "setTimeout(() => process.exit(0), 100)"]);
  assert.equal(r.code, 0);
});

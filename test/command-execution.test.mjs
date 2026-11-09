// The completion kernel (src/command-execution.mjs), driven through both of its callers: the
// dispatcher (runCli, with scratch command modules loaded through the test-only `commandsDir`
// override) and the in-process step runner `gates` and `audit record` use (runStep). Each shared
// rule has one test per path; where the paths deliberately differ, both behaviors are pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.mjs";
import { runStep } from "../src/audit/step.mjs";
import { RxError } from "../src/errors.mjs";
import { withTempDir } from "./helpers.mjs";

const ERRORS_URL = JSON.stringify(new URL("../src/errors.mjs", import.meta.url).href);
const STEP_URL = JSON.stringify(new URL("../src/audit/step.mjs", import.meta.url).href);

/**
 * Run `rx <argv>` in-process against one scratch module named zz-kernel.
 * @param {string} source @param {string[]} argv
 */
async function cli(source, argv = ["zz-kernel", "--json"]) {
  return withTempDir(async (dir) => {
    writeFileSync(join(dir, "zz-kernel.mjs"), source);
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { cwd: dir, commandsDir: dir, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
    return { code, stdout, stderr, json: argv.includes("--json") ? JSON.parse(stdout) : null };
  });
}

/** A parent context for runStep that records stderr. */
function parent() {
  const ctx = { cwd: process.cwd(), env: {}, stdin: async () => "", log: (/** @type {string} */ s) => (ctx.stderr += s), version: "0.0.0-test", stderr: "" };
  return ctx;
}

/** @param {(ctx: any) => any} run @param {Record<string, unknown>} [checks] */
function stepModule(run, checks = { a: "a", b: "b", tooling: "t" }) {
  return /** @type {any} */ ({ spec: { name: "zz-step", summary: "s", root: "required", checks }, run });
}

const ids = (/** @type {{ id: string, verdict: string }[]} */ items) => items.map((r) => [r.verdict, r.id]);

// Rule 1: results recorded before a throw are kept; the throw is appended as one ERROR.

test("kernel, CLI path: results recorded before a throw are kept and the throw is appended", async () => {
  const r = await cli(`import { RxError } from ${ERRORS_URL};
export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { a: "a", tooling: "t" } };
export async function run({ results }) { results.pass("a", "first"); throw new RxError("broke", { id: "tooling" }); }
`);
  assert.deepEqual(ids(r.json.results), [["PASS", "a"], ["ERROR", "tooling"]]);
  assert.deepEqual(r.json.data, {});
  assert.equal(r.json.fingerprint, null);
});

test("kernel, step path: results recorded before a throw are kept and the throw is appended", async () => {
  const out = await runStep(stepModule(async ({ results }) => { results.pass("a", "first"); throw new RxError("broke", { id: "tooling" }); }), /** @type {any} */ (parent()), { root: "/x" });
  assert.deepEqual(ids(out.results.items), [["PASS", "a"], ["ERROR", "tooling"]]);
  assert.deepEqual(out.data, {});
  assert.equal(out.fingerprint, null);
});

// Rule 2: silence is never a pass.

test("kernel, CLI path: a command that records nothing is ERROR protocol, exit 2", async () => {
  const r = await cli(`export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: {} };
export async function run() { return { data: { x: 1 } }; }
`);
  assert.equal(r.code, 2);
  assert.deepEqual(ids(r.json.results), [["ERROR", "protocol"]]);
  assert.equal(r.json.results[0].message, "zz-kernel produced no results; silence is never a pass");
  assert.deepEqual(r.json.data, { x: 1 });
});

test("kernel, step path: a step that records nothing is ERROR protocol", async () => {
  const out = await runStep(stepModule(async () => ({ data: { x: 1 } })), /** @type {any} */ (parent()), { root: "/x" });
  assert.deepEqual(ids(out.results.items), [["ERROR", "protocol"]]);
  assert.equal(out.results.items[0].message, "zz-step produced no results; silence is never a pass");
  assert.equal(out.results.exit, 2);
  assert.deepEqual(out.data, { x: 1 });
});

// Rule 3: an undeclared check id is ERROR protocol. The dispatcher checks every command against its
// own spec; a step's ids are checked one level up, against the composite's spec.

test("kernel, CLI path: an undeclared id is ERROR protocol naming the command", async () => {
  const r = await cli(`export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { a: "a" } };
export async function run({ results }) { results.pass("a", "ok"); results.pass("nope", "x"); }
`);
  assert.equal(r.code, 2);
  assert.deepEqual(ids(r.json.results), [["PASS", "a"], ["PASS", "nope"], ["ERROR", "protocol"]]);
  assert.equal(r.json.results[2].message, 'zz-kernel emitted undeclared check id "nope"; declare it in spec.checks and docs/commands.md');
});

test("kernel, step path: a step's undeclared id reaches the composite's dispatcher as ERROR protocol", async () => {
  // A composite command that runs an inline step through runStep and merges it, as gates does.
  const r = await cli(`import { runStep } from ${STEP_URL};
const step = { spec: { name: "zz-inner", summary: "s", root: "required", checks: { a: "a" } }, async run({ results }) { results.pass("a", "ok"); results.pass("nope", "x"); } };
export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { ...step.spec.checks } };
export async function run(ctx) { const s = await runStep(step, ctx, { root: "/x" }); ctx.results.merge(s.results); }
`);
  assert.equal(r.code, 2);
  assert.deepEqual(ids(r.json.results), [["PASS", "a"], ["PASS", "nope"], ["ERROR", "protocol"]]);
  assert.match(r.json.results[2].message, /^zz-kernel emitted undeclared check id "nope"/);
});

// Rule 4: ERROR outranks FAIL.

test("kernel, CLI path: a FAIL followed by a throw exits 2", async () => {
  const r = await cli(`export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { a: "a" } };
export async function run({ results }) { results.fail("a", "bad"); throw new Error("then this"); }
`);
  assert.equal(r.code, 2);
  assert.equal(r.json.exit, 2);
  assert.deepEqual(ids(r.json.results), [["FAIL", "a"], ["ERROR", "internal"]]);
});

test("kernel, step path: a FAIL followed by a throw is exit 2 for the step", async () => {
  const out = await runStep(stepModule(async ({ results }) => { results.fail("a", "bad"); throw new Error("then this"); }), /** @type {any} */ (parent()), { root: "/x" });
  assert.deepEqual(ids(out.results.items), [["FAIL", "a"], ["ERROR", "internal"]]);
  assert.equal(out.results.exit, 2);
});

// Rule 5: a thrown RxError is ERROR under its own id (first line the message, the rest details);
// any other throw is ERROR internal with its name.

test("kernel, CLI path: thrown errors become one ERROR each, RxError under its id, others internal", async () => {
  const rx = await cli(`import { RxError } from ${ERRORS_URL};
export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { tooling: "t" } };
export async function run() { throw new RxError("first\\nsecond\\n\\n third ", { id: "tooling" }); }
`);
  assert.deepEqual(rx.json.results, [{ id: "tooling", verdict: "ERROR", message: "first", details: [{ text: "second" }, { text: "third" }] }]);
  const other = await cli(`export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: {} };
export async function run() { throw new RangeError("out of range"); }
`);
  assert.deepEqual(other.json.results, [{ id: "internal", verdict: "ERROR", message: "RangeError: out of range", details: [] }]);
});

test("kernel, step path: thrown errors become one ERROR each, RxError under its id, others internal", async () => {
  const rx = await runStep(stepModule(async () => { throw new RxError("first\nsecond\n\n third ", { id: "tooling" }); }), /** @type {any} */ (parent()), { root: "/x" });
  assert.deepEqual(rx.results.items, [{ id: "tooling", verdict: "ERROR", message: "first", details: [{ text: "second" }, { text: "third" }] }]);
  const other = await runStep(stepModule(async () => { throw new RangeError("out of range"); }), /** @type {any} */ (parent()), { root: "/x" });
  assert.deepEqual(other.results.items, [{ id: "internal", verdict: "ERROR", message: "RangeError: out of range", details: [] }]);
});

// Rule 6 (a kept difference): an unexpected throw's stack goes to stderr on the CLI path only.

test("kernel, CLI path: an unexpected throw logs its stack to stderr; an RxError does not", async () => {
  const other = await cli(`export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: {} };
export async function run() { throw new RangeError("out of range"); }
`);
  assert.match(other.stderr, /^RangeError: out of range\n\s+at /);
  const rx = await cli(`import { RxError } from ${ERRORS_URL};
export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { tooling: "t" } };
export async function run() { throw new RxError("x", { id: "tooling" }); }
`);
  assert.equal(rx.stderr, "");
});

test("kernel, step path: an unexpected throw logs nothing to the composite's stderr", async () => {
  const p = parent();
  const out = await runStep(stepModule(async () => { throw new RangeError("out of range"); }), /** @type {any} */ (p), { root: "/x" });
  assert.equal(out.results.items[0].id, "internal");
  assert.equal(p.stderr, "");
});

// Rule 7 (a kept difference): when recording the ERROR itself fails (an RxError with an invalid
// id), the CLI contains it as ERROR internal; a step lets it escape to its composite.

test("kernel, CLI path: a throw that cannot be recorded is contained as 'error while reporting an error'", async () => {
  const r = await cli(`import { RxError } from ${ERRORS_URL};
export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { a: "a" } };
export async function run({ results }) { results.pass("a", "kept"); throw new RxError("x", { id: "Not_An_Id" }); }
`);
  assert.equal(r.code, 2);
  assert.deepEqual(r.json.results, [
    { id: "a", verdict: "PASS", message: "kept", details: [] },
    { id: "internal", verdict: "ERROR", message: 'error while reporting an error: not a check id: "Not_An_Id"', details: [] },
  ]);
});

test("kernel, step path: a throw that cannot be recorded escapes runStep", async () => {
  await assert.rejects(
    runStep(stepModule(async () => { throw new RxError("x", { id: "Not_An_Id" }); }), /** @type {any} */ (parent()), { root: "/x" }),
    { name: "TypeError", message: 'not a check id: "Not_An_Id"' },
  );
});

// Rule 8: a step gets none of the dispatcher's surroundings: no argument parsing, no root
// resolution, no invalidate; and the CLI does not invalidate a run whose arguments parsed.

test("kernel, step path: the step sees the caller's root and flags verbatim and is never invalidated", async () => {
  let invalidated = 0;
  /** @type {any} */
  let seen = null;
  const mod = /** @type {any} */ ({
    spec: { name: "zz-step", summary: "s", root: "required", checks: { a: "a" }, flags: { "--root": { type: "string" }, "--n": { type: "number" } } },
    async run(/** @type {any} */ ctx) { seen = ctx; ctx.results.pass("a", "ok"); },
    async invalidate() { invalidated++; },
  });
  await runStep(mod, /** @type {any} */ (parent()), { root: "/not/a/real/root", flags: { "--root": "/not/a/real/root", "--n": "7" } });
  assert.equal(invalidated, 0);
  assert.equal(seen.root, "/not/a/real/root");
  assert.deepEqual(seen.args, { subcommand: null, positionals: {}, flags: { "--root": "/not/a/real/root", "--n": "7" }, json: false, help: false });
});

test("kernel, CLI path: a run whose arguments parsed never calls invalidate", async () => {
  await withTempDir(async (dir) => {
    const marker = join(dir, "invalidated");
    const r = await cli(`import { writeFileSync } from "node:fs";
export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { a: "a" } };
export async function run({ results }) { results.pass("a", "ok"); }
export async function invalidate() { writeFileSync(${JSON.stringify(marker)}, "x"); }
`);
    assert.equal(r.code, 0);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(marker), false);
  });
});

// Rule 9: the hook transport is a CLI concern; a step drops it.

test("kernel, step path: a returned transport is dropped; data and fingerprint are kept", async () => {
  const out = await runStep(stepModule(async ({ results }) => { results.pass("a", "ok"); return { data: { d: 1 }, fingerprint: "f", transport: { stdout: "x", exit: 0 } }; }), /** @type {any} */ (parent()), { root: "/x" });
  assert.deepEqual(Object.keys(out), ["results", "data", "fingerprint"]);
  assert.deepEqual(out.data, { d: 1 });
  assert.equal(out.fingerprint, "f");
});

test("kernel, CLI path (W11 round 1): output that fails while reporting a command's throw escapes after one write attempt, as before the kernel", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "zz-kernel.mjs"), `import { RxError } from ${ERRORS_URL};
export const spec = { name: "zz-kernel", summary: "s", root: "none", checks: { a: "a" } };
export async function run() { throw new RxError("original", { id: "input" }); }
`);
    for (const fmt of [[], ["--json"], ["--format", "md"]]) {
      let writes = 0;
      let stderr = "";
      const stdout = () => {
        writes++;
        throw new Error("output failed");
      };
      await assert.rejects(runCli(["zz-kernel", ...fmt], { cwd: dir, commandsDir: dir, stdout, stderr: (s) => (stderr += s) }), /output failed/, fmt.join(" "));
      assert.equal(writes, 1, `one write attempt (${fmt.join(" ") || "text"})`);
      assert.doesNotMatch(stderr, /output failed/, "the output failure is not logged as a second error");
    }
  });
});

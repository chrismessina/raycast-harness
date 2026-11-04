import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeExtension, rx, rxProcess, withTempDir } from "./helpers.mjs";

test("unknown command → one ERROR result, exit 2 (also as a real process)", async () => {
  const r = await rx(["bogus", "--x", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(r.json.results.length, 1);
  assert.equal(r.json.results[0].verdict, "ERROR");
  assert.equal(r.json.results[0].id, "args");
  const p = await rxProcess(["bogus", "--x"]);
  assert.equal(p.code, 2);
  assert.match(p.stdout, /^ERROR {2}args {2}unknown command "bogus"/);
});

test("unknown argument to a real command → ERROR args, exit 2", async () => {
  const r = await rx(["doctor", "--published", "x", "--json"]);
  assert.equal(r.code, 2);
  assert.deepEqual(r.json.results.map((x) => [x.verdict, x.id]), [["ERROR", "args"]]);
  assert.match(r.json.results[0].message, /unknown argument "--published"/);
});

test("--json envelope has the frozen shape", async () => {
  const r = await rx(["commands", "--json"]);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.json), ["command", "version", "fingerprint", "data", "results", "exit"]);
  assert.equal(r.json.command, "commands");
  assert.match(r.json.version, /^\d+\.\d+\.\d+/);
  assert.ok(Array.isArray(r.json.data.commands));
  const names = r.json.data.commands.map((c) => c.name);
  assert.ok(names.includes("commands") && names.includes("doctor"));
  for (const c of r.json.data.commands) {
    assert.ok(["required", "optional", "none"].includes(c.root), `${c.name}.root`);
    assert.equal(typeof c.network, "string");
    assert.equal(typeof c.state, "string");
    assert.ok("--json" in c.flags && "--help" in c.flags, `${c.name} lists the global flags`);
  }
});

test("--help prints usage and exits 0; no args prints usage and exits 2; --version prints the version", async () => {
  const h = await rx(["doctor", "--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage: rx doctor \[--root <dir>\]/);
  assert.match(h.stdout, /Network: `gh auth status`/);
  const none = await rx([]);
  assert.equal(none.code, 2);
  assert.match(none.stdout, /Commands:/);
  const v = await rx(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test("a two-extension tree makes a root-taking command exit 2 asking for --root (before it runs)", async () => {
  await withTempDir(async (dir) => {
    fakeExtension(dir, "alpha");
    fakeExtension(dir, "beta");
    const r = await rx(["doctor", "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.results.map((x) => [x.verdict, x.id]), [["ERROR", "root"]]);
    assert.match(r.json.results[0].message, /alpha, beta.*--root/);
    const p = await rxProcess(["doctor"], { cwd: dir });
    assert.equal(p.code, 2);
    assert.match(p.stdout, /^ERROR {2}root {2}more than one extension/);
  });
});

test("a bad --root is an ERROR even for an optional-root command", async () => {
  await withTempDir(async (dir) => {
    const r = await rx(["doctor", "--root", "missing", "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "root");
  });
});

test("--help and --version reject unknown tokens; --help cannot be combined with --json", async () => {
  for (const argv of [["--version", "--bogus"], ["--help", "--bogus"], ["--version", "--json"]]) {
    const r = await rx(argv);
    assert.equal(r.code, 2, argv.join(" "));
    const msg = r.json ? r.json.results[0].message : r.stdout;
    assert.match(msg, /unknown argument/);
  }
  const h = await rx(["commands", "--help", "--json"]);
  assert.equal(h.code, 2);
  assert.match(h.json.results[0].message, /--help prints text/);
});

// Scratch command modules live in a temp directory and are loaded through the test-only
// `commandsDir` override, never written into src/commands/ (other test files load it concurrently).
async function withScratchCommand(source, argv, fn) {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "zz-scratch.mjs"), source);
    let stdout = "";
    const { runCli } = await import("../src/cli.mjs");
    const code = await runCli(argv, { cwd: dir, commandsDir: dir, stdout: (s) => (stdout += s), stderr: () => {} });
    await fn({ code, json: JSON.parse(stdout) });
  });
}

test("a multi-line error thrown after results were recorded keeps them and appends one ERROR with details", async () => {
  await withScratchCommand(
    `import { RxError } from ${JSON.stringify(new URL("../src/errors.mjs", import.meta.url).href)};
export const spec = { name: "zz-scratch", summary: "scratch", root: "none", checks: { a: "a", tooling: "t" } };
export async function run({ results }) { results.fail("a", "first"); throw new RxError("tool said:\\nline two\\nline three", { id: "tooling" }); }
`,
    ["zz-scratch", "--json"],
    ({ code, json: j }) => {
      assert.equal(code, 2);
      assert.deepEqual(j.results.map((x) => [x.verdict, x.id]), [["FAIL", "a"], ["ERROR", "tooling"]]);
      assert.equal(j.results[1].message, "tool said:");
      assert.deepEqual(j.results[1].details.map((d) => d.text), ["line two", "line three"]);
    },
  );
});

test("a command module that fails to load is ERROR protocol, exit 2, as one envelope", async () => {
  await withScratchCommand("export const spec = { name: 'zz-broken' ;\n", ["anything", "--json"], ({ code, json: j }) => {
    assert.equal(code, 2);
    assert.deepEqual(j.results.map((x) => [x.verdict, x.id]), [["ERROR", "protocol"]]);
    assert.match(j.results[0].message, /zz-scratch\.mjs failed to load/);
  });
});

test("an undeclared check id is ERROR protocol on the normal path, on a thrown RxError, and for a result recorded before a throw", async () => {
  const ok = `export const spec = { name: "zz-ids", summary: "s", root: "none", checks: { "stale-*": "classes" } };
export async function run({ results }) { results.pass("stale-mine", "ok"); }
`;
  await withScratchCommand(ok, ["zz-ids", "--json"], ({ code }) => assert.equal(code, 0));
  const undeclaredResult = ok.replace('results.pass("stale-mine", "ok");', 'results.pass("stale-mine", "ok"); results.pass("not-declared", "oops");');
  await withScratchCommand(undeclaredResult, ["zz-ids", "--json"], ({ code, json: j }) => {
    assert.equal(code, 2);
    assert.match(j.results.at(-1).message, /undeclared check id "not-declared"/);
  });
  const thrown = `import { RxError } from ${JSON.stringify(new URL("../src/errors.mjs", import.meta.url).href)};
export const spec = { name: "zz-ids", summary: "s", root: "none", checks: { "stale-*": "classes" } };
export async function run() { throw new RxError("boom", { id: "undeclared-error" }); }
`;
  await withScratchCommand(thrown, ["zz-ids", "--json"], ({ code, json: j }) => {
    assert.equal(code, 2);
    assert.deepEqual(j.results.map((x) => x.id), ["undeclared-error", "protocol"]);
  });
  const before = ok.replace('results.pass("stale-mine", "ok");', 'results.pass("not-declared", "x"); throw new Error("later");');
  await withScratchCommand(before, ["zz-ids", "--json"], ({ code, json: j }) => {
    assert.equal(code, 2);
    assert.ok(j.results.some((x) => x.id === "protocol" && /not-declared/.test(x.message)));
  });
});

test("a command returning `transport` (the hook exception) prints exactly transport.stdout and exits transport.exit without --json; with --json the envelope is printed", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { runCli } = await import("../src/cli.mjs");
  const source = `export const spec = { name: "zz-scratch", summary: "s", root: "none", checks: { zz: "zz" } };
export async function run({ results }) { results.fail("zz", "blocked"); return { data: { decision: "block" }, transport: { stdout: '{"deny":true}\\n', exit: 0 } }; }
`;
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "zz-scratch.mjs"), source);
    let stdout = "";
    const io = { cwd: dir, commandsDir: dir, stdout: (/** @type {string} */ s) => (stdout += s), stderr: () => {} };
    const code = await runCli(["zz-scratch"], io);
    assert.equal(code, 0, "transport.exit wins over the FAIL verdict's exit 1");
    assert.equal(stdout, '{"deny":true}\n');
    stdout = "";
    const jsonCode = await runCli(["zz-scratch", "--json"], io);
    assert.equal(jsonCode, 1);
    const env = JSON.parse(stdout);
    assert.equal(env.results[0].verdict, "FAIL");
    assert.equal(env.data.decision, "block");
  });
});

test("a command returning `transport` with an undeclared check id still gets ERROR protocol, exit 2 (the registry wins over the transport)", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { runCli } = await import("../src/cli.mjs");
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "zz-scratch.mjs"), `export const spec = { name: "zz-scratch", summary: "s", root: "none", checks: {} };
export async function run({ results }) { results.pass("nope", "x"); return { transport: { stdout: "", exit: 0 } }; }
`);
    let stdout = "";
    const code = await runCli(["zz-scratch"], { cwd: dir, commandsDir: dir, stdout: (/** @type {string} */ s) => (stdout += s), stderr: () => {} });
    assert.equal(code, 2);
    assert.match(stdout, /^ERROR {2}protocol /m);
  });
});

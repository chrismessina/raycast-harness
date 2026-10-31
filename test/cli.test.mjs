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

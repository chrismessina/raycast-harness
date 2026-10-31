import { test } from "node:test";
import assert from "node:assert/strict";
import { Results, VERDICTS, envelope, exitCodeFor, renderText } from "../src/verdict.mjs";

test("exit 0 when only PASS, WARN and N/A", () => {
  const r = new Results().pass("a", "ok").warn("b", "meh").na("c", "nothing to inspect");
  assert.equal(r.exit, 0);
});

test("exit 1 on any FAIL", () => {
  const r = new Results().pass("a", "ok").fail("b", "bad");
  assert.equal(r.exit, 1);
});

test("exit 2 on any ERROR, and ERROR outranks FAIL", () => {
  assert.equal(new Results().error("x", "boom").exit, 2);
  assert.equal(new Results().fail("a", "bad").error("x", "boom").pass("z", "ok").exit, 2);
  assert.equal(exitCodeFor([{ id: "a", verdict: "FAIL", message: "m", details: [] }, { id: "b", verdict: "ERROR", message: "m", details: [] }]), 2);
});

test("every verdict is accepted and nothing else", () => {
  for (const v of VERDICTS) new Results().add(v, "id", "message");
  assert.throws(() => new Results().add(/** @type {any} */ ("OK"), "id", "m"), /not a verdict/);
});

test("ids are kebab-case and messages are one non-empty line", () => {
  assert.throws(() => new Results().pass("Bad_Id", "m"), /not a check id/);
  assert.throws(() => new Results().pass("ok", ""), /needs a message/);
  assert.throws(() => new Results().pass("ok", "two\nlines"), /one line/);
});

test("envelope carries command, version, fingerprint, data, results and exit", () => {
  const results = new Results().fail("readme-assets", "missing", [{ file: "README.md", line: 3, text: "metadata/x.png" }]);
  const env = envelope({ command: "preflight", version: "0.1.0", data: { published: false }, results });
  assert.deepEqual(Object.keys(env), ["command", "version", "fingerprint", "data", "results", "exit"]);
  assert.equal(env.fingerprint, null);
  assert.equal(env.exit, 1);
  assert.deepEqual(env.results[0], { id: "readme-assets", verdict: "FAIL", message: "missing", details: [{ text: "metadata/x.png", file: "README.md", line: 3 }] });
});

test("text form is VERDICT  id  message with details indented", () => {
  const text = renderText(new Results().na("png", "no published copy").fail("scan", "2 hits", [{ file: "CHANGELOG.md", line: 9, text: "example@x" }]));
  assert.match(text, /^N\/A {4}png {3}no published copy\n/);
  assert.match(text, /\nFAIL {3}scan {2}2 hits\n {7}CHANGELOG\.md:9 {2}example@x\n$/);
});

test("merge appends another command's results", () => {
  const a = new Results().pass("a", "ok");
  const b = new Results().fail("b", "bad");
  assert.equal(a.merge(b).exit, 1);
  assert.equal(a.items.length, 2);
});

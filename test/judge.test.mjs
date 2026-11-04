// `rx judge ask|eval` (docs/commands.md, plan Phase 7, D6). Nothing here reaches the network or
// reads a real key: every provider test installs a fake transport, and every run passes an
// explicit `env` (keys in it are fake strings), so process.env is never consulted or changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DECISION_SCHEMA, decisionIds, decisionProblems, loadDecision } from "../src/judge/decisions.mjs";
import { HAIKU_MODEL, HAIKU_TOOL, HAIKU_URL, JEV_URL, ANTHROPIC_VERSION, normalizeProbabilities, ProviderError } from "../src/judge/providers.mjs";
import { setTransport } from "../src/judge/transport.mjs";
import { REPO, rx, withTempDir } from "./helpers.mjs";

const FIX = join(REPO, "test", "fixtures", "judge");
const NO_KEYS = Object.freeze({ PATH: process.env.PATH ?? "" });
const HAIKU_ENV = { ...NO_KEYS, ANTHROPIC_API_KEY: "test-anthropic-key" };
const JEV_ENV = { ...NO_KEYS, TYPESAFE_API_KEY: "test-jev-key" };

/** A fake transport that fails the test when called. */
const noNetwork = {
  async postJson(/** @type {string} */ url) {
    throw new Error(`unexpected network call to ${url}`);
  },
};

/**
 * Install `t` for the duration of `fn`, restoring the previous transport in finally.
 * @template T @param {import("../src/judge/transport.mjs").Transport} t @param {() => Promise<T>} fn
 */
async function withTransport(t, fn) {
  const prev = setTransport(t);
  try {
    return await fn();
  } finally {
    setTransport(prev);
  }
}

/** @param {Record<string, unknown>} probabilities */
const haikuBody = (probabilities) => ({
  model: HAIKU_MODEL,
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_test", name: HAIKU_TOOL, input: { probabilities } }],
});

/** @param {Record<string, unknown>} probabilities */
const jevBody = (probabilities) => ({
  model: "jev-test",
  answers: { answer: { type: "choice", choice: Object.keys(probabilities)[0], confidence: 0.5, probabilities } },
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** A transport answering every call with one Haiku body; records the calls. @param {unknown} body @param {number} [status] */
function fixedHaiku(body, status = 200) {
  /** @type {Array<{ url: string, headers: Record<string, string>, payload: any }>} */
  const calls = [];
  return {
    calls,
    t: {
      async postJson(/** @type {string} */ url, /** @type {Record<string, string>} */ headers, /** @type {any} */ payload) {
        calls.push({ url, headers, payload });
        return { status, body, text: JSON.stringify(body) };
      },
    },
  };
}

const inputsFile = join(FIX, "changelog-user-visible.inputs.json");
const askArgs = (/** @type {string[]} */ extra = []) => ["judge", "ask", "changelog-user-visible", "--inputs", inputsFile, "--json", ...extra];
/** @param {any} json @param {string} id */
const verdictOf = (json, id) => json.results.filter((/** @type {any} */ r) => r.id === id).map((/** @type {any} */ r) => r.verdict);

// ---------------------------------------------------------------------------------------------
// Decisions: structure and receipts
// ---------------------------------------------------------------------------------------------

test("the four decisions load, each with ≥ 4 fixtures and every answer covered", () => {
  assert.deepEqual(decisionIds(), ["changelog-user-visible", "needs-code", "png-provenance", "review-finding-triage"]);
  const answers = {
    "changelog-user-visible": ["user-visible", "internal", "branch-only-bug"],
    "review-finding-triage": ["valid", "valid-wrong-remedy", "false-positive", "conflicts-with-chris"],
    "needs-code": ["code", "metadata-only"],
    "png-provenance": ["ours-newer", "contributor", "unclear"],
  };
  for (const [id, want] of Object.entries(answers)) {
    const d = loadDecision(id);
    assert.deepEqual(d.answers, want, id);
    assert.ok(d.fixtures.length >= 4, `${id} has ${d.fixtures.length} fixtures`);
    for (const a of want) assert.ok(d.fixtures.some((f) => f.expected === a), `${id}: no fixture expects ${a}`);
  }
});

test("every fixture source is a ~/ receipt with a line range inside its file, or marked synthetic", (t) => {
  for (const id of decisionIds()) {
    for (const [i, f] of loadDecision(id).fixtures.entries()) {
      assert.equal(f.source.includes(homedir()), false, `${id} fixture ${i + 1}: an absolute home-directory path; write ~/ instead`);
      if (f.source.startsWith("synthetic: ")) continue;
      const m = f.source.match(/^~\/(.+):(\d+)(?:-(\d+))?$/);
      assert.ok(m, `${id} fixture ${i + 1}: ${f.source}`);
      const path = join(homedir(), m[1]);
      // The receipts live in the sibling skills checkout; on a machine without it (CI) the range
      // cannot be checked, and the test says so instead of passing silently.
      if (!existsSync(path)) { t.diagnostic(`receipt not on this machine, range unchecked: ${f.source}`); continue; }
      const lines = readFileSync(path, "utf8").split("\n").length;
      const end = Number(m[3] ?? m[2]);
      assert.ok(Number(m[2]) >= 1 && Number(m[2]) <= end && end <= lines, `${id} fixture ${i + 1}: ${f.source} is outside 1..${lines}`);
    }
  }
});

test("decisionProblems rejects a fixture whose expected answer is not an answer, or whose inputs fail the schema", () => {
  const d = structuredClone(loadDecision("needs-code"));
  assert.deepEqual(decisionProblems(d, "needs-code"), []);
  d.fixtures[0].expected = "maybe";
  d.fixtures[1].inputs = { context: "no feedback field" };
  const p = decisionProblems(d, "needs-code");
  assert.ok(p.some((x) => x.includes("fixtures[0].expected")), p.join("\n"));
  assert.ok(p.some((x) => x.includes("fixtures[1].inputs") && x.includes("feedback")), p.join("\n"));
  assert.ok(decisionProblems({ ...d, extra: 1 }).some((x) => x.includes("unknown property")));
  assert.equal(DECISION_SCHEMA.properties.fixtures.items.required.includes("source"), true);
});

// ---------------------------------------------------------------------------------------------
// ask: inputs validation
// ---------------------------------------------------------------------------------------------

test("ask: inputs that fail the decision's schema are ERROR judge-inputs (exit 2) and no provider is called", async () => {
  await withTempDir(async (dir) => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ context: "missing change", extra: true }));
    const r = await withTransport(noNetwork, () => rx(["judge", "ask", "changelog-user-visible", "--inputs", bad, "--json"], { env: HAIKU_ENV }));
    assert.equal(r.code, 2);
    assert.deepEqual(verdictOf(r.json, "judge-inputs"), ["ERROR"]);
    const texts = r.json.results[0].details.map((/** @type {any} */ d) => d.text).join("\n");
    assert.match(texts, /missing required property "change"/);
    assert.match(texts, /\$\.extra: unknown property/);
    const notJson = join(dir, "x.json");
    writeFileSync(notJson, "{");
    const r2 = await rx(["judge", "ask", "needs-code", "--inputs", notJson, "--json"], { env: NO_KEYS });
    assert.equal(r2.code, 2);
    assert.deepEqual(verdictOf(r2.json, "judge-inputs"), ["ERROR"]);
  });
});

// ---------------------------------------------------------------------------------------------
// ask: agent mode with no keys
// ---------------------------------------------------------------------------------------------

test("ask with no keys set: agent mode, N/A, the structured prompt, no probabilities, no network", async () => {
  const r = await withTransport(noNetwork, () => rx(askArgs(), { env: NO_KEYS }));
  assert.equal(r.code, 0);
  assert.deepEqual(verdictOf(r.json, "judge-changelog-user-visible"), ["N/A"]);
  const res = r.json.results.find((/** @type {any} */ x) => x.id === "judge-changelog-user-visible");
  assert.equal(res.message, "agent mode: decide and record in the audit");
  const d = loadDecision("changelog-user-visible");
  assert.equal(r.json.data.mode, "agent");
  assert.equal(r.json.data.provider, "agent");
  assert.equal(r.json.data.probabilities, null);
  assert.equal(r.json.data.answer, null);
  assert.equal(r.json.data.fallback, null, "no keys is agent mode by choice, not a provider failure");
  assert.deepEqual(verdictOf(r.json, "judge-provider"), []);
  assert.deepEqual(r.json.data.prompt, { question: d.question, answers: d.answers, inputs: JSON.parse(readFileSync(inputsFile, "utf8")) });
});

// ---------------------------------------------------------------------------------------------
// ask: the 0.7 threshold
// ---------------------------------------------------------------------------------------------

test("ask: top probability 0.71 is PASS with data.answer; 0.69 is WARN defer-to-agent", async () => {
  const high = fixedHaiku(haikuBody({ "user-visible": 0.71, internal: 0.29, "branch-only-bug": 0 }));
  const r1 = await withTransport(high.t, () => rx(askArgs(), { env: HAIKU_ENV }));
  assert.equal(r1.code, 0);
  assert.deepEqual(verdictOf(r1.json, "judge-changelog-user-visible"), ["PASS"]);
  assert.equal(r1.json.data.answer, "user-visible");
  assert.equal(r1.json.data.provider, "haiku");
  assert.equal(r1.json.data.probabilitySource, "model-reported");
  assert.equal(typeof r1.json.data.latencyMs, "number");
  assert.ok(Math.abs(r1.json.data.probabilities["user-visible"] - 0.71) < 1e-9);

  const low = fixedHaiku(haikuBody({ "user-visible": 0.69, internal: 0.31, "branch-only-bug": 0 }));
  const r2 = await withTransport(low.t, () => rx(askArgs(), { env: HAIKU_ENV }));
  assert.equal(r2.code, 0, "a deferral is advisory and never exits non-zero");
  assert.deepEqual(verdictOf(r2.json, "judge-changelog-user-visible"), ["WARN"]);
  assert.match(r2.json.results.find((/** @type {any} */ x) => x.id === "judge-changelog-user-visible").message, /^defer-to-agent/);
  assert.equal(r2.json.data.answer, null);
  assert.equal(r2.json.data.top.answer, "user-visible");
  assert.ok(r2.json.data.prompt, "a deferral carries the structured question");
});

// ---------------------------------------------------------------------------------------------
// ask: provider errors fall back to agent mode in the same run
// ---------------------------------------------------------------------------------------------

test("ask: a provider error (HTTP, timeout, missing key) is WARN judge-provider, then agent mode, exit 0", async () => {
  const http = fixedHaiku({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529);
  const cases = [
    { name: "HTTP 529", t: http.t, env: HAIKU_ENV, args: [], want: /haiku: HTTP 529: Overloaded; falling back to agent mode/ },
    {
      name: "timeout",
      t: { async postJson() { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; } },
      env: HAIKU_ENV,
      args: [],
      want: /haiku: timed out after 30 s/,
    },
    { name: "missing key", t: noNetwork, env: NO_KEYS, args: ["--provider", "haiku"], want: /haiku: ANTHROPIC_API_KEY is not set/ },
    { name: "missing jev key", t: noNetwork, env: NO_KEYS, args: ["--provider", "jev"], want: /jev: TYPESAFE_API_KEY is not set/ },
  ];
  for (const c of cases) {
    const r = await withTransport(c.t, () => rx(askArgs(c.args), { env: c.env }));
    assert.equal(r.code, 0, c.name);
    assert.deepEqual(verdictOf(r.json, "judge-provider"), ["WARN"], c.name);
    assert.match(r.json.results.find((/** @type {any} */ x) => x.id === "judge-provider").message, c.want, c.name);
    assert.deepEqual(verdictOf(r.json, "judge-changelog-user-visible"), ["N/A"], c.name);
    assert.equal(r.json.data.mode, "agent", c.name);
    assert.equal(r.json.data.probabilities, null, c.name);
    assert.ok(r.json.data.fallback?.error, c.name);
    assert.ok(r.json.data.prompt, c.name);
  }
});

// ---------------------------------------------------------------------------------------------
// Haiku adapter: request shape and malformed-output rejection
// ---------------------------------------------------------------------------------------------

test("haiku: forced tool call against the Messages API, version 2026-10-21, no sampling parameters", async () => {
  const h = fixedHaiku(haikuBody({ "user-visible": 0.9, internal: 0.1, "branch-only-bug": 0 }));
  await withTransport(h.t, () => rx(askArgs(), { env: HAIKU_ENV }));
  assert.equal(h.calls.length, 1);
  const { url, headers, payload } = h.calls[0];
  assert.equal(url, HAIKU_URL);
  assert.equal(headers["x-api-key"], "test-anthropic-key");
  assert.equal(headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(payload.model, "claude-haiku-5-5");
  assert.deepEqual(payload.tool_choice, { type: "tool", name: HAIKU_TOOL });
  assert.deepEqual(payload.tools[0].input_schema.properties.probabilities.required, ["user-visible", "internal", "branch-only-bug"]);
  for (const k of ["temperature", "top_p", "top_k", "thinking"]) assert.equal(k in payload, false, k);
});

test("haiku: malformed output (missing answer, unknown key, non-number, sum 0, no tool call, refusal) is a provider error", async () => {
  const bodies = [
    { why: "missing answer", body: haikuBody({ "user-visible": 0.9, internal: 0.1 }), want: /missing answer branch-only-bug/ },
    { why: "unknown key", body: haikuBody({ "user-visible": 0.8, internal: 0.1, "branch-only-bug": 0.1, maybe: 0 }), want: /unknown answer "maybe"/ },
    { why: "non-number", body: haikuBody({ "user-visible": "high", internal: 0.1, "branch-only-bug": 0 }), want: /not a number/ },
    { why: "sum 0", body: haikuBody({ "user-visible": 0, internal: 0, "branch-only-bug": 0 }), want: /sum to 0/ },
    { why: "no tool call", body: { model: HAIKU_MODEL, stop_reason: "end_turn", content: [{ type: "text", text: "user-visible" }] }, want: /no record_probabilities tool call/ },
    { why: "refusal", body: { model: HAIKU_MODEL, stop_reason: "refusal", stop_details: { category: null }, content: [] }, want: /declined/ },
  ];
  for (const b of bodies) {
    const h = fixedHaiku(b.body);
    const r = await withTransport(h.t, () => rx(askArgs(), { env: HAIKU_ENV }));
    assert.equal(r.code, 0, b.why);
    const msg = r.json.results.find((/** @type {any} */ x) => x.id === "judge-provider")?.message ?? "(no judge-provider result)";
    assert.match(msg, b.want, b.why);
    assert.deepEqual(verdictOf(r.json, "judge-changelog-user-visible"), ["N/A"], b.why);
  }
  assert.throws(() => normalizeProbabilities("haiku", { a: 1.5, b: 0 }, ["a", "b"]), ProviderError);
});

// ---------------------------------------------------------------------------------------------
// Jev adapter and the D6 default order
// ---------------------------------------------------------------------------------------------

test("jev: request per the documented API, choice probabilities parsed and normalized", async () => {
  /** @type {Array<{ url: string, headers: Record<string, string>, payload: any }>} */
  const calls = [];
  const t = {
    async postJson(/** @type {string} */ url, /** @type {Record<string, string>} */ headers, /** @type {any} */ payload) {
      calls.push({ url, headers, payload });
      const body = jevBody({ "user-visible": 0.8, internal: 0.15, "branch-only-bug": 0.05 });
      return { status: 200, body, text: JSON.stringify(body) };
    },
  };
  const r = await withTransport(t, () => rx(askArgs(), { env: JEV_ENV }));
  assert.equal(r.code, 0);
  assert.equal(r.json.data.provider, "jev");
  assert.equal(r.json.data.answer, "user-visible");
  assert.equal(r.json.data.probabilitySource, "provider-reported");
  assert.equal(calls[0].url, JEV_URL);
  assert.equal(calls[0].headers.authorization, "Bearer test-jev-key");
  assert.equal(calls[0].payload.model, "jev-latest");
  assert.deepEqual(calls[0].payload.state, JSON.parse(readFileSync(inputsFile, "utf8")));
  assert.equal(calls[0].payload.questions.answer.type, "choice");
  assert.deepEqual(Object.keys(calls[0].payload.questions.answer.criteria), ["user-visible", "internal", "branch-only-bug"]);
  const bad = { async postJson() { return { status: 200, body: { model: "jev", answers: { answer: { type: "score", score: 1 } } }, text: "" }; } };
  const r2 = await withTransport(bad, () => rx(askArgs(), { env: JEV_ENV }));
  assert.match(r2.json.results.find((/** @type {any} */ x) => x.id === "judge-provider").message, /jev: malformed output: no choice answer/);
});

test("D6 order with no --provider: jev when TYPESAFE_API_KEY is set, else haiku when ANTHROPIC_API_KEY is set, else agent", async () => {
  /** @type {string[]} */
  const urls = [];
  const t = {
    async postJson(/** @type {string} */ url) {
      urls.push(url);
      const body = url === JEV_URL ? jevBody({ "user-visible": 0.9, internal: 0.1, "branch-only-bug": 0 }) : haikuBody({ "user-visible": 0.9, internal: 0.1, "branch-only-bug": 0 });
      return { status: 200, body, text: "" };
    },
  };
  const both = await withTransport(t, () => rx(askArgs(), { env: { ...JEV_ENV, ANTHROPIC_API_KEY: "test-anthropic-key" } }));
  assert.equal(both.json.data.provider, "jev");
  const haiku = await withTransport(t, () => rx(askArgs(), { env: HAIKU_ENV }));
  assert.equal(haiku.json.data.provider, "haiku");
  assert.deepEqual(urls, [JEV_URL, HAIKU_URL]);
  const none = await withTransport(noNetwork, () => rx(askArgs(), { env: NO_KEYS }));
  assert.equal(none.json.data.provider, "agent");
  const forced = await withTransport(noNetwork, () => rx(askArgs(["--provider", "agent"]), { env: HAIKU_ENV }));
  assert.equal(forced.json.data.provider, "agent", "--provider agent wins over a set key");
  const bad = await rx(askArgs(["--provider", "gpt"]), { env: NO_KEYS });
  assert.equal(bad.code, 2);
  assert.deepEqual(verdictOf(bad.json, "args"), ["ERROR"]);
});

// ---------------------------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------------------------

/**
 * An oracle transport for one decision: answers each fixture with `p` on the answer `pick` returns.
 * @param {string} id @param {(expected: string, index: number, answers: string[]) => string} pick @param {number} [p]
 */
function oracle(id, pick, p = 0.9) {
  const d = loadDecision(id);
  const byInputs = new Map(d.fixtures.map((f, i) => [JSON.stringify(f.inputs), { f, i }]));
  return {
    async postJson(/** @type {string} */ url, /** @type {unknown} */ _h, /** @type {any} */ payload) {
      const key = url === JEV_URL ? JSON.stringify(payload.state) : JSON.stringify(JSON.parse(/** @type {any} */ (payload).messages[0].content.split("Inputs (JSON):\n")[1]));
      const hit = byInputs.get(key);
      if (!hit) throw new Error("oracle: unknown inputs");
      const chosen = pick(hit.f.expected, hit.i, d.answers);
      const rest = (1 - p) / (d.answers.length - 1);
      const probs = Object.fromEntries(d.answers.map((a) => [a, a === chosen ? p : rest]));
      const body = url === JEV_URL ? jevBody(probs) : haikuBody(probs);
      return { status: 200, body, text: "" };
    },
  };
}

test("eval: one judge-eval per fixture and data.accuracy = correct / total", async () => {
  const d = loadDecision("png-provenance");
  const n = d.fixtures.length;
  // Every fixture right.
  const all = await withTransport(oracle("png-provenance", (e) => e), () => rx(["judge", "eval", "png-provenance", "--json"], { env: HAIKU_ENV }));
  assert.equal(all.code, 0);
  assert.deepEqual(verdictOf(all.json, "judge-eval"), Array(n).fill("PASS"));
  assert.equal(all.json.data.accuracy, 1);
  assert.deepEqual(verdictOf(all.json, "judge-accuracy"), ["PASS"]);
  // The first fixture wrong, the second deferred (right answer below 0.7): two FAILs.
  const wrongFirst = (/** @type {string} */ e, /** @type {number} */ i, /** @type {string[]} */ answers) => (i === 0 ? answers.find((a) => a !== e) ?? e : e);
  const mixed = await withTransport(
    {
      async postJson(url, h, payload) {
        const r = await oracle("png-provenance", wrongFirst).postJson(url, h, payload);
        const probs = /** @type {any} */ (r.body).content[0].input.probabilities;
        const second = JSON.stringify(JSON.parse(/** @type {any} */ (payload).messages[0].content.split("Inputs (JSON):\n")[1])) === JSON.stringify(d.fixtures[1].inputs);
        if (second) for (const k of Object.keys(probs)) probs[k] = k === d.fixtures[1].expected ? 0.6 : 0.4 / (d.answers.length - 1);
        return r;
      },
    },
    () => rx(["judge", "eval", "png-provenance", "--json"], { env: HAIKU_ENV }),
  );
  assert.equal(mixed.code, 1, "eval FAILs a wrong fixture (a provider measurement, not a gate)");
  assert.deepEqual(verdictOf(mixed.json, "judge-eval"), ["FAIL", "FAIL", ...Array(n - 2).fill("PASS")]);
  assert.equal(mixed.json.data.correct, n - 2);
  assert.equal(mixed.json.data.accuracy, (n - 2) / n);
  assert.deepEqual(verdictOf(mixed.json, "judge-accuracy"), ["WARN"]);
  assert.match(mixed.json.results[1].message, /deferred/);
});

test("eval in agent mode: every fixture N/A 'agent mode makes no prediction', accuracy null; a provider error falls back", async () => {
  const r = await withTransport(noNetwork, () => rx(["judge", "eval", "needs-code", "--json"], { env: NO_KEYS }));
  assert.equal(r.code, 0);
  const n = loadDecision("needs-code").fixtures.length;
  assert.deepEqual(verdictOf(r.json, "judge-eval"), Array(n).fill("N/A"));
  assert.ok(r.json.results.filter((/** @type {any} */ x) => x.id === "judge-eval").every((/** @type {any} */ x) => x.message.includes("agent mode makes no prediction")));
  assert.equal(r.json.data.accuracy, null);
  assert.deepEqual(verdictOf(r.json, "judge-accuracy"), ["N/A"]);
  const err = fixedHaiku({ error: { message: "bad key" } }, 401);
  const r2 = await withTransport(err.t, () => rx(["judge", "eval", "needs-code", "--json"], { env: HAIKU_ENV }));
  assert.equal(r2.code, 0);
  assert.deepEqual(verdictOf(r2.json, "judge-provider"), ["WARN"]);
  assert.deepEqual(verdictOf(r2.json, "judge-eval"), Array(n).fill("N/A"));
  assert.equal(r2.json.data.accuracy, null);
});

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

test("rx commands --json lists judge with ask/eval and their flags", async () => {
  const r = await rx(["commands", "--json"], { env: NO_KEYS });
  const judge = r.json.data.commands.find((/** @type {any} */ c) => c.name === "judge");
  assert.ok(judge);
  assert.deepEqual(Object.keys(judge.subcommands), ["ask", "eval"]);
  assert.ok("--inputs" in judge.subcommands.ask.flags && "--provider" in judge.subcommands.ask.flags);
  assert.ok("--provider" in judge.subcommands.eval.flags);
  assert.equal(judge.subcommands.ask.checks["judge-*"].levels.includes("FAIL"), false, "ask can never FAIL");
});

// ---------------------------------------------------------------------------------------------
// Codex round 1 (2026-11-04): five P2s, one test each
// ---------------------------------------------------------------------------------------------

test("a provider error whose text has newlines still falls back to agent mode (ask and eval), first line in the message, rest in details", async () => {
  const httpBody = { error: { message: "upstream failed\nline two\r\nline three" } };
  const http = fixedHaiku(httpBody, 500);
  const thrown = { async postJson() { throw new Error("socket hang up\nat connect (net.js:1)\nat retry"); } };
  for (const [name, t] of /** @type {const} */ ([["http", http.t], ["thrown", thrown]])) {
    const r = await withTransport(t, () => rx(askArgs(), { env: HAIKU_ENV }));
    assert.equal(r.code, 0, `ask ${name}: ${r.stdout}`);
    const w = r.json.results.find((/** @type {any} */ x) => x.id === "judge-provider");
    assert.ok(w, `ask ${name}: a judge-provider WARN`);
    assert.doesNotMatch(w.message, /[\r\n]/);
    assert.ok(w.details.length >= 2, `ask ${name}: the remaining lines are kept in details`);
    assert.equal(r.json.data.mode, "agent", `ask ${name}`);
    assert.ok(r.json.data.prompt, `ask ${name}`);
    const e = await withTransport(t, () => rx(["judge", "eval", "needs-code", "--json"], { env: HAIKU_ENV }));
    assert.equal(e.code, 0, `eval ${name}: ${e.stdout}`);
    assert.deepEqual(verdictOf(e.json, "judge-provider"), ["WARN"], `eval ${name}`);
    assert.equal(e.json.data.mode, "agent", `eval ${name}`);
    assert.equal(e.json.data.accuracy, null, `eval ${name}`);
  }
});

test("text output shows the question, the answers and the inputs in agent mode, after a fallback, and on a deferral", async () => {
  const d = loadDecision("changelog-user-visible");
  const inputs = JSON.parse(readFileSync(inputsFile, "utf8"));
  const textArgs = askArgs().filter((a) => a !== "--json");
  const runs = [
    { name: "agent", t: noNetwork, env: NO_KEYS },
    { name: "fallback", t: fixedHaiku({ error: { message: "Overloaded" } }, 529).t, env: HAIKU_ENV },
    { name: "deferral", t: fixedHaiku(haikuBody({ "user-visible": 0.5, internal: 0.3, "branch-only-bug": 0.2 })).t, env: HAIKU_ENV },
  ];
  for (const run of runs) {
    const r = await withTransport(run.t, () => rx(textArgs, { env: run.env }));
    assert.equal(r.code, 0, run.name);
    assert.ok(r.stdout.includes(d.question), `${run.name}: the question is printed`);
    assert.ok(r.stdout.includes(d.answers.join(", ")), `${run.name}: the answers are printed`);
    assert.ok(r.stdout.includes(JSON.stringify(inputs)), `${run.name}: the inputs are printed`);
  }
  // The JSON envelope keeps the prompt in data.
  const j = await withTransport(noNetwork, () => rx(askArgs(), { env: NO_KEYS }));
  assert.deepEqual(j.json.data.prompt, { question: d.question, answers: d.answers, inputs });
});

test("haiku: stop_reason max_tokens is a provider error even with a parseable tool block", async () => {
  const body = { ...haikuBody({ "user-visible": 0.9, internal: 0.1, "branch-only-bug": 0 }), stop_reason: "max_tokens" };
  const r = await withTransport(fixedHaiku(body).t, () => rx(askArgs(), { env: HAIKU_ENV }));
  assert.equal(r.code, 0);
  assert.match(r.json.results.find((/** @type {any} */ x) => x.id === "judge-provider")?.message ?? "(none)", /max_tokens/);
  assert.equal(r.json.data.mode, "agent");
  const e = await withTransport(fixedHaiku(body).t, () => rx(["judge", "eval", "needs-code", "--json"], { env: HAIKU_ENV }));
  assert.equal(e.json.data.mode, "agent", "eval falls back for the whole run");
  assert.equal(e.json.data.accuracy, null);
  // Another stop_reason with no valid tool block names the stop_reason.
  const odd = { ...haikuBody({ "user-visible": 0.9 }), stop_reason: "pause_turn" };
  const r2 = await withTransport(fixedHaiku(odd).t, () => rx(askArgs(), { env: HAIKU_ENV }));
  assert.match(r2.json.results.find((/** @type {any} */ x) => x.id === "judge-provider")?.message ?? "(none)", /pause_turn/);
});

test("fixture semantics: the shipped shortcut revert is user-visible; an unattributed published PNG is unclear", () => {
  const cl = loadDecision("changelog-user-visible").fixtures.find((f) => String(f.inputs.change).includes("Shift-Command-P"));
  assert.equal(cl?.expected, "user-visible");
  const png = loadDecision("png-provenance").fixtures.find((f) => f.inputs.file === "metadata/example-1.png");
  assert.equal(png?.inputs.history, "matches-no-commit");
  assert.equal(png?.expected, "unclear", "no history match and no other ownership evidence is unclear, not contributor");
  const contributor = loadDecision("png-provenance").fixtures.filter((f) => f.expected === "contributor");
  assert.ok(contributor.length >= 1 && contributor.every((f) => /contributor/i.test(String(f.inputs.context))), "every contributor fixture states contributor evidence");
});

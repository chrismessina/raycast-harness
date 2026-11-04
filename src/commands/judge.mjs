// `rx judge ask <decision-id> --inputs <file> [--provider jev|haiku|agent]` and
// `rx judge eval <decision-id> [--provider …]` (plan Phase 7, decision D6, docs/commands.md).
//
// Advisory only: never blocks, never acts. `ask` emits only PASS, WARN and N/A for the judgment
// itself, so its exit code is 0 whatever the provider says or does; an ERROR (exit 2) means the
// call was malformed (unknown decision, unreadable inputs, inputs that fail the decision's schema),
// which the caller must fix, and is never a judgment. `eval` FAILs a fixture the provider got
// wrong: that is a measurement of the provider for the adoption rule, not a publish gate. No judge
// result is part of `rx gates`' receipt or `rx audit`'s evidence, and `rx guard` reads neither.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ArgError, RxError } from "../errors.mjs";
import { decisionIds, loadDecision } from "../judge/decisions.mjs";
import { PROVIDERS, ProviderError, askProvider, defaultProvider } from "../judge/providers.mjs";
import { validate } from "../preset/schema.mjs";

export const THRESHOLD = 0.7;

const providerFlag = { type: /** @type {const} */ ("string"), value: "<jev|haiku|agent>", help: "provider; default per D6: jev if TYPESAFE_API_KEY is set, else haiku if ANTHROPIC_API_KEY is set, else agent" };

const JUDGE_LEVELS = /** @type {Array<"PASS" | "WARN" | "N/A">} */ (["PASS", "WARN", "N/A"]);

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "judge",
  summary: "advisory answers to named judgment calls (never blocks, never acts)",
  root: "none",
  network: "the chosen provider's API only (Jev: api.typesafe.ai with TYPESAFE_API_KEY; Haiku: api.anthropic.com with ANTHROPIC_API_KEY); agent mode: none",
  state: "none",
  subcommands: {
    ask: {
      name: "ask",
      summary: "one decision for one set of inputs: a provider's answer probabilities, or the structured question in agent mode",
      positionals: [{ name: "decision-id", required: true, help: `one of src/judge/decisions/: ${decisionIds().join(", ")}` }],
      flags: {
        "--inputs": { type: "string", value: "<file>", required: true, help: "JSON file validated against the decision's inputs schema" },
        "--provider": providerFlag,
      },
      checks: {
        "judge-inputs": { description: "the inputs file is valid against the decision's inputs schema (ERROR otherwise)", levels: ["PASS", "ERROR"] },
        "judge-provider": { description: "a provider error (missing key, HTTP error, timeout, malformed output); WARN, then agent mode in the same run", levels: ["WARN"] },
        "judge-*": { description: "judge-<decision-id>: PASS with data.answer when the top probability is at least 0.7, WARN defer-to-agent below, N/A in agent mode", levels: JUDGE_LEVELS },
      },
      data: {
        decision: "string",
        mode: "\"provider\" | \"agent\"",
        provider: "\"jev\" | \"haiku\" | \"agent\"",
        answer: "string | null — set only on PASS",
        top: "{ answer, probability } | null",
        probabilities: "Record<answer, number> | null — normalized to sum to 1; null in agent mode",
        probabilitySource: "\"provider-reported\" (jev) | \"model-reported\" (haiku) | null — never calibrated",
        latencyMs: "number | null",
        threshold: "0.7",
        fallback: "{ provider, error } | null — the provider error that sent this run to agent mode",
        prompt: "{ question, answers, inputs } — agent mode and defer-to-agent only",
      },
    },
    eval: {
      name: "eval",
      summary: "run every fixture of a decision and report per-case output and accuracy",
      positionals: [{ name: "decision-id", required: true, help: `one of src/judge/decisions/: ${decisionIds().join(", ")}` }],
      flags: { "--provider": providerFlag },
      checks: {
        "judge-provider": { description: "a provider error; WARN, then every fixture in agent mode", levels: ["WARN"] },
        "judge-eval": { description: "one per fixture: PASS when the provider's answer clears 0.7 and equals the expected answer, FAIL otherwise, N/A in agent mode", levels: ["PASS", "FAIL", "N/A"] },
        "judge-accuracy": { description: "the share of fixtures answered correctly; PASS when every fixture is (the adoption rule), WARN otherwise, N/A in agent mode", levels: JUDGE_LEVELS },
      },
      data: {
        decision: "string",
        mode: "\"provider\" | \"agent\"",
        provider: "\"jev\" | \"haiku\" | \"agent\"",
        probabilitySource: "\"provider-reported\" | \"model-reported\" | null",
        accuracy: "number | null — correct / total; null in agent mode",
        correct: "number | null",
        total: "number",
        fallback: "{ provider, error } | null",
        cases: "[{ index, source, expected, answer, top, probabilities, latencyMs, verdict }]",
      },
    },
  },
};

/** @param {import("../args.mjs").ParsedArgs} args @param {NodeJS.ProcessEnv} env */
function pickProvider(args, env) {
  const flag = args.flags["--provider"];
  if (flag === undefined) return defaultProvider(env);
  if (typeof flag !== "string" || !(/** @type {readonly string[]} */ (PROVIDERS)).includes(flag)) throw new ArgError(`--provider must be one of ${PROVIDERS.join(", ")}, got ${JSON.stringify(flag)}`);
  return /** @type {"jev" | "haiku" | "agent"} */ (flag);
}

/** @param {Record<string, number>} p @param {string[]} answers */
function topOf(p, answers) {
  let best = answers[0];
  for (const a of answers) if (p[a] > p[best]) best = a;
  return { answer: best, probability: p[best] };
}

/** @param {number} n */
const fmt = (n) => n.toFixed(2);

/**
 * A provider error as one verdict line plus details. Provider text (an HTTP error body, a thrown
 * transport error) can hold newlines, and a result message must be one line; the first non-empty
 * line goes in the message and every further line becomes a detail.
 * @param {string} error
 * @returns {{ first: string, rest: import("../verdict.mjs").Detail[] }}
 */
export function splitError(error) {
  const lines = String(error).split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  return { first: lines[0] ?? "(no message)", rest: lines.slice(1).map((text) => ({ text })) };
}

/**
 * The structured question as details, so text output shows what agent mode, a fallback and a
 * deferral hand to the agent (the JSON envelope carries the same thing in data.prompt). Each
 * value is one line: the question is a single sentence block and the inputs are compact JSON.
 * @param {{ question: string, answers: string[], inputs: Record<string, unknown> }} prompt
 * @returns {import("../verdict.mjs").Detail[]}
 */
export function promptDetails(prompt) {
  return [
    { text: `question: ${prompt.question.replace(/\s*[\r\n]+\s*/g, " ")}` },
    { text: `answers: ${prompt.answers.join(", ")}` },
    { text: `inputs: ${JSON.stringify(prompt.inputs)}` },
  ];
}

/**
 * One provider call, timed. Returns the answer or the provider error (never throws a ProviderError).
 * @param {"jev" | "haiku"} provider @param {import("../judge/decisions.mjs").Decision} decision @param {Record<string, unknown>} inputs @param {NodeJS.ProcessEnv} env
 */
async function call(provider, decision, inputs, env) {
  const t0 = performance.now();
  try {
    const out = await askProvider(provider, decision, inputs, env);
    return { ok: /** @type {const} */ (true), ...out, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) {
    if (e instanceof ProviderError) return { ok: /** @type {const} */ (false), error: e.message };
    throw e;
  }
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  return ctx.args.subcommand === "ask" ? ask(ctx) : evaluate(ctx);
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function ask({ args, cwd, env, results }) {
  const provider = pickProvider(args, env);
  const id = args.positionals["decision-id"];
  const decision = loadDecision(id);
  const file = resolve(cwd, String(args.flags["--inputs"]));
  /** @type {unknown} */
  let inputs;
  try {
    inputs = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new RxError(`--inputs ${file} is not a readable JSON file: ${/** @type {Error} */ (e).message}`, { id: "judge-inputs" });
  }
  const errors = validate(inputs, decision.inputs);
  if (errors.length) {
    results.error("judge-inputs", `${errors.length} input error${errors.length === 1 ? "" : "s"} against ${id}'s inputs schema`, errors.map((e) => ({ file, text: `${e.path}: ${e.message}` })));
    return { data: { decision: id, mode: null, provider } };
  }
  results.pass("judge-inputs", `inputs valid against ${id}'s inputs schema`);
  const valid = /** @type {Record<string, unknown>} */ (inputs);
  const prompt = { question: decision.question, answers: decision.answers, inputs: valid };
  const check = `judge-${id}`;

  /** @type {{ provider: string, error: string } | null} */
  let fallback = null;
  if (provider !== "agent") {
    const r = await call(provider, decision, valid, env);
    if (r.ok) {
      const top = topOf(r.probabilities, decision.answers);
      const base = { decision: id, mode: "provider", provider, top, probabilities: r.probabilities, probabilitySource: r.probabilitySource, latencyMs: r.latencyMs, threshold: THRESHOLD, fallback: null };
      if (top.probability >= THRESHOLD) {
        results.pass(check, `${top.answer} (${fmt(top.probability)}, ${provider}, ${r.probabilitySource}); advisory: decide and record in the audit`);
        return { data: { ...base, answer: top.answer } };
      }
      results.warn(check, `defer-to-agent: top answer ${top.answer} at ${fmt(top.probability)} is below ${THRESHOLD}; decide and record in the audit`, promptDetails(prompt));
      return { data: { ...base, answer: null, prompt } };
    }
    fallback = { provider, error: r.error };
    const { first, rest } = splitError(r.error);
    results.warn("judge-provider", `${provider}: ${first}; falling back to agent mode`, rest);
  }
  results.na(check, "agent mode: decide and record in the audit", promptDetails(prompt));
  return { data: { decision: id, mode: "agent", provider: "agent", answer: null, top: null, probabilities: null, probabilitySource: null, latencyMs: null, threshold: THRESHOLD, fallback, prompt } };
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function evaluate({ args, env, results }) {
  const provider = pickProvider(args, env);
  const id = args.positionals["decision-id"];
  const decision = loadDecision(id);
  const total = decision.fixtures.length;
  /** @type {{ provider: string, error: string } | null} */
  let fallback = null;
  /** @type {Array<Record<string, unknown>>} */
  const cases = [];
  /** @type {string | null} */
  let probabilitySource = null;

  if (provider !== "agent") {
    /** @type {Array<{ text: string, verdict: "PASS" | "FAIL", c: Record<string, unknown> }>} */
    const pending = [];
    for (const [i, f] of decision.fixtures.entries()) {
      const r = await call(provider, decision, f.inputs, env);
      if (!r.ok) {
        fallback = { provider, error: `fixture ${i + 1}: ${r.error}` };
        break;
      }
      probabilitySource = r.probabilitySource;
      const top = topOf(r.probabilities, decision.answers);
      const answer = top.probability >= THRESHOLD ? top.answer : null;
      const verdict = answer === f.expected ? "PASS" : "FAIL";
      const got = answer === null ? `deferred (top ${top.answer} at ${fmt(top.probability)})` : `${answer} (${fmt(top.probability)})`;
      pending.push({ verdict, text: `fixture ${i + 1}: expected ${f.expected}, got ${got}`, c: { index: i + 1, source: f.source, expected: f.expected, answer, top, probabilities: r.probabilities, latencyMs: r.latencyMs, verdict } });
    }
    if (!fallback) {
      for (const p of pending) {
        results.add(p.verdict, "judge-eval", p.text, [{ text: `source: ${p.c.source}` }]);
        cases.push(p.c);
      }
      const correct = pending.filter((p) => p.verdict === "PASS").length;
      const accuracy = total === 0 ? 0 : correct / total;
      if (correct === total) results.pass("judge-accuracy", `${correct}/${total} (${fmt(accuracy)}) with ${provider}; every fixture's expected answer, so the adoption rule allows a provider suggestion (not a calibration claim)`);
      else results.warn("judge-accuracy", `${correct}/${total} (${fmt(accuracy)}) with ${provider}; not every fixture is right, so the adoption rule allows no provider suggestion for ${id}`);
      return { data: { decision: id, mode: "provider", provider, probabilitySource, accuracy, correct, total, fallback: null, cases } };
    }
    const { first, rest } = splitError(fallback.error);
    results.warn("judge-provider", `${provider}: ${first}; falling back to agent mode for every fixture`, rest);
  }

  for (const [i, f] of decision.fixtures.entries()) {
    results.na("judge-eval", `fixture ${i + 1}: agent mode makes no prediction (expected ${f.expected})`, [{ text: `source: ${f.source}` }]);
    cases.push({ index: i + 1, source: f.source, expected: f.expected, answer: null, top: null, probabilities: null, latencyMs: null, verdict: "N/A" });
  }
  results.na("judge-accuracy", "agent mode makes no prediction; accuracy is null");
  return { data: { decision: id, mode: "agent", provider: "agent", probabilitySource: null, accuracy: null, correct: null, total, fallback, cases } };
}

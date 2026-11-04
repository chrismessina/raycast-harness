// `rx judge` providers (decision D6). Each returns a probability for every answer of a decision,
// normalized to sum to 1, or throws ProviderError (missing key, HTTP error, timeout, malformed
// output); the caller then falls back to agent mode. No probability here is calibrated, and none
// is presented as such: Jev's are what its API returns, Haiku's are what the model writes into a
// forced tool call ("model-reported").

import { transport } from "./transport.mjs";

/** @typedef {import("./decisions.mjs").Decision} Decision */
/** @typedef {"jev" | "haiku"} ProviderName */
/** @typedef {{ probabilities: Record<string, number>, probabilitySource: "provider-reported" | "model-reported", model: string | null }} ProviderAnswer */

export const PROVIDERS = /** @type {const} */ (["jev", "haiku", "agent"]);
export const TIMEOUT_MS = 30_000;

export class ProviderError extends Error {
  /** @param {string} provider @param {string} message */
  constructor(provider, message) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

/**
 * Check a provider's raw probability map against the decision's answers and normalize it.
 * Malformed (a missing answer, an unknown key, a non-number or out-of-range value, a sum of 0)
 * → ProviderError.
 * @param {string} provider @param {unknown} raw @param {string[]} answers
 * @returns {Record<string, number>}
 */
export function normalizeProbabilities(provider, raw, answers) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProviderError(provider, "malformed output: probabilities is not an object");
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const unknown = Object.keys(obj).filter((k) => !answers.includes(k));
  if (unknown.length) throw new ProviderError(provider, `malformed output: unknown answer${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => JSON.stringify(k)).join(", ")}`);
  const missing = answers.filter((a) => !(a in obj));
  if (missing.length) throw new ProviderError(provider, `malformed output: missing answer${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`);
  for (const a of answers) {
    const v = obj[a];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ProviderError(provider, `malformed output: probability for ${a} is not a number (${JSON.stringify(v)})`);
    if (v < 0 || v > 1) throw new ProviderError(provider, `malformed output: probability for ${a} is outside 0..1 (${v})`);
  }
  const sum = answers.reduce((s, a) => s + /** @type {number} */ (obj[a]), 0);
  if (sum <= 0) throw new ProviderError(provider, "malformed output: probabilities sum to 0");
  return Object.fromEntries(answers.map((a) => [a, /** @type {number} */ (obj[a]) / sum]));
}

/** @param {string} provider @param {import("./transport.mjs").HttpResponse} r */
function httpError(provider, r) {
  const b = /** @type {any} */ (r.body);
  const detail = b?.error?.message ?? b?.message ?? r.text.trim().split("\n")[0] ?? "";
  return new ProviderError(provider, `HTTP ${r.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`);
}

/** @param {string} provider @param {string} url @param {Record<string, string>} headers @param {unknown} payload */
async function post(provider, url, headers, payload) {
  try {
    return await transport().postJson(url, headers, payload, TIMEOUT_MS);
  } catch (e) {
    const err = /** @type {Error} */ (e);
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new ProviderError(provider, timedOut ? `timed out after ${TIMEOUT_MS / 1000} s` : `request failed: ${err?.message ?? String(e)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Jev (TypeSafe). Implemented against the public API reference at https://docs.typesafe.ai/api
// (OpenAPI version 0.2.0), fetched 2026-11-04: `POST https://api.typesafe.ai/v1/systemone`,
// `Authorization: Bearer <key>`, body `{ model, state, questions: { <name>: { type: "choice",
// instructions, criteria: { <choice>: <description | null> } } } }`; a choice answer is
// `{ type: "choice", choice, confidence, probabilities: { <choice>: 0..1 } }` under
// `answers.<name>`, with probabilities that "sum to approximately 1".
// ---------------------------------------------------------------------------------------------

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/**
 * @param {Decision} decision @param {Record<string, unknown>} inputs @param {string} key
 * @returns {Promise<ProviderAnswer>}
 */
export async function askJev(decision, inputs, key) {
  const payload = {
    model: JEV_MODEL,
    state: inputs,
    questions: {
      answer: {
        type: "choice",
        instructions: decision.question,
        // The question defines each answer; a criterion with a null description is read by its name.
        criteria: Object.fromEntries(decision.answers.map((a) => [a, null])),
      },
    },
  };
  const r = await post("jev", JEV_URL, { authorization: `Bearer ${key}` }, payload);
  if (r.status < 200 || r.status > 299) throw httpError("jev", r);
  const body = /** @type {any} */ (r.body);
  if (!body || typeof body !== "object") throw new ProviderError("jev", "malformed output: response is not JSON");
  const ans = body.answers?.answer;
  if (!ans || ans.type !== "choice") throw new ProviderError("jev", "malformed output: no choice answer under answers.answer");
  return {
    probabilities: normalizeProbabilities("jev", ans.probabilities, decision.answers),
    probabilitySource: "provider-reported",
    model: typeof body.model === "string" ? body.model : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Claude Haiku (`claude-haiku-5-5`) over the Messages API with plain fetch (no SDK: the one runtime
// dependency stays pngjs). The Messages API returns no token probabilities, so the request forces
// one call of a tool whose input is a probability per answer (`tool_choice` naming the tool, which
// Claude Haiku 5.5 accepts); the values are what the model wrote, normalized, and labeled
// "model-reported". API version `2026-10-21`: no temperature/top_p/top_k may be sent.
// ---------------------------------------------------------------------------------------------

export const HAIKU_URL = "https://api.anthropic.com/v1/messages";
export const HAIKU_MODEL = "claude-haiku-5-5";
export const ANTHROPIC_VERSION = "2026-10-21";
export const HAIKU_TOOL = "record_probabilities";

/** The Messages API request for one question. Exported so tests can assert its shape. @param {Decision} decision @param {Record<string, unknown>} inputs */
export function haikuRequest(decision, inputs) {
  return {
    model: HAIKU_MODEL,
    // A forced tool call starts with the call and skips thinking; this leaves room for the input.
    max_tokens: 1024,
    system:
      "You classify one decision for a developer tool. Read the question and the inputs, then call the tool once with a probability between 0 and 1 for every answer, summing to 1. Base the probabilities only on the inputs.",
    tools: [
      {
        name: HAIKU_TOOL,
        description: "Record how likely each predefined answer is to be correct for the question.",
        input_schema: {
          type: "object",
          required: ["probabilities"],
          additionalProperties: false,
          properties: {
            probabilities: {
              type: "object",
              required: decision.answers,
              additionalProperties: false,
              properties: Object.fromEntries(decision.answers.map((a) => [a, { type: "number", minimum: 0, maximum: 1 }])),
            },
          },
        },
      },
    ],
    tool_choice: { type: "tool", name: HAIKU_TOOL },
    messages: [
      {
        role: "user",
        content: `Question: ${decision.question}\n\nAnswers: ${decision.answers.join(", ")}\n\nInputs (JSON):\n${JSON.stringify(inputs, null, 2)}`,
      },
    ],
  };
}

/**
 * @param {Decision} decision @param {Record<string, unknown>} inputs @param {string} key
 * @returns {Promise<ProviderAnswer>}
 */
export async function askHaiku(decision, inputs, key) {
  const r = await post("haiku", HAIKU_URL, { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }, haikuRequest(decision, inputs));
  if (r.status < 200 || r.status > 299) throw httpError("haiku", r);
  const body = /** @type {any} */ (r.body);
  if (!body || typeof body !== "object") throw new ProviderError("haiku", "malformed output: response is not JSON");
  if (body.stop_reason === "refusal") throw new ProviderError("haiku", `the model declined the request${body.stop_details?.category ? ` (${body.stop_details.category})` : ""}`);
  // A response cut off at max_tokens can still carry a parseable tool block; its values are
  // unfinished output, so it is a provider error before the tool input is read.
  if (body.stop_reason === "max_tokens") throw new ProviderError("haiku", "incomplete output: the response stopped at max_tokens");
  const stop = JSON.stringify(body.stop_reason ?? null);
  const call = Array.isArray(body.content) ? body.content.find((/** @type {any} */ b) => b?.type === "tool_use" && b.name === HAIKU_TOOL) : undefined;
  if (!call) throw new ProviderError("haiku", `malformed output: no ${HAIKU_TOOL} tool call (stop_reason ${stop})`);
  /** @type {Record<string, number>} */
  let probabilities;
  try {
    probabilities = normalizeProbabilities("haiku", call.input?.probabilities, decision.answers);
  } catch (e) {
    // An invalid tool block under any stop_reason but tool_use is an unfinished turn; say so.
    if (body.stop_reason !== "tool_use" && e instanceof ProviderError) throw new ProviderError("haiku", `incomplete output (stop_reason ${stop}): ${e.message}`);
    throw e;
  }
  return {
    probabilities,
    probabilitySource: "model-reported",
    model: typeof body.model === "string" ? body.model : null,
  };
}

/** Env var holding each provider's key. */
export const KEY_VARS = /** @type {const} */ ({ jev: "TYPESAFE_API_KEY", haiku: "ANTHROPIC_API_KEY" });

/**
 * D6 order when no --provider is given: Jev if TYPESAFE_API_KEY is set (an adapter exists), else Haiku
 * if ANTHROPIC_API_KEY is set, else agent mode.
 * @param {NodeJS.ProcessEnv} env
 * @returns {"jev" | "haiku" | "agent"}
 */
export function defaultProvider(env) {
  if (env.TYPESAFE_API_KEY) return "jev";
  if (env.ANTHROPIC_API_KEY) return "haiku";
  return "agent";
}

/**
 * Ask one provider. A missing key is a ProviderError like any other.
 * @param {ProviderName} name @param {Decision} decision @param {Record<string, unknown>} inputs @param {NodeJS.ProcessEnv} env
 * @returns {Promise<ProviderAnswer>}
 */
export async function askProvider(name, decision, inputs, env) {
  const key = env[KEY_VARS[name]];
  if (!key) throw new ProviderError(name, `${KEY_VARS[name]} is not set`);
  return name === "jev" ? askJev(decision, inputs, key) : askHaiku(decision, inputs, key);
}

// Demonstration, not a test: `rx judge eval <decision>` for each provider adapter (jev, haiku)
// through a MOCKED transport, so the per-case output and accuracy can be seen without a key or a
// network. The mock is a scripted stand-in: it answers each fixture's expected answer at 0.9,
// except the last fixture, which it answers wrong, so the accuracy line shows a miss. Nothing here
// says anything about how a real provider would score.
//
//   node test/judge-mock-eval.mjs [decision-id]     (default: review-finding-triage)

import { runCli } from "../src/cli.mjs";
import { loadDecision } from "../src/judge/decisions.mjs";
import { HAIKU_MODEL, HAIKU_TOOL, JEV_URL } from "../src/judge/providers.mjs";
import { setTransport } from "../src/judge/transport.mjs";

const id = process.argv[2] ?? "review-finding-triage";
const d = loadDecision(id);
const last = d.fixtures.length - 1;
const byInputs = new Map(d.fixtures.map((f, i) => [JSON.stringify(f.inputs), i]));

/** @type {import("../src/judge/transport.mjs").Transport} */
const mock = {
  async postJson(url, _headers, payload) {
    const p = /** @type {any} */ (payload);
    const inputs = url === JEV_URL ? p.state : JSON.parse(p.messages[0].content.split("Inputs (JSON):\n")[1]);
    const i = byInputs.get(JSON.stringify(inputs));
    if (i === undefined) throw new Error("mock: unknown inputs");
    const expected = d.fixtures[i].expected;
    const chosen = i === last ? d.answers.find((a) => a !== expected) ?? expected : expected;
    const rest = 0.1 / (d.answers.length - 1);
    const probabilities = Object.fromEntries(d.answers.map((a) => [a, a === chosen ? 0.9 : rest]));
    const body = url === JEV_URL
      ? { model: "jev-mock", answers: { answer: { type: "choice", choice: chosen, confidence: 0.9, probabilities } }, usage: { input_tokens: 0, output_tokens: 0 } }
      : { model: HAIKU_MODEL, stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_mock", name: HAIKU_TOOL, input: { probabilities } }] };
    return { status: 200, body, text: "" };
  },
};

const prev = setTransport(mock);
try {
  for (const provider of ["jev", "haiku"]) {
    // Fake keys in an explicit env object; process.env is neither read for keys nor changed.
    const env = { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "mock-jev-key", ANTHROPIC_API_KEY: "mock-anthropic-key" };
    process.stdout.write(`\n$ rx judge eval ${id} --provider ${provider}   (MOCKED transport)\n`);
    const code = await runCli(["judge", "eval", id, "--provider", provider], { env, stdout: (s) => process.stdout.write(s) });
    process.stdout.write(`exit ${code}\n`);
  }
} finally {
  setTransport(prev);
}

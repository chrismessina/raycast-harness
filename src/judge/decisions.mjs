// Judgment decisions (plan Phase 7): one JSON file per decision in src/judge/decisions/, shape
// { id, question, answers[], inputs (JSON Schema), fixtures: [{ inputs, expected, source }] }.
// Each file is validated on load against DECISION_SCHEMA and its own consistency rules, so a broken
// decision is an ERROR, never a judgment made against a half-read file.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RxError } from "../errors.mjs";
import { validate } from "../preset/schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DECISIONS_DIR = join(HERE, "decisions");

/**
 * @typedef {{ inputs: Record<string, unknown>, expected: string, source: string }} Fixture
 * @typedef {{ id: string, question: string, answers: string[], inputs: Record<string, unknown>, fixtures: Fixture[] }} Decision
 */

/** The shape every decision file must have (draft 2020-12 subset understood by src/preset/schema.mjs). */
export const DECISION_SCHEMA = {
  type: "object",
  required: ["id", "question", "answers", "inputs", "fixtures"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" },
    question: { type: "string", minLength: 1 },
    answers: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" } },
    inputs: { type: "object", required: ["type"], properties: { type: { const: "object" } } },
    fixtures: {
      type: "array",
      items: {
        type: "object",
        required: ["inputs", "expected", "source"],
        additionalProperties: false,
        properties: {
          inputs: { type: "object" },
          expected: { type: "string" },
          // A `raycast-extensions-skills:<repo path>:<line>[-<line>]` receipt (a path inside that
          // repository, never one on a machine), or `synthetic: <why>` when no real receipt exists.
          source: { type: "string", pattern: "^(raycast-extensions-skills:[^\\s:]+:\\d+(-\\d+)?|synthetic: .+)$" },
        },
      },
    },
  },
};

/** Every decision id shipped in src/judge/decisions/, sorted. @param {string} [dir] */
export function decisionIds(dir = DECISIONS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

/**
 * Problems with a parsed decision: schema errors, then consistency (file name matches id, every
 * fixture's inputs valid against the decision's own inputs schema, every expected answer is one
 * of `answers`). Empty = usable.
 * @param {unknown} d @param {string} [fileId]
 * @returns {string[]}
 */
export function decisionProblems(d, fileId) {
  const schemaErrors = validate(d, DECISION_SCHEMA).map((e) => `${e.path}: ${e.message}`);
  if (schemaErrors.length) return schemaErrors;
  const dec = /** @type {Decision} */ (d);
  /** @type {string[]} */
  const out = [];
  if (fileId !== undefined && dec.id !== fileId) out.push(`$.id: ${JSON.stringify(dec.id)} does not match the file name ${fileId}.json`);
  dec.fixtures.forEach((f, i) => {
    if (!dec.answers.includes(f.expected)) out.push(`$.fixtures[${i}].expected: ${JSON.stringify(f.expected)} is not one of the answers`);
    for (const e of validate(f.inputs, dec.inputs)) out.push(`$.fixtures[${i}].inputs${e.path.slice(1)}: ${e.message}`);
  });
  return out;
}

/**
 * Load and validate one decision. Unknown id or a broken file → RxError (ERROR, exit 2).
 * @param {string} id @param {string} [dir]
 * @returns {Decision}
 */
export function loadDecision(id, dir = DECISIONS_DIR) {
  const known = decisionIds(dir);
  if (!known.includes(id)) throw new RxError(`unknown decision ${JSON.stringify(id)}; known: ${known.join(", ") || "(none)"}`, { id: "input" });
  const path = join(dir, `${id}.json`);
  /** @type {unknown} */
  let d;
  try {
    d = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RxError(`decision ${id}: ${path} is not valid JSON: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  const problems = decisionProblems(d, id);
  if (problems.length) throw new RxError([`decision ${id} is malformed (${problems.length} problem${problems.length === 1 ? "" : "s"})`, ...problems].join("\n"), { id: "input" });
  return /** @type {Decision} */ (d);
}

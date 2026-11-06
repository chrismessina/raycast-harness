// What binds an authorization to the place and the attempt it was made for (docs/commands.md §1
// State locations, `rx gates`, `rx guard` limitation (2)). The attestation (src/attest.mjs) proves
// who wrote a receipt; these two prove where and when.
//
// Subject     `subject: { root, gitCommonDir }` inside the attested body of receipt.json and
//             audit.json: the realpath of the extension root and of `git rev-parse
//             --git-common-dir`. A receipt copied into another checkout (an identical clone, a
//             second worktree of another repository) names the checkout it was made in, so the
//             guard, recomputing both for the root it checks, blocks it.
// Generation  one file per extension root OUTSIDE the repository, beside the key:
//             $XDG_CONFIG_HOME/raycast-harness/generations/<first 32 hex of SHA-256(realpath root)>.json
//             = { root, generation }, `generation` being 32 random bytes as hex. `rx gates` writes a
//             new one (temp file + rename, file 0600, directory 0700) as its very first state action
//             on every attempt, including one that later FAILs or ERRORs on its arguments, and the
//             receipt carries the generation it was made under. The guard requires the receipt's
//             generation to equal the file's, so a receipt saved before any later gates attempt and
//             restored afterward blocks. `rx audit record` rotates nothing; it records the receipt's
//             generation and attestation MAC, and the guard requires both to equal the current
//             receipt's, so an audit recorded against a superseded receipt blocks too.
// Residual    someone who also restores the generation file (outside the repository; the guard
//             blocks Write/Edit and Bash mentions of that directory) can replay. That is the same
//             deliberate multi-step evasion limitation (2) already names.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, keyPaths } from "./attest.mjs";
import { git } from "./git.mjs";

export const GENERATION_BYTES = 32;

/** The sentences the guard and `rx audit record` share. */
export const SENTENCES = {
  /** @param {string} other */
  otherCheckout: (other) => `receipt.json was written for another checkout: ${other}; run rx gates here`,
  earlierAttempt: "receipt.json is from an earlier rx gates attempt; run rx gates again",
  auditSuperseded: "audit.json was recorded against an earlier receipt.json; run rx audit record again",
};

/**
 * The physical identity of an extension root.
 * @param {string} root
 * @returns {Promise<{ root: string, gitCommonDir: string }>}
 */
export async function subjectOf(root) {
  const real = realpathSync(root);
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: real })).stdout.trim();
  return { root: real, gitCommonDir: realpathSync(common) };
}

/** The generation file for an extension root (realpath'd here). @param {string} root */
export function generationPaths(root) {
  const real = realpathSync(root);
  const dir = join(keyPaths().dir, "generations");
  return { real, dir, file: join(dir, `${createHash("sha256").update(real).digest("hex").slice(0, 32)}.json`) };
}

/**
 * Write a new generation for this root (atomically) and return it. Throws RxError `attest-key`
 * when the config directory or `generations/` exists with group or other access.
 * @param {string} root
 * @returns {string}
 */
export function rotateGeneration(root) {
  const { real, dir, file } = generationPaths(root);
  ensurePrivateDir(keyPaths().dir);
  ensurePrivateDir(dir);
  const generation = randomBytes(GENERATION_BYTES).toString("hex");
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ root: real, generation }) + "\n");
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return generation;
}

/**
 * The current generation for this root, or null when there is none (or the file is not one rx
 * wrote for this root).
 * @param {string} root
 * @returns {string | null}
 */
export function currentGeneration(root) {
  try {
    const { real, file } = generationPaths(root);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    if (doc && doc.root === real && typeof doc.generation === "string" && /^[0-9a-f]{64}$/.test(doc.generation)) return doc.generation;
    return null;
  } catch {
    return null;
  }
}

/**
 * Is this (attested, well-formed) receipt bound to this root and to its latest gates attempt?
 * Returns null when it is, else the one sentence.
 * @param {any} receipt
 * @param {string} root
 * @returns {Promise<string | null>}
 */
export async function receiptBindingProblem(receipt, root) {
  const recorded = receipt?.subject;
  /** @type {{ root: string, gitCommonDir: string } | null} */
  let here;
  try {
    here = await subjectOf(root);
  } catch {
    here = null;
  }
  if (!here || !recorded || recorded.root !== here.root || recorded.gitCommonDir !== here.gitCommonDir) return SENTENCES.otherCheckout(typeof recorded?.root === "string" ? recorded.root : "(none recorded)");
  const current = currentGeneration(root);
  if (current === null || receipt.generation !== current) return SENTENCES.earlierAttempt;
  return null;
}

/**
 * Is this audit bound to exactly this receipt (its subject, its generation and its attestation MAC)?
 * @param {any} audit
 * @param {any} receipt
 * @returns {string | null}
 */
export function auditBindingProblem(audit, receipt) {
  if (audit?.subject?.root !== receipt?.subject?.root || audit?.subject?.gitCommonDir !== receipt?.subject?.gitCommonDir) return SENTENCES.auditSuperseded;
  if (typeof audit?.receiptGeneration !== "string" || audit.receiptGeneration !== receipt?.generation) return SENTENCES.auditSuperseded;
  if (typeof audit?.receiptMac !== "string" || audit.receiptMac !== receipt?.attestation?.mac) return SENTENCES.auditSuperseded;
  return null;
}

/**
 * The guard's sentence for a receipt that records a FAIL or ERROR, or null.
 * @param {any} receipt
 * @returns {string | null}
 */
export function receiptFailures(receipt) {
  const bad = (Array.isArray(receipt?.results) ? receipt.results : []).filter((/** @type {any} */ r) => r?.verdict === "FAIL" || r?.verdict === "ERROR");
  if (!bad.length) return null;
  return `the receipt records ${bad.length} FAIL/ERROR result(s) (${[...new Set(bad.map((/** @type {any} */ r) => r.id))].slice(0, 5).join(", ")}); a receipt is only written clean, so this one was edited: run rx gates again`;
}

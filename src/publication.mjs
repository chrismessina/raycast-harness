// The publication record (docs/commands.md, `rx publication record`): one plain file in the git
// repository's state, `repo/publication.json`, saying which pull request and remote head a
// successful publish produced. `rx publication record` is its only writer; `rx greptile can-reply
// --claims-fix` is its reader. Both hold it to the one shape below, so a record the writer would
// refuse is never read as evidence.
//
//   { repo: "owner/name", pr: <positive int>, remoteSha: "<40 lowercase hex>", at: "<ISO-8601>" }
//
// It is a plain record: no attestation, no binding to a checkout or a receipt, and nothing here
// touches the network. Exactly these four keys; anything else is a malformed record.

import { existsSync, readFileSync } from "node:fs";
import { RxError } from "./errors.mjs";
import { repoStatePath, writeJsonAtomic } from "./state.mjs";

export const PUBLICATION_FILE = "publication.json";
export const PUBLICATION_KEYS = Object.freeze(["repo", "pr", "remoteSha", "at"]);

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * @typedef {{ repo: string, pr: number, remoteSha: string, at: string }} PublicationRecord
 */

/**
 * Why `value` is not a publication record, or null when it is one. The single validator the
 * writer and the reader share.
 * @param {unknown} value
 * @returns {string | null}
 */
export function publicationProblem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "must be a JSON object { repo, pr, remoteSha, at }";
  const v = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(v).sort();
  const want = [...PUBLICATION_KEYS].sort();
  if (keys.join(",") !== want.join(",")) return `must hold exactly the keys ${PUBLICATION_KEYS.join(", ")}; got ${keys.join(", ") || "none"}`;
  if (typeof v.repo !== "string" || !REPO_RE.test(v.repo)) return `repo must be owner/name; got ${JSON.stringify(v.repo)}`;
  if (!Number.isSafeInteger(v.pr) || /** @type {number} */ (v.pr) < 1) return `pr must be a positive integer; got ${JSON.stringify(v.pr)}`;
  if (typeof v.remoteSha !== "string" || !SHA_RE.test(v.remoteSha)) return `remoteSha must be a full 40-hex lowercase commit SHA; got ${JSON.stringify(v.remoteSha)}`;
  if (typeof v.at !== "string" || !ISO_RE.test(v.at) || Number.isNaN(Date.parse(v.at))) return `at must be an ISO-8601 timestamp; got ${JSON.stringify(v.at)}`;
  return null;
}

/**
 * Build a record from the command-line operands, or throw `ERROR args` naming the bad operand.
 * The operands are text, so `pr` must be the decimal form of a positive integer.
 * @param {{ repo: string, pr: string, remoteSha: string, at: string }} operands
 * @returns {PublicationRecord}
 */
export function recordFromOperands({ repo, pr, remoteSha, at }) {
  if (!/^[1-9]\d*$/.test(pr)) throw new RxError(`pull request number must be a positive integer; got ${JSON.stringify(pr)}`, { id: "args" });
  const record = { repo, pr: Number(pr), remoteSha, at };
  const problem = publicationProblem(record);
  if (problem) throw new RxError(`publication record ${problem}`, { id: "args" });
  return record;
}

/**
 * Where the record lives: the repo state of the git repository containing `root` (`git rev-parse
 * --git-path rx`). Any directory inside the repository names the same file.
 * @param {string} root
 */
export function publicationPath(root) {
  return repoStatePath(root, PUBLICATION_FILE);
}

/**
 * Validate and write the record atomically. Throws (and writes nothing) when the record is malformed.
 * @param {string} root
 * @param {PublicationRecord} record
 * @returns {Promise<string>} the file written
 */
export async function writePublication(root, record) {
  const problem = publicationProblem(record);
  if (problem) throw new RxError(`publication record ${problem}`, { id: "input" });
  const file = await publicationPath(root);
  writeJsonAtomic(file, record);
  return file;
}

/**
 * Read the record at `file`. Missing → null. Unreadable JSON or a malformed record → `ERROR input`:
 * a record the writer would refuse is never evidence.
 * @param {string} file
 * @returns {PublicationRecord | null}
 */
export function readPublication(file) {
  if (!existsSync(file)) return null;
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new RxError(`publication record ${file} is unreadable: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  const problem = publicationProblem(value);
  if (problem) throw new RxError(`publication record ${file} is malformed: it ${problem}; rewrite it with \`rx publication record\``, { id: "input" });
  return /** @type {PublicationRecord} */ (value);
}

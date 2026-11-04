// The receipt fingerprint (docs/commands.md §4.8; plan-review-1 #1). Identifies the exact tree
// `rx gates` checked, so `rx guard` can tell whether anything changed between the gates run and
// `ray publish`. Nothing here writes to git: no `write-tree`, no index, no objects.
//
//   payload       SHA-256 over a sorted, length-delimited manifest of the publisher copy set
//                 (`src/payload.mjs`: the root minus ray's fixed skip list, ignored and untracked
//                 files included): path, entry type, executable bit, symlink target, file bytes.
//                 A symlink to a file hashes the TARGET's bytes and the target's executable bit,
//                 because that is what ray copies; a dangling or directory link hashes the
//                 failure text instead (ray's copy fails there too, and the fingerprint still
//                 changes when the link does).
//   head          `git rev-parse HEAD`, or `none` outside a work tree / before the first commit
//   publishRange  the `git log` range `rx scan` scans, with the publish tag's commit:
//                 `HEAD...__raycast_latest_publish_ext/<name>__@<sha>`, else `HEAD`, else `none`
//   preset        SHA-256 of the preset file's bytes
//   forbidden     SHA-256 of the forbidden-list file's bytes
//   rxVersion     the running rx version (package.json)
//   baseline      the published baseline SHA `rx stale` recorded, the literal `unpublished`, or
//                 the literal `unknown` when `rx stale` has not run (a later first publication
//                 changes `unpublished` to a SHA and invalidates the receipt)
//   combined      SHA-256 over the seven fields above, in that order, length-delimited
//
// `rx gates` records the preset and forbidden paths beside the fingerprints so `rx guard`, which
// takes no flags, can re-read the same files. A file that has since vanished hashes as `missing`.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvePublishTag } from "./publish-tag.mjs";
import { git, isWorkTree } from "./git.mjs";
import { listPayload, readPayloadBytes } from "./payload.mjs";
import { repoStatePathReadOnly } from "./state.mjs";

/**
 * @typedef {{
 *   payload: string,
 *   head: string,
 *   publishRange: string,
 *   preset: string,
 *   forbidden: string,
 *   rxVersion: string,
 *   baseline: string,
 *   combined: string,
 * }} Fingerprints
 */

export const FINGERPRINT_FIELDS = /** @type {const} */ (["payload", "head", "publishRange", "preset", "forbidden", "rxVersion", "baseline"]);

/** Publish tag ray reads (@raycast/api dist/utils/publish/git.js). @param {string} name */

/** @param {Buffer | string} b */
export function sha256(b) {
  return createHash("sha256").update(b).digest("hex");
}

/**
 * Length-delimited field framing: `<byte length>:<bytes>` for every field, so no separator
 * character can be forged by a path or file content.
 * @param {import("node:crypto").Hash} hash @param {Buffer | string} field
 */
function frame(hash, field) {
  const buf = Buffer.isBuffer(field) ? field : Buffer.from(field, "utf8");
  hash.update(`${buf.length}:`);
  hash.update(buf);
}

/**
 * The payload fingerprint: every entry `ray publish` would copy, sorted by path.
 * @param {string} root absolute extension root
 * @returns {{ hash: string, entries: number }}
 */
export function payloadFingerprint(root) {
  const entries = listPayload(root);
  const hash = createHash("sha256");
  for (const e of entries) {
    frame(hash, e.path);
    frame(hash, e.type);
    frame(hash, (e.mode & 0o111) !== 0 ? "x" : "-");
    frame(hash, e.target ?? "");
    if (e.type === "dir") {
      frame(hash, "");
      continue;
    }
    if (e.type === "symlink") {
      // ray copies the target's bytes AND its mode (copyFileSync), so the dereferenced
      // executable bit is part of what ships; a dangling link records the failure text.
      try {
        frame(hash, (statSync(join(root, e.path)).mode & 0o111) !== 0 ? "target:x" : "target:-");
      } catch (err) {
        frame(hash, `target:unreadable:${/** @type {Error} */ (err).message}`);
      }
    }
    try {
      frame(hash, readPayloadBytes(root, e));
    } catch (err) {
      frame(hash, `unreadable:${/** @type {Error} */ (err).message}`);
    }
  }
  return { hash: hash.digest("hex"), entries: entries.length };
}

/** SHA-256 of a file's bytes, or `missing` when it cannot be read. @param {string | null} file */
export function fileFingerprint(file) {
  if (!file) return "missing";
  try {
    return sha256(readFileSync(file));
  } catch {
    return "missing";
  }
}

/**
 * The published baseline `rx stale` recorded for this root: the baseline SHA, `unpublished`, or
 * `unknown` (no baseline file, or one without a boolean `published`). Creates nothing.
 * @param {string} root
 */
export async function readBaseline(root) {
  try {
    const file = await repoStatePathReadOnly(root, "stale", "baseline.json");
    if (!existsSync(file)) return "unknown";
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j?.published === false) return "unpublished";
    if (j?.published === true && typeof j.baseline === "string" && j.baseline) return j.baseline;
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * HEAD and the publish range, both `none` outside a git work tree.
 * @param {string} root
 */
async function gitFingerprints(root) {
  if (!(await isWorkTree(root))) return { head: "none", publishRange: "none" };
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root, allowFail: true });
  const headSha = head.code === 0 ? head.stdout.trim() : "none";
  let publishRange = "HEAD";
  /** @type {string | null} */
  let name;
  try {
    const n = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
    name = typeof n === "string" && n ? n : null;
  } catch {
    name = null;
  }
  if (name) {
    const tag = await resolvePublishTag(root, name);
    if (tag) publishRange = `HEAD...${tag.tag}@${tag.sha}`;
  }
  return { head: headSha, publishRange };
}

/**
 * Compute every fingerprint for `root`.
 * @param {{ root: string, version: string, presetPath: string | null, forbiddenPath: string | null, baseline?: string }} p
 *   `baseline` overrides the value read from `repo/stale/baseline.json` (gates passes stale's own
 *   result; guard reads the file).
 * @returns {Promise<Fingerprints>}
 */
export async function computeFingerprints({ root, version, presetPath, forbiddenPath, baseline }) {
  const { head, publishRange } = await gitFingerprints(root);
  /** @type {Omit<Fingerprints, "combined">} */
  const parts = {
    payload: payloadFingerprint(root).hash,
    head,
    publishRange,
    preset: fileFingerprint(presetPath),
    forbidden: fileFingerprint(forbiddenPath),
    rxVersion: version,
    baseline: baseline ?? (await readBaseline(root)),
  };
  return { ...parts, combined: combine(parts) };
}

/**
 * The combined hash over the seven fields, in a fixed order.
 * @param {Omit<Fingerprints, "combined">} parts
 */
export function combine(parts) {
  const hash = createHash("sha256");
  for (const k of FINGERPRINT_FIELDS) frame(hash, String(parts[k]));
  return hash.digest("hex");
}

/**
 * Field-by-field comparison of a recorded fingerprint set with a fresh one.
 * @param {Partial<Fingerprints> | null | undefined} recorded
 * @param {Fingerprints} fresh
 * @returns {string[]} the names of the fields that differ (`combined` included when any does)
 */
export function diffFingerprints(recorded, fresh) {
  /** @type {string[]} */
  const out = [];
  for (const k of FINGERPRINT_FIELDS) if (!recorded || recorded[k] !== fresh[k]) out.push(k);
  if (out.length || !recorded || recorded.combined !== fresh.combined) out.push("combined");
  return out;
}

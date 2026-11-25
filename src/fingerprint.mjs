// The receipt fingerprint (docs/commands.md §4.8; plan-review-1 #1). Identifies the exact tree
// `rx gates` checked, so `rx guard` can tell whether anything changed between the gates run and
// `ray publish`. Nothing here writes to git: no `write-tree`, no index, no objects.
//
//   payload       SHA-256 over a sorted, length-delimited manifest of the publisher copy set
//                 (`src/payload.mjs`: the root minus ray's fixed skip list, ignored and untracked
//                 files included): path, entry type, executable bit, symlink target, file bytes.
//                 One exception: an entry inside a SwiftPM scratch directory (`.build` beside a
//                 `Package.swift`) that the .gitignore files the extension ships exclude and the
//                 extension's repo does not track. `ray build` rewrites `.build/.lock` with its PID
//                 on every run, so counting it made every Swift extension fail
//                 `gates-tree-changed`. ray still copies it and `rx scan` still reads it, but the
//                 fork-side `git add` does not stage an untracked ignored path. git check-ignore
//                 decides, over the shipped .gitignore files (src/preflight/gitignore.mjs). It
//                 fails closed: when git cannot answer, or anything here throws, nothing is left
//                 out (the pure-JS matcher is not trusted to authorize an omission). An entry
//                 that is not ignored, or that the repo tracks (git stages a tracked file even when
//                 it is ignored), stays in. Residual: "tracked" is read from the extension's repo,
//                 not from the fork, which normally tracks the same files.
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
import { gitIgnoredSet, shippedGitignores } from "./preflight/gitignore.mjs";
import { listPayload, readPayloadBytes } from "./payload.mjs";
import { readStaleBaseline } from "./published-copy.mjs";
import { ownerExecutable } from "./util.mjs";

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
 * The payload fingerprint: every entry `ray publish` would copy, sorted by path, minus `leaveOut`.
 * @param {string} root absolute extension root
 * @param {ReadonlySet<string>} [leaveOut] entry paths to leave out (computeFingerprints passes ignoredSwiftPMScratch)
 * @returns {{ hash: string, entries: number }}
 */
export function payloadFingerprint(root, leaveOut = new Set()) {
  const entries = listPayload(root).filter((e) => !leaveOut.has(e.path));
  const hash = createHash("sha256");
  for (const e of entries) {
    frame(hash, e.path);
    frame(hash, e.type);
    frame(hash, ownerExecutable(e.mode) ? "x" : "-");
    frame(hash, e.target ?? "");
    if (e.type === "dir") {
      frame(hash, "");
      continue;
    }
    if (e.type === "symlink") {
      // ray copies the target's bytes AND its mode (copyFileSync), so the dereferenced
      // executable bit is part of what ships; a dangling link records the failure text.
      try {
        frame(hash, ownerExecutable(statSync(join(root, e.path)).mode) ? "target:x" : "target:-");
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

/**
 * True for a SwiftPM scratch directory or a path inside one: a `.build` segment whose parent holds
 * a `Package.swift`. @param {string} root @param {string} relPath `/`-joined, relative to root
 */
export function isSwiftPMScratch(root, relPath) {
  const segments = relPath.split("/");
  const i = segments.indexOf(".build");
  return i >= 0 && existsSync(join(root, ...segments.slice(0, i), "Package.swift"));
}

/**
 * The payload entries inside SwiftPM scratch directories that the shipped .gitignore files exclude
 * and the extension's repo does not track: what payloadFingerprint leaves out. git check-ignore
 * decides (a directory is asked with a trailing `/`, which git needs to apply a directory-only
 * pattern to a path its scratch repo cannot see). Fails closed: an empty set whenever git cannot
 * answer or anything throws.
 * @param {string} root absolute extension root
 * @returns {Promise<Set<string>>}
 */
export async function ignoredSwiftPMScratch(root) {
  try {
    const scratch = listPayload(root).filter((e) => isSwiftPMScratch(root, e.path));
    if (!scratch.length) return new Set();
    const key = (/** @type {{ path: string, type: string }} */ e) => (e.type === "dir" ? `${e.path}/` : e.path);
    const ignored = await gitIgnoredSet(shippedGitignores(root), scratch.map(key));
    if (!ignored) return new Set();
    /** @type {Set<string>} */
    let tracked = new Set();
    if (await isWorkTree(root)) {
      const r = await git(["ls-files", "-z", "--full-name", "--", "."], { cwd: root, allowFail: true });
      if (r.code !== 0) return new Set();
      const top = await git(["rev-parse", "--show-prefix"], { cwd: root, allowFail: true });
      if (top.code !== 0) return new Set();
      const prefix = top.stdout.trim();
      tracked = new Set(r.stdout.split("\0").filter(Boolean).map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f)));
    }
    return new Set(scratch.filter((e) => ignored.has(key(e)) && !tracked.has(e.path)).map((e) => e.path));
  } catch {
    return new Set();
  }
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
    const j = await readStaleBaseline(root);
    if (j === null) return "unknown";
    if (j.published === false) return "unpublished";
    if (j.published === true && typeof j.baseline === "string" && j.baseline) return j.baseline;
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
    payload: payloadFingerprint(root, await ignoredSwiftPMScratch(root)).hash,
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

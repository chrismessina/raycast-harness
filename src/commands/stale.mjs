// `rx stale [--root d] [--json]` (docs/commands.md §4.2): is the published copy of this extension
// older or different from what is here? The dispatcher resolves the root before this runs (Q3), so
// the first network call already knows which extension it is asking about.
//
// Classifier per path, published tree versus the local payload (what `ray publish` copies):
//   MINE       published blob == local HEAD blob (identical, or the delta is uncommitted)
//   CHECK      published blob == an older commit of this path
//   NEW?       local file the published tree lacks
//   UPSTREAM   published blob not in this path's history
//   ONLY-PUB   published has a file local does not
//   REMOVE     an ONLY-PUB path the preset's `holdout.localOnly` lists (the path itself or a path
//              under a listed directory), absent locally because `rx holdout out` holds it out or
//              because it is simply not there: publishing deletes it upstream, deliberately
//              (Chris's 2026-11-03 ruling: AGENTS.md, CONCEPTS.md, CLAUDE.md and HANDOFF.md never
//              ship). Only with --preset; without one every such path stays ONLY-PUB.
//   UNHANDLED  symlink, mode change, or an undecidable path
// CHECK, NEW? and REMOVE are WARN "requiring an audit disposition" keyed by { path, localHash,
// baseline } (data.files[]), which `rx audit record` matches. A REMOVE row has localHash null
// (absent locally); its disposition key uses the literal "absent" (src/audit/evaluate.mjs) and its
// only accepted disposition is `remove-published`.

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { RxError } from "../errors.mjs";
import { git } from "../git.mjs";
import { withPublishedCopy, writeStaleBaseline } from "../published-copy.mjs";
import { blobId, skipSegment } from "../upstream.mjs";
import { repoStatePathReadOnly } from "../state.mjs";
import { readPresetFields } from "./holdout.mjs";
import { isUnder } from "../util.mjs";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "stale",
  summary: "compare the local extension with its published copy in raycast/extensions, path by path",
  root: "required",
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root" },
    "--preset": { type: "string", value: "<file>", help: "preset JSON; reads holdout.localOnly so a listed path the published copy has and local lacks is REMOVE (a deliberate deletion), not ONLY-PUB" },
  },
  network: "GitHub API (publication lookup) and `git fetch` of raycast/extensions into the cross-repo cache",
  state: "reads/writes cache/upstream/ (sparse checkout); writes repo/stale/baseline.json { name, published, baseline, at } (no cache path)",
  checks: {
    stale: { description: "N/A when the extension is not published (no baseline to compare)", levels: ["N/A"] },
    "stale-mine": { description: "published == local HEAD for these paths (PASS)", levels: ["PASS"] },
    "stale-check": { description: "published == an older commit of these paths; WARN requiring an audit disposition", levels: ["WARN"] },
    "stale-new": { description: "local files the published tree lacks; WARN requiring an audit disposition", levels: ["WARN"] },
    "stale-upstream": "published content not in these paths' history (FAIL)",
    "stale-only-pub": "published files local lacks; publishing deletes them (FAIL)",
    "stale-remove": { description: "published files the preset's holdout.localOnly lists and local lacks (held out by rx holdout, or absent); publishing deletes them on purpose; WARN requiring an audit disposition remove-published", levels: ["WARN"] },
    "stale-unhandled": "symlink, mode change or undecidable path (FAIL)",
  },
  data: {
    name: "string — package.json name",
    published: "boolean",
    publishedDir: "string | null — cache path of the published copy (a convenience for this run; never persisted)",
    baseline: "string | null — raycast/extensions main commit the comparison used",
    files: "[{ path, class, localHash, publishedHash | null, note }] — class ∈ MINE CHECK NEW? UPSTREAM ONLY-PUB REMOVE UNHANDLED; localHash is the git blob id of the on-disk bytes (null when absent locally; a REMOVE disposition keys it as \"absent\")",
  },
};

/** The verdict each class maps to and its result id. */
const CLASSES = /** @type {const} */ ({
  MINE: { id: "stale-mine", verdict: "PASS", summary: "published matches local HEAD" },
  CHECK: { id: "stale-check", verdict: "WARN", summary: "published matches an older commit; audit disposition required" },
  "NEW?": { id: "stale-new", verdict: "WARN", summary: "not published (your new file, or deleted upstream); audit disposition required" },
  UPSTREAM: { id: "stale-upstream", verdict: "FAIL", summary: "published content is not in this path's history; publishing would revert it" },
  "ONLY-PUB": { id: "stale-only-pub", verdict: "FAIL", summary: "published has files local lacks; publishing would delete them" },
  REMOVE: { id: "stale-remove", verdict: "WARN", summary: "local-only per the preset and absent here; publishing deletes the published copy; audit disposition remove-published required" },
  UNHANDLED: { id: "stale-unhandled", verdict: "FAIL", summary: "classify by hand" },
});

/** @typedef {keyof typeof CLASSES} Class */
/** @typedef {{ path: string, class: Class, localHash: string | null, publishedHash: string | null, note: string }} FileRow */
/** @typedef {{ localOnly: string[], heldOut: Set<string> }} LocalOnly the preset's holdout.localOnly and the paths rx holdout holds out now */

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, cwd, results, root, log }) {
  const dir = /** @type {string} */ (root);
  const name = readName(dir);
  const presetFile = typeof args.flags["--preset"] === "string" ? resolve(cwd, args.flags["--preset"]) : null;
  const localOnly = presetFile ? readPresetFields(presetFile).localOnly : [];
  const heldOut = localOnly.length ? await heldOutPaths(dir) : new Set();
  // The service holds the upstream lock from the fetch through the whole comparison: another rx
  // fetching a different extension would otherwise move the shared tree while this one reads it.
  return withPublishedCopy({ name, refresh: true, log }, (copy) => compare(dir, name, copy, results, { localOnly, heldOut }));
}

/**
 * @param {string} dir @param {string} name @param {import("../published-copy.mjs").PublishedCopy} copy @param {import("../verdict.mjs").Results} results
 * @param {LocalOnly} localOnly
 * @returns {Promise<import("../cli.mjs").CommandOutput>}
 */
async function compare(dir, name, copy, results, localOnly) {
  await writeStaleBaseline(dir, { name, published: copy.published, baseline: copy.baseline, at: /** @type {string} */ (copy.at) });

  if (!copy.published) {
    results.na("stale", `not published: extensions/${name} is not on raycast/extensions main; no baseline`);
    return { data: { name, published: false, publishedDir: null, baseline: null, files: [] } };
  }

  const publishedDir = /** @type {string} */ (copy.directory);
  const files = await classify(dir, publishedDir, localOnly);

  /** @type {Map<Class, FileRow[]>} */
  const byClass = new Map();
  for (const f of files) {
    const list = byClass.get(f.class) ?? [];
    list.push(f);
    byClass.set(f.class, list);
  }
  const allMine = files.length > 0 && files.every((f) => f.class === "MINE" && f.note === "identical");
  if (allMine) results.pass("stale-mine", `identical to published (${files.length} files, baseline ${copy.baseline?.slice(0, 12)})`);
  else if (files.length === 0) results.fail("stale-unhandled", "neither side has any file to compare");
  else {
    for (const cls of /** @type {Class[]} */ (Object.keys(CLASSES))) {
      const rows = byClass.get(cls);
      if (!rows) continue;
      const { id, verdict, summary } = CLASSES[cls];
      results.add(verdict, id, `${rows.length} ${rows.length === 1 ? "path" : "paths"}: ${summary}`, rows.map((r) => ({ file: r.path, text: `${cls} ${r.note}` })));
    }
  }
  return { data: { name, published: true, publishedDir, baseline: copy.baseline, files } };
}

/**
 * The sources `rx holdout out` recorded for this root (its inventory), or an empty set. Read
 * only: a missing or unreadable inventory means nothing is held out; it never fails stale.
 * @param {string} dir
 * @returns {Promise<Set<string>>}
 */
async function heldOutPaths(dir) {
  try {
    const inv = JSON.parse(readFileSync(await repoStatePathReadOnly(dir, "holdout", "inventory.json"), "utf8"));
    return new Set(Array.isArray(inv?.entries) ? inv.entries.map((/** @type {any} */ e) => e?.source).filter((/** @type {unknown} */ s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Is `path` one the preset lists as local-only: the listed path itself, or a path under a listed
 * directory? @param {string} path @param {string[]} localOnly
 */
export function listedLocalOnly(path, localOnly) {
  return localOnly.find((p) => isUnder(path, p)) ?? null;
}

/** @param {string} dir */
function readName(dir) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (e) {
    throw new RxError(`cannot read ${join(dir, "package.json")}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  if (typeof pkg?.name !== "string" || !pkg.name.trim()) throw new RxError(`package.json in ${dir} has no "name"`, { id: "input" });
  return pkg.name;
}

/**
 * Walk a directory tree, returning payload-relative POSIX paths with their lstat type. Skips the
 * publish skip list and compare noise at any depth.
 * @param {string} base
 * @returns {Map<string, { kind: "file" | "symlink" | "other", mode: number }>}
 */
export function walkPayload(base) {
  /** @type {Map<string, { kind: "file" | "symlink" | "other", mode: number }>} */
  const out = new Map();
  const visit = (/** @type {string} */ abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (skipSegment(entry.name)) continue;
      const full = join(abs, entry.name);
      const rel = relative(base, full).split("\\").join("/");
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out.set(rel, { kind: "symlink", mode: st.mode });
      else if (st.isDirectory()) visit(full);
      else if (st.isFile()) out.set(rel, { kind: "file", mode: st.mode });
      else out.set(rel, { kind: "other", mode: st.mode });
    }
  };
  visit(base);
  return out;
}

/**
 * `git ls-tree -r <ref> .` run inside `cwd`: paths come back relative to that directory, which is
 * what makes the same call work from a standalone checkout, from `extensions/<name>` inside a
 * monorepo clone, and inside the upstream cache.
 * @param {string} cwd
 * @param {string} ref
 */
async function lsTree(cwd, ref) {
  const r = await git(["ls-tree", "-r", "-z", ref, "."], { cwd, allowFail: true });
  /** @type {Map<string, { mode: string, blob: string }>} */
  const out = new Map();
  if (r.code !== 0) return out; // no HEAD yet (fresh repo): nothing tracked
  for (const rec of r.stdout.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, , blob] = rec.slice(0, tab).split(" ");
    out.set(rec.slice(tab + 1), { mode, blob });
  }
  return out;
}

/**
 * The classifier. Exported for tests.
 * @param {string} dir local extension root
 * @param {string} publishedDir the published copy on disk (inside the upstream cache)
 * @param {LocalOnly} [localOnly] without it (no --preset) nothing is REMOVE
 * @returns {Promise<FileRow[]>}
 */
export async function classify(dir, publishedDir, localOnly = { localOnly: [], heldOut: new Set() }) {
  const local = walkPayload(dir);
  const published = walkPayload(publishedDir);
  const pubTree = await lsTree(publishedDir, "HEAD");
  const inRepo = (await git(["rev-parse", "--is-inside-work-tree"], { cwd: dir, allowFail: true })).stdout.trim() === "true";
  const localTree = inRepo ? await lsTree(dir, "HEAD") : new Map();

  const paths = [...new Set([...local.keys(), ...published.keys()])].sort();
  /** @type {FileRow[]} */
  const rows = [];
  for (const path of paths) {
    const l = local.get(path);
    const p = published.get(path);
    const localHash = l?.kind === "file" ? blobId(readFileSync(join(dir, path))) : null;
    const pubEntry = pubTree.get(path);
    const publishedHash = pubEntry?.blob ?? (p?.kind === "file" ? blobId(readFileSync(join(publishedDir, path))) : null);
    const row = (/** @type {Class} */ cls, /** @type {string} */ note) => rows.push({ path, class: cls, localHash, publishedHash, note });

    if ((l && l.kind !== "file") || (p && p.kind !== "file")) { row("UNHANDLED", `${l?.kind ?? p?.kind} (not a regular file)`); continue; }
    if (p && !l) {
      const listed = listedLocalOnly(path, localOnly.localOnly);
      if (listed === null) row("ONLY-PUB", "published has this file; local does not");
      else row("REMOVE", `local-only (${listed} in the preset's holdout.localOnly), ${[...localOnly.heldOut].some((h) => isUnder(path, h)) ? "held out by rx holdout" : "absent locally"}; publishing deletes the published copy`);
      continue;
    }
    if (l && !p) { row("NEW?", "not published: your new file, or deleted upstream"); continue; }
    if (!l || !p) continue;

    if (!pubEntry) { row("UNHANDLED", "no published blob id (not tracked upstream?)"); continue; }
    // Mode: the working file's executable bit (uncommitted changes included) against the published
    // tree entry, before identical bytes are accepted as MINE.
    const localMode = gitMode(l.mode);
    const localEntry = localTree.get(path);
    if (pubEntry.mode !== localMode) { row("UNHANDLED", `mode ${pubEntry.mode} published, ${localMode} local${localEntry && localEntry.mode === pubEntry.mode ? " (uncommitted)" : ""}`); continue; }

    const headBlob = inRepo ? (await git(["rev-parse", "-q", "--verify", `HEAD:./${path}`], { cwd: dir, allowFail: true })) : null;
    const headId = headBlob && headBlob.code === 0 ? headBlob.stdout.trim() : null;
    const identical = localHash === publishedHash || (localHash !== null && readFileSync(join(dir, path)).equals(readFileSync(join(publishedDir, path))));
    if (identical) { row("MINE", "identical"); continue; }
    if (headId && headId === pubEntry.blob) { row("MINE", "published == your HEAD; the delta is uncommitted"); continue; }
    if (inRepo && (await blobInHistory(dir, path, pubEntry.blob))) { row("CHECK", "published == an older commit of yours; read the diff"); continue; }
    row("UPSTREAM", "published blob not found in this path's history");
  }
  return rows;
}

/** A working file's git tree mode: 100755 when any execute bit is set, else 100644. @param {number} mode */
function gitMode(mode) {
  return (mode & 0o111) !== 0 ? "100755" : "100644";
}

/**
 * Did any commit of `path` (from HEAD) ever hold blob `id`? `--full-history --diff-merges=separate`
 * so a blob that only ever arrived through a merge is still found.
 * @param {string} cwd @param {string} path @param {string} id
 */
async function blobInHistory(cwd, path, id) {
  const r = await git(["--literal-pathspecs", "log", "--full-history", "--diff-merges=separate", "--raw", "--no-abbrev", "--format=", "HEAD", "--", path], { cwd, allowFail: true });
  if (r.code !== 0) return false;
  for (const line of r.stdout.split("\n")) {
    // :100644 100644 <old> <new> M\tpath
    const m = line.match(/^:\d{6} \d{6} [0-9a-f]{40} ([0-9a-f]{40}) /);
    if (m && m[1] === id) return true;
  }
  return false;
}

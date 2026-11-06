// Which file paths `rx guard` refuses to let a Write, Edit, MultiEdit or NotebookEdit touch (and,
// through src/audit/publish-command.mjs, which paths a Bash command may not name): anything inside
// a repository's rx state directory, and the rx config directory holding the attestation key
// (src/attest.mjs) and the generations (src/binding.mjs). rx state is written only by rx.
//
// The target is checked in three forms, and any one matching blocks:
//   lexical    resolved against the hook payload's cwd (`..` collapsed textually);
//   physical   the pathname walked in filesystem order, as the kernel walks it (resolveFsOrder):
//              from `/` (the cwd's components first for a relative path), each component applied
//              to the current physical directory, so a symlink followed by `..` lands in the link
//              target's parent; a dangling symlink is followed to where it points, since writing
//              through it creates its target; once a component does not exist, the rest is
//              appended lexically;
//   physical-of-lexical  the lexical form walked the same way (the earlier rule, kept).
// A path is rx state when
//   (1) its segments contain `.git` followed by `rx` (`…/.git/rx`, `…/.git/rx/…`), or
//   (2) it lies at or under `git rev-parse --git-path rx` of the repository containing its
//       deepest existing directory (this covers a worktree, whose state is under
//       `.git/worktrees/<name>/rx`, and a separate git dir).
// The rx config directory ($XDG_CONFIG_HOME/raycast-harness: the attestation key and the
// generations/ of src/binding.mjs) is protected whole.
// Comparison ignores case: on a case-insensitive volume `.GIT/RX` is the same directory, and on a
// case-sensitive one refusing it costs nothing.

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { keyPaths } from "../attest.mjs";
import { git } from "../git.mjs";

/** Symlink hops before the walk gives up and appends the rest lexically. */
const MAX_HOPS = 40;

/**
 * Walk `comps` from the physical directory `start`.
 * @param {string} start an existing physical directory
 * @param {string[]} comps
 * @param {number} hops
 * @returns {string}
 */
function walk(start, comps, hops) {
  let cur = start;
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    if (c === "" || c === ".") continue;
    if (c === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, c);
    const rest = comps.slice(i + 1).filter((x) => x !== "");
    /** @type {import("node:fs").Stats | null} */
    let st;
    try {
      st = lstatSync(next);
    } catch {
      st = null;
    }
    if (st === null) return rest.length ? resolve(next, rest.join(sep)) : next; // the rest is lexical
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    try {
      cur = realpathSync.native(next);
      continue;
    } catch {
      // a dangling link: follow its text below
    }
    if (hops >= MAX_HOPS) return rest.length ? resolve(next, rest.join(sep)) : next;
    const target = readlinkSync(next);
    return walk(isAbsolute(target) ? sep : cur, [...target.split(sep), ...rest], hops + 1);
  }
  return cur;
}

/**
 * Resolve a pathname in filesystem order (see the header): what a write to `filePath`, issued
 * from `cwd`, would actually touch.
 * @param {string} filePath
 * @param {string} cwd absolute
 */
export function resolveFsOrder(filePath, cwd) {
  const abs = isAbsolute(filePath) ? filePath : `${cwd}${sep}${filePath}`;
  return walk(sep, abs.split(sep), 0);
}

/**
 * The physical form of an absolute path that may not exist yet.
 * @param {string} p absolute
 * @returns {string}
 */
export function physicalPath(p) {
  return resolveFsOrder(p, sep);
}

/** The deepest existing directory at or above an absolute path. @param {string} p */
function deepestDir(p) {
  let d = p;
  for (;;) {
    try {
      if (statSync(d).isDirectory()) return d;
    } catch {
      // keep walking up
    }
    const up = dirname(d);
    if (up === d) return d;
    d = up;
  }
}

/** @param {string} p */
const lower = (p) => p.toLowerCase();

/** Is `p` at or under `base` (case-insensitive)? @param {string} p @param {string} base */
export function within(p, base) {
  const a = lower(p);
  const b = lower(base).replace(/[\\/]+$/, "");
  return a === b || a.startsWith(b + sep);
}

/**
 * The `…/.git/rx` prefix of a path containing the segment sequence `.git` / `rx`, or null.
 * @param {string} p
 */
export function stateSegments(p) {
  const segs = p.split(sep);
  for (let i = 0; i + 1 < segs.length; i++) if (lower(segs[i]) === ".git" && lower(segs[i + 1]) === "rx") return segs.slice(0, i + 2).join(sep);
  return null;
}

/**
 * Decide whether a Write/Edit target is protected.
 * @param {string} filePath the tool's `file_path` / `notebook_path`
 * @param {string} cwd the hook payload's cwd
 * @returns {Promise<{ path: string, protected: false } | { path: string, protected: true, what: "state" | "key", base: string }>}
 *   `path` is the physical target.
 */
export async function checkProtectedPath(filePath, cwd) {
  const lexical = resolve(cwd, filePath);
  const physical = resolveFsOrder(filePath, cwd);
  const forms = [...new Set([lexical, physical, physicalPath(lexical)])];

  const { dir: keyDir } = keyPaths();
  const keyDirs = [keyDir, physicalPath(keyDir)];
  for (const f of forms) for (const k of keyDirs) if (within(f, k)) return { path: physical, protected: true, what: "key", base: k };

  for (const f of forms) {
    const base = stateSegments(f);
    if (base !== null) return { path: physical, protected: true, what: "state", base };
  }

  for (const d of new Set(forms.map(deepestDir))) {
    const r = await git(["rev-parse", "--path-format=absolute", "--git-path", "rx"], { cwd: d, allowFail: true });
    if (r.code === 0 && r.stdout.trim()) {
      const stateDir = r.stdout.trim();
      for (const s of [stateDir, physicalPath(stateDir)]) for (const f of forms) if (within(f, s)) return { path: physical, protected: true, what: "state", base: s };
    }
  }
  return { path: physical, protected: false };
}

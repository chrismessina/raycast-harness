// The publisher copy set: every path under an extension root that `ray publish` would copy into
// the fork checkout. `copyDir` (@raycast/api dist/utils/publish/copy-dir.js) walks the root with
// readdirSync and copies everything, ignored and untracked files included, skipping only the
// names in PUBLISH_SKIPS, at any depth. It never reads an ignore file; the extension's own
// `.gitignore` only matters at the later `git add` in the fork checkout, which is why gate −2
// (`rx scan`) and the fingerprint (`rx gates`) both read this list rather than `git ls-files`.
//
// Exports
//   PUBLISH_SKIPS            the fixed skip list (names, matched against every path segment)
//   isSkipped(relPath)       true when any segment of a `/`-joined relative path is skipped
//   listPayload(root)        sorted PayloadEntry[]: { path, type: "file" | "dir" | "symlink", mode, target }
//                            `path` is `/`-joined and relative to the root; directories are
//                            entries too (ray creates them); symlinks are listed as symlinks (not
//                            followed while walking) and carry their `target`.
//   readPayloadBytes(root, entry)   the bytes ray would publish for a file or symlink entry. ray's
//                            copyDir does `lstatSync(...).isDirectory()` then `copyFileSync`, so a
//                            symlink to a file publishes the TARGET's bytes (an external target
//                            included). Anything hashing or scanning the payload (rx scan, the
//                            Wave 3 fingerprint) must read `type: "symlink"` entries through this
//                            helper, never by the link itself. A dangling link, a link to a
//                            directory or an unreadable target throws (ray's copy would fail too).

import { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

/** Names ray publish never copies, at any depth (@raycast/api 1.104.22 and 2.x, copy-dir.js). */
export const PUBLISH_SKIPS = Object.freeze([
  ".git",
  ".github",
  "node_modules",
  "raycast-env.d.ts",
  ".direnv",
  ".raycast-swift-build",
  ".swiftpm",
  "compiled_raycast_swift",
  "compiled_raycast_rust",
]);

const SKIP_SET = new Set(PUBLISH_SKIPS);

/**
 * @typedef {{ path: string, type: "file" | "dir" | "symlink", mode: number, target: string | null }} PayloadEntry
 */

/** @param {string} relPath `/`-joined path relative to the root */
export function isSkipped(relPath) {
  return relPath.split("/").some((seg) => SKIP_SET.has(seg));
}

/**
 * Every entry `ray publish` would copy, sorted by path. Throws the underlying fs error when the
 * root cannot be read; callers turn that into an ERROR.
 * @param {string} root absolute extension root
 * @returns {PayloadEntry[]}
 */
export function listPayload(root) {
  /** @type {PayloadEntry[]} */
  const out = [];
  walk(root, "", out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {PayloadEntry[]} out
 */
function walk(root, rel, out) {
  const dir = rel ? join(root, rel) : root;
  const names = readdirSync(dir).sort();
  for (const name of names) {
    if (SKIP_SET.has(name)) continue;
    const path = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, path));
    if (st.isSymbolicLink()) {
      out.push({ path, type: "symlink", mode: st.mode & 0o7777, target: readlinkSync(join(root, path)) });
    } else if (st.isDirectory()) {
      out.push({ path, type: "dir", mode: st.mode & 0o7777, target: null });
      walk(root, path, out);
    } else {
      out.push({ path, type: "file", mode: st.mode & 0o7777, target: null });
    }
  }
}

/**
 * The bytes `ray publish` copies for a file or symlink entry. Throws for a directory entry, a
 * dangling symlink, a symlink to a directory, or an unreadable target.
 * @param {string} root absolute extension root
 * @param {PayloadEntry} entry
 * @returns {Buffer}
 */
export function readPayloadBytes(root, entry) {
  const abs = join(root, entry.path);
  if (entry.type === "dir") throw new Error(`${entry.path} is a directory`);
  if (entry.type === "symlink") {
    // statSync follows the whole chain; ENOENT here means the link dangles.
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`${entry.path} -> ${entry.target} is not a file`);
  }
  return readFileSync(abs);
}

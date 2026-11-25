// Small value and filesystem helpers shared across commands.

import { statSync } from "node:fs";

/** Is `v` a plain object (not null, not an array)? @param {unknown} v */
export function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Is `p` a directory? A symlink is followed; a missing path or dangling link is false. @param {string} p */
export function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Is `path` the directory `dir` itself or a path under it (both relative, `/`-separated)? @param {string} path @param {string} dir */
export function isUnder(path, dir) {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Git's executable bit for a regular file: the owner execute bit (S_IXUSR, 0o100). Group or other
 * execute bits alone do not make a file 100755 in git.
 * @param {number} mode an lstat/stat mode
 */
export function ownerExecutable(mode) {
  return (mode & 0o100) !== 0;
}

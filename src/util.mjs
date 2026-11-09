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

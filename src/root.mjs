// Root resolution for every command that takes an extension (docs/commands.md §1):
//   --root <dir> wins. Otherwise walk up from cwd to the nearest package.json with a `commands`
//   array; if none, search downward one level; more than one candidate is an ERROR asking for
//   --root; none is an ERROR too. Never a silent guess.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RootError } from "./errors.mjs";

/** @param {string} dir */
export function isExtensionDir(dir) {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return false;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    return pkg !== null && typeof pkg === "object" && Array.isArray(pkg.commands);
  } catch {
    return false;
  }
}

/**
 * @param {{ root?: string | null, cwd?: string }} [opts]
 * @returns {string} absolute path of the extension root
 */
export function resolveRoot({ root = null, cwd = process.cwd() } = {}) {
  if (root) {
    const abs = resolve(cwd, root);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new RootError(`--root ${JSON.stringify(root)} is not a directory`, "bad-root");
    return abs;
  }
  let dir = resolve(cwd);
  for (;;) {
    if (isExtensionDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Directory symlinks are followed (statSync), a dangling one is skipped.
  const isDir = (/** @type {string} */ p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const children = readdirSync(resolve(cwd), { withFileTypes: true })
    .filter((e) => e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => join(resolve(cwd), e.name))
    .filter((p) => isDir(p) && isExtensionDir(p))
    .sort();
  if (children.length === 1) return children[0];
  if (children.length > 1)
    throw new RootError(`more than one extension under ${resolve(cwd)}: ${children.map((c) => c.slice(resolve(cwd).length + 1)).join(", ")}; pass --root <dir>`, "ambiguous");
  throw new RootError(`no extension found from ${resolve(cwd)} (no package.json with a "commands" array here, above, or one level down); pass --root <dir>`, "none");
}

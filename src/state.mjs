// Where commands keep state (docs/commands.md §1):
//   repo state   → `git rev-parse --git-path rx` in the extension's repo (never in the payload,
//                  never in the npm install): receipt.json, audit.json, stale baselines, rounds
//   cross-repo   → $XDG_CACHE_HOME/raycast-harness (default ~/.cache/raycast-harness):
//                  the sparse upstream checkout, the runtime shortcut table

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitPath } from "./git.mjs";

/**
 * Absolute path of a file or directory under the repo's rx state directory; creates the
 * directory (not the leaf) on demand.
 * @param {string} root extension root (any path inside the repo works)
 * @param {...string} segments
 */
export async function repoStatePath(root, ...segments) {
  const base = await gitPath(root, "rx");
  mkdirSync(base, { recursive: true });
  return join(base, ...segments);
}

/**
 * Cross-repo cache directory, created on demand.
 * @param {...string} segments
 */
export function cachePath(...segments) {
  const base = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim()
    ? join(process.env.XDG_CACHE_HOME, "raycast-harness")
    : join(homedir(), ".cache", "raycast-harness");
  mkdirSync(base, { recursive: true });
  return join(base, ...segments);
}

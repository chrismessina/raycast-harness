// Where commands keep state (docs/commands.md §1):
//   repo state   → `git rev-parse --git-path rx` in the extension's repo (never in the payload,
//                  never in the npm install): receipt.json, audit.json, stale baselines, rounds
//   cross-repo   → $XDG_CACHE_HOME/raycast-harness (default ~/.cache/raycast-harness):
//                  the sparse upstream checkout, the runtime shortcut table, the Greptile rules
//                  `rx greptile update` writes (greptile/rules/)

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
 * Like repoStatePath but creates nothing: for commands that only read state (preflight,
 * api-floor) and must not leave a `.git/rx` directory behind.
 * @param {string} root
 * @param {...string} segments
 */
export async function repoStatePathReadOnly(root, ...segments) {
  const base = await gitPath(root, "rx");
  return join(base, ...segments);
}

/**
 * An XDG base directory, read at call time: `$name` when it is set and not blank, else
 * ~/`fallback`.
 * @param {"XDG_CACHE_HOME" | "XDG_CONFIG_HOME"} name
 * @param {string} fallback
 */
export function xdgBase(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v : join(homedir(), fallback);
}

function cacheBase() {
  return join(xdgBase("XDG_CACHE_HOME", ".cache"), "raycast-harness");
}

/**
 * Write `value` as indented JSON with a trailing newline, atomically: the parent directory is
 * created on demand, then a temp file beside `path` is renamed over it.
 * @param {string} path
 * @param {unknown} value
 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Cross-repo cache directory, created on demand.
 * @param {...string} segments
 */
export function cachePath(...segments) {
  const base = cacheBase();
  mkdirSync(base, { recursive: true });
  return join(base, ...segments);
}

/**
 * Like cachePath but creates nothing: for read-only commands that only need to know where the
 * cache would be (is `--published` inside it?) and must not leave an empty cache directory behind.
 * @param {...string} segments
 */
export function cachePathReadOnly(...segments) {
  return join(cacheBase(), ...segments);
}

/**
 * Where `rx greptile update` keeps its copies of Greptile's review rules: `greptile/rules/` under
 * the cross-repo cache, one directory per copy. Creates nothing: the rules lookup only reads, and
 * `update` creates the directory when it writes.
 * @param {...string} segments
 */
export function greptileRulesCachePath(...segments) {
  return cachePathReadOnly("greptile", "rules", ...segments);
}

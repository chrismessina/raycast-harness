// Which paths the .gitignore files an extension ships exclude. Every `.gitignore` in the payload
// (src/payload.mjs: what `ray publish` copies) counts, nested ones included, because the fork-side
// `git add` reads each of them: a pattern is relative to its own file's directory, a deeper file
// takes precedence over a shallower one, and nothing under an excluded directory can be
// re-included. The extension's .git/info/exclude never counts (it is not copied). Git itself
// decides when it is available (check-ignore in a scratch repo holding every shipped .gitignore at
// its path, global excludes off); the pure-JS matcher is the fallback and is tested against git.
//
// Exports
//   gitignoreMatcher(text)            one .gitignore at the root, as a (rel, isDir) => boolean
//   gitignoreTreeMatcher(files)       the whole hierarchy, files = { dir, text }[] (dir "" is the root)
//   shippedGitignores(root)           every .gitignore the payload ships, as { dir, text }[]
//   gitIgnoredSet(files, paths)       which of paths the hierarchy excludes, decided by git; null when git cannot answer
//   ignoredPredicate(root, paths)     shippedGitignores + gitIgnoredSet, falling back to gitignoreTreeMatcher

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../exec.mjs";
import { listPayload, readPayloadBytes } from "../payload.mjs";

/** @typedef {{ dir: string, text: string }} GitignoreFile `dir` is `/`-joined and relative to the root; "" is the root. */

/**
 * One .gitignore pattern as a regex source: "\x" is a literal x, "[...]" a class ("!" or "^"
 * negates), "**\/" any leading directories, "/**" everything inside, "*" and "?" stop at "/".
 * @param {string} s
 */
function globToRegex(s) {
  const lit = (/** @type {string} */ c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) out += lit(s[++i]);
    else if (s.startsWith("**/", i) && (i === 0 || s[i - 1] === "/")) { out += "(?:.*/)?"; i += 2; }
    else if (s.startsWith("/**", i) && i + 3 === s.length) { out += "/.*"; i += 2; }
    else if (s.startsWith("**", i)) { out += ".*"; i += 1; }
    else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      let j = i + 1;
      if (s[j] === "!" || s[j] === "^") j++;
      if (s[j] === "]") j++;
      while (j < s.length && s[j] !== "]") j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) { out += "\\["; continue; }
      let body = s.slice(i + 1, j);
      const negate = body[0] === "!" || body[0] === "^";
      if (negate) body = body.slice(1);
      body = body.replace(/\\(.)|([\\\]^])/g, (_, esc, raw) => `\\${esc ?? raw}`);
      out += `[${negate ? "^/" : ""}${body}]`;
      i = j;
    } else out += lit(c);
  }
  return out;
}

/**
 * One .gitignore compiled the way git reads a single file: patterns in order, the last match
 * wins, "!" re-includes, a trailing "/" matches directories only. Returns true (excluded), false
 * (re-included) or undefined (no pattern matched) for a path relative to the file's directory.
 * @param {string} text
 * @returns {(path: string, isDir: boolean) => boolean | undefined}
 */
function compile(text) {
  /** @type {{ negate: boolean, dirOnly: boolean, anchored: boolean, re: RegExp }[]} */
  const patterns = [];
  for (let line of (text ?? "").split("\n")) {
    line = line.replace(/\r$/, "").replace(/(?<!\\) +$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    const body = line.replace(/\/$/, "");
    const anchored = body.includes("/");
    const glob = globToRegex(body.replace(/^\//, ""));
    try {
      patterns.push({ negate, dirOnly, anchored, re: new RegExp(`^${glob}$`) });
    } catch {
      // A pattern git accepts but this translation cannot express; git itself is used when present.
    }
  }
  return (path, isDir) => {
    /** @type {boolean | undefined} */
    let ignored;
    for (const p of patterns) {
      if (p.dirOnly && !isDir) continue;
      if (p.re.test(p.anchored ? path : /** @type {string} */ (path.split("/").pop()))) ignored = !p.negate;
    }
    return ignored;
  };
}

/**
 * The root .gitignore alone, read the way git does: see gitignoreTreeMatcher.
 * @param {string} text
 * @returns {(rel: string, isDir: boolean) => boolean}
 */
export function gitignoreMatcher(text) {
  return gitignoreTreeMatcher([{ dir: "", text }]);
}

/**
 * A .gitignore hierarchy read the way git does: each path is tested against the files of the
 * directories that contain it, deepest first, each with the path relative to its own directory;
 * the first file with a matching pattern decides (within it the last match wins). A path under a
 * directory the hierarchy excludes is excluded, whatever a deeper file says.
 * @param {GitignoreFile[]} files
 * @returns {(rel: string, isDir: boolean) => boolean}
 */
export function gitignoreTreeMatcher(files) {
  const compiled = files
    .map((f) => ({ dir: f.dir.replace(/^\/+|\/+$/g, ""), test: compile(f.text) }))
    .sort((a, b) => (b.dir ? b.dir.split("/").length : 0) - (a.dir ? a.dir.split("/").length : 0));
  const exact = (/** @type {string} */ path, /** @type {boolean} */ isDir) => {
    for (const f of compiled) {
      if (f.dir && !path.startsWith(`${f.dir}/`)) continue;
      const r = f.test(f.dir ? path.slice(f.dir.length + 1) : path, isDir);
      if (r !== undefined) return r;
    }
    return false;
  };
  return (rel, isDir) => {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) if (exact(parts.slice(0, i).join("/"), true)) return true;
    return exact(rel, isDir);
  };
}

/**
 * Every `.gitignore` the payload ships, read as ray publish copies it (a symlink publishes its
 * target's bytes, which git then reads as a regular file).
 * @param {string} root absolute extension root
 * @returns {GitignoreFile[]}
 */
export function shippedGitignores(root) {
  return listPayload(root)
    .filter((e) => e.type !== "dir" && (e.path === ".gitignore" || e.path.endsWith("/.gitignore")))
    .map((e) => ({ dir: e.path.slice(0, -".gitignore".length).replace(/\/$/, ""), text: readPayloadBytes(root, e).toString("utf8") }));
}

/**
 * Which of `paths` the .gitignore hierarchy excludes, decided by git itself: every file is written
 * at its directory in a scratch repo, so check-ignore applies them as the fork-side `git add`
 * would. Returns null when git cannot answer; callers fall back to gitignoreTreeMatcher.
 * @param {GitignoreFile[]} files
 * @param {string[]} paths
 * @returns {Promise<Set<string> | null>}
 */
export async function gitIgnoredSet(files, paths) {
  if (!paths.length || !files.length) return new Set();
  const scratch = mkdtempSync(join(tmpdir(), "rx-ignore-"));
  try {
    const init = await run("git", ["init", "-q"], { cwd: scratch });
    if (init.code !== 0) return null;
    for (const f of files) {
      mkdirSync(join(scratch, f.dir), { recursive: true });
      writeFileSync(join(scratch, f.dir, ".gitignore"), f.text);
    }
    const r = await run("git", ["-c", "core.excludesFile=", "check-ignore", "--no-index", "--stdin", "-z"], {
      cwd: scratch,
      input: paths.join("\0") + "\0",
    });
    if (r.code !== 0 && r.code !== 1) return null;
    return new Set(r.stdout.split("\0").filter(Boolean));
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Is a path excluded by the .gitignore files the extension at `root` ships? Git decides for
 * `paths` (the ones the caller will ask about); the pure-JS matcher answers when git cannot.
 * @param {string} root absolute extension root
 * @param {string[]} paths
 * @returns {Promise<(rel: string, isDir: boolean) => boolean>}
 */
export async function ignoredPredicate(root, paths) {
  const files = shippedGitignores(root);
  const fromGit = await gitIgnoredSet(files, paths);
  return fromGit ? (rel) => fromGit.has(rel) : gitignoreTreeMatcher(files);
}

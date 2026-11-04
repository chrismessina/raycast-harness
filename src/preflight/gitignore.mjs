// Which paths the extension's own .gitignore excludes. Only that file counts: the fork-side
// `git add` sees the extension's .gitignore, never its .git/info/exclude, and nested .gitignore
// files are not read. Git itself decides when it is available (check-ignore in a scratch repo with
// global excludes off); the pure-JS matcher is the fallback and is tested against git.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../exec.mjs";

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
 * The .gitignore read the way git does for one file: patterns in order, the last match wins,
 * "!" re-includes, a trailing "/" matches directories only, and nothing under an excluded
 * directory can be re-included.
 * @param {string} text
 * @returns {(rel: string, isDir: boolean) => boolean}
 */
export function gitignoreMatcher(text) {
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
  const exact = (/** @type {string} */ path, /** @type {boolean} */ isDir) => {
    let ignored = false;
    for (const p of patterns) {
      if (p.dirOnly && !isDir) continue;
      if (p.re.test(p.anchored ? path : /** @type {string} */ (path.split("/").pop()))) ignored = !p.negate;
    }
    return ignored;
  };
  return (rel, isDir) => {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) if (exact(parts.slice(0, i).join("/"), true)) return true;
    return exact(rel, isDir);
  };
}

/**
 * Which of `paths` the .gitignore excludes, decided by git itself. Returns null when git cannot
 * answer; callers fall back to gitignoreMatcher.
 * @param {string} gitignore
 * @param {string[]} paths
 * @returns {Promise<Set<string> | null>}
 */
export async function gitIgnoredSet(gitignore, paths) {
  if (!paths.length) return new Set();
  const scratch = mkdtempSync(join(tmpdir(), "rx-ignore-"));
  try {
    const init = await run("git", ["init", "-q"], { cwd: scratch });
    if (init.code !== 0) return null;
    writeFileSync(join(scratch, ".gitignore"), gitignore);
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

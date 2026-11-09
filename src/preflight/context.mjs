// Reading an extension for preflight: the manifest, its preferences, the source tree with
// comments stripped, the lockfile, and the applicability context (docs/applicability.md).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { readStaleBaseline } from "../published-copy.mjs";
import { stripComments } from "./lexer.mjs";
import { isObject as isObj } from "../util.mjs";

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
export const WEB_REQUESTS_RE = /\bfetch\s*\(|axios|node-fetch|useFetch|@chrismessina\/raycast-downloader|from "(node:)?https?"|from "(undici|got|ky)"/;
export const WRITES_FILES_RE = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|mkdir|mkdirSync|rename|renameSync)\s*\(/;
export const CALLS_AI_RE = /\bAI\.ask\s*\(|\buseAI\s*\(|canAccess\s*\(\s*AI\b|\bAI\.Model\b/;

/** @param {string} file @returns {string | null} */
export function read(file) {
  try { return readFileSync(file, "utf8"); } catch { return null; }
}

export { isObj };

/**
 * Every source file under src/ (absolute paths), skipping node_modules and dot-directories.
 * @param {string} root
 */
export function sourceFiles(root) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (SOURCE_EXT.has(extname(e.name))) out.push(p);
    }
  };
  walk(join(root, "src"));
  return out.sort();
}

/**
 * @typedef {{ file: string, rel: string, code: string }} Source `code` has comments stripped.
 */

/** @param {string} root @returns {Source[]} */
export function loadSources(root) {
  return sourceFiles(root).map((file) => ({ file, rel: relative(root, file), code: stripComments(read(file) ?? "") }));
}

/**
 * Every match of a regex across the stripped sources, as `{ file, line, text }` details.
 * @param {Source[]} sources @param {RegExp} regex
 */
export function grepSources(sources, regex) {
  /** @type {{ file: string, line: number, text: string }[]} */
  const hits = [];
  for (const s of sources) {
    s.code.split("\n").forEach((line, i) => {
      if (regex.test(line)) hits.push({ file: s.rel, line: i + 1, text: `${s.rel}:${i + 1}` });
      regex.lastIndex = 0;
    });
  }
  return hits;
}

/** @param {any} pkg @returns {{ where: string, p: any }[]} */
export function allPreferences(pkg) {
  const arr = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter(isObj) : []);
  const prefs = arr(pkg.preferences).map((p) => ({ where: "extension", p }));
  for (const c of arr(pkg.commands)) for (const p of arr(c.preferences)) prefs.push({ where: `command ${c.name}`, p });
  return prefs;
}

/** @param {any} pkg @returns {any[]} */
export function commandsOf(pkg) {
  return Array.isArray(pkg.commands) ? pkg.commands.filter(isObj) : [];
}

/**
 * Lockfile-resolved versions. Reads package-lock.json (v2/v3 `packages`, v1 `dependencies`);
 * npm-shrinkwrap.json is read the same way when present (npm prefers it).
 * @param {string} root
 * @returns {{ present: boolean, resolved: (name: string) => string | null }}
 */
export function readLockfile(root) {
  for (const name of ["npm-shrinkwrap.json", "package-lock.json"]) {
    const text = read(join(root, name));
    if (text === null) continue;
    let lock;
    try { lock = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { continue; }
    return {
      present: true,
      resolved: (pkg) => {
        const v3 = lock?.packages?.[`node_modules/${pkg}`]?.version;
        if (typeof v3 === "string") return v3;
        const v1 = lock?.dependencies?.[pkg]?.version;
        return typeof v1 === "string" ? v1 : null;
      },
    };
  }
  return { present: false, resolved: () => null };
}

/**
 * The publication status `rx stale` recorded, or null when unknown.
 * @param {string} root
 * @returns {Promise<boolean | null>}
 */
export async function readPublished(root) {
  try {
    const j = await readStaleBaseline(root);
    return typeof j?.published === "boolean" ? j.published : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ pkg: any, owner: string | null, sources: Source[], lock: ReturnType<typeof readLockfile>, published: boolean | null }} p
 * @returns {import("../preset/applies.mjs").ApplyContext}
 */
export function buildApplyContext({ pkg, owner, sources, lock, published }) {
  const author = typeof pkg.author === "string" ? pkg.author : isObj(pkg.author) && typeof pkg.author.name === "string" ? pkg.author.name : null;
  const code = sources.map((s) => s.code).join("\n");
  return {
    selfAuthored: owner !== null && author !== null && author.toLowerCase() === owner.toLowerCase(),
    platforms: Array.isArray(pkg.platforms) ? pkg.platforms.filter((/** @type {unknown} */ p) => typeof p === "string") : ["macOS"],
    published,
    webRequests: WEB_REQUESTS_RE.test(code),
    preferences: allPreferences(pkg).map(({ p }) => p.name).filter((n) => typeof n === "string"),
    resolved: lock.resolved,
    commandModes: commandsOf(pkg).map((c) => c.mode).filter((m) => typeof m === "string"),
    declaresInterval: commandsOf(pkg).some((c) => c.interval !== undefined),
    writesFiles: WRITES_FILES_RE.test(code),
    callsAI: CALLS_AI_RE.test(code),
  };
}

/** PNG header dimensions from IHDR, or null when the file is not a PNG. @param {string} file */
export function pngSize(file) {
  let buf;
  try { buf = readFileSync(file); } catch { return null; }
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Every file under rel (rel itself when it is a file), relative to root; [] when absent. @param {string} root @param {string} rel */
export function filesUnder(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((name) => filesUnder(root, `${rel}/${name}`));
}

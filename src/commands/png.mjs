// `rx png [--published <dir>] [--root <dir>] [--json]` (docs/commands.md §4.3): screenshot and
// icon triage against the published copy. Read-only: it recommends, never modifies a file.
//
// One result per PNG, id `png`, outcome in details[0].text and data.files[].outcome:
//   SAME-PIXELS  equal size, RGBA and color metadata     PASS  adopt the published copy (it is what ships)
//   16-BIT       local bit depth > 8, with or without a published copy
//                                                          FAIL  convert to 8-bit (the message gives the magick command)
//   UNDECIDED    published copy 16-bit, or metadata differs WARN  compare by eye, then record an audit disposition
//                                                                (path, local hash, baseline = sha256 of the published bytes)
//   LOCAL-ONLY   no published copy, or no --published      N/A   keep local
//   OLDER-SHOT   differs; published equals a commit in this path's history
//                                                          WARN  needs an audit disposition (path, local hash, baseline SHA)
//   NOT-YOURS    differs; published matches nothing in this path's history
//                                                          FAIL  needs a human: keeping local reverts someone's shot
// Decode or chunk failure → ERROR png. No `sips` pass anywhere (X7): sips preserves channel
// count, so it cannot tell a lossless RGBA→RGB re-encode from a new screenshot.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PngError, comparePng, decodeRgba, readPngInfo } from "../png.mjs";
import { git, isWorkTree } from "../git.mjs";
import { withPublishedCopy } from "../published-copy.mjs";

/** Single-quotes a path for a shell command the user copies. @param {string} p */
const shq = (p) => `'${p.replace(/'/g, `'\\''`)}'`;

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "png",
  summary: "triage screenshots and icons against the published copy: SAME-PIXELS, 16-BIT, UNDECIDED, LOCAL-ONLY, OLDER-SHOT, NOT-YOURS (read-only; UNDECIDED and OLDER-SHOT need an audit disposition)",
  root: "required",
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root" },
    "--published": { type: "string", value: "<dir>", help: "the extension as published in raycast/extensions (same layout); without it every 8-bit file is LOCAL-ONLY" },
  },
  network: "none (reads git history locally)",
  state: "none (read-only; recommends, never modifies a file). A --published dir inside the upstream cache is read under the cache's reader lock (ERROR github after the wait if another rx holds it)",
  checks: {
    png: "one result per PNG under metadata/ or named as an icon in package.json; outcome in details[0]",
  },
  data: {
    published: "boolean — whether --published was given",
    files: "[{ path, outcome, local: { width, height, bitDepth, colorType, gAMA, iCCP, sRGB, cHRM } | null, published: {…} | null, provenance: string | null (commit whose blob the published bytes match, OLDER-SHOT only), localHash: \"sha256:…\" | null (null only when the local file is unreadable), baseline: string | null (OLDER-SHOT: same commit as provenance; UNDECIDED: \"sha256:…\" of the published bytes) }]",
  },
  examples: ["rx png --published ~/.cache/raycast-harness/upstream/extensions/my-ext", "rx png --root ./my-ext --json"],
};

/**
 * Every PNG this command inspects: `.png` files under metadata/ (recursively) and the icon(s)
 * package.json names (top-level `icon`, each command's and tool's `icon`), resolved under assets/.
 * Sorted, deduplicated, extension-relative with `/`.
 * @param {string} root
 */
export function pngTargets(root) {
  /** @type {Set<string>} */
  const out = new Set();
  const meta = join(root, "metadata");
  if (existsSync(meta) && statSync(meta).isDirectory()) {
    const walk = (/** @type {string} */ rel) => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".png")) out.add(p);
      }
    };
    walk("metadata");
  }
  /** @type {any} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    pkg = null;
  }
  const icons = [pkg?.icon, ...(Array.isArray(pkg?.commands) ? pkg.commands.map((/** @type {any} */ c) => c?.icon) : []), ...(Array.isArray(pkg?.tools) ? pkg.tools.map((/** @type {any} */ t) => t?.icon) : [])];
  for (const icon of icons) {
    if (typeof icon !== "string" || !icon.toLowerCase().endsWith(".png")) continue;
    const rel = icon.startsWith("assets/") ? icon : `assets/${icon}`;
    if (existsSync(join(root, rel)) && statSync(join(root, rel)).isFile()) out.add(rel);
  }
  return [...out].sort();
}

/**
 * The blob of `path` at `commit`, fetched binary-safe through `git archive` into a temp tar
 * (exec.mjs decodes stdout as UTF-8, which would corrupt image bytes).
 * @param {string} cwd @param {string} commit @param {string} path
 * @returns {Promise<Buffer | null>} null when the path is absent from that commit
 */
export async function blobAt(cwd, commit, path) {
  const dir = mkdtempSync(join(tmpdir(), "rx-png-"));
  try {
    const tar = join(dir, "blob.tar");
    const r = await git(["archive", "--format=tar", "-o", tar, commit, "--", path], { cwd, allowFail: true });
    if (r.code !== 0) return null;
    return extractFirstFile(readFileSync(tar));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * First regular file in a ustar/pax archive (git archive writes a pax global header, then
 * directory entries, then the file).
 * @param {Buffer} tar
 */
export function extractFirstFile(tar) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const sizeField = header.toString("latin1", 124, 136).replace(/\0.*$/s, "").trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    if (Number.isNaN(size)) return null;
    const type = String.fromCharCode(header[156]);
    const dataStart = off + 512;
    if (type === "0" || type === "\0") {
      if (dataStart + size > tar.length) return null;
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** @param {Buffer} b */
const sha256 = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/**
 * One data.files[] row; every field present on every row. `baseline` defaults to the provenance
 * commit (OLDER-SHOT); UNDECIDED passes the published bytes' sha256 instead.
 * @param {{ path: string, outcome: string, local?: import("../png.mjs").PngInfo | null, published?: import("../png.mjs").PngInfo | null, provenance?: string | null, localHash?: string | null, baseline?: string | null }} r
 */
const row = (r) => ({ path: r.path, outcome: r.outcome, local: r.local ?? null, published: r.published ?? null, provenance: r.provenance ?? null, localHash: r.localHash ?? null, baseline: r.baseline ?? r.provenance ?? null });

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, root, results, log }) {
  const rootDir = /** @type {string} */ (root);
  const published = typeof args.flags["--published"] === "string" ? args.flags["--published"] : null;
  if (published && !(existsSync(published) && statSync(published).isDirectory())) {
    results.error("png", `--published ${JSON.stringify(published)} is not a directory`);
    return { data: { published: true, files: [] } };
  }
  const targets = pngTargets(rootDir);
  /** @type {Record<string, unknown>[]} */
  const files = [];
  if (!targets.length) {
    results.na("png", "no PNG under metadata/ and no PNG icon named in package.json; nothing to triage");
    return { data: { published: published !== null, files } };
  }
  /** @type {boolean | null} */
  let inGit = null;

  // Every read of the published copy happens inside the published-copy service: a dir inside the
  // shared upstream cache is read under its lock so a concurrent `rx stale` for another extension
  // cannot swap the tree between two of this run's reads; any other dir is read as given.
  const compareAll = async (/** @type {import("../published-copy.mjs").PublishedCopy | null} */ copy) => {
  for (const path of targets) {
    const localPath = join(rootDir, path);
    /** @type {Buffer} */
    let localBuf;
    /** @type {import("../png.mjs").PngInfo} */
    let local;
    /** @type {string | null} */
    let localHash = null;
    try {
      localBuf = readFileSync(localPath);
      localHash = sha256(localBuf);
      local = readPngInfo(localBuf);
      decodeRgba(localBuf); // a damaged IDAT is an error before any outcome, LOCAL-ONLY included
    } catch (e) {
      results.error("png", `${path}: ${e instanceof PngError ? e.message : `unreadable: ${/** @type {Error} */ (e).message}`}`, [{ file: path, text: "ERROR" }]);
      files.push(row({ path, outcome: "ERROR", localHash }));
      continue;
    }
    // 16-bit before anything else: decoding to 8 bits merges distinct values, so no comparison
    // could vouch for it, and with no published copy it would otherwise pass as LOCAL-ONLY.
    // Read-only, so recommend the conversion instead of making it (sips keeps 16 bits).
    if (local.bitDepth > 8) {
      results.fail("png", `${path}: 16-bit; convert it to 8-bit, then run gates again: magick ${shq(localPath)} -depth 8 ${shq(localPath)} (ImageMagick: brew install imagemagick)`, [{ file: path, text: "16-BIT convert to 8-bit" }]);
      files.push(row({ path, outcome: "16-BIT", local, localHash }));
      continue;
    }
    const pubPath = copy && published ? copy.path(path) : null;
    if (!pubPath || !existsSync(pubPath) || !statSync(pubPath).isFile()) {
      results.na("png", `${path}: LOCAL-ONLY, keep local (${published ? "no published copy of this path" : "no --published given"})`, [{ file: path, text: "LOCAL-ONLY keep local" }]);
      files.push(row({ path, outcome: "LOCAL-ONLY", local, localHash }));
      continue;
    }
    /** @type {Buffer} */
    let pubBuf;
    /** @type {import("../png.mjs").Comparison} */
    let cmp;
    try {
      pubBuf = readFileSync(pubPath);
      cmp = comparePng(pubBuf, localBuf);
    } catch (e) {
      results.error("png", `${path}: published copy ${e instanceof PngError ? e.message : `unreadable: ${/** @type {Error} */ (e).message}`}`, [{ file: path, text: "ERROR" }]);
      files.push(row({ path, outcome: "ERROR", local, localHash }));
      continue;
    }
    const pub = cmp.a;
    if (cmp.outcome === "SAME-PIXELS") {
      results.pass("png", `${path}: SAME-PIXELS; adopt the published copy (${cmp.reason})`, [{ file: path, text: "SAME-PIXELS adopt the published copy" }]);
      files.push(row({ path, outcome: "SAME-PIXELS", local, published: pub, localHash }));
      continue;
    }
    if (cmp.outcome === "UNDECIDED") {
      // A human compares the two by eye; the disposition pins the exact published bytes they saw.
      // comparePng's reason already ends "; compare by eye"; the message says it once, with the next step.
      const pubHash = sha256(pubBuf);
      const reason = cmp.reason.replace(/; compare by eye$/, "");
      results.warn("png", `${path}: UNDECIDED; ${reason}; compare by eye, then record an audit disposition`, [
        { file: path, text: `UNDECIDED ${reason}` },
        { file: path, text: `disposition needs: path=${path} localHash=${localHash} baseline=${pubHash}` },
      ]);
      files.push(row({ path, outcome: "UNDECIDED", local, published: pub, localHash, baseline: pubHash }));
      continue;
    }

    // DIFFERENT: provenance through this path's history. The published copy is either an older
    // shot of ours (OLDER-SHOT) or someone else's (NOT-YOURS); history can only narrow it down.
    if (inGit === null) inGit = await isWorkTree(rootDir);
    if (!inGit) {
      results.error("png", `${path}: pixels differ (${cmp.reason}) and ${rootDir} is not a git work tree, so provenance cannot run`, [{ file: path, text: "ERROR no git history" }]);
      files.push(row({ path, outcome: "ERROR", local, published: pub, localHash }));
      continue;
    }
    const logOut = await git(["--literal-pathspecs", "log", "--full-history", "--diff-filter=d", "--format=%H", "HEAD", "--", path], { cwd: rootDir, allowFail: true });
    if (logOut.code !== 0) {
      results.error("png", `${path}: git log failed: ${logOut.stderr.trim().split("\n")[0] ?? ""}`, [{ file: path, text: "ERROR git log" }]);
      files.push(row({ path, outcome: "ERROR", local, published: pub, localHash }));
      continue;
    }
    const commits = logOut.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    /** @type {string | null} */
    let baseline = null;
    for (const c of commits) {
      log(`png: ${path}: comparing published copy with ${c.slice(0, 7)}\n`);
      const blob = await blobAt(rootDir, c, path);
      if (!blob) continue;
      try {
        if (comparePng(pubBuf, blob).outcome === "SAME-PIXELS") {
          baseline = c;
          break;
        }
      } catch {
        // an unreadable historical version is simply not the baseline
      }
    }
    if (baseline) {
      results.warn(
        "png",
        `${path}: OLDER-SHOT; published equals this path at ${baseline.slice(0, 7)}; record an audit disposition before keeping local`,
        [
          { file: path, text: `OLDER-SHOT baseline ${baseline}` },
          { file: path, text: `disposition needs: path=${path} localHash=${localHash} baseline=${baseline}; historical membership alone never authorizes keeping local` },
        ],
      );
      files.push(row({ path, outcome: "OLDER-SHOT", local, published: pub, provenance: baseline, localHash }));
    } else {
      results.fail("png", `${path}: NOT-YOURS; published matches no version in this path's history (${commits.length} commits checked); look at both and ask before keeping local`, [
        { file: path, text: "NOT-YOURS published copy is not in this path's history" },
        { file: path, text: `localHash=${localHash}` },
      ]);
      files.push(row({ path, outcome: "NOT-YOURS", local, published: pub, localHash }));
    }
  }
  };
  if (published !== null) await withPublishedCopy({ directory: published }, compareAll);
  else await compareAll(null);
  return { data: { published: published !== null, files } };
}

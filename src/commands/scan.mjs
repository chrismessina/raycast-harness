// `rx scan --forbidden <file> [--pr-text <file>]... [--root <dir>] [--json]` (docs/commands.md
// §4.4): gate −2. Does any forbidden example value (a reproduction URL, handle, post ID, a path
// with a name in it) leak into what is about to go public?
//
// Scans, by literal substring match of every line in the forbidden file:
//   scan-files     contents of every text file in the payload (what `ray publish` copies: the
//                  root minus PUBLISH_SKIPS, ignored and untracked files included; a file symlink
//                  is read through to its target's bytes, as ray's copyFileSync publishes them;
//                  an unreadable or dangling target is ERROR scan-files)
//   scan-names     every payload path (files, directories, symlinks)
//   scan-commits   full commit messages in the range ray logs: `HEAD...<publish tag>` when the tag
//                  `__raycast_latest_publish_ext/<name>__` exists, else all history
//   scan-pr-text   each --pr-text file (N/A when none given)
//   scan-binary    WARN listing binary payload files (a NUL byte in the first 8 KiB) for a human
//                  look; PASS when there are none
// An empty forbidden list means every example was approved: every check is N/A, never PASS.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePublishTag } from "../publish-tag.mjs";
import { RxError } from "../errors.mjs";
import { git, isWorkTree } from "../git.mjs";
import { listPayload, readPayloadBytes } from "../payload.mjs";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "scan",
  summary: "gate −2: find forbidden example values in the payload, its file names, the commits ray publishes and PR text",
  root: "required",
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root" },
    "--forbidden": { type: "string", value: "<file>", required: true, help: "text file, one literal per line; blank lines and # comments ignored; keep it outside the extension root" },
    "--pr-text": { type: "string", value: "<file>", repeat: true, help: "a PR body, comment or reply file to scan before sending" },
  },
  network: "none (reads git history locally)",
  state: "none",
  checks: {
    "scan-files": "no forbidden literal in any text file ray publish copies (symlinks read through; unreadable target → ERROR)",
    "scan-names": "no forbidden literal in any payload path",
    "scan-commits": "no forbidden literal in the commit messages ray publishes (HEAD...<publish tag>, else all history)",
    "scan-pr-text": "no forbidden literal in any --pr-text file (N/A when none given)",
    "scan-binary": { description: "WARN listing binary payload files that need a human look; PASS when none", levels: ["PASS", "WARN", "N/A"] },
  },
  data: {
    forbiddenHash: "\"sha256:<hex>\" of the forbidden file's bytes",
    forbiddenCount: "number of literals after dropping blank lines and comments",
    range: "the git log range scanned (\"HEAD...<tag>\" or \"HEAD\" for all history), or null when not a git work tree",
    hits: "total number of hit details across the four scans",
    binaries: "string[] — payload files skipped as binary",
  },
  examples: ["rx scan --forbidden ../forbidden.txt --pr-text ../pr-body.md"],
};

/** Publish tag ray reads (@raycast/api dist/utils/publish/git.js). @param {string} name */

/** @param {string} text */
export function parseForbidden(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** grep -I's heuristic: a NUL byte in the first 8 KiB. @param {Buffer} buf */
export function isBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

/**
 * Every (line, literal) hit in `text`. Lines are 1-based.
 * @param {string} text @param {string[]} literals
 * @returns {{ line: number, text: string }[]}
 */
export function hitsIn(text, literals) {
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) for (const lit of literals) if (lines[i].includes(lit)) out.push({ line: i + 1, text: lit });
  return out;
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, root, cwd, results }) {
  const rootDir = /** @type {string} */ (root);
  const forbiddenPath = resolve(cwd, /** @type {string} */ (args.flags["--forbidden"]));
  /** @type {Buffer} */
  let forbiddenBuf;
  try {
    forbiddenBuf = readFileSync(forbiddenPath);
  } catch (e) {
    throw new RxError(`--forbidden ${forbiddenPath}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  const literals = parseForbidden(forbiddenBuf.toString("utf8"));
  const forbiddenHash = `sha256:${createHash("sha256").update(forbiddenBuf).digest("hex")}`;
  const prTextFlag = args.flags["--pr-text"];
  const prTexts = Array.isArray(prTextFlag) ? prTextFlag.map((p) => resolve(cwd, p)) : [];
  // Every input is read before any verdict, so a missing --pr-text file is an ERROR, not a gap.
  const prTextContents = prTexts.map((p) => {
    try {
      return { path: p, text: readFileSync(p, "utf8") };
    } catch (e) {
      throw new RxError(`--pr-text ${p}: ${/** @type {Error} */ (e).message}`, { id: "input" });
    }
  });

  /** @type {string[]} */
  const binaries = [];
  /** @type {import("../payload.mjs").PayloadEntry[]} */
  let payload;
  try {
    payload = listPayload(rootDir);
  } catch (e) {
    throw new RxError(`cannot list the payload under ${rootDir}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  /** @type {Map<string, string>} path → text, for text files only */
  const texts = new Map();
  /** @type {import("../verdict.mjs").Detail[]} payload entries ray would publish but rx cannot read */
  const unreadable = [];
  for (const e of payload) {
    if (e.type === "dir") continue;
    /** @type {Buffer} */
    let buf;
    try {
      buf = readPayloadBytes(rootDir, e);
    } catch (err) {
      unreadable.push({ file: e.path, text: `${e.type === "symlink" ? `symlink to ${e.target}: ` : ""}${/** @type {Error} */ (err).message}` });
      continue;
    }
    if (isBinary(buf)) binaries.push(e.path);
    else texts.set(e.path, buf.toString("utf8"));
  }

  /** @type {string | null} */
  let range = null;
  /** @type {{ sha: string, body: string }[] | null} */
  let commits = null;
  /** @type {string | null} */
  let commitError = null;
  if (await isWorkTree(rootDir)) {
    /** @type {string | null} */
    let name;
    try {
      name = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).name ?? null;
    } catch {
      name = null;
    }
    range = "HEAD";
    if (typeof name === "string" && name) {
      const tag = await resolvePublishTag(rootDir, name);
      if (tag) range = `HEAD...${tag.tag}`;
    }
    const sep = "\u001e";
    const logOut = await git(["log", `--format=%H%n%B${sep}`, range], { cwd: rootDir, allowFail: true });
    if (logOut.code !== 0) commitError = logOut.stderr.trim().split("\n")[0] || `git log exit ${logOut.code}`;
    else
      commits = logOut.stdout
        .split(sep)
        .map((rec) => rec.replace(/^\n/, ""))
        .filter((rec) => rec.trim())
        .map((rec) => {
          const nl = rec.indexOf("\n");
          return nl === -1 ? { sha: rec.trim(), body: "" } : { sha: rec.slice(0, nl).trim(), body: rec.slice(nl + 1) };
        });
  }

  const data = { forbiddenHash, forbiddenCount: literals.length, range, hits: 0, binaries };

  if (!literals.length) {
    const why = "every example approved (forbidden list is empty)";
    for (const id of ["scan-files", "scan-names", "scan-commits", "scan-pr-text", "scan-binary"]) results.na(id, why);
    return { data };
  }

  // scan-files
  /** @type {import("../verdict.mjs").Detail[]} */
  const fileHits = [];
  for (const [path, text] of texts) for (const h of hitsIn(text, literals)) fileHits.push({ file: path, line: h.line, text: h.text });
  if (unreadable.length) results.error("scan-files", `${unreadable.length} payload file(s) ray would copy could not be read; ${fileHits.length} hit(s) in the rest`, [...unreadable, ...fileHits]);
  else if (fileHits.length) results.fail("scan-files", `${fileHits.length} forbidden value(s) in payload file contents`, fileHits);
  else results.pass("scan-files", `${texts.size} text file(s) clean`);

  // scan-names
  /** @type {import("../verdict.mjs").Detail[]} */
  const nameHits = [];
  for (const e of payload) for (const lit of literals) if (e.path.includes(lit)) nameHits.push({ file: e.path, text: lit });
  if (nameHits.length) results.fail("scan-names", `${nameHits.length} forbidden value(s) in payload path names`, nameHits);
  else results.pass("scan-names", `${payload.length} payload path(s) clean`);

  // scan-commits
  /** @type {import("../verdict.mjs").Detail[]} */
  const commitHits = [];
  if (!range) results.error("scan-commits", `${rootDir} is not a git work tree; the commit messages ray publishes cannot be scanned`);
  else if (commitError !== null || !commits) results.error("scan-commits", `git log ${range} failed: ${commitError}`);
  else {
    for (const c of commits) for (const h of hitsIn(c.body, literals)) commitHits.push({ file: `commit:${c.sha.slice(0, 7)}`, line: h.line, text: h.text });
    if (commitHits.length) results.fail("scan-commits", `${commitHits.length} forbidden value(s) in commit messages (${range})`, commitHits);
    else results.pass("scan-commits", `${commits.length} commit message(s) clean (${range})`);
  }

  // scan-pr-text
  /** @type {import("../verdict.mjs").Detail[]} */
  const prHits = [];
  if (!prTextContents.length) results.na("scan-pr-text", "no --pr-text given");
  else {
    for (const { path, text } of prTextContents) for (const h of hitsIn(text, literals)) prHits.push({ file: path, line: h.line, text: h.text });
    if (prHits.length) results.fail("scan-pr-text", `${prHits.length} forbidden value(s) in PR text`, prHits);
    else results.pass("scan-pr-text", `${prTextContents.length} PR text file(s) clean`);
  }

  // scan-binary
  if (binaries.length) results.warn("scan-binary", `${binaries.length} binary file(s) not scanned; look at each for a forbidden value`, binaries.map((b) => ({ file: b, text: "binary, not scanned" })));
  else results.pass("scan-binary", "no binary files in the payload");

  data.hits = fileHits.length + nameHits.length + commitHits.length + prHits.length;
  return { data };
}

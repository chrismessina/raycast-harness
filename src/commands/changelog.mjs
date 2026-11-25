// `rx changelog [--root d] [--published d] [--redactions f] [--merge] [--json]` (docs/commands.md
// §4.5). Placeholder count and position, dated history versus the published copy (except recorded
// privacy redactions, F5), bullet length, and the merge-time rebuild from HEAD and MERGE_HEAD by
// heading structure (Q6: a stamped heading on one side and the placeholder on the other name the
// same entry; any other boundary is an ERROR and nothing is written).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEHOLDER, bodyHash, parseChangelog, placeholderProblems, sameEntry } from "../changelog/parse.mjs";
import { RxError } from "../errors.mjs";
import { git } from "../git.mjs";
import { NOTHING_TO_SHIP, nothingToShip } from "../payload-identity.mjs";
import { withPublishedCopy } from "../published-copy.mjs";

export const BULLET_MAX = 280;

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "changelog",
  summary: "check CHANGELOG.md: one placeholder on top, history unchanged against the published copy, bullets ≤ 280; --merge rebuilds it during a merge",
  root: "required",
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root" },
    "--published": { type: "string", value: "<dir>", help: "the published copy (from `rx stale`); enables changelog-history" },
    "--redactions": { type: "string", value: "<file>", help: "JSON [{ heading, originalHash, replacementHash, forbiddenLine }] authorizing privacy edits to dated entries" },
    "--merge": { type: "boolean", help: "during a merge: rebuild CHANGELOG.md from HEAD and MERGE_HEAD by heading structure, then check the result" },
  },
  network: "none",
  state: "--merge reads MERGE_HEAD and writes CHANGELOG.md in the root; otherwise read-only",
  checks: {
    "changelog-placeholder": `exactly one ${PLACEHOLDER}, in the top entry`,
    "changelog-history": "dated entries byte-equal to the published copy except recorded redactions; N/A without --published",
    "changelog-bullets": { description: `each bullet ≤ ${BULLET_MAX} characters (advisory: WARN at most)`, levels: ["PASS", "WARN", "N/A"] },
    "changelog-merge": { description: "with --merge: rebuilt from HEAD and MERGE_HEAD (PASS) or ambiguous boundary (ERROR, nothing written)", levels: ["PASS", "ERROR"] },
  },
  data: {
    placeholders: "number — occurrences in the (rebuilt) file",
    topHeading: "string | null",
    entries: "[{ heading, date, bullets, changed, redacted }] — changed/redacted are against --published",
    merged: "boolean — true when --merge rewrote CHANGELOG.md",
  },
};

/** @typedef {{ heading: string, originalHash: string, replacementHash: string, forbiddenLine: string }} Redaction */

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ results, root, args }) {
  const dir = /** @type {string} */ (root);
  const file = join(dir, "CHANGELOG.md");
  const publishedDir = typeof args.flags["--published"] === "string" ? args.flags["--published"] : null;
  const redactions = typeof args.flags["--redactions"] === "string" ? loadRedactions(args.flags["--redactions"]) : [];

  // Every input is read and validated before anything is written: the published copy, the
  // redactions (above), and with --merge both sides of the merge.
  const { text: published, identical } = await readPublished(dir, publishedDir);

  let merged = false;
  /** @type {string} */
  let text;
  if (args.flags["--merge"] === true) {
    const built = await rebuild(dir);
    if ("error" in built) {
      results.error("changelog-merge", built.error, built.details);
      return { data: { placeholders: null, topHeading: null, entries: [], merged: false } };
    }
    writeFileSync(file, built.text);
    merged = true;
    text = built.text;
    results.pass("changelog-merge", `rebuilt CHANGELOG.md: ${built.fromHead} ${built.fromHead === 1 ? "entry" : "entries"} from HEAD, ${built.fromTheirs} from MERGE_HEAD`);
  } else {
    text = readText(file);
  }

  const log = parseChangelog(text);

  // Placeholder: the shared predicate (src/changelog/parse.mjs), also used by rx preflight.
  const ph = placeholderProblems(text);
  // The identity was read with the published history, in one hold of the copy. A --merge run has
  // rewritten CHANGELOG.md since, so that identity no longer describes this payload.
  if (identical && !merged) results.na("changelog-placeholder", NOTHING_TO_SHIP);
  else if (ph.problems.length) results.fail("changelog-placeholder", ph.problems[0], ph.conflictMarkers ? [] : placeholderLines(text));
  else results.pass("changelog-placeholder", `one ${PLACEHOLDER}, in ${log.entries[0].heading}`);

  // History versus the published copy. Pairing is by occurrence: a heading the published copy
  // repeats (brew has two `## [Improvements] - 2024-06-14` with different bodies) pairs its n-th
  // published occurrence with the n-th local one, so `status` is keyed by the local entry itself.
  /** @type {Map<import("../changelog/parse.mjs").Entry, { changed: boolean, redacted: boolean }>} */
  const status = new Map();
  /** @type {Set<import("../changelog/parse.mjs").Entry>} */
  const paired = new Set();
  /** @type {Set<Redaction>} */
  const usedRedactions = new Set();
  if (!publishedDir) results.na("changelog-history", "no published copy given; pass --published <dir> (rx stale prints it) to compare dated history");
  else if (published === null) results.na("changelog-history", `published copy has no CHANGELOG.md (${join(publishedDir, "CHANGELOG.md")})`);
  else {
    const pub = parseChangelog(published);
    /** @type {import("../verdict.mjs").Detail[]} */
    const problems = [];
    let redactedCount = 0;
    for (const pe of pub.entries) {
      const matches = log.entries.filter((le) => le.title === pe.title && !paired.has(le));
      const le = matches.find((m) => m.date === pe.date) ?? matches.find((m) => sameEntry(m, pe));
      if (!le) { problems.push({ file: "CHANGELOG.md", text: `published entry missing locally: ${pe.heading}` }); continue; }
      paired.add(le);
      if (le.heading !== pe.heading) {
        problems.push({ file: "CHANGELOG.md", line: le.line, text: `heading differs from published: ${le.heading} (published: ${pe.heading})${le.date === PLACEHOLDER && pe.date !== PLACEHOLDER ? "; stamp the merged date" : ""}` });
        continue;
      }
      if (le.rawHeading !== pe.rawHeading) {
        problems.push({ file: "CHANGELOG.md", line: le.line, text: `heading differs from published byte for byte (whitespace or line ending): ${JSON.stringify(le.rawHeading)} (published: ${JSON.stringify(pe.rawHeading)})` });
        continue;
      }
      if (le.body === pe.body) { status.set(le, { changed: false, redacted: false }); continue; }
      const oh = bodyHash(pe.body);
      const rh = bodyHash(le.body);
      // Each record authorizes exactly one changed body: a used record is consumed, so two identical
      // occurrences changed alike need two records (CDUP-1).
      const auth = redactions.find((r) => !usedRedactions.has(r) && r.heading === le.heading && r.originalHash === oh && r.replacementHash === rh);
      if (auth) { usedRedactions.add(auth); redactedCount++; status.set(le, { changed: true, redacted: true }); continue; }
      status.set(le, { changed: true, redacted: false });
      problems.push({ file: "CHANGELOG.md", line: le.line, text: `body differs from published and no redaction authorizes it (published ${oh.slice(0, 19)}, local ${rh.slice(0, 19)}): ${le.heading}` });
    }
    if (problems.length) results.fail("changelog-history", `${problems.length} dated ${problems.length === 1 ? "entry differs" : "entries differ"} from the published copy`, problems);
    else results.pass("changelog-history", `${pub.entries.length} published entries unchanged${redactedCount ? ` (${redactedCount} recorded ${redactedCount === 1 ? "redaction" : "redactions"})` : ""}`);
  }

  // Bullets (line numbers from the raw text, not the normalized bodies).
  const long = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*[-*]\s+/.test(l) && l.length > BULLET_MAX) long.push({ file: "CHANGELOG.md", line: i + 1, text: `${l.length} chars: ${l.slice(0, 60)}…` });
  });
  if (long.length) results.warn("changelog-bullets", `${long.length} ${long.length === 1 ? "bullet exceeds" : "bullets exceed"} ${BULLET_MAX} characters`, long);
  else results.pass("changelog-bullets", `${log.entries.reduce((n, e) => n + e.bullets.length, 0)} bullets, all ≤ ${BULLET_MAX} characters`);

  return {
    data: {
      placeholders: log.placeholders,
      topHeading: log.entries[0]?.heading ?? null,
      entries: log.entries.map((e) => ({ heading: e.heading, date: e.date, bullets: e.bullets.length, changed: status.get(e)?.changed ?? false, redacted: status.get(e)?.redacted ?? false })),
      merged,
    },
  };
}

/** Read a UTF-8 text file or throw `ERROR input`. @param {string} file */
function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw new RxError(`cannot read ${file}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
}

/**
 * The published CHANGELOG.md (`text`: null when there is no --published or the copy has none, N/A
 * later; `ERROR input` when it exists but cannot be read) and whether the payload is identical to
 * the copy (`identical`, nothingToShip). Both are read in one call of the published-copy service,
 * so a copy inside the shared upstream cache is read under one hold of its lock and both reads see
 * the same cache state.
 * @param {string} root @param {string | null} publishedDir
 * @returns {Promise<{ text: string | null, identical: boolean }>}
 */
async function readPublished(root, publishedDir) {
  if (!publishedDir) return { text: null, identical: false };
  return withPublishedCopy({ directory: publishedDir }, async (copy) => ({
    text: copy.exists("CHANGELOG.md") ? readText(copy.path("CHANGELOG.md")) : null,
    identical: copy.directory !== null && nothingToShip(root, copy.directory),
  }));
}

/** @param {string} text */
function placeholderLines(text) {
  return text.split(/\r?\n/).flatMap((l, i) => (l.includes(PLACEHOLDER) ? [{ file: "CHANGELOG.md", line: i + 1, text: l.trim() }] : []));
}

/** @param {string} path @returns {Redaction[]} */
function loadRedactions(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RxError(`--redactions ${path}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  if (!Array.isArray(parsed)) throw new RxError(`--redactions ${path}: expected a JSON array`, { id: "input" });
  return parsed.map((r, i) => {
    for (const k of ["heading", "originalHash", "replacementHash", "forbiddenLine"])
      if (typeof r?.[k] !== "string" || !r[k].trim()) throw new RxError(`--redactions ${path}: entry ${i} needs a non-empty string ${k}`, { id: "input" });
    return { heading: r.heading.trim(), originalHash: r.originalHash, replacementHash: r.replacementHash, forbiddenLine: r.forbiddenLine };
  });
}

/**
 * Rebuild CHANGELOG.md from the two known-good sources of a merge in progress. Ours contributes
 * everything above the first heading of theirs; theirs contributes from that heading down. The
 * boundary is the ours entry that `sameEntry` matches to theirs' first entry (stamped vs
 * placeholder count as the same entry). No match, or more than one → error, nothing written.
 * Exported for tests.
 * @param {string} dir extension root (CHANGELOG.md is read as `HEAD:./CHANGELOG.md`, so a monorepo subdirectory works)
 * @returns {Promise<{ text: string, fromHead: number, fromTheirs: number } | { error: string, details: import("../verdict.mjs").Detail[] }>}
 */
export async function rebuild(dir) {
  const mh = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir, allowFail: true });
  if (mh.code !== 0) throw new RxError("--merge needs a merge in progress (no MERGE_HEAD)", { id: "changelog-merge" });
  const show = async (/** @type {string} */ ref) => {
    const r = await git(["show", `${ref}:./CHANGELOG.md`], { cwd: dir, allowFail: true });
    if (r.code !== 0) throw new RxError(`${ref}:CHANGELOG.md is missing: ${r.stderr.trim().split("\n")[0] ?? ""}`, { id: "changelog-merge" });
    return r.stdout.replace(/\n$/, "") + "\n"; // git() strips one trailing newline; restore exactly one
  };
  const oursText = await show("HEAD");
  const theirsText = await show("MERGE_HEAD");
  const ours = parseChangelog(oursText);
  const theirs = parseChangelog(theirsText);
  if (!theirs.entries.length) return { error: "MERGE_HEAD:CHANGELOG.md has no `## ` heading; nothing to anchor the rebuild", details: [] };
  const first = theirs.entries[0];
  const candidates = ours.entries.filter((e) => sameEntry(e, first));
  if (candidates.length !== 1) {
    return {
      error: candidates.length === 0
        ? "ambiguous boundary: the first heading of MERGE_HEAD matches no heading of HEAD; rebuild by hand"
        : `ambiguous boundary: the first heading of MERGE_HEAD matches ${candidates.length} headings of HEAD; rebuild by hand`,
      details: [
        { file: "MERGE_HEAD:CHANGELOG.md", line: first.line, text: first.heading },
        ...(candidates.length ? candidates : ours.entries.slice(0, 1)).map((c) => ({ file: "HEAD:CHANGELOG.md", line: c.line, text: c.heading })),
      ],
    };
  }
  const boundary = candidates[0];
  const oursLines = oursText.split("\n");
  const theirsLines = theirsText.split("\n");
  const head = oursLines.slice(0, boundary.line - 1).join("\n");
  const tail = theirsLines.slice(first.line - 1).join("\n");
  const text = (head ? head + "\n" : "") + tail.replace(/\n*$/, "\n");
  return { text, fromHead: ours.entries.indexOf(boundary), fromTheirs: theirs.entries.length };
}

// CHANGELOG.md structure shared by `rx changelog` and `rx contributions`.
//
// An entry is an ATX level-2 heading (`## [Title] - 2026-10-20`, `## [Title] - {PR_MERGE_DATE}`)
// and the lines under it up to the next level-2 heading. Bytes are preserved: the text is split on
// "\n" only, so a CRLF file keeps its "\r" inside every line and body; the body is normalized
// only by dropping leading and trailing blank lines. A hash of it is therefore stable across the
// blank line that usually follows a heading and an appended newline, and nothing else.

import { createHash } from "node:crypto";

export const PLACEHOLDER = "{PR_MERGE_DATE}";

/**
 * @typedef {{ heading: string, title: string, date: string | null, line: number, body: string, bullets: string[] }} Entry
 *   `heading` is the heading line, trimmed; `title` the text inside the brackets (or the whole
 *   heading text when unbracketed); `date` the token after " - " (a date or the placeholder), null
 *   when absent; `line` 1-based; `body` the lines under the heading with leading and trailing
 *   blank lines removed; `bullets` the body lines that start with "- " or "* ".
 * @typedef {{ preamble: string, entries: Entry[], placeholders: number }} Changelog
 */

/** @param {string} line */
export function parseHeading(line) {
  const trimmed = line.trim().replace(/\s+#+\s*$/, ""); // closing-ATX "## [X] ##"; trim also drops a CR
  const m = trimmed.match(/^##\s+\[(.*?)\]\s*(?:-\s*(.+?))?\s*$/);
  if (m) return { title: m[1], date: m[2]?.trim() ?? null };
  return { title: trimmed.replace(/^##\s+/, "").trim(), date: null };
}

/** @param {string} line */
export function isHeading(line) {
  return /^##\s/.test(line);
}

/**
 * @param {string} text
 * @returns {Changelog}
 */
export function parseChangelog(text) {
  const lines = text.split("\n"); // never /\r?\n/: a CR is part of the bytes being compared
  /** @type {Entry[]} */
  const entries = [];
  /** @type {string[]} */
  const preamble = [];
  /** @type {Entry | null} */
  let current = null;
  /** @type {string[]} */
  let body = [];
  const flush = () => {
    if (!current) return;
    while (body.length && !body[body.length - 1].trim()) body.pop();
    while (body.length && !body[0].trim()) body.shift();
    current.body = body.join("\n");
    current.bullets = body.filter((l) => /^\s*[-*]\s+/.test(l));
    entries.push(current);
  };
  lines.forEach((line, i) => {
    if (isHeading(line)) {
      flush();
      const { title, date } = parseHeading(line);
      current = { heading: line.trim(), title, date, line: i + 1, body: "", bullets: [] };
      body = [];
    } else if (current) body.push(line);
    else preamble.push(line);
  });
  flush();
  const placeholders = text.split(PLACEHOLDER).length - 1;
  return { preamble: preamble.join("\n"), entries, placeholders };
}

/** `sha256:<hex>` of a body as `parseChangelog` normalizes it. @param {string} body */
export function bodyHash(body) {
  return "sha256:" + createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Do two headings name the same entry? Equal titles; dates equal, or one side still the
 * placeholder the other side has stamped (Q6: `- {PR_MERGE_DATE}` versus `- 2026-10-20`).
 * @param {Entry} a @param {Entry} b
 */
export function sameEntry(a, b) {
  if (a.title !== b.title) return false;
  if (a.date === b.date) return true;
  return a.date === PLACEHOLDER || b.date === PLACEHOLDER;
}

/**
 * The one normative `{PR_MERGE_DATE}` predicate, shared by `rx changelog` and `rx preflight`:
 * exactly one occurrence anywhere in the file, and it is on the top entry's heading. `<<<<<<<`,
 * `=======` or `>>>>>>>` conflict markers are reported first (a merge in progress is not a
 * CHANGELOG to judge). `problems` is empty when the file passes.
 * @param {string} text CHANGELOG.md contents
 * @returns {{ count: number, topHasPlaceholder: boolean, conflictMarkers: boolean, problems: string[] }}
 */
export function placeholderProblems(text) {
  const { entries, placeholders: count } = parseChangelog(text);
  const topHasPlaceholder = entries.length > 0 && entries[0].heading.includes(PLACEHOLDER);
  const conflictMarkers = /^(<{7} |={7}\r?$|>{7} )/m.test(text);
  /** @type {string[]} */
  const problems = [];
  if (conflictMarkers) problems.push("conflict markers present; resolve the merge (rx changelog --merge) first");
  else if (count === 0) problems.push(`no ${PLACEHOLDER}; the new entry must carry it (zero placeholders is not a pass)`);
  else if (count > 1) problems.push(`${count} occurrences of ${PLACEHOLDER}; exactly one, in the top entry`);
  else if (!topHasPlaceholder) problems.push(`${PLACEHOLDER} is not in the top entry's heading`);
  return { count, topHasPlaceholder, conflictMarkers, problems };
}

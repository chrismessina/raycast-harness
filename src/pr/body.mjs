// The pure half of `rx pr body`: the pr-body.py safety contract as functions over exact strings.
// No I/O here. Bodies are exact strings, so CRLF line endings survive untouched.
//
//   wholeLineSpans(body, find)  every place `find` occurs as one or more WHOLE lines
//   splice(body, edits)          apply [{ find, replace }] at once, or report why not
//   checklistItems(template)     the `- [ ]` lines of Raycast's PR template, in order
//   missingChecklist(body, items) which template items the proposed body lacks, verbatim
//   lineDiff(a, b)               `-`/`+` lines for the details of pr-body-diff

/**
 * Spans `[start, end)` where `find` occurs starting at a line start and ending at a line end.
 * A find ending in "\r" right before "\n" splits a CRLF terminator and does not count.
 * @param {string} body @param {string} find
 * @returns {Array<[number, number]>}
 */
export function wholeLineSpans(body, find) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  if (!find) return spans;
  let i = body.indexOf(find);
  while (i !== -1) {
    const end = i + find.length;
    const startsLine = i === 0 || body[i - 1] === "\n";
    const splitsCrlf = find.endsWith("\r") && end < body.length && body[end] === "\n";
    const endsLine = !splitsCrlf && (end === body.length || body[end] === "\r" || body[end] === "\n" || find.endsWith("\n"));
    if (startsLine && endsLine) spans.push([i, end]);
    i = body.indexOf(find, i + 1);
  }
  return spans;
}

/**
 * @typedef {{ find: string, replace: string }} Edit
 * @typedef {{ ok: true, body: string } | { ok: false, problems: string[] }} SpliceResult
 */

/**
 * Every anchor is located in the ORIGINAL body and all replacements are applied at once, so one
 * replacement can neither create nor destroy another's anchor. Any anchor not exactly once as
 * whole lines, or two anchors overlapping, and nothing is produced.
 * @param {string} base @param {Edit[]} edits
 * @returns {SpliceResult}
 */
export function splice(base, edits) {
  /** @type {Array<[number, number, string]>} */
  const spans = [];
  /** @type {string[]} */
  const problems = [];
  edits.forEach((e, n) => {
    const found = wholeLineSpans(base, e.find);
    if (found.length !== 1) problems.push(`edit ${n + 1}: anchor occurs ${found.length}x as whole lines (edited by hand?): ${JSON.stringify(e.find.slice(0, 80))}`);
    else spans.push([found[0][0], found[0][1], e.replace]);
  });
  if (problems.length) return { ok: false, problems };
  spans.sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < spans.length; k++) {
    if (spans[k][0] < spans[k - 1][1]) return { ok: false, problems: ["two anchors overlap; merge them into one edit"] };
  }
  let out = "";
  let pos = 0;
  for (const [start, end, replace] of spans) {
    out += base.slice(pos, start) + replace;
    pos = end;
  }
  return { ok: true, body: out + base.slice(pos) };
}

/**
 * Validate the shape of an edits file. Returns the problem, or null.
 * @param {unknown} parsed
 * @returns {string | null}
 */
export function validateEdits(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return "edits must be a non-empty JSON array of { find, replace }";
  for (const [i, e] of parsed.entries()) {
    if (!e || typeof e !== "object") return `edit ${i + 1} is not an object`;
    if (typeof (/** @type {any} */ (e).find) !== "string" || !(/** @type {any} */ (e).find)) return `edit ${i + 1}: find must be a non-empty string`;
    if (typeof (/** @type {any} */ (e).replace) !== "string") return `edit ${i + 1}: replace must be a string`;
  }
  return null;
}

/**
 * The checklist items of Raycast's PR template: every `- [ ]` line after the `## Checklist`
 * heading, trailing whitespace removed.
 * @param {string} template
 */
export function checklistItems(template) {
  const lines = template.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Checklist\s*$/.test(l));
  if (start === -1) return [];
  return lines.slice(start + 1).map((l) => l.trimEnd()).filter((l) => /^- \[ \] /.test(l));
}

/**
 * Which template items the body lacks. An item counts only as a whole line, verbatim after
 * trailing whitespace, with the box unticked: the initial post is ours, and ticking a box is
 * the author's hand-made claim, made afterward on the live body.
 * @param {string} body @param {string[]} items
 */
export function missingChecklist(body, items) {
  const have = new Set(body.split(/\r?\n/).map((l) => l.trimEnd()));
  return items.filter((it) => !have.has(it));
}

/**
 * Line diff as `-`/`+` lines (unchanged lines omitted), for human-readable details. Lines keep
 * their terminators stripped; CR shows as "\r" so a CRLF difference is visible.
 * @param {string} a @param {string} b
 */
export function lineDiff(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  // LCS table; bodies are a few hundred lines at most.
  const n = al.length;
  const m = bl.length;
  /** @type {Uint32Array[]} */
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  /** @type {string[]} */
  const out = [];
  const show = (/** @type {string} */ s) => s.replace(/\r/g, "\\r");
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${show(al[i++])}`);
    else out.push(`+${show(bl[j++])}`);
  }
  while (i < n) out.push(`-${show(al[i++])}`);
  while (j < m) out.push(`+${show(bl[j++])}`);
  return out;
}

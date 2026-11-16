// The pure half of `rx greptile fetch|wait|can-reply`: reading a Greptile round out of GitHub's
// comment payloads, and the forbidden-list scan of a reply.
//
// Greptile's summary is an ISSUE comment it edits in place on every re-review: one comment,
// `created_at` fixed forever, only `updated_at` (or the body) moves. So the round key is the
// summary's `updated_at`, and the summary is Greptile's FIRST issue comment (oldest created_at),
// never a later bot reply in the thread. Inline findings are REVIEW comments; a finding is new
// when its `original_commit_id` is new, never by `commit_id`, which GitHub rewrites to the newest
// commit for every comment whose lines did not move.

/** @param {any} c */
export function isGreptile(c) {
  return /greptile/i.test(String(c?.user?.login ?? ""));
}

/**
 * The summary comment: Greptile's oldest issue comment, or null when it has not reviewed yet.
 * @param {any[]} issueComments
 */
export function summaryComment(issueComments) {
  const mine = (Array.isArray(issueComments) ? issueComments : []).filter(isGreptile).filter((c) => typeof c?.created_at === "string");
  if (!mine.length) return null;
  mine.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return mine[0];
}

/**
 * Score (`N/5`) and the last reviewed commit from a summary body; null when absent.
 * @param {string} body
 */
export function parseSummary(body) {
  const text = String(body ?? "");
  const score = text.match(/(?:score|confidence)[^\n]{0,40}?\b([0-5])\s*\/\s*5\b/i)?.[1] ?? text.match(/\b([0-5])\s*\/\s*5\b/)?.[1] ?? null;
  return { score: score === null ? null : Number(score), reviewedCommit: reviewedCommit(text) };
}

/**
 * The SHA on the summary's footer line, or null. Only the LAST "Last reviewed commit" line is read: the footer
 * ends the body, and an earlier one is an example or a quote. Two shapes: (2026-11) a Markdown link whose text is
 * the commit title and whose URL ends in /commit/<sha>, or a SHA (bare, backticked, or as link text) right after
 * the label. Hex inside a title is never read as the SHA.
 * @param {string} text
 */
function reviewedCommit(text) {
  const labels = [...text.matchAll(/last\s+reviewed\s+commit/gi)];
  if (!labels.length) return null;
  const last = /** @type {RegExpMatchArray} */ (labels.at(-1));
  const line = text.slice(/** @type {number} */ (last.index) + last[0].length).split("\n")[0];
  const linked = line.match(/\]\(https?:\/\/[^)\s]*\/commit\/([0-9a-f]{7,40})\)/i)?.[1];
  if (linked) return linked.toLowerCase();
  const bare = line.match(/^:?\s*(?:\[([0-9a-f]{7,40})\]|`?([0-9a-f]{7,40})`?(?![\w-]))/i);
  return (bare?.[1] ?? bare?.[2])?.toLowerCase() ?? null;
}

/**
 * @typedef {{ id: number, path: string | null, line: number | null, originalCommitId: string | null, body: string }} Finding
 * @typedef {{ score: number | null, updatedAt: string, reviewedCommit: string | null, summary: string, findings: Finding[] }} Round
 */

/**
 * Build the round from the two comment lists plus the PR head. Null when Greptile has no summary.
 * @param {any[]} issueComments @param {any[]} reviewComments
 * @returns {Round | null}
 */
export function buildRound(issueComments, reviewComments) {
  const summary = summaryComment(issueComments);
  if (!summary || typeof summary.updated_at !== "string") return null;
  const { score, reviewedCommit } = parseSummary(summary.body);
  const findings = (Array.isArray(reviewComments) ? reviewComments : [])
    .filter(isGreptile)
    .filter((c) => typeof c?.id === "number")
    .map((c) => ({
      id: /** @type {number} */ (c.id),
      path: typeof c.path === "string" ? c.path : null,
      line: typeof c.line === "number" ? c.line : typeof c.original_line === "number" ? c.original_line : null,
      originalCommitId: typeof c.original_commit_id === "string" ? c.original_commit_id : null,
      body: String(c.body ?? ""),
    }));
  // The summary body travels with the round: a summary-only finding (no inline comment) is read
  // from it (Codex W4 r2 B1-4).
  return { score, updatedAt: summary.updated_at, reviewedCommit, summary: String(summary.body ?? ""), findings };
}

/**
 * Parse a forbidden list: one literal per line, blank lines and `#` comments ignored.
 * @param {string} text
 */
export function parseForbidden(text) {
  return text.split(/\r?\n/).map((l, i) => ({ literal: l, line: i + 1 })).filter((e) => e.literal.trim() && !e.literal.trimStart().startsWith("#"));
}

/**
 * Where forbidden literals occur in the reply. The literal itself is never echoed: the detail
 * names the forbidden list's line, so the terminal does not leak what the list protects.
 * @param {string} reply @param {ReturnType<typeof parseForbidden>} forbidden
 * @returns {{ replyLine: number, forbiddenLine: number }[]}
 */
export function scanReply(reply, forbidden) {
  /** @type {{ replyLine: number, forbiddenLine: number }[]} */
  const hits = [];
  const lines = reply.split(/\r?\n/);
  for (const f of forbidden) {
    lines.forEach((l, i) => {
      if (l.includes(f.literal)) hits.push({ replyLine: i + 1, forbiddenLine: f.line });
    });
    // A literal spanning a line break in the reply still counts.
    if (f.literal.includes("\n") && reply.includes(f.literal)) hits.push({ replyLine: 0, forbiddenLine: f.line });
  }
  return hits;
}

/**
 * @typedef {{ finding: number, disposition: "fixed" | "partial" | "declined", artifact: string, explanation: string }} Evidence
 */

/**
 * Validate the evidence file's shape and that it names the finding. Returns the problem or null.
 * @param {unknown} e @param {number} finding
 */
export function validateEvidence(e, finding) {
  const v = /** @type {any} */ (e);
  if (!v || typeof v !== "object" || Array.isArray(v)) return "evidence must be a JSON object { finding, disposition, artifact, explanation }";
  if (Number(v.finding) !== finding) return `evidence.finding (${JSON.stringify(v.finding)}) is not --finding ${finding}`;
  if (!["fixed", "partial", "declined"].includes(v.disposition)) return `evidence.disposition must be fixed, partial or declined, got ${JSON.stringify(v.disposition)}`;
  if (typeof v.artifact !== "string" || !v.artifact.trim()) return "evidence.artifact must name the supporting artifact or policy";
  if (typeof v.explanation !== "string" || !v.explanation.trim()) return "evidence.explanation must be a non-empty string";
  return null;
}

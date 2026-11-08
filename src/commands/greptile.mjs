// `rx greptile fetch|wait|can-reply|outdated|update` (docs/commands.md §4.12): the Greptile review
// loop's mechanics, and keeping the Greptile rules rx uses current with raycast/extensions.
//
//   fetch <N>      the round: summary score, updated_at (the round key), last reviewed commit,
//                  inline findings (id, path, line, original_commit_id) and the PR head. Written to
//                  state as rounds/<updated_at>.json.
//   wait <N>       ONE conditional GET of the issue comments with the stored ETag. 304 → N/A no
//                  change; 200 with a new summary updated_at → PASS new round; anything that is not
//                  a parsed 200 or a 304 → ERROR (a failed check is never "no change").
//   can-reply <N>  may THESE reply bytes be posted on THIS finding at THIS head? The finding must
//                  belong to the stored round, the fetched head must equal --expected-head, the
//                  evidence must name the finding with a disposition, the reply is scanned with
//                  the forbidden list, and a fix claim (--claims-fix) needs a publication record
//                  naming this PR and the current remote SHA, which must differ from the round's
//                  reviewed commit. A decline permits an unchanged head without any publication
//                  record (job-A P1-3: decline-only rounds used to be unanswerable).
//   outdated       compare the rules in use (src/greptile/rules.mjs: the newest cache copy, else the
//                  shipped src/rules/greptile/) with the live .greptile/ on main.
//   update         fetch the live .greptile/, validate it, and write it atomically as a new copy in
//                  the cache; --dest writes a maintainer checkout's src/rules/greptile/ instead
//                  (staged and validated, then replaced all-or-nothing), never the installed
//                  package. Nothing is written when nothing changed or on any error. A cache copy
//                  that does not become the copy in use (one already there sorts later by upstream
//                  commit date) is a WARN, never "updated".
//
// Every upstream request names raycast/extensions (GREPTILE_REPO), never a copy's own metadata.
//
// State (docs/commands.md §1): greptile/<owner>/<name>/<N>/ under the extension's repo state when
// a root resolves, else under the cross-repo cache. `rounds/<updated_at>.json`, `etag`, `seen`,
// `replies.json`.
//
// publication.json (read by can-reply --claims-fix; written only by `rx publication record`, which
// the plugin's ship flow runs after its publish succeeds): `repo/publication.json` = { repo:
// "owner/name", pr: <int>, remoteSha: "<40 hex>", at: "<ISO-8601>" }. Both sides validate it with
// src/publication.mjs; a malformed record is ERROR input, never evidence.
//
// All GitHub traffic goes through src/pr/transport.mjs.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RxError } from "../errors.mjs";
import { GREPTILE_REPO } from "../greptile/compare.mjs";
import { SHIPPED_DIR, describeRules, loadGreptileRules, readRuleDir, writeDestCopy } from "../greptile/rules.mjs";
import { compareLive, notInUseMessage, updateCacheCopy, updatedMessage } from "../greptile/update.mjs";
import { buildRound, parseForbidden, scanReply, validateEvidence } from "../greptile/rounds.mjs";
import { parsePrNumber, transport } from "../pr/transport.mjs";
import { publicationPath, readPublication } from "../publication.mjs";
import { cachePath, repoStatePath } from "../state.mjs";

const REPO = "raycast/extensions";
const [OWNER, NAME] = REPO.split("/");

const PR_POSITIONAL = [{ name: "N", required: true, help: `pull request number in ${REPO}` }];
/** The dispatcher reads `--root` only when the (sub)command declares it. */
const ROOT_FLAG = { "--root": /** @type {import("../args.mjs").Flag} */ ({ type: "string", value: "<dir>", help: "extension root whose repo state holds the round store (optional; cross-repo cache otherwise)" }) };
const ROUND_STATE = "greptile/<owner>/<name>/<N>/ under the extension's repo state when a root resolves, else under the cross-repo cache";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "greptile",
  summary: "fetch a Greptile round, wait for the next one, authorize a reply, or keep the Greptile rules current",
  root: "optional",
  network: `GitHub API via gh (${REPO})`,
  state: ROUND_STATE,
  subcommands: {
    fetch: {
      name: "fetch",
      summary: "the current round: score, updated_at, last reviewed commit, the summary body, inline findings, PR head",
      root: "optional",
      positionals: PR_POSITIONAL,
      flags: ROOT_FLAG,
      state: `writes rounds/<updated_at>.json in ${ROUND_STATE}`,
      checks: { "greptile-round": { description: "a Greptile summary exists on the PR and was stored as a round", levels: ["PASS", "N/A"] } },
      data: { repo: "owner/name", pr: "int", head: "sha", round: "{ score, updatedAt, reviewedCommit, summary, findings: [{ id, path, line, originalCommitId, body }] } | null" },
    },
    wait: {
      name: "wait",
      summary: "one ETag-conditional GET: PASS new round / N/A no change / ERROR on any failure",
      root: "optional",
      positionals: PR_POSITIONAL,
      flags: ROOT_FLAG,
      state: `reads and writes etag and seen in ${ROUND_STATE} (fetch writes seen too, as the wait baseline)`,
      checks: { "greptile-wait": { description: "a new Greptile round arrived (PASS), nothing changed (N/A), or the check could not complete (ERROR)", levels: ["PASS", "N/A", "ERROR"] } },
      data: { etag: "string | null", changed: "boolean", updatedAt: "string | null" },
    },
    "can-reply": {
      name: "can-reply",
      summary: "authorize exactly these reply bytes on one finding of a stored round at an expected head",
      root: "optional",
      positionals: PR_POSITIONAL,
      flags: {
        ...ROOT_FLAG,
        "--round": { type: "string", required: true, value: "<updated_at>", help: "the stored round's summary updated_at" },
        "--finding": { type: "string", required: true, value: "<id>", help: "the inline finding (review comment id) being answered" },
        "--expected-head": { type: "string", required: true, value: "<sha>", help: "the PR head the reply is written against" },
        "--forbidden": { type: "string", required: true, value: "<file>", help: "forbidden literals, one per line (blank lines and # comments ignored)" },
        "--reply": { type: "string", required: true, value: "<file>", help: "the exact reply bytes to post" },
        "--evidence": { type: "string", required: true, value: "<file>", help: "JSON { finding, disposition: fixed|partial|declined, artifact, explanation }" },
        "--claims-fix": { type: "boolean", help: "the reply says a fix was published; requires repo/publication.json (written by `rx publication record`) for this PR at a new remote SHA" },
      },
      state: `appends to replies.json in ${ROUND_STATE}; reads repo/publication.json with --claims-fix`,
      checks: {
        "reply-round": "the finding belongs to the stored round named by --round",
        "reply-head": "the fetched PR head equals --expected-head",
        "reply-evidence": "the evidence names this finding with a disposition consistent with --claims-fix",
        "reply-publication": "a fix claim is backed by publication.json naming this PR at the current remote SHA, different from the reviewed commit",
        "reply-scan": "the reply bytes contain no forbidden literal",
      },
      data: { authorized: "boolean", record: "{ repo, pr, round, finding, expectedHead, evidenceHash, forbiddenHash, replyHash, authorized, at }" },
    },
    outdated: {
      name: "outdated",
      summary: "compare the Greptile rules in use with the live .greptile/ on raycast/extensions main",
      root: "none",
      network: `GitHub API via gh: ${REPO} the latest commit touching .greptile/ on main, then its .greptile/ contents when that differs from the copy in use`,
      state: "reads the cache copies in greptile/rules/ under the cross-repo cache; writes nothing",
      checks: { "greptile-outdated": "the rules in use match the live rules (PASS), differ (FAIL, one detail per change), or could not be compared (ERROR)" },
      data: { inUse: "{ kind: updated|shipped, repo, sha, committed, fetched, path, origin: main|pr, pr }", live: "{ source, sha, committed } | null", changes: "string[] (source moved included)" },
    },
    update: {
      name: "update",
      summary: "fetch the live .greptile/ from raycast/extensions main and make it the copy in use",
      root: "none",
      flags: {
        "--dest": { type: "string", value: "<dir>", help: "a raycast-harness maintainer checkout whose src/rules/greptile/ receives the update instead of the cache (never the installed package)" },
      },
      network: `GitHub API via gh: ${REPO} the latest commit touching .greptile/ on main, then its .greptile/ contents when that differs from the copy in use`,
      state: "writes a new copy under greptile/rules/ in the cross-repo cache, or with --dest only into --dest/src/rules/greptile/; nothing when already current or on error",
      checks: { "greptile-update": "the live rules were written and are the copy in use (PASS updated), matched already (PASS already current), were written to the cache but a copy from a later upstream commit stays in use (WARN, naming it), or could not be read, validated or written (ERROR, nothing written; --dest is restored all-or-nothing)" },
      data: { previous: "{ kind, repo, sha, committed, fetched, path, origin, pr } (the copy compared against)", live: "{ source, sha, committed } | null", changes: "string[] (source moved included)", updated: "string | null (the directory written)", inUse: "boolean | null (whether the cache copy written, or the current one, is the copy in use; null with --dest)" },
    },
  },
};

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  switch (ctx.args.subcommand) {
    case "fetch": return fetch(ctx);
    case "wait": return wait(ctx);
    case "can-reply": return canReply(ctx);
    case "outdated": return outdated(ctx);
    default: return update(ctx);
  }
}

/** @param {string} s */
const sha256 = (s) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

/** @param {string} file @param {string} what */
function readText(file, what) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw new RxError(`cannot read ${what} ${file}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
}

/** @param {string | null} root @param {number} n */
async function roundDir(root, n) {
  const dir = root ? await repoStatePath(root, "greptile", OWNER, NAME, String(n)) : cachePath("greptile", OWNER, NAME, String(n));
  mkdirSync(join(dir, "rounds"), { recursive: true });
  return dir;
}

/** @param {number} n */
async function prHead(n) {
  const pr = await transport().getJson(`repos/${REPO}/pulls/${n}`);
  const sha = pr?.head?.sha;
  if (typeof sha !== "string" || !sha) throw new RxError(`pulls/${n} has no head.sha`, { id: "github" });
  return sha;
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function fetch({ args, root, results }) {
  const n = parsePrNumber(args.positionals.N);
  const t = transport();
  // Paginated to completion: a finding past the first 100 comments is still a finding.
  const [issue, review, head] = await Promise.all([
    t.getJsonPages(`repos/${REPO}/issues/${n}/comments?per_page=100`),
    t.getJsonPages(`repos/${REPO}/pulls/${n}/comments?per_page=100`),
    prHead(n),
  ]);
  const round = buildRound(issue, review);
  const data = { repo: REPO, pr: n, head, round };
  if (!round) {
    results.na("greptile-round", `no Greptile review on #${n} yet`);
    return { data };
  }
  const dir = await roundDir(root, n);
  writeFileSync(join(dir, "rounds", `${round.updatedAt}.json`), JSON.stringify({ repo: REPO, pr: n, head, ...round }, null, 2) + "\n");
  // The fetched round is the baseline `wait` compares against: the first wait after a fetch must
  // not announce this same round as new (Codex W4 B1-6).
  writeFileSync(join(dir, "seen"), `${round.updatedAt}\n`);
  results.pass("greptile-round", `round ${round.updatedAt}: score ${round.score ?? "?"}/5, ${round.findings.length} inline finding(s), reviewed ${round.reviewedCommit?.slice(0, 7) ?? "unknown"}, head ${head.slice(0, 7)}`);
  return { data };
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function wait({ args, root, results }) {
  const n = parsePrNumber(args.positionals.N);
  const dir = await roundDir(root, n);
  const etagFile = join(dir, "etag");
  const seenFile = join(dir, "seen");
  const prevEtag = existsSync(etagFile) ? readFileSync(etagFile, "utf8").trim() || null : null;
  const seen = existsSync(seenFile) ? readFileSync(seenFile, "utf8").trim() : "";
  /** @type {{ status: number, etag: string | null, body: any }} */
  let r;
  try {
    r = await transport().getConditional(`repos/${REPO}/issues/${n}/comments?per_page=100`, prevEtag);
  } catch (e) {
    results.error("greptile-wait", `check failed (not the same as no change): ${/** @type {Error} */ (e).message}`);
    return { data: { etag: prevEtag, changed: false, updatedAt: null } };
  }
  if (r.status === 304) {
    results.na("greptile-wait", "no change (304)");
    return { data: { etag: prevEtag, changed: false, updatedAt: seen || null } };
  }
  if (r.status !== 200 || !Array.isArray(r.body)) {
    results.error("greptile-wait", `check failed (not the same as no change): HTTP ${r.status}${Array.isArray(r.body) ? "" : ", unparseable body"}`);
    return { data: { etag: prevEtag, changed: false, updatedAt: null } };
  }
  const round = buildRound(r.body, []);
  // Persist state only after a successful parse.
  if (r.etag) writeFileSync(etagFile, r.etag + "\n");
  const last = round?.updatedAt ?? null;
  if (last && last !== seen) {
    writeFileSync(seenFile, last + "\n");
    results.pass("greptile-wait", `new round ${last}`);
    return { data: { etag: r.etag, changed: true, updatedAt: last } };
  }
  results.na("greptile-wait", last ? `no new round (summary updated_at still ${last})` : "no change (Greptile has not reviewed this PR yet)");
  return { data: { etag: r.etag, changed: false, updatedAt: last } };
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function canReply({ args, root, results }) {
  const n = parsePrNumber(args.positionals.N);
  const roundKey = String(args.flags["--round"]);
  const findingRaw = String(args.flags["--finding"]);
  if (!/^\d+$/.test(findingRaw)) throw new RxError(`--finding must be a review comment id, got ${JSON.stringify(findingRaw)}`, { id: "args" });
  const finding = Number(findingRaw);
  const expectedHead = String(args.flags["--expected-head"]).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(expectedHead)) throw new RxError(`--expected-head must be a commit SHA, got ${JSON.stringify(expectedHead)}`, { id: "args" });
  const claimsFix = args.flags["--claims-fix"] === true;

  const forbiddenText = readText(String(args.flags["--forbidden"]), "forbidden list");
  const replyText = readText(String(args.flags["--reply"]), "reply");

  // Evidence: missing, unreadable or mismatched is ERROR reply-evidence (the check cannot run),
  // never a FAIL and never the generic input id.
  /** @type {string} */
  let evidenceText;
  try {
    evidenceText = readFileSync(String(args.flags["--evidence"]), "utf8");
  } catch (e) {
    throw new RxError(`evidence ${args.flags["--evidence"]} is missing or unreadable: ${/** @type {Error} */ (e).message}`, { id: "reply-evidence" });
  }
  /** @type {unknown} */
  let evidence;
  try {
    evidence = JSON.parse(evidenceText);
  } catch (e) {
    throw new RxError(`evidence is not JSON: ${/** @type {Error} */ (e).message}`, { id: "reply-evidence" });
  }
  const problem = validateEvidence(evidence, finding);
  if (problem) throw new RxError(`evidence mismatch: ${problem}`, { id: "reply-evidence" });
  const disposition = /** @type {import("../greptile/rounds.mjs").Evidence} */ (evidence).disposition;
  if (claimsFix && disposition === "declined") throw new RxError("evidence mismatch: --claims-fix with disposition \"declined\"", { id: "reply-evidence" });
  if (!claimsFix && disposition !== "declined") throw new RxError(`evidence mismatch: disposition "${disposition}" claims a fix; pass --claims-fix`, { id: "reply-evidence" });
  results.pass("reply-evidence", `${disposition}: ${/** @type {any} */ (evidence).artifact}`);

  // Round membership.
  const dir = await roundDir(root, n);
  const roundFile = join(dir, "rounds", `${roundKey}.json`);
  /** @type {any} */
  let round = null;
  if (!existsSync(roundFile)) results.fail("reply-round", `no stored round ${roundKey} for #${n}; run \`rx greptile fetch ${n}\` first`);
  else {
    try {
      round = JSON.parse(readFileSync(roundFile, "utf8"));
    } catch (e) {
      throw new RxError(`stored round ${roundFile} is unreadable: ${/** @type {Error} */ (e).message}`, { id: "input" });
    }
    const member = Array.isArray(round.findings) && round.findings.some((/** @type {any} */ f) => f.id === finding);
    if (member) results.pass("reply-round", `finding ${finding} belongs to round ${roundKey}`);
    else results.fail("reply-round", `finding ${finding} is not in round ${roundKey} (${(round.findings ?? []).map((/** @type {any} */ f) => f.id).join(", ") || "no inline findings"})`);
  }

  // Head.
  const head = (await prHead(n)).toLowerCase();
  if (head.startsWith(expectedHead)) results.pass("reply-head", `PR head ${head.slice(0, 7)} matches --expected-head`);
  else results.fail("reply-head", `PR head is ${head.slice(0, 7)}, not ${expectedHead.slice(0, 7)}; the reply was written against a stale head`);

  // Publication record, only for fix claims. A decline needs no new head (P1-3).
  if (!claimsFix) results.na("reply-publication", "not a fix claim");
  else {
    const pubFile = root ? await publicationPath(root) : null;
    const pub = pubFile ? readPublication(pubFile) : null;
    if (!pubFile || !pub) results.fail("reply-publication", root ? `no publication record at ${pubFile}; a fix claim needs \`rx publication record\` to have recorded this PR after its publish` : "no extension root resolved, so no publication record can be read; run from the extension or pass --root");
    else {
      const remote = pub.remoteSha;
      const reviewed = String(round?.reviewedCommit ?? round?.head ?? "").toLowerCase();
      if (pub.repo !== REPO || pub.pr !== n) results.fail("reply-publication", `publication record names ${pub.repo}#${pub.pr}, not ${REPO}#${n}`);
      else if (remote !== head) results.fail("reply-publication", `publication record's remoteSha ${remote.slice(0, 7)} is not the current head ${head.slice(0, 7)}`);
      else if (reviewed && (remote === reviewed || remote.startsWith(reviewed) || reviewed.startsWith(remote))) results.fail("reply-publication", `remote head ${remote.slice(0, 7)} is the commit Greptile already reviewed; no new revision landed`);
      else if (!reviewed) results.fail("reply-publication", `stored round ${roundKey} records no reviewed commit or head to compare the published SHA against`);
      else results.pass("reply-publication", `published ${remote.slice(0, 7)} at ${pub.at}, newer than reviewed ${reviewed.slice(0, 7)}`);
    }
  }

  // Scan the exact reply bytes.
  const forbidden = parseForbidden(forbiddenText);
  if (forbidden.length === 0) results.na("reply-scan", "every example approved (forbidden list is empty)");
  else {
    const hits = scanReply(replyText, forbidden);
    if (hits.length === 0) results.pass("reply-scan", `no forbidden literal in ${replyText.length} reply byte(s)`);
    else results.fail("reply-scan", `${hits.length} forbidden literal(s) in the reply`, hits.map((h) => ({ file: String(args.flags["--reply"]), line: h.replyLine || undefined, text: `forbidden list line ${h.forbiddenLine}` })));
  }

  const authorized = results.items.every((r) => r.verdict === "PASS" || r.verdict === "N/A");
  const record = {
    repo: REPO,
    pr: n,
    round: roundKey,
    finding,
    expectedHead,
    evidenceHash: sha256(evidenceText),
    forbiddenHash: sha256(forbiddenText),
    replyHash: sha256(replyText),
    authorized,
    at: new Date().toISOString(),
  };
  const repliesFile = join(dir, "replies.json");
  /** @type {unknown[]} */
  let replies = [];
  if (existsSync(repliesFile)) {
    try {
      const parsed = JSON.parse(readFileSync(repliesFile, "utf8"));
      if (Array.isArray(parsed)) replies = parsed;
    } catch { replies = []; }
  }
  replies.push(record);
  // Atomic replacement: a crash mid-write must not leave a truncated replies.json.
  const tmp = join(dir, `.replies.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(replies, null, 2) + "\n");
  renameSync(tmp, repliesFile);
  return { data: { authorized, record } };
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function outdated({ results, log }) {
  const inUse = loadGreptileRules({ warn: log });
  const data = { inUse: inUse.source, live: /** @type {{ source: string, sha: string, committed: string } | null} */ (null), changes: /** @type {string[]} */ ([]) };
  try {
    const { where, changes } = await compareLive(inUse.source, inUse.rules, transport());
    data.live = { source: where.source, sha: where.sha, committed: where.committed };
    data.changes = changes;
  } catch (e) {
    results.error("greptile-outdated", `could not read or compare the live rules: ${/** @type {Error} */ (e).message}`);
    return { data };
  }
  if (!data.changes.length) results.pass("greptile-outdated", `the rules are current: ${describeRules(inUse.source)}`);
  else results.fail("greptile-outdated", `out of date: ${data.changes.length} change(s) since ${inUse.source.fetched.slice(0, 10)}; run rx greptile update`, data.changes.map((text) => ({ text })));
  return { data };
}

/** What a --dest SOURCE.json written before `committed` existed counts as: older than any dated copy. */
const LEGACY_COMMITTED = "1970-01-01T00:00:00Z";

/** @param {import("../cli.mjs").CommandContext} ctx */
async function update({ args, results, log }) {
  const dest = typeof args.flags["--dest"] === "string" ? args.flags["--dest"] : null;
  /** @type {string | null} */
  let destDir = null;
  if (dest) {
    destDir = join(dest, "src", "rules", "greptile");
    const ok = existsSync(destDir) && statSync(destDir).isDirectory() && existsSync(join(destDir, "SOURCE.json"));
    if (!ok) throw new RxError(`--dest ${dest} is not a raycast-harness checkout (no src/rules/greptile/SOURCE.json)`, { id: "input" });
    // The running package's own shipped copy is never a destination, however the path is spelled.
    /** @type {boolean} */
    let same;
    try {
      same = realpathSync(destDir) === realpathSync(SHIPPED_DIR);
    } catch { same = false; }
    if (same) throw new RxError(`--dest ${dest} is the running package's own shipped rules directory; point --dest at a separate maintainer checkout`, { id: "greptile-update" });
  }

  // Without --dest: the one check-and-update routine rx gates shares (src/greptile/update.mjs).
  if (!destDir) return updateCache(results, log);

  // With --dest the copy being replaced is that checkout's.
  /** @type {import("../greptile/rules.mjs").LoadedRules} */
  let before;
  try {
    // An older checkout's SOURCE.json may predate `committed` (W9 round 2 finding E): it is
    // accepted here and treated as older than any dated copy (the epoch).
    const r = readRuleDir(destDir, "--dest", { legacy: true });
    before = { rules: r.set, source: { kind: "shipped", repo: r.source.repo, sha: r.source.sha, committed: r.source.committed ?? LEGACY_COMMITTED, fetched: r.source.fetched, path: destDir, origin: r.source.source, pr: r.source.pr ?? null } };
  } catch (e) {
    throw new RxError(`--dest ${dest}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }

  const data = { previous: before.source, live: /** @type {{ source: string, sha: string, committed: string } | null} */ (null), changes: /** @type {string[]} */ ([]), updated: /** @type {string | null} */ (null), inUse: /** @type {boolean | null} */ (null) };
  /** @type {Awaited<ReturnType<typeof compareLive>>} */
  let got;
  try {
    got = await compareLive(before.source, before.rules, transport());
  } catch (e) {
    results.error("greptile-update", `could not read or validate the live rules; nothing written: ${/** @type {Error} */ (e).message}`);
    return { data };
  }
  const { where, live, changes } = got;
  data.live = { source: where.source, sha: where.sha, committed: where.committed };
  data.changes = changes;
  if (!changes.length) {
    results.pass("greptile-update", `already current: ${describeRules(before.source)} matches ${where.label}`);
    return { data };
  }
  if (!live) throw new RxError("internal: changes without a fetched live copy", { id: "internal" });
  const details = changes.map((text) => ({ text }));
  const arrow = `${before.source.sha.slice(0, 7)} → ${where.sha.slice(0, 7)}`;
  // A maintainer checkout keeps the PR its SOURCE.json already recorded (the provenance of the
  // first copy).
  const pr = before.source.pr ? { pr: before.source.pr } : {};
  // Second, independent guard at the write site: whatever happened above, the installed shipped
  // copy is never written (2026-10-30: a test run with the first guard disabled rewrote it).
  if (realpathSync(destDir) === realpathSync(SHIPPED_DIR)) throw new RxError(`refusing to write into the running package's shipped rules ${SHIPPED_DIR}`, { id: "greptile-update" });
  const fetched = new Date().toISOString().slice(0, 10);
  try {
    writeDestCopy(destDir, live.raw, { repo: GREPTILE_REPO, ...pr, source: where.source, sha: where.sha, committed: where.committed, fetched });
  } catch (e) {
    const partial = /** @type {any} */ (e).partial === true;
    results.error("greptile-update", `could not write --dest ${destDir}; ${partial ? "some files could not be restored" : "nothing written"}: ${/** @type {Error} */ (e).message}`);
    return { data };
  }
  data.updated = destDir;
  results.pass("greptile-update", `updated: ${arrow}, ${changes.length} change(s) written to ${destDir}; carry them into the plugin mapping`, details);
  return { data };
}

/**
 * `update` without --dest: the cache copy, through updateCacheCopy.
 * @param {import("../verdict.mjs").Results} results @param {(s: string) => void} log
 */
async function updateCache(results, log) {
  const o = await updateCacheCopy({ fetcher: transport(), warn: log });
  const data = { previous: o.before.source, live: o.live, changes: o.changes, updated: /** @type {string | null} */ (null), inUse: /** @type {boolean | null} */ (null) };
  const details = o.changes.map((text) => ({ text }));
  switch (o.status) {
    case "unchecked":
    case "invalid":
    case "timed-out": // only under updateWithin's deadline (rx gates); listed for the type
      results.error("greptile-update", `could not read or validate the live rules; nothing written: ${o.error}`);
      break;
    case "current":
      data.inUse = true;
      results.pass("greptile-update", `already current: ${describeRules(o.before.source)} matches ${o.label}`);
      break;
    case "write-failed":
      results.error("greptile-update", `could not write the cache copy; nothing written: ${o.error}`);
      break;
    case "not-in-use":
      data.updated = o.dir;
      data.inUse = false;
      results.warn("greptile-update", notInUseMessage(o), details);
      break;
    default:
      data.updated = o.dir;
      data.inUse = true;
      results.pass("greptile-update", updatedMessage(o), details);
  }
  return { data };
}

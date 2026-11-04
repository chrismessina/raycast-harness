// `rx greptile fetch|wait|can-reply|drift` (docs/commands.md §4.12): the Greptile review loop's
// mechanics, and whether the vendored rule snapshot still matches raycast/extensions.
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
//   drift          compare src/rules/greptile/ with the live .greptile/; --update rewrites only an
//                  explicit --dest maintainer checkout, never the installed package.
//
// State (docs/commands.md §1): greptile/<owner>/<name>/<N>/ under the extension's repo state when
// a root resolves, else under the cross-repo cache. `rounds/<updated_at>.json`, `etag`, `seen`,
// `replies.json`.
//
// publication.json (read by can-reply --claims-fix; WRITTEN by the plugin runner's publish step,
// not by rx): `repo/publication.json` = { repo: "owner/name", pr: <int>, remoteSha: "<40 hex>",
// at: "<ISO-8601>" } — the remote head the runner observed after its publish succeeded.
//
// All GitHub traffic goes through src/pr/transport.mjs.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RxError } from "../errors.mjs";
import { SNAPSHOT_FILES, diffRuleSets, fetchLive, liveSource } from "../greptile/drift.mjs";
import { buildRound, parseForbidden, scanReply, validateEvidence } from "../greptile/rounds.mjs";
import { parsePrNumber, transport } from "../pr/transport.mjs";
import { cachePath, repoStatePath } from "../state.mjs";

const REPO = "raycast/extensions";
const [OWNER, NAME] = REPO.split("/");
export const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "rules", "greptile");

const PR_POSITIONAL = [{ name: "N", required: true, help: `pull request number in ${REPO}` }];
/** The dispatcher reads `--root` only when the (sub)command declares it. */
const ROOT_FLAG = { "--root": /** @type {import("../args.mjs").Flag} */ ({ type: "string", value: "<dir>", help: "extension root whose repo state holds the round store (optional; cross-repo cache otherwise)" }) };
const ROUND_STATE = "greptile/<owner>/<name>/<N>/ under the extension's repo state when a root resolves, else under the cross-repo cache";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "greptile",
  summary: "fetch a Greptile round, wait for the next one, authorize a reply, or check the rule snapshot for drift",
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
        "--claims-fix": { type: "boolean", help: "the reply says a fix was published; requires repo/publication.json for this PR at a new remote SHA" },
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
    drift: {
      name: "drift",
      summary: "compare the core Greptile rule snapshot with the live .greptile/ in raycast/extensions",
      root: "none",
      flags: {
        "--update": { type: "boolean", help: "rewrite the snapshot from the live copy; requires --dest" },
        "--dest": { type: "string", value: "<dir>", help: "a raycast-harness maintainer checkout whose src/rules/greptile/ receives the update (never the installed package)" },
      },
      network: `GitHub API via gh: ${REPO} commits, pulls and .greptile/ contents`,
      state: "writes only into --dest/src/rules/greptile/ with --update; otherwise none",
      checks: { "greptile-drift": "the snapshot matches the live rules (PASS), differs (FAIL, one detail per change), or could not be compared (ERROR)" },
      data: { snapshot: "SOURCE.json { repo, pr, source, sha, fetched }", live: "{ source, sha }", changes: "string[] (source moved included)", updated: "string | null (the --dest written)" },
    },
  },
};

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  switch (ctx.args.subcommand) {
    case "fetch": return fetch(ctx);
    case "wait": return wait(ctx);
    case "can-reply": return canReply(ctx);
    default: return drift(ctx);
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
    const pubFile = root ? await repoStatePath(root, "publication.json") : null;
    if (!pubFile || !existsSync(pubFile)) results.fail("reply-publication", root ? `no publication record at ${pubFile}; a fix claim needs the runner's publish step to have recorded this PR` : "no extension root resolved, so no publication record can be read; run from the extension or pass --root");
    else {
      /** @type {any} */
      let pub;
      try {
        pub = JSON.parse(readFileSync(pubFile, "utf8"));
      } catch (e) {
        throw new RxError(`publication record ${pubFile} is unreadable: ${/** @type {Error} */ (e).message}`, { id: "input" });
      }
      const remote = String(pub?.remoteSha ?? "").toLowerCase();
      const reviewed = String(round?.reviewedCommit ?? round?.head ?? "").toLowerCase();
      if (pub?.repo !== REPO || Number(pub?.pr) !== n) results.fail("reply-publication", `publication record names ${pub?.repo ?? "?"}#${pub?.pr ?? "?"}, not ${REPO}#${n}`);
      else if (!remote || remote !== head) results.fail("reply-publication", `publication record's remoteSha ${remote.slice(0, 7) || "(none)"} is not the current head ${head.slice(0, 7)}`);
      else if (reviewed && (remote === reviewed || remote.startsWith(reviewed) || reviewed.startsWith(remote))) results.fail("reply-publication", `remote head ${remote.slice(0, 7)} is the commit Greptile already reviewed; no new revision landed`);
      else if (!reviewed) results.fail("reply-publication", `stored round ${roundKey} records no reviewed commit or head to compare the published SHA against`);
      else results.pass("reply-publication", `published ${remote.slice(0, 7)} at ${pub.at ?? "?"}, newer than reviewed ${reviewed.slice(0, 7)}`);
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

/** @param {string} dir */
function readSnapshot(dir) {
  const read = (/** @type {string} */ f) => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch (e) {
      throw new RxError(`snapshot ${join(dir, f)} is unreadable: ${/** @type {Error} */ (e).message}`, { id: "input" });
    }
  };
  /** @type {import("../greptile/drift.mjs").Source} */
  const source = JSON.parse(read("SOURCE.json"));
  return { source, set: { config: JSON.parse(read("config.json")), files: JSON.parse(read("files.json")), rules: read("rules.md") } };
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function drift({ args, results }) {
  const update = args.flags["--update"] === true;
  const dest = typeof args.flags["--dest"] === "string" ? args.flags["--dest"] : null;
  if (update && !dest) throw new RxError("--update requires --dest <maintainer checkout>; the installed package is never rewritten", { id: "args" });
  if (dest && !update) throw new RxError("--dest only applies with --update", { id: "args" });
  /** @type {string | null} */
  let destDir = null;
  if (dest) {
    destDir = join(dest, "src", "rules", "greptile");
    const ok = existsSync(destDir) && statSync(destDir).isDirectory() && existsSync(join(destDir, "SOURCE.json"));
    if (!ok) throw new RxError(`--dest ${dest} is not a raycast-harness checkout (no src/rules/greptile/SOURCE.json)`, { id: "input" });
    // The running package's own snapshot is never a destination, however the path is spelled.
    /** @type {boolean} */
    let same;
    try {
      same = realpathSync(destDir) === realpathSync(SNAPSHOT_DIR);
    } catch { same = false; }
    if (same) throw new RxError(`--dest ${dest} is the running package's own snapshot directory; point --dest at a separate maintainer checkout`, { id: "greptile-drift" });
  }

  const { source, set: snapshot } = readSnapshot(SNAPSHOT_DIR);
  const data = { snapshot: source, live: /** @type {{ source: string, sha: string } | null} */ (null), changes: /** @type {string[]} */ ([]), updated: /** @type {string | null} */ (null) };
  /** @type {{ source: "main" | "pr", sha: string, label: string }} */
  let where;
  /** @type {{ raw: Record<string, string>, set: import("../greptile/drift.mjs").RuleSet }} */
  let live;
  try {
    where = await liveSource(source.repo, source.pr, transport());
    live = await fetchLive(source.repo, where.sha, transport());
    data.changes = diffRuleSets(snapshot, live.set);
  } catch (e) {
    results.error("greptile-drift", `could not read or compare the live rules: ${/** @type {Error} */ (e).message}`);
    return { data };
  }
  data.live = { source: where.source, sha: where.sha };
  // `source moved` is a change like any other: it lives in data.changes, and details derive from it.
  if (where.source !== source.source) data.changes.unshift(`source moved ${source.source} → ${where.source}${where.source === "main" ? ` (PR #${source.pr} merged)` : ""}`);
  const details = data.changes.map((text) => ({ text }));

  if (update && destDir) {
    // Second, independent guard at the write site: whatever happened above, the installed snapshot
    // is never written (2026-10-30: a test run with the first guard disabled rewrote it).
    if (realpathSync(destDir) === realpathSync(SNAPSHOT_DIR)) throw new RxError(`refusing to write into the running package's snapshot ${SNAPSHOT_DIR}`, { id: "greptile-drift" });
    for (const f of SNAPSHOT_FILES) writeFileSync(join(destDir, f), live.raw[f]);
    const fetched = new Date().toISOString().slice(0, 10);
    writeFileSync(join(destDir, "SOURCE.json"), JSON.stringify({ ...source, source: where.source, sha: where.sha, fetched }, null, 2) + "\n");
    data.updated = destDir;
    results.pass("greptile-drift", `snapshot in ${destDir} rewritten from ${where.label}${details.length ? `; ${details.length} change(s) to carry into the plugin mapping` : ""}`, details);
    return { data };
  }
  if (!details.length) results.pass("greptile-drift", `snapshot ${source.source} @ ${source.sha.slice(0, 7)} matches ${where.label}`);
  else results.fail("greptile-drift", `snapshot is ${source.source} @ ${source.sha.slice(0, 7)} (${source.fetched}); live is ${where.label}: ${details.length} change(s)`, details);
  return { data };
}

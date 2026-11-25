// `rx post-merge [<pr>] [--dry-run] [--root d]` (docs/commands.md § rx post-merge): after
// raycast/extensions merges this extension's PR, adopt what raycastbot rewrote on the PR branch
// before the squash (the {PR_MERGE_DATE} stamp, recompressed PNGs) in one signed commit, and push it.
//
// The run is a sequence of six steps, each with its own check id, emitted on every run:
//   1 post-merge-pr        the PR is this extension's and merged            src/post-merge/github.mjs
//   2 post-merge-rewrites  raycastbot's trailing commits, the adoption set  src/post-merge/github.mjs
//   3 post-merge-adopt     each path's sides decided by the outcome table   src/post-merge/decide.mjs
//   4 post-merge-signing   the rx signing key, registered on GitHub         src/post-merge/signing.mjs
//   5 post-merge-commit    Prepare and Sign                                 src/post-merge/commit.mjs
//                          Install under git's index lock                   src/post-merge/install.mjs
//   6 post-merge-push      the cleanup commit to the upstream's single URL  src/post-merge/push.mjs
//
// Writes, without --dry-run (the documented payload exception, docs/commands.md §1): the adopted
// blobs, a tree and the signed commit into the object database (validate phase: unreachable until
// Install); then, under index.lock, the index entries of the adopted paths (every other entry is
// kept), the adopted files (temp file plus rename; a STAMP replaces one heading line), and the
// current branch, moved one commit by update-ref against its old value; finally a push of that one
// commit to the branch's upstream URL. The signing key is created on first need. No repo state of
// rx's own is written. Under --dry-run every read and check runs and nothing outside the cache is
// written.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RxError } from "../errors.mjs";
import { topLevel } from "../git.mjs";
import { PUBLICATION_FILE, readPublication } from "../publication.mjs";
import { withPublishedCopy } from "../published-copy.mjs";
import { repoStatePathReadOnly } from "../state.mjs";
import { prepare, sign } from "../post-merge/commit.mjs";
import { decidePath } from "../post-merge/decide.mjs";
import { readPull, readRewrites } from "../post-merge/github.mjs";
import { install } from "../post-merge/install.mjs";
import { cleanupSubject, planPush, push, qualifyHead } from "../post-merge/push.mjs";
import { currentBranch, headCommit, localRepo, operationInProgress } from "../post-merge/sides.mjs";
import { checkSigning } from "../post-merge/signing.mjs";

export { _setInstallStopForTests } from "../post-merge/install.mjs";
export { _setBeforeSignForTests } from "../post-merge/commit.mjs";

const STEPS = /** @type {const} */ (["post-merge-pr", "post-merge-rewrites", "post-merge-adopt", "post-merge-signing", "post-merge-commit", "post-merge-push"]);
/** @typedef {typeof STEPS[number]} Step */

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "post-merge",
  summary: "after raycast/extensions merges this extension's PR, adopt raycastbot's merge-time rewrites (CHANGELOG stamp, recompressed PNGs) in one signed commit and push it",
  root: "required",
  positionals: [{ name: "pr", required: false, help: "pull request number in raycast/extensions (default: repo/publication.json's pr when its repo is raycast/extensions)" }],
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root (inside a git work tree)" },
    "--dry-run": { type: "boolean", help: "run every read and check, print the plan (files, commit message, push) and write nothing outside the cache" },
  },
  network:
    "GitHub API through the transport (the pull request, its commits, each raycastbot commit, two tree listings, the authenticated user and that user's SSH signing keys); the published-copy refresh (git fetch of raycast/extensions into the cache); git ls-remote and git push of the current branch's upstream URL",
  state:
    "reads repo/publication.json; refreshes cache/upstream/; creates the signing key on first need (never under --dry-run); without --dry-run writes the adopted blobs, a tree and the signed commit into the object database, then under index.lock sets the adopted paths' index entries (keeping every other entry), writes the adopted files into the payload and moves the current branch by one commit (update-ref against its old value), then pushes that commit; writes no repo state of its own; under --dry-run writes nothing outside the cache",
  checks: {
    "post-merge-pr": { description: "the PR's head is ext/<name> and it merged (N/A when open or closed unmerged)", levels: ["PASS", "FAIL", "N/A", "ERROR"] },
    "post-merge-rewrites": { description: "raycastbot's trailing commits on the PR branch modified or added only files inside the extension", levels: ["PASS", "FAIL", "N/A", "ERROR"] },
    "post-merge-adopt": { description: "every rewritten path is ALREADY, ADOPT or STAMP under the outcome table", levels: ["PASS", "FAIL", "N/A", "ERROR"] },
    "post-merge-signing": { description: "the rx signing key exists and is registered on GitHub as a signing key", levels: ["PASS", "FAIL", "WARN", "N/A", "ERROR"] },
    "post-merge-commit": { description: "the signed cleanup commit, installed under git's index lock (under --dry-run, the planned one)", levels: ["PASS", "FAIL", "N/A", "ERROR"] },
    "post-merge-push": { description: "the cleanup commit goes to the branch's single upstream URL as a one-commit fast-forward", levels: ["PASS", "WARN", "N/A", "ERROR"] },
  },
  data: {
    pr: "int — the pull request number used",
    merged: "boolean",
    mergeCommit: "string | null",
    branch: "string | null",
    rewrites: "[{ sha, files: string[] }] — raycastbot's trailing commits and the extension-relative files each changed",
    files: "[{ path, outcome: ADOPT | STAMP | ALREADY | FAIL, pre: string | null, post, head: string | null, index: string | null, work: string | null, reason: string | null }] — path extension-relative; the side values are blob ids",
    signingKey: "{ path, created: boolean, registered: boolean | null } | null",
    commit: "string | null — the cleanup commit this run made",
    pushed: "{ remote, branch } | null — the remote name and the merge ref pushed",
    dryRun: "boolean",
  },
};

/** @typedef {import("../post-merge/decide.mjs").PathPlan} PathPlan */
/** @typedef {(verdict: "PASS" | "FAIL" | "WARN" | "N/A", id: Step, message: string, details?: import("../verdict.mjs").Detail[]) => void} Record */

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, root, results, log }) {
  const dir = /** @type {string} */ (root);
  const dryRun = args.flags["--dry-run"] === true;
  const data = {
    pr: /** @type {number | null} */ (null),
    merged: false,
    mergeCommit: /** @type {string | null} */ (null),
    branch: /** @type {string | null} */ (null),
    rewrites: /** @type {Array<{ sha: string, files: string[] }>} */ ([]),
    files: /** @type {object[]} */ ([]),
    signingKey: /** @type {object | null} */ (null),
    commit: /** @type {string | null} */ (null),
    pushed: /** @type {{ remote: string, branch: string } | null} */ (null),
    dryRun,
  };
  /** @type {Set<string>} */
  const emitted = new Set();
  /** @type {Record} */
  const record = (verdict, id, message, details = []) => {
    results.add(verdict, id, message, details);
    emitted.add(id);
  };
  /** @type {Step | null} */
  let current = null;
  /** Every step not yet emitted is N/A with this reason. @param {string} why */
  const done = (why) => {
    for (const id of STEPS) if (!emitted.has(id)) results.na(id, `not reached: ${why}`);
    return { data };
  };

  try {
    const given = positionalPr(args.positionals.pr);
    const name = readName(dir);
    const repo = await localRepo(dir);
    const rec = readPublication(await repoStatePathReadOnly(dir, PUBLICATION_FILE));
    const n = given ?? recordedPr(rec);
    data.pr = n;

    // 1. The pull request.
    current = "post-merge-pr";
    const pull = await readPull(n);
    if (pull.ref !== `ext/${name}`) {
      record("FAIL", current, `#${n} is ${pull.ref}, not this extension's PR`);
      return done(`${current} did not pass`);
    }
    if (!pull.merged) {
      record("N/A", current, pull.state === "open" ? `#${n} is open, not merged; nothing to clean up` : `#${n} was closed without merging`);
      return done("post-merge-pr found no merge");
    }
    data.merged = true;
    data.mergeCommit = pull.mergeSha;
    record("PASS", current, `#${n} merged ${pull.mergedAt} as ${String(pull.mergeSha).slice(0, 7)}`);

    // 2. raycastbot's rewrites.
    current = "post-merge-rewrites";
    const rw = await readRewrites({ n, name, record: rec });
    if (rw.status === "fail") {
      record("FAIL", current, rw.message, rw.details);
      return done(`${current} did not pass`);
    }
    data.rewrites = rw.run;
    record("PASS", current, rw.message, rw.details);

    // 3–5. The published copy's lock is held from the refresh through Install. The refresh runs
    // for an empty adoption set too, so a refresh failure is an ERROR whatever the set.
    current = "post-merge-adopt";
    /** @param {string | null} cacheRoot */
    const steps = (cacheRoot) =>
      adoptAndCommit({ top: repo.top, prefix: repo.prefix, name, cacheRoot, paths: rw.paths, n, mergeSha: /** @type {string} */ (pull.mergeSha), dryRun, data, record, setCurrent: (id) => (current = id) });
    const plan = await withPublishedCopy({ name, refresh: true, log }, async (copy) => steps(copy.published && copy.directory && rw.paths.length ? await topLevel(copy.directory) : null));
    if (plan.stop) return done(plan.stop);

    // 6. The push.
    current = "post-merge-push";
    const branch = /** @type {string} */ (data.branch);
    /** @type {{ sha: string | null, parent: string } | null} */
    let cleanup = plan.cleanup;
    if (!cleanup) {
      const q = await qualifyHead({ top: repo.top, n, rows: plan.rows });
      if (q.status === "mismatch") {
        record("WARN", current, "HEAD carries the cleanup subject but changes more than raycastbot's files; not pushed");
        return done("");
      }
      if (q.status === "none") {
        record("N/A", current, "nothing committed");
        return done("");
      }
      cleanup = { sha: q.sha, parent: q.parent };
    }
    const target = await planPush({ top: repo.top, branch, parent: cleanup.parent });
    if (target.verdict !== "PASS" || !target.target || dryRun || !cleanup.sha) {
      record(target.verdict, current, target.message, target.details);
      return done("");
    }
    const { remote, url, mergeRef, tip } = target.target;
    await push({ top: repo.top, url, mergeRef, tip, commit: cleanup.sha });
    data.pushed = { remote, branch: mergeRef };
    record("PASS", current, `pushed ${cleanup.sha.slice(0, 7)} to ${url} ${mergeRef}`);
    return done("");
  } catch (e) {
    // One completion path for every exception. A step that throws reports ERROR under its own check
    // id, the message led by the underlying id (`github: …`, `git: …`, `internal: …`); the steps
    // after it are not reached. An error before step 1 (args, input, root) is reported under its own
    // id, and every step is not reached.
    const cause = e instanceof RxError ? e.id : "internal";
    const text = e instanceof Error ? e.message : String(e);
    // git's stderr can span lines: the first is the message, the rest are details.
    const [first, ...rest] = text.split(/\r?\n/);
    const details = rest.filter((l) => l.trim()).map((t) => ({ text: t }));
    const message = first.trim() || text.trim() || "(no message)";
    if (current === null) results.error(cause, message, details);
    else {
      results.error(current, `${cause}: ${message}`, details);
      emitted.add(current);
    }
    return done(`${current ?? cause} did not pass`);
  }
}

/**
 * Steps 3, 4 and 5 (Prepare, Sign, Install). Records each step's result. `stop` is the not-reached
 * reason for the steps after the one that stopped; `cleanup` is the commit this run made (`sha`
 * null under --dry-run, where the planned commit stands in) with its parent; `rows` is step 3's
 * plan, for the HEAD qualification of a run that commits nothing.
 * @param {{ top: string, prefix: string, name: string, cacheRoot: string | null, paths: import("../post-merge/github.mjs").RewritePath[], n: number, mergeSha: string, dryRun: boolean,
 *   data: any, record: Record, setCurrent: (id: Step) => void }} o
 * @returns {Promise<{ stop: string | null, cleanup: { sha: string | null, parent: string } | null, rows: PathPlan[] }>}
 */
async function adoptAndCommit({ top, prefix, name, cacheRoot, paths, n, mergeSha, dryRun, data, record, setCurrent }) {
  /** @param {string} stop */
  const stopped = (stop) => ({ stop, cleanup: null, rows: /** @type {PathPlan[]} */ ([]) });

  // 3. Adopt.
  const op = await operationInProgress(top);
  if (op) {
    record("FAIL", "post-merge-adopt", `a ${op} is in progress; finish it first`);
    return stopped("post-merge-adopt did not pass");
  }
  const branch = await currentBranch(top);
  if (!branch) {
    record("FAIL", "post-merge-adopt", "HEAD is detached; check out the branch to clean up");
    return stopped("post-merge-adopt did not pass");
  }
  data.branch = branch;
  const oldHead = await headCommit(top);

  /** @type {PathPlan[]} */
  const rows = [];
  for (const p of paths) rows.push(await decidePath({ top, prefix, cacheRoot, name }, p));
  data.files = rows.map((r) => ({ path: r.path, outcome: r.outcome, pre: r.pre?.blob ?? null, post: r.post.blob, head: r.head?.blob ?? null, index: r.index?.blob ?? null, work: r.work?.blob ?? null, reason: r.reason }));
  const details = rows.flatMap((r) => [
    { file: r.path, text: r.outcome === "FAIL" ? `FAIL: ${r.reason}` : r.outcome },
    ...(r.hint ? [{ file: r.path, text: r.hint }] : []),
  ]);
  const failed = rows.filter((r) => r.outcome === "FAIL");
  if (failed.length) {
    record("FAIL", "post-merge-adopt", `${failed.length} of ${rows.length} file(s) cannot be adopted`, details);
    return stopped("post-merge-adopt did not pass");
  }
  const count = (/** @type {PathPlan["outcome"]} */ o) => rows.filter((r) => r.outcome === o).length;
  if (rows.length === 0) record("PASS", "post-merge-adopt", "nothing to adopt");
  else record("PASS", "post-merge-adopt", `${count("ADOPT")} to adopt, ${count("STAMP")} to stamp, ${count("ALREADY")} already adopted`, details);

  // 4. Signing, only when there is something to commit.
  const commit = rows.filter((r) => r.outcome === "ADOPT" || r.outcome === "STAMP").sort((a, b) => (a.repoPath < b.repoPath ? -1 : a.repoPath > b.repoPath ? 1 : 0));
  if (commit.length === 0) {
    record("N/A", "post-merge-signing", "nothing to commit");
    record("N/A", "post-merge-commit", "nothing to commit");
    return { stop: null, cleanup: null, rows };
  }
  setCurrent("post-merge-signing");
  const signing = await checkSigning({ top, dryRun });
  data.signingKey = signing.data;
  record(signing.verdict, "post-merge-signing", signing.message, signing.details);
  if (!signing.goOn) return stopped("post-merge-signing did not pass");

  // 5. The commit: Prepare (the hash check alone under --dry-run), Sign, Install.
  setCurrent("post-merge-commit");
  const tree = await prepare({ top, oldHead, commit, dryRun });
  const message = commitMessage({ n, name, mergeSha, paths: commit.map((r) => r.repoPath) });
  if (dryRun || tree === null) {
    record("PASS", "post-merge-commit", `would commit on ${branch}: ${commit.length} file(s)`, message.split("\n").map((text) => ({ text })));
    return { stop: null, cleanup: { sha: null, parent: oldHead }, rows };
  }
  const sha = await sign({ top, tree, oldHead, privateKey: /** @type {string} */ (signing.privateKey), message });
  const installed = await install({ top, branch, oldHead, commitSha: sha, n, commit });
  if (installed.verdict === "FAIL") {
    record("FAIL", "post-merge-commit", installed.message);
    return stopped("post-merge-commit did not pass");
  }
  data.commit = sha;
  record("PASS", "post-merge-commit", `committed ${sha.slice(0, 7)} on ${branch}: ${commit.length} file(s)`, commit.map((r) => ({ file: r.repoPath, text: r.outcome })));
  return { stop: null, cleanup: { sha, parent: oldHead }, rows };
}

/**
 * The cleanup commit's message.
 * @param {{ n: number, name: string, mergeSha: string, paths: string[] }} o paths repository-relative, in path order
 */
export function commitMessage({ n, name, mergeSha, paths }) {
  return [cleanupSubject(n), "", `raycastbot rewrote these files on ext/${name} before the squash (${mergeSha.slice(0, 7)}):`, ...paths.map((p) => `- ${p}`)].join("\n");
}

/** The `<pr>` positional, checked before anything is read; null when absent. @param {string | undefined} raw */
function positionalPr(raw) {
  if (raw === undefined) return null;
  if (!/^[1-9]\d*$/.test(raw)) throw new RxError(`<pr> must be a positive decimal integer, got ${JSON.stringify(raw)}`, { id: "args" });
  return Number(raw);
}

/** The publication record's pull request, when the record is for raycast/extensions. @param {import("../publication.mjs").PublicationRecord | null} rec */
function recordedPr(rec) {
  if (!rec || rec.repo !== "raycast/extensions") throw new RxError("no pull request given and no publication record for raycast/extensions; pass the number", { id: "input" });
  return rec.pr;
}

/** @param {string} dir */
function readName(dir) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (e) {
    throw new RxError(`cannot read ${join(dir, "package.json")}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  if (typeof pkg?.name !== "string" || !pkg.name.trim()) throw new RxError(`package.json in ${dir} has no "name"`, { id: "input" });
  return pkg.name;
}

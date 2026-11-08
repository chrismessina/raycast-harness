// `rx contributions --published d [--root d] [--json]` (docs/commands.md §4.6). Run during a
// `pull-contributions` merge, from the extension root or a monorepo checkout (T1, T2).
//
// For each conflicted path under the extension subtree, the decision uses only two blobs: the
// incoming side (MERGE_HEAD) and the published copy. Incoming == published → OURS-SAFE (taking ours
// discards nothing the contributor wrote). Incoming != published → REAL-CONTRIBUTION, whatever ours
// holds. CHANGELOG containment (every incoming heading already in ours, bodies equal) decides only
// CHANGELOG.md. Path sets are compared in both directions and a missing object is an ERROR, never
// silence.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PLACEHOLDER, isHeading, parseChangelog, sameEntry } from "../changelog/parse.mjs";
import { RxError } from "../errors.mjs";
import { run as exec } from "../exec.mjs";
import { git, topLevel } from "../git.mjs";
import { withPublishedCopy } from "../published-copy.mjs";
import { skipSegment } from "../upstream.mjs";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "contributions",
  summary: "during a pull-contributions merge: is each conflicted file a real contribution, or the published copy coming back?",
  root: "required",
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root (inside a standalone or monorepo checkout)" },
    "--published": { type: "string", value: "<dir>", required: true, help: "the published copy of the extension (rx stale's publishedDir)" },
  },
  network: "none",
  state: "none",
  checks: {
    contributions: { description: "ERROR: no merge in progress, --published missing or empty, or a missing object (never silence)", levels: ["ERROR"] },
    contribution: "one per conflicted path: OURS-SAFE (incoming == published; PASS) or REAL-CONTRIBUTION (FAIL); N/A when nothing is conflicted",
    "contribution-branch": { description: "WARN when a leftover ext/<name> branch (or MERGE_HEAD) adds only raycastbot's CHANGELOG date stamp (proven by content); PASS otherwise, each rejected candidate's reason in details", levels: ["PASS", "WARN"] },
  },
  data: {
    extension: "string — the extension subtree relative to the repository top level ('' when standalone)",
    conflicted: "[{ path, outcome, ours, incoming, published }] — blob ids (null when a side lacks the path)",
    incomingTree: "{ onlyIncoming: string[], onlyPublished: string[], differing: string[] } — MERGE_HEAD's extension subtree versus --published, both directions",
    leftoverBranch: "{ name, commit } | null",
  },
};

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ results, root, args }) {
  const dir = /** @type {string} */ (root);
  const publishedDir = resolve(String(args.flags["--published"]));
  if (!nonEmptyDir(publishedDir)) throw new RxError(`--published ${publishedDir} is missing or empty; run rx stale first`, { id: "contributions" });
  // The published copy normally lives in the shared upstream cache; the published-copy service
  // holds its lock for the whole comparison so a concurrent fetch cannot swap the tree under this
  // read. A directory outside the cache is neither locked nor refreshed.
  return withPublishedCopy({ directory: publishedDir }, (copy) => decide(dir, /** @type {string} */ (copy.directory), results));
}

/**
 * @param {string} dir @param {string} publishedDir @param {import("../verdict.mjs").Results} results
 * @returns {Promise<import("../cli.mjs").CommandOutput>}
 */
async function decide(dir, publishedDir, results) {
  const top = realpathSync(await topLevel(dir));
  const prefix = relative(top, realpathSync(dir)).split("\\").join("/");
  const mh = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir, allowFail: true });
  if (mh.code !== 0) throw new RxError("no merge in progress (no MERGE_HEAD); run pull-contributions first", { id: "contributions" });
  const name = readName(dir);

  // Conflicted paths under the extension subtree, relative to the extension root.
  const unmerged = await git(["ls-files", "-u", "-z", "--", "."], { cwd: dir });
  /** @type {Map<string, Record<number, string>>} path → stage → blob */
  const stages = new Map();
  for (const rec of unmerged.stdout.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [, blob, stage] = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    const s = stages.get(path) ?? {};
    s[Number(stage)] = blob;
    stages.set(path, s);
  }
  // `ls-files -u .` from a subdirectory prints paths relative to it.
  const conflicted = [...stages.keys()].sort();

  // Whole-tree comparison of MERGE_HEAD's extension subtree with the published copy, both directions.
  const incomingTree = await treeDiff(dir, prefix, publishedDir);

  /** @type {Array<{ path: string, outcome: string, ours: string | null, incoming: string | null, published: string | null }>} */
  const rows = [];
  if (!conflicted.length) {
    const same = !incomingTree.onlyIncoming.length && !incomingTree.onlyPublished.length && !incomingTree.differing.length;
    results.na("contribution", `no conflicted paths under ${prefix || "the extension root"}${same ? "; MERGE_HEAD's extension tree equals the published copy" : `; MERGE_HEAD's extension tree differs from published (${incomingTree.differing.length} differing, ${incomingTree.onlyIncoming.length} only incoming, ${incomingTree.onlyPublished.length} only published)`}`);
  }
  for (const path of conflicted) {
    const s = /** @type {Record<number, string>} */ (stages.get(path));
    const ours = s[2] ?? null;
    const incoming = s[3] ?? null;
    if (!incoming) throw new RxError(`${path}: no incoming (MERGE_HEAD) object; a delete/modify conflict needs a hand decision`, { id: "contributions" });
    const pubFile = join(publishedDir, path);
    const published = existsSync(pubFile) && statSync(pubFile).isFile() ? await hashAsPath(dir, path, pubFile) : null;
    let outcome;
    let text;
    if (published && incoming === published) {
      outcome = "OURS-SAFE";
      text = `OURS-SAFE incoming ${incoming} == published ${published}`;
    } else if (path === "CHANGELOG.md" && ours && (await changelogContained(dir, incoming, ours))) {
      outcome = "OURS-SAFE";
      text = `OURS-SAFE incoming ${incoming} is contained in ours ${ours} (every incoming CHANGELOG entry is already here, byte for byte)`;
    } else {
      outcome = "REAL-CONTRIBUTION";
      text = published ? `REAL-CONTRIBUTION incoming ${incoming} != published ${published}` : `REAL-CONTRIBUTION incoming ${incoming}; published copy lacks ${path}`;
    }
    rows.push({ path, outcome, ours, incoming, published });
    results.add(outcome === "OURS-SAFE" ? "PASS" : "FAIL", "contribution", outcome === "OURS-SAFE" ? "taking ours discards nothing the contributor wrote" : "a real contribution: reconcile this file by hand, never --ours", [{ file: path, text }]);
  }

  const { stamp, rejected } = await leftoverBranch(dir, name, prefix);
  if (stamp) results.warn("contribution-branch", `${stamp.name} adds only raycastbot's CHANGELOG date stamp (${stamp.commit.slice(0, 12)}): a merged PR's leftover, not new work`);
  else results.pass("contribution-branch", `no leftover ext/${name} branch carrying only a bot date stamp`, rejected.map((text) => ({ text })));

  return { data: { extension: prefix, conflicted: rows, incomingTree, leftoverBranch: stamp } };
}

/** @param {string} dir */
function readName(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (typeof pkg?.name === "string" && pkg.name.trim()) return pkg.name;
  } catch { /* fall through */ }
  throw new RxError(`cannot read "name" from ${join(dir, "package.json")}`, { id: "input" });
}

/** @param {string} dir */
function nonEmptyDir(dir) {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * The blob id a file would have if committed at `path` in this repository (`git hash-object
 * --path` applies the repository's clean filters), so a published file compares with committed
 * blobs on equal terms.
 * @param {string} cwd @param {string} path @param {string} file
 */
async function hashAsPath(cwd, path, file) {
  return (await git(["hash-object", "--path", path, "--", file], { cwd })).stdout.trim();
}

/**
 * MERGE_HEAD's copy of the extension versus the published directory, both directions.
 * @param {string} dir extension root
 * @param {string} prefix extension subtree relative to the repository top level
 * @param {string} publishedDir
 */
async function treeDiff(dir, prefix, publishedDir) {
  const r = await git(["ls-tree", "-r", "-z", "MERGE_HEAD", "."], { cwd: dir, allowFail: true });
  if (r.code !== 0) throw new RxError(`MERGE_HEAD has no ${prefix || "extension"} tree: ${r.stderr.trim().split("\n")[0] ?? ""}`, { id: "contributions" });
  /** @type {Map<string, string>} */
  const incoming = new Map();
  for (const rec of r.stdout.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [, , blob] = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    if (path.split("/").some(skipSegment)) continue;
    incoming.set(path, blob);
  }
  /** @type {Map<string, string>} */
  const published = new Map();
  const visit = async (/** @type {string} */ abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (skipSegment(e.name)) continue;
      const full = join(abs, e.name);
      if (e.isDirectory()) await visit(full);
      else if (e.isFile()) {
        const rel = relative(publishedDir, full).split("\\").join("/");
        published.set(rel, await hashAsPath(dir, rel, full));
      }
    }
  };
  await visit(publishedDir);
  const onlyIncoming = [...incoming.keys()].filter((p) => !published.has(p)).sort();
  const onlyPublished = [...published.keys()].filter((p) => !incoming.has(p)).sort();
  const differing = [...incoming.keys()].filter((p) => published.has(p) && published.get(p) !== incoming.get(p)).sort();
  return { onlyIncoming, onlyPublished, differing };
}

/**
 * Is every entry of the incoming CHANGELOG already in ours, byte for byte, in the same order from
 * the first shared heading down? Stamped-versus-placeholder headings count as the same entry.
 * @param {string} cwd @param {string} incomingBlob @param {string} oursBlob
 */
async function changelogContained(cwd, incomingBlob, oursBlob) {
  const read = async (/** @type {string} */ blob) => {
    // Raw stdout: `git()` trims one trailing newline, which would turn a CRLF blob's last line into
    // a bare CR and break the byte-for-byte comparison.
    const r = await exec("git", ["cat-file", "blob", blob], { cwd, id: "git" });
    if (r.code !== 0) throw new RxError(`CHANGELOG.md blob ${blob} is missing from this repository`, { id: "contributions" });
    return parseChangelog(r.stdout);
  };
  const theirs = await read(incomingBlob);
  const ours = await read(oursBlob);
  if (!theirs.entries.length) return false;
  const start = ours.entries.findIndex((e) => sameEntry(e, theirs.entries[0]));
  if (start === -1) return false;
  const tail = ours.entries.slice(start);
  if (tail.length !== theirs.entries.length) return false;
  // Same entry identity as the boundary (a stamped heading and its placeholder form are one
  // entry); bodies byte for byte, line endings included.
  return tail.every((o, i) => sameEntry(o, theirs.entries[i]) && o.body === theirs.entries[i].body);
}

/**
 * A leftover `ext/<name>` branch (local or remote-tracking), or MERGE_HEAD itself, whose only
 * commit beyond HEAD is raycastbot's merge-time "Update CHANGELOG.md" date stamp: one commit,
 * raycastbot as author or committer, that subject, a patch touching nothing but the extension's
 * CHANGELOG.md (`git diff-tree`), and that patch proven to be the stamp by content (`notAStamp`).
 * Anything else is real work; `rejected` says why each candidate was not a stamp.
 * @param {string} cwd extension root @param {string} name @param {string} prefix extension subtree relative to the top level
 * @returns {Promise<{ stamp: { name: string, commit: string } | null, rejected: string[] }>}
 */
async function leftoverBranch(cwd, name, prefix) {
  const refs = await git(["for-each-ref", "--format=%(refname)", `refs/heads/ext/${name}`, `refs/remotes/*/ext/${name}`], { cwd, allowFail: true });
  const candidates = refs.code === 0 ? refs.stdout.split("\n").filter(Boolean) : [];
  candidates.push("MERGE_HEAD");
  /** @type {string[]} */
  const rejected = [];
  const changelog = prefix ? `${prefix}/CHANGELOG.md` : "CHANGELOG.md";
  for (const ref of candidates) {
    const short = ref.replace(/^refs\/(heads|remotes)\//, "");
    const list = await git(["rev-list", `HEAD..${ref}`], { cwd, allowFail: true });
    if (list.code !== 0) continue;
    const commits = list.stdout.split("\n").filter(Boolean);
    if (commits.length !== 1) { if (commits.length) rejected.push(`${short}: ${commits.length} commits beyond HEAD`); continue; }
    const c = commits[0];
    const info = await git(["log", "-1", "--format=%an%n%cn%n%s", c], { cwd, allowFail: true });
    if (info.code !== 0) continue;
    const [author, committer, subject] = info.stdout.split("\n");
    if (!/raycastbot/i.test(`${author} ${committer}`) || !/update changelog\.md/i.test(subject ?? "")) { rejected.push(`${short}: ${c.slice(0, 12)} is not a raycastbot "Update CHANGELOG.md" commit`); continue; }
    const touched = await git(["diff-tree", "-r", "--no-commit-id", "--name-only", "--root", c], { cwd, allowFail: true });
    if (touched.code !== 0) continue;
    const files = touched.stdout.split("\n").filter(Boolean);
    if (files.length !== 1 || files[0] !== changelog) { rejected.push(`${short}: ${c.slice(0, 12)} touches ${files.join(", ") || "nothing"}, not only ${changelog}`); continue; }
    const why = await notAStamp(cwd, c, changelog);
    if (why) { rejected.push(`${short}: ${c.slice(0, 12)} ${why}`); continue; }
    return { stamp: { name: short, commit: c }, rejected };
  }
  return { stamp: null, rejected };
}

/**
 * Is the change `commit` makes to `path` exactly one `## ` heading whose `{PR_MERGE_DATE}` became a
 * `YYYY-MM-DD` date, every other byte identical to the parent? Null when it is, else the reason.
 * @param {string} cwd @param {string} commit @param {string} path repo-relative
 */
async function notAStamp(cwd, commit, path) {
  const blob = async (/** @type {string} */ rev) => {
    const r = await exec("git", ["show", `${rev}:${path}`], { cwd, id: "git" }); // raw: no trailing-newline trim
    return r.code === 0 ? r.stdout : null;
  };
  const before = await blob(`${commit}^`);
  const after = await blob(commit);
  if (before === null) return `adds ${path} (no parent copy)`;
  if (after === null) return `deletes ${path}`;
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return `changes the line count of ${path} (${a.length} → ${b.length}), not just a date`;
  const changed = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i !== -1);
  if (changed.length === 0) return `leaves ${path} unchanged`;
  if (changed.length !== 1) return `changes ${changed.length} lines of ${path}, not just a date`;
  const i = changed[0];
  const date = b[i].match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!isHeading(a[i]) || !a[i].includes(PLACEHOLDER) || !date || a[i].replace(PLACEHOLDER, date) !== b[i])
    return `changes line ${i + 1} of ${path} (${JSON.stringify(a[i].trim())} → ${JSON.stringify(b[i].trim())}), not a ${PLACEHOLDER} date stamp`;
  return null;
}

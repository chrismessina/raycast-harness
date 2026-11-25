#!/usr/bin/env node
// The GitHub release that matches an npm release. npm's registry record is the authority: the
// GitHub tag and release go on the commit npm recorded for the version (`gitHead`), with the notes
// from that commit's CHANGELOG, and only once npm lists the version.
//
//   prepublishOnly → `node scripts/github-release.mjs --check` (no side effects, so a dry run is
//     harmless): refuse the upload unless origin/main is an ancestor of HEAD, HEAD is a clean `main`,
//     no v<version> tag points elsewhere, package.json carries no gitHead of its own, and HEAD's
//     CHANGELOG section passes changelogProblems(). The slow fetch runs first and HEAD is re-read
//     last, so what was validated is what npm packs.
//   postpublish → `node scripts/github-release.mjs`: finish the version npm just uploaded
//     (npm_package_name / npm_package_version, never the file on disk).
//   by hand → `node scripts/github-release.mjs <version>`: finish that version. Needed after a
//     staged upload is approved (approval runs no package scripts), and after any failure.
//
// Finishing: wait up to 60 s for npm to list the version (a fresh upload can lag); fetch main and
// fast-forward origin to the recorded commit if it is ahead; create the signed tag on that commit
// (SSH signing: 1Password must be unlocked) and push it, verifying any existing local or remote
// tag points at it; create the GitHub release. Every step checks before it acts, so a rerun
// finishes from wherever the last attempt stopped. A tarball upload (`npm publish <file>.tgz`)
// runs no package scripts and may record no gitHead, so it is unsupported.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Group headings a version's section may use, in this order, and each item's character budget. */
export const GROUPS = Object.freeze({ Breaking: 240, New: 160, Changed: 140, Fixed: 120 });
const SUMMARY_BUDGET = 200;

/**
 * @typedef {import("mdast").Root} Root
 * @typedef {import("mdast").RootContent} Node
 */

/** The text of a heading node. @param {Node} n @returns {string} */
const textOf = (n) => ("value" in n ? String(n.value) : "children" in n ? n.children.map((c) => textOf(/** @type {Node} */ (c))).join("") : "");

/** @param {Node} n */
const start = (n) => /** @type {number} */ (n.position?.start.offset);
/** @param {Node} n */
const end = (n) => /** @type {number} */ (n.position?.end.offset);

/**
 * A version's CHANGELOG section, found by the Markdown parser: the depth-2 heading whose text is
 * the version, through the node before the next heading of depth 1 or 2. A heading inside a code
 * block is code, so it neither starts nor ends a section.
 * @param {string} changelog @param {string} version
 * @returns {{ nodes: Node[], from: number, to: number }}
 */
function section(changelog, version) {
  const tree = fromMarkdown(changelog, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const at = tree.children.findIndex((n) => n.type === "heading" && n.depth === 2 && textOf(n).trim() === version);
  if (at === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const rest = tree.children.slice(at + 1);
  const stop = rest.findIndex((n) => n.type === "heading" && n.depth <= 2);
  const nodes = stop === -1 ? rest : rest.slice(0, stop);
  if (!nodes.length) throw new Error(`CHANGELOG.md's "## ${version}" section is empty`);
  return { nodes, from: start(nodes[0]), to: end(nodes[nodes.length - 1]) };
}

/**
 * The GitHub release body for `version`: its CHANGELOG section byte for byte, then a line to run
 * that version. Nothing is rewritten: changelogProblems() requires each paragraph and item on one
 * line, since GitHub shows every line break in a release body.
 * @param {string} changelog @param {string} version @param {string} name the npm package name
 */
export function releaseNotes(changelog, version, name) {
  const { from, to } = section(changelog, version);
  return `${changelog.slice(from, to)}\n\nRun it: \`npx ${name}@${version} commands\`\n`;
}

/**
 * What keeps a version's CHANGELOG section from being skimmable or self-contained: at most one
 * summary paragraph (SUMMARY_BUDGET characters), then one list under each GROUPS heading, in that
 * order, none empty, each top-level item within its group's budget, and no reference link whose
 * definition the release notes would leave behind.
 * @param {string} changelog @param {string} version @returns {string[]}
 */
export function changelogProblems(changelog, version) {
  const { nodes } = section(changelog, version);
  /** @type {string[]} */
  const problems = [];
  const order = Object.keys(GROUPS);
  const source = (/** @type {Node} */ n) => changelog.slice(start(n), end(n));
  /** @param {Node} n @returns {boolean} */
  const hasReference = (n) => ["linkReference", "imageReference", "definition", "footnoteReference", "footnoteDefinition"].includes(n.type) || ("children" in n && n.children.some((c) => hasReference(/** @type {Node} */ (c))));
  if (nodes.some(hasReference)) problems.push("a reference link or image needs a definition outside the section; write the URL inline");
  /** A paragraph's line endings other than those a hard break (`\\` or trailing spaces) owns. @param {Node} n */
  const wrapped = (n) => {
    if (n.type === "paragraph") {
      /** @type {[number, number][]} */
      const hard = [];
      /** @param {Node} c */
      const breaks = (c) => {
        if (c.type === "break") hard.push([start(c), end(c)]);
        if ("children" in c) for (const k of c.children) breaks(/** @type {Node} */ (k));
      };
      breaks(n);
      const text = source(n);
      for (const m of text.matchAll(/\r\n?|\n/g)) {
        const at = start(n) + /** @type {number} */ (m.index);
        if (!hard.some(([a, b]) => at >= a && at < b)) {
          problems.push(`a line break inside a paragraph ("${text.split(/\r\n?|\n/)[0].slice(0, 40)}"); write each paragraph and item on one line`);
          return;
        }
      }
    }
    if ("children" in n) for (const c of n.children) wrapped(/** @type {Node} */ (c));
  };
  for (const n of nodes) wrapped(n);
  /** @type {string | null} */
  let group = null;
  let items = 0;
  let summaries = 0;
  const closeGroup = () => {
    if (group && group !== "?" && items === 0) problems.push(`"### ${group}" has no items; leave an empty group out`);
  };
  for (const n of nodes) {
    if (n.type === "heading") {
      closeGroup();
      const name = textOf(n).trim();
      items = 0;
      if (n.depth !== 3 || !order.includes(name)) {
        problems.push(`"${"#".repeat(n.depth)} ${name}" is not a group; use ${order.map((g) => `### ${g}`).join(", ").replace(/, (?=[^,]*$)/, " or ")}`);
        group = "?";
        continue;
      }
      if (group && group !== "?" && order.indexOf(name) <= order.indexOf(group)) problems.push(`"### ${name}" comes after "### ${group}"; the order is ${order.join(", ")}`);
      group = name;
    } else if (n.type === "list") {
      if (!group) { problems.push("a list before any group heading"); continue; }
      if (group === "?") continue; // its heading is already reported
      if (items) problems.push(`a second list inside "### ${group}"; keep one list per group`);
      items += n.children.length;
      const budget = GROUPS[/** @type {keyof typeof GROUPS} */ (group)];
      for (const item of n.children) {
        const length = source(/** @type {Node} */ (item)).split(/\r\n?|\n/)[0].replace(/^([-*+]|\d+[.)])\s+/, "").trimEnd().length;
        if (length > budget) problems.push(`a ${group} item is ${length} characters; the budget is ${budget}`);
      }
    } else if (group) problems.push(`a ${n.type} inside "### ${group}"; write it as an item`);
    else if (n.type !== "paragraph") problems.push(`a ${n.type} above the groups; only a summary paragraph goes there`);
    else if (++summaries === 2) problems.push("more than one summary paragraph; keep one sentence or two above the groups");
    else if (summaries === 1 && source(n).length > SUMMARY_BUDGET) problems.push(`the summary is ${source(n).length} characters; the budget is ${SUMMARY_BUDGET}`);
  }
  closeGroup();
  return problems;
}

/** An exact release version, `1.2.3`: never `v1.2.3`, `latest`, a range or a prerelease. @param {string} v */
export const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(v);

/** Numeric order of release versions. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const na = a.split(".").map(Number);
  const nb = b.split(".").map(Number);
  return na[0] - nb[0] || na[1] - nb[1] || na[2] - nb[2];
}

const root = join(fileURLToPath(import.meta.url), "..", "..");
/** @param {string} cmd @param {string[]} args @param {{ input?: string }} [o] */
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", input: o.input, stdio: [o.input === undefined ? "inherit" : "pipe", "pipe", "pipe"] }).trim();
/** A file at a commit, byte for byte (run() trims). @param {string} commit @param {string} path */
const fileAt = (commit, path) => execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** @param {string} cmd @param {string[]} args */
const attempt = (cmd, args) => {
  try { return { ok: true, out: run(cmd, args) }; } catch { return { ok: false, out: "" }; }
};
const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));
/** The commit a local tag peels to, or null. @param {string} tag */
const localTag = (tag) => { const r = attempt("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]); return r.ok ? r.out : null; };
/** The commit origin's tag peels to, or null. @param {string} tag */
function remoteTag(tag) {
  const lines = run("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split("\n").filter(Boolean).map((l) => l.split("\t"));
  return (lines.find(([, ref]) => ref.endsWith("^{}")) ?? lines[0])?.[0] ?? null;
}
/** @param {string} a @param {string} b */
const isAncestor = (a, b) => attempt("git", ["merge-base", "--is-ancestor", a, b]).ok;

function check() {
  run("git", ["fetch", "-q", "origin", "main"]);
  const head = run("git", ["rev-parse", "HEAD"]);
  const pkg = JSON.parse(run("git", ["show", `${head}:package.json`]));
  const tag = `v${pkg.version}`;
  if (!isVersion(String(pkg.version))) throw new Error(`version ${pkg.version} is not a plain release version (1.2.3); this script cannot finish a prerelease`);
  if (pkg.gitHead) throw new Error("package.json has a gitHead field; remove it, npm records the commit itself");
  if (!isAncestor("origin/main", head)) throw new Error("origin/main has commits this checkout lacks; pull before releasing");
  const remote = remoteTag(tag);
  if (remote && remote !== head) throw new Error(`origin's tag ${tag} points at ${remote.slice(0, 7)}, not HEAD`);
  const local = localTag(tag);
  if (local && local !== head) throw new Error(`tag ${tag} points at ${local.slice(0, 7)}, not HEAD`);
  const problems = changelogProblems(fileAt(head, "CHANGELOG.md"), pkg.version);
  if (problems.length) throw new Error(`CHANGELOG.md's "## ${pkg.version}" section is not release-ready (CONTRIBUTING.md, Writing the CHANGELOG):\n  ${problems.join("\n  ")}`);
  // Last, so a commit made while the fetch ran is caught: npm packs the tree as it is now.
  if (run("git", ["branch", "--show-current"]) !== "main") throw new Error("HEAD is not on main");
  if (run("git", ["status", "--porcelain"])) throw new Error("the working tree has uncommitted changes; commit the release first");
  if (run("git", ["rev-parse", "HEAD"]) !== head) throw new Error("HEAD moved during the check; run it again");
  console.log(`github-release: ${tag} is ready to upload`);
}

/**
 * npm's record for `name@version`: its gitHead, or why it could not be read. E404 means npm does
 * not list the version; anything else (network, auth, a missing npm) means the state is unknown.
 * Each lookup is bounded, and the whole wait ends at the deadline.
 * @param {string} name @param {string} version @param {number} deadline epoch ms
 * @returns {Promise<{ gitHead: string } | { missing: true } | { error: string }>}
 */
async function registryRecord(name, version, deadline) {
  /** @type {{ missing: true } | { error: string }} */
  let last = { missing: true };
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return last;
    try {
      const out = execFileSync("npm", ["view", `${name}@${version}`, "version", "gitHead", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: Math.min(left, 20_000) }).trim();
      if (out) {
        const r = JSON.parse(out);
        if (r === version) return { error: `npm's record for ${version} has no gitHead, so the commit it came from is unknown; tag it by hand` };
        if (!r || typeof r !== "object" || Array.isArray(r) || r.version !== version) return { error: `npm answered ${out.slice(0, 80)} for ${version}` };
        if (typeof r.gitHead !== "string" || !/^[0-9a-f]{40}$/.test(r.gitHead)) return { error: `npm's record for ${version} has no gitHead, so the commit it came from is unknown; tag it by hand` };
        return { gitHead: r.gitHead };
      }
      last = { missing: true };
    } catch (e) {
      const err = String(/** @type {any} */ (e).stderr ?? "");
      last = /\bE404\b/.test(err) ? { missing: true } : { error: (err.split("\n").find((l) => l.trim()) ?? String(e)).trim() };
    }
    await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
  }
}

/**
 * @param {string} name @param {string} version @param {boolean} hook
 * @param {number} [waitMs] how long to wait for npm to list the version (60 s; `npm run release` waits longer after an approval)
 * @param {string} [expected] the commit `npm run release` uploaded and CI passed; npm's gitHead must equal it
 */
export async function finish(name, version, hook, waitMs = 60_000, expected) {
  const tag = `v${version}`;
  const record = await registryRecord(name, version, Date.now() + waitMs);
  if (!("gitHead" in record)) {
    const why = "missing" in record ? `${name}@${version} is not on npm yet (a staged upload waiting for approval, or one that failed)` : `npm could not be checked (${record.error})`;
    const msg = `${why}. GitHub completion is pending: once npm lists it, run \`node scripts/github-release.mjs ${version}\``;
    if (hook) { console.log(`github-release: ${msg}`); return; }
    throw new Error(msg);
  }
  const commit = record.gitHead;
  if (expected && commit !== expected) throw new Error(`npm recorded ${version} from ${commit.slice(0, 7)}, but the release uploaded and tested ${expected.slice(0, 7)}; nothing was tagged`);
  if (!attempt("git", ["cat-file", "-e", `${commit}^{commit}`]).ok) throw new Error(`npm recorded commit ${commit.slice(0, 7)}, which this checkout does not have; fetch it`);
  // Everything that can fail without writing runs before the first write.
  const notes = releaseNotes(fileAt(commit, "CHANGELOG.md"), version, name);
  const versions = /** @type {string[]} */ ([].concat(JSON.parse(run("npm", ["view", name, "versions", "--json"]))));
  const latest = versions.filter(isVersion).sort(compareVersions).pop() === version;

  run("git", ["fetch", "-q", "origin", "main"]);
  if (!isAncestor(commit, "origin/main")) {
    if (!isAncestor("origin/main", commit)) throw new Error(`origin/main and ${commit.slice(0, 7)} (npm's ${version}) have diverged`);
    run("git", ["push", "origin", `${commit}:refs/heads/main`]);
  }
  const local = localTag(tag);
  if (local && local !== commit) throw new Error(`tag ${tag} points at ${local.slice(0, 7)}, but npm's ${version} is ${commit.slice(0, 7)}`);
  if (!local) run("git", ["tag", "-s", tag, "-m", `rx ${version}`, commit]);
  const remote = remoteTag(tag);
  if (remote && remote !== commit) throw new Error(`origin's tag ${tag} points at ${remote.slice(0, 7)}, but npm's ${version} is ${commit.slice(0, 7)}`);
  if (!remote) run("git", ["push", "origin", `refs/tags/${tag}`]);

  if (attempt("gh", ["release", "view", tag, "--json", "tagName"]).ok) {
    console.log(`github-release: ${tag} is complete`);
    return;
  }
  run("gh", ["release", "create", tag, "--verify-tag", `--latest=${latest}`, "--title", `rx ${version}`, "--notes-file", "-"], { input: notes });
  console.log(`github-release: ${run("gh", ["release", "view", tag, "--json", "url", "-q", ".url"])}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) return check();
  if (process.env.npm_config_dry_run === "true") {
    console.log("github-release: a dry run; nothing is tagged or released");
    return;
  }
  const hook = process.env.npm_lifecycle_event === "postpublish";
  // `npm run release` (scripts/release.mjs) runs the upload itself and finishes after CI and the
  // staged approval; the hook would only wait 60 s and report pending.
  if (hook && process.env.RX_RELEASE === "1") {
    console.log("github-release: npm run release finishes this after CI and the approval");
    return;
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const name = (hook && process.env.npm_package_name) || pkg.name;
  const version = args[0] ?? (hook ? process.env.npm_package_version : undefined);
  if (!version || !isVersion(version)) throw new Error(`name the exact version to finish, such as 0.2.0${version ? ` (not "${version}")` : ""}: node scripts/github-release.mjs <version>`);
  await finish(name, version, hook);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`github-release: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

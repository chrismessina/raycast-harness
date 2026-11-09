// `rx pr verify|files|body` (docs/commands.md §4.10): is this PR mine, does it touch only my
// extension, and write its body without clobbering the user's edits. The body subcommand is the
// port of ship's pr-body.py; its docstring is the safety contract and every safeguard is kept:
//
//   --initial only onto a body that is still the one the PR was created with (no edit history,
//             or equal to the oldest entry), and only if the proposed body carries Raycast's PR
//             template checklist verbatim (fetched from raycast/extensions at run time)
//   --splice  [{ find, replace }]: each find one or more WHOLE lines occurring exactly once in
//             the LIVE body, anchors non-overlapping, all applied at once
//   --apply   re-read immediately before the single PATCH (abort if the body moved); the write is
//             sent once and never retried; the edit history is checked afterward for an edit that
//             landed in the gap between the re-read and the write (GitHub's PATCH has no
//             conditional write)
//
// Bodies are exact strings; CRLF survives. Every live body read is backed up under the cross-repo
// cache (pr-body/<owner>/<name>/<N>/<timestamp>.md) so a clobbered body is recoverable.
// All GitHub traffic goes through src/pr/transport.mjs.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RxError } from "../errors.mjs";
import { checklistItems, lineDiff, missingChecklist, splice, validateEdits } from "../pr/body.mjs";
import { parsePrNumber, parseRepo, transport } from "../pr/transport.mjs";
import { cachePath } from "../state.mjs";
import { readPresetFields } from "./holdout.mjs";

const DEFAULT_REPO = "raycast/extensions";
const TEMPLATE_PATH = `repos/${DEFAULT_REPO}/contents/.github/pull_request_template.md`;

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "pr",
  summary: "verify a Store PR is yours, check its file set, and edit its body without clobbering hand edits",
  root: "none",
  network: "GitHub API via gh (raycast/extensions unless --repo)",
  state: "body: a copy of every live body read goes to the cross-repo cache pr-body/<owner>/<name>/<N>/<timestamp>.md; verify and files write nothing",
  subcommands: {
    verify: {
      name: "verify",
      summary: "author, head branch ext/<name>, draft, open and base raycast/extensions:main, each a result",
      positionals: [{ name: "N", required: true, help: "pull request number in raycast/extensions" }],
      flags: {
        "--author": { type: "string", required: true, value: "<login>", help: "the GitHub login the PR must be authored by" },
        "--extension": { type: "string", required: true, value: "<name>", help: "extension folder name; the head branch must be ext/<name>" },
      },
      checks: {
        "pr-author": "PR author login equals --author",
        "pr-head": "head branch is ext/<extension>",
        "pr-draft": "PR is still a draft",
        "pr-open": "PR is open",
        "pr-base": "base is raycast/extensions:main",
      },
      data: { number: "int", author: "string", head: "string", base: "string owner/repo:ref", draft: "boolean", state: "string" },
    },
    files: {
      name: "files",
      summary: "FAIL on any changed file outside extensions/<name>/ (rename sources included, all pages fetched); with --preset, FAIL on a local-only file the PR adds or changes",
      positionals: [{ name: "N", required: true, help: "pull request number in raycast/extensions" }],
      flags: {
        "--extension": { type: "string", required: true, value: "<name>", help: "extension folder name" },
        "--preset": { type: "string", value: "<file>", help: "preset JSON; reads holdout.localOnly for the pr-local-only check" },
      },
      checks: {
        "pr-files": "every changed path is under extensions/<extension>/ (details: each file with its GitHub status)",
        "pr-local-only": { description: "with --preset: every changed path the preset's holdout.localOnly lists (AGENTS.md, CONCEPTS.md, CLAUDE.md, HANDOFF.md, .env, …, under extensions/<extension>/) has status removed (PASS names the removals; FAIL any other status); N/A without --preset", levels: ["PASS", "FAIL", "N/A"] },
      },
      data: {
        files: "[{ path, status, previous }] one per changed file: status is GitHub's (added, removed, modified, renamed, copied, changed, unchanged); previous is the rename source, else null",
        paths: "string[] every changed path, rename sources included",
        stray: "string[] paths outside the extension",
      },
    },
    body: {
      name: "body",
      summary: "write the PR body onto the LIVE body: --initial first post only, --splice every later edit; dry run without --apply",
      positionals: [{ name: "N", required: true, help: "pull request number" }],
      flags: {
        "--initial": { type: "string", value: "<file>", help: "first post: the whole body, allowed only onto an unedited body carrying the template checklist" },
        "--splice": { type: "string", value: "<file>", help: "JSON [{ find, replace }]; each find is whole lines occurring exactly once in the live body" },
        "--apply": { type: "boolean", help: "write (once); without it, print the diff and write nothing" },
        "--prospective": { type: "string", value: "<file>", help: "dry run: write the whole composed body to this file (outside the extension) for rx scan --pr-text; with --apply: refuse unless the body composed now equals that file byte for byte" },
        "--repo": { type: "string", value: "<owner/repo>", help: `repository (default ${DEFAULT_REPO})` },
      },
      checks: {
        "pr-body-diff": "the proposed body was derived safely from the live body (diff in details); FAIL names the refused anchor or the edited body",
        "pr-body-write": "the single PATCH landed and the edit history shows nothing was overwritten; N/A on a dry run or no change; FAIL (nothing written) when --apply --prospective names a file that differs from the body composed now",
      },
      data: { applied: "boolean", before: "sha256:… of the live body read", after: "sha256:… of the body sent (or proposed)", edits: "int", overwritten: "boolean" },
    },
  },
};

/** @param {string} s */
const sha256 = (s) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  const sub = ctx.args.subcommand;
  if (sub === "verify") return verify(ctx);
  if (sub === "files") return files(ctx);
  return body(ctx);
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function verify({ args, results }) {
  const n = parsePrNumber(args.positionals.N);
  const author = String(args.flags["--author"]);
  const ext = String(args.flags["--extension"]);
  const pr = await transport().getJson(`repos/${DEFAULT_REPO}/pulls/${n}`);
  const login = pr?.user?.login ?? "";
  const head = pr?.head?.ref ?? "";
  const baseRepo = pr?.base?.repo?.full_name ?? "";
  const baseRef = pr?.base?.ref ?? "";
  const base = `${baseRepo}:${baseRef}`;
  const draft = pr?.draft === true;
  const state = String(pr?.state ?? "");

  if (login === author) results.pass("pr-author", `authored by ${login}`);
  else results.fail("pr-author", `authored by ${JSON.stringify(login)}, not ${author}: this is not your PR`);
  if (head === `ext/${ext}`) results.pass("pr-head", `head branch ${head}`);
  else results.fail("pr-head", `head branch ${JSON.stringify(head)} is not ext/${ext}`);
  if (draft) results.pass("pr-draft", "still a draft");
  else results.fail("pr-draft", "not a draft: already submitted for review; do not post onto it");
  if (state === "open") results.pass("pr-open", "open");
  else results.fail("pr-open", `state is ${JSON.stringify(state)}`);
  if (baseRepo === DEFAULT_REPO && baseRef === "main") results.pass("pr-base", `base ${base}`);
  else results.fail("pr-base", `base ${base} is not ${DEFAULT_REPO}:main`);
  return { data: { number: n, author: login, head, base, draft, state } };
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function files({ args, results, cwd }) {
  const n = parsePrNumber(args.positionals.N);
  const ext = String(args.flags["--extension"]);
  const prefix = `extensions/${ext}/`;
  const localOnly = typeof args.flags["--preset"] === "string" ? readPresetFields(resolve(cwd, args.flags["--preset"])).localOnly : null;
  // Every page: a stray path on page 2 must not pass.
  const list = await transport().getJsonPages(`repos/${DEFAULT_REPO}/pulls/${n}/files?per_page=100`);
  if (!Array.isArray(list)) throw new RxError(`pulls/${n}/files did not return a list`, { id: "github" });
  /** @type {string[]} */
  const paths = [];
  /** @type {{ path: string, status: string, previous: string | null }[]} */
  const changed = [];
  for (const f of list) {
    if (typeof f?.filename !== "string") continue;
    const previous = typeof f.previous_filename === "string" ? f.previous_filename : null;
    changed.push({ path: f.filename, status: typeof f.status === "string" ? f.status : "unknown", previous });
    paths.push(f.filename);
    if (previous !== null) paths.push(previous);
  }
  const describe = (/** @type {{ status: string, previous: string | null }} */ c) => (c.previous !== null ? `${c.status} from ${c.previous}` : c.status);
  const stray = paths.filter((p) => !p.startsWith(prefix));
  if (paths.length === 0) results.fail("pr-files", "the PR changes no files");
  else if (stray.length === 0) results.pass("pr-files", `${paths.length} changed path(s), all under ${prefix}`, changed.map((c) => ({ file: c.path, text: describe(c) })));
  else {
    const statusOf = (/** @type {string} */ p) => changed.find((c) => c.path === p) ?? changed.find((c) => c.previous === p);
    results.fail("pr-files", `${stray.length} path(s) outside ${prefix}`, stray.map((p) => {
      const c = statusOf(p);
      return { file: p, text: `outside the extension (${c && c.path === p ? describe(c) : `renamed to ${c?.path}`})` };
    }));
  }

  // The 2026-11-03 ruling: a local-only file (AGENTS.md, CONCEPTS.md, CLAUDE.md, HANDOFF.md, and
  // the rest of the preset's holdout.localOnly) may appear in a Store PR only as a deletion.
  if (localOnly === null) results.na("pr-local-only", "no --preset: the local-only file list is the preset's holdout.localOnly");
  else {
    const hits = changed.filter((c) => c.path.startsWith(prefix) && localOnly.some((p) => c.path === `${prefix}${p}` || c.path.startsWith(`${prefix}${p}/`)));
    const shipped = hits.filter((c) => c.status !== "removed");
    if (shipped.length) results.fail("pr-local-only", `${shipped.length} local-only file(s) the PR adds or changes; they stay in the mirror, listed in the extension's .gitignore, and are held out by rx holdout out`, shipped.map((c) => ({ file: c.path, text: describe(c) })));
    else if (hits.length) results.pass("pr-local-only", `${hits.length} local-only file(s) in the PR, every one removed`, hits.map((c) => ({ file: c.path, text: c.status })));
    else results.pass("pr-local-only", "no local-only file in the PR");
  }
  return { data: { files: changed, paths, stray } };
}

/**
 * @param {string} slug @param {number} n
 * @returns {Promise<string>} the live body, exact
 */
async function liveBody(slug, n) {
  const pr = await transport().getJson(`repos/${slug}/pulls/${n}`);
  const body = typeof pr?.body === "string" ? pr.body : "";
  backup(slug, n, body);
  return body;
}

/** @param {string} slug @param {number} n @param {string} body */
function backup(slug, n, body) {
  const [owner, name] = slug.split("/");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = cachePath("pr-body", owner, name, String(n));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}-${process.hrtime.bigint().toString(36)}.md`), body);
}

/**
 * The newest recorded versions of the body, NEWEST first (each `diff` is the whole body as of
 * that edit); empty when never edited.
 * @param {string} slug @param {number} n
 * @returns {Promise<string[]>}
 */
async function history(slug, n) {
  const { owner, name } = parseRepo(slug);
  const q = "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){userContentEdits(first:3){nodes{diff}}}}}";
  const data = await transport().graphql(q, { o: owner, n: name, p: n });
  const nodes = data?.data?.repository?.pullRequest?.userContentEdits?.nodes;
  if (!Array.isArray(nodes)) throw new RxError("userContentEdits missing from the GraphQL response", { id: "github" });
  return nodes.map((x) => (typeof x?.diff === "string" ? x.diff : ""));
}

/**
 * Is the live body still the PR's own original? Compared with the OLDEST edit entry, not a
 * template copy: `ray publish` posts a checklist worded differently from the repo's template.
 * @param {string} slug @param {number} n @param {string} body
 */
async function isUntouched(slug, n, body) {
  const { owner, name } = parseRepo(slug);
  const q = "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){userContentEdits(last:1){totalCount nodes{diff}}}}}";
  const data = await transport().graphql(q, { o: owner, n: name, p: n });
  const edits = data?.data?.repository?.pullRequest?.userContentEdits;
  if (!edits || typeof edits.totalCount !== "number") throw new RxError("userContentEdits missing from the GraphQL response", { id: "github" });
  return edits.totalCount === 0 || (edits.nodes?.[0]?.diff ?? "") === body;
}

/** Test hook: how long to wait between edit-history polls after a write. */
let GAP_DELAY_MS = 2000;
/** @param {number} ms */
export function _setGapDelayMs(ms) { GAP_DELAY_MS = ms; }

/**
 * After a write: ("ok"), ("lost", overwritten body) or ("unverified"). Trusts the history only
 * once its newest entry IS our write; before that, the entry before it proves nothing.
 * @param {string} slug @param {number} n @param {string} base @param {string} sent
 * @returns {Promise<{ state: "ok" | "lost" | "unverified", lost: string | null }>}
 */
async function gapCheck(slug, n, base, sent) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const versions = await history(slug, n);
    if (versions.length && versions[0] === sent) {
      const before = versions.length > 1 ? versions[1] : null;
      if (before === null || before === base) return { state: "ok", lost: null };
      return { state: "lost", lost: before };
    }
    if (GAP_DELAY_MS > 0) await new Promise((r) => setTimeout(r, GAP_DELAY_MS));
  }
  return { state: "unverified", lost: null };
}

/** @param {string} file */
function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw new RxError(`cannot read ${file}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function body({ args, results, log, cwd }) {
  const n = parsePrNumber(args.positionals.N);
  const slug = parseRepo(String(args.flags["--repo"] ?? DEFAULT_REPO)).slug;
  const initial = typeof args.flags["--initial"] === "string" ? args.flags["--initial"] : null;
  const spliceFile = typeof args.flags["--splice"] === "string" ? args.flags["--splice"] : null;
  const apply = args.flags["--apply"] === true;
  const prospectiveFile = typeof args.flags["--prospective"] === "string" ? resolve(cwd, args.flags["--prospective"]) : null;
  if ((initial === null) === (spliceFile === null)) throw new RxError("pass exactly one of --initial <file> or --splice <file>", { id: "args" });

  const data = { applied: false, before: "", after: "", edits: 0, overwritten: false };
  const base = await liveBody(slug, n);
  data.before = sha256(base);

  /** @type {string} */
  let proposed;
  if (initial !== null) {
    proposed = readText(initial);
    data.edits = 1;
    const untouched = await isUntouched(slug, n, base);
    if (!untouched) {
      results.fail("pr-body-diff", "the live body has been edited since the PR was created; use --splice against the live body instead");
      results.na("pr-body-write", "nothing written");
      data.after = sha256(proposed);
      return { data };
    }
    const template = await transport().getRaw(TEMPLATE_PATH);
    const items = checklistItems(template);
    if (items.length === 0) throw new RxError(`the PR template at ${TEMPLATE_PATH} has no "## Checklist" items; cannot verify the body`, { id: "github" });
    const missing = missingChecklist(proposed, items);
    if (missing.length) {
      results.fail("pr-body-diff", `the proposed body lacks ${missing.length} of ${items.length} template checklist item(s) verbatim`, missing.map((t) => ({ text: t })));
      results.na("pr-body-write", "nothing written");
      data.after = sha256(proposed);
      return { data };
    }
  } else {
    const raw = readText(/** @type {string} */ (spliceFile));
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new RxError(`${spliceFile} is not JSON: ${/** @type {Error} */ (e).message}`, { id: "input" });
    }
    const problem = validateEdits(parsed);
    if (problem) throw new RxError(`${spliceFile}: ${problem}`, { id: "input" });
    const edits = /** @type {import("../pr/body.mjs").Edit[]} */ (parsed);
    data.edits = edits.length;
    const r = splice(base, edits);
    if (!r.ok) {
      results.fail("pr-body-diff", "anchors are not exactly once as whole lines in the LIVE body; nothing written", r.problems.map((t) => ({ text: t })));
      results.na("pr-body-write", "nothing written");
      data.after = data.before;
      return { data };
    }
    proposed = r.body;
  }
  data.after = sha256(proposed);

  if (proposed === base) {
    results.pass("pr-body-diff", "no change: the proposed body equals the live body");
    results.na("pr-body-write", "nothing to write");
    return { data };
  }
  const diff = lineDiff(base, proposed);
  let note = "";
  if (prospectiveFile && !apply) {
    writeFileSync(prospectiveFile, proposed);
    note = `; prospective body written to ${prospectiveFile}`;
  }
  results.pass("pr-body-diff", `${diff.length} changed line(s) against the live body${note}`, diff.map((t) => ({ text: t })));
  if (!apply) {
    results.na("pr-body-write", "dry run; pass --apply to write");
    return { data };
  }
  // With --apply, --prospective names the file the caller scanned after the dry run. The write is
  // bound to it: the body this run composed must be byte-identical, or bytes nobody scanned would
  // go out (the live body or the edits changed in between). The file is never rewritten here.
  let bound = "";
  if (prospectiveFile) {
    const scanned = readText(prospectiveFile);
    if (scanned !== proposed) {
      results.fail("pr-body-write", `the body composed now differs from the scanned prospective body ${prospectiveFile} (${sha256(scanned)}); nothing written. Re-run without --apply to rewrite the file, scan it again, then --apply`);
      return { data };
    }
    bound = `; matches the scanned prospective body ${prospectiveFile}`;
  }

  // Re-read immediately before the write: the base must still be the live body.
  const again = await liveBody(slug, n);
  if (again !== base) {
    results.fail("pr-body-write", "the live body changed while this ran; nothing written. Re-run to splice onto the new version");
    return { data };
  }
  log("PATCH (sent once)\n");
  const w = await transport().patch(`repos/${slug}/pulls/${n}`, { body: proposed });
  if (!w.ok) {
    // Never retried. Re-read to say what state the PR is in.
    let state = "the body could not be re-read";
    try {
      const now = await liveBody(slug, n);
      state = now === proposed ? "it DID land" : now === base ? "it did not land" : "the body is now something else";
      data.applied = now === proposed;
    } catch { /* reported below as unknown */ }
    results.error("pr-body-write", `the write failed (${w.error}), but ${state}. It was NOT retried; re-run to see the current state`);
    return { data };
  }
  data.applied = true;
  const now = await liveBody(slug, n);
  if (now !== proposed) {
    results.error("pr-body-write", "the PATCH ran but the live body does not match what was sent; check the PR by hand");
    return { data };
  }
  const gap = await gapCheck(slug, n, base, proposed);
  if (gap.state === "lost") {
    data.overwritten = true;
    results.fail("pr-body-write", "written, but an edit landed between the re-read and the write and was overwritten; the overwritten version follows, splice it back in", String(gap.lost).split(/\r?\n/).map((t) => ({ text: t })));
  } else if (gap.state === "unverified") {
    results.warn("pr-body-write", `written and verified, but the edit history had not caught up; an edit in the gap cannot be ruled out. Check the PR's edit history${bound}`);
  } else {
    results.pass("pr-body-write", `written and verified; the edit history shows nothing was overwritten${bound}`);
  }
  return { data };
}

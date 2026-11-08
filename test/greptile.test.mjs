import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES, diffRuleSets, liveSource } from "../src/greptile/compare.mjs";
import { SHIPPED_DIR as SNAPSHOT_DIR, loadGreptileRules, readRuleDir, writeDestCopy, writeUpdatedCopy } from "../src/greptile/rules.mjs";
import { buildRound, parseForbidden, parseSummary, scanReply, summaryComment } from "../src/greptile/rounds.mjs";
import { setTransport } from "../src/pr/transport.mjs";
import { RxError } from "../src/errors.mjs";
import { REPO, fakeExtension, rx, withTempDir } from "./helpers.mjs";

// Nothing here reaches github.com: every command test installs a fake transport serving the
// recorded, scrubbed payloads under test/fixtures/greptile/.

const FIX = join(REPO, "test", "fixtures", "greptile");
const fixture = (/** @type {string} */ f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const PR = "12345";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const ROUND = "2026-10-02T09:30:00Z";
/** A commit date after the shipped copy's (2026-11-03): a copy carrying it is the copy in use. */
const LATER = "2026-11-05T00:00:00Z";
/** A commit date before the shipped copy's. */
const EARLIER = "2026-10-01T00:00:00Z";

/**
 * Comment lists are served only through `getJsonPages` (`reviewPage2` adds a second page), so a
 * regression to a single-page `getJson` throws.
 * @param {Partial<{ issue: any[], review: any[], reviewPage2: any[], pull: any, conditional: { status: number, etag: string | null, body: any } | Error, snapshotFiles: Record<string, string>, mainHas: boolean, mainSha: string, mainCommitted: string, prState: string, prHeadSha: string }>} [o]
 */
function fakeGitHub(o = {}) {
  const snapshot = Object.fromEntries(["config.json", "files.json", "rules.md"].map((f) => [f, readFileSync(join(SNAPSHOT_DIR, f), "utf8")]));
  const liveFiles = { ...snapshot, ...(o.snapshotFiles ?? {}) };
  const calls = /** @type {string[]} */ ([]);
  const notFound = (/** @type {string} */ p) => { const e = new RxError(`gh api ${p} failed (HTTP 404)`, { id: "github" }); /** @type {any} */ (e).status = 404; return e; };
  const t = {
    async getJsonPages(path) {
      calls.push(`PAGES ${path}`);
      if (/\/issues\/\d+\/comments/.test(path)) return [...(o.issue ?? fixture("issue-comments.json"))];
      if (/\/pulls\/\d+\/comments/.test(path)) return [...(o.review ?? fixture("review-comments.json")), ...(o.reviewPage2 ?? [])];
      throw new Error(`unexpected paginated GET ${path}`);
    },
    async getJson(path) {
      calls.push(`GET ${path}`);
      if (/\/commits\?path=\.greptile&sha=main&per_page=1$/.test(path)) return (o.mainHas ?? false) ? [{ sha: o.mainSha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", commit: { committer: { date: o.mainCommitted ?? LATER } } }] : [];
      if (/\/pulls\/\d+$/.test(path)) {
        const p = structuredClone(o.pull ?? fixture("pull.json"));
        if (o.prState) p.state = o.prState;
        if (o.prHeadSha) p.head.sha = o.prHeadSha;
        return p;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async getRaw(path) {
      calls.push(`RAW ${path}`);
      const m = path.match(/\.greptile\/([^?]+)\?ref=(\w+)/);
      if (!m) throw new Error(`unexpected RAW ${path}`);
      const onMain = m[2] === (o.mainSha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      if (onMain && !(o.mainHas ?? false)) throw notFound(path);
      return liveFiles[m[1]];
    },
    async getConditional(path, etag) {
      calls.push(`COND ${path} ${etag ?? "-"}`);
      if (o.conditional instanceof Error) throw o.conditional;
      return o.conditional ?? { status: 200, etag: "W/\"etag-1\"", body: o.issue ?? fixture("issue-comments.json") };
    },
    async graphql() { throw new Error("not used by greptile"); },
    async patch() { throw new Error("greptile never writes to GitHub"); },
  };
  return { t, calls };
}

/**
 * Run with a fake transport inside a temp dir (cache redirected there). `setup` can create an
 * extension root and files; `inspect` runs before cleanup.
 * @param {ReturnType<typeof fakeGitHub>["t"]} t @param {string[]} argv
 * @param {{ setup?: (dir: string) => string | void, inspect?: (dir: string, cwd: string) => void }} [o]
 */
async function withFake(t, argv, o = {}) {
  return withTempDir(async (dir) => {
    const prevCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const prev = setTransport(t);
    const snapshotBefore = snapshotBytes();
    try {
      const cwd = o.setup?.(dir) || dir;
      const r = await rx([...argv, "--json"], { cwd });
      o.inspect?.(dir, cwd);
      return { ...r, by: Object.fromEntries((r.json?.results ?? []).map((x) => [x.id, x])) };
    } finally {
      // No test may write into the installed snapshot, whatever the command under test did.
      assert.deepEqual(snapshotBytes(), snapshotBefore, `src/rules/greptile/ was modified by: rx ${argv.join(" ")}`);
      setTransport(prev);
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevCache;
    }
  });
}

/** Every byte of the installed snapshot, for the integrity assertion around each run. */
function snapshotBytes() {
  return Object.fromEntries(readdirSync(SNAPSHOT_DIR).sort().map((f) => [f, readFileSync(join(SNAPSHOT_DIR, f), "utf8")]));
}

/**
 * A transport whose live-content fetch always fails: for tests that point --dest at a path that
 * must be refused, so that even a disabled guard has nothing to write.
 */
function unfetchable() {
  const { t } = fakeGitHub();
  t.getRaw = async (path) => { throw new RxError(`test transport refuses live content (${path})`, { id: "github" }); };
  return t;
}

/** A git-initialized fake extension so repo state resolves. @param {string} dir */
function gitExtension(dir) {
  const ext = fakeExtension(dir, "sample-ext");
  execFileSync("git", ["init", "-q"], { cwd: ext });
  return ext;
}

/** @param {string} ext */
const stateDir = (ext) => join(ext, ".git", "rx", "greptile", "raycast", "extensions", PR);

/** Store the fixture round the way `fetch` would. @param {string} ext */
function storeRound(ext) {
  const round = buildRound(fixture("issue-comments.json"), fixture("review-comments.json"));
  mkdirSync(join(stateDir(ext), "rounds"), { recursive: true });
  writeFileSync(join(stateDir(ext), "rounds", `${ROUND}.json`), JSON.stringify({ repo: "raycast/extensions", pr: 12345, head: HEAD, ...round }));
}

// ---- rounds: pure ----------------------------------------------------------------------------

test("summaryComment is Greptile's OLDEST issue comment, never a later bot reply or a human", () => {
  const s = summaryComment(fixture("issue-comments.json"));
  assert.equal(s.id, 5002);
  assert.equal(summaryComment([{ user: { login: "octo-author" }, created_at: "2026-01-01T00:00:00Z" }]), null);
});

test("parseSummary reads the N/5 score and the last reviewed commit; absent → null", () => {
  assert.deepEqual(parseSummary("**Confidence score: 4/5**\n<sub>Last reviewed commit: 0123456789abcdef0123456789abcdef01234567</sub>"), { score: 4, reviewedCommit: HEAD });
  assert.deepEqual(parseSummary("Score: 5 / 5"), { score: 5, reviewedCommit: null });
  assert.deepEqual(parseSummary("no score here"), { score: null, reviewedCommit: null });
});

test("buildRound keys on the summary updated_at and keeps original_commit_id per finding; humans in finding threads are not findings", () => {
  const r = /** @type {NonNullable<ReturnType<typeof buildRound>>} */ (buildRound(fixture("issue-comments.json"), fixture("review-comments.json")));
  assert.equal(r.updatedAt, ROUND);
  assert.equal(r.score, 4);
  // Codex W4 r2 B1-4: the summary comment's body travels with the round, so a summary-only finding is readable.
  assert.equal(typeof r.summary, "string");
  assert.match(r.summary, /4\/5/);
  assert.deepEqual(r.findings.map((f) => f.id), [1001, 1002]);
  assert.equal(r.findings[0].originalCommitId, "89abcdef0123456789abcdef0123456789abcdef");
  assert.equal(r.findings[1].line, 7, "falls back to original_line");
  assert.equal(buildRound([], []), null);
});

test("parseForbidden skips blanks and comments; scanReply reports hits by forbidden-list line without echoing the literal", () => {
  const f = parseForbidden("# examples\n\nAbCdEfGhIjK\n  \nhttps://example.test/secret\n");
  assert.deepEqual(f.map((x) => x.line), [3, 5]);
  const hits = scanReply("@greptile Fixed in 0123456. See https://example.test/secret for context.", f);
  assert.deepEqual(hits, [{ replyLine: 1, forbiddenLine: 5 }]);
  assert.deepEqual(scanReply("clean reply", f), []);
});

// ---- fetch -----------------------------------------------------------------------------------

test("greptile fetch stores the round under the extension's repo state when a root resolves", async () => {
  const { t } = fakeGitHub();
  const r = await withFake(t, ["greptile", "fetch", PR], {
    setup: gitExtension,
    inspect: (_dir, ext) => {
      const stored = JSON.parse(readFileSync(join(stateDir(ext), "rounds", `${ROUND}.json`), "utf8"));
      assert.equal(stored.head, HEAD);
      assert.equal(stored.findings.length, 2);
    },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.by["greptile-round"].verdict, "PASS");
  assert.match(r.by["greptile-round"].message, /score 4\/5, 2 inline finding/);
  assert.equal(r.json.data.head, HEAD);
  assert.equal(r.json.data.round.updatedAt, ROUND);
});

test("greptile fetch paginates the comment lists: a finding only on page 2 is in the round", async () => {
  const { t } = fakeGitHub({ reviewPage2: fixture("review-comments-page2.json") });
  const r = await withFake(t, ["greptile", "fetch", PR]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.data.round.findings.map((f) => f.id), [1001, 1002, 1004]);
  assert.match(r.by["greptile-round"].message, /3 inline finding/);
});

test("greptile fetch/wait/can-reply accept --root (declared, so the dispatcher reads it)", async () => {
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    const prevCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const prev = setTransport(fakeGitHub().t);
    try {
      const f = await rx(["greptile", "fetch", PR, "--root", ext, "--json"], { cwd: elsewhere });
      assert.equal(f.code, 0, f.stdout);
      assert.ok(existsSync(join(stateDir(ext), "rounds", `${ROUND}.json`)), "round stored under the --root repo state, not the cache");
      const w = await rx(["greptile", "wait", PR, "--root", ext, "--json"], { cwd: elsewhere });
      assert.equal(w.code, 0, w.stdout);
      assert.ok(existsSync(join(stateDir(ext), "etag")));
      const files = replyFiles(dir);
      const c = await rx([...replyArgv(files, ["--root", ext]), "--json"], { cwd: elsewhere });
      assert.equal(c.code, 0, c.stdout);
      assert.ok(existsSync(join(stateDir(ext), "replies.json")));
    } finally {
      setTransport(prev);
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevCache;
    }
  });
  const reg = await rx(["commands", "--json"]);
  const g = reg.json.data.commands.find((c) => c.name === "greptile");
  for (const s of ["fetch", "wait", "can-reply"]) assert.ok("--root" in g.subcommands[s].flags, `${s} declares --root`);
  for (const s of ["outdated", "update"]) assert.ok(!("--root" in (g.subcommands[s].flags ?? {})), `${s} has no root`);
});

test("greptile fetch without a root stores under the cross-repo cache; no summary yet → N/A", async () => {
  const { t } = fakeGitHub();
  const r = await withFake(t, ["greptile", "fetch", PR], {
    inspect: (dir) => assert.ok(existsSync(join(dir, "cache", "raycast-harness", "greptile", "raycast", "extensions", PR, "rounds", `${ROUND}.json`))),
  });
  assert.equal(r.code, 0, r.stdout);
  const none = await withFake(fakeGitHub({ issue: [fixture("issue-comments.json")[0]] }).t, ["greptile", "fetch", PR]);
  assert.equal(none.by["greptile-round"].verdict, "N/A");
  assert.match(none.by["greptile-round"].message, /no Greptile review on #12345 yet/);
  assert.equal(none.json.data.round, null);
});

// ---- wait ------------------------------------------------------------------------------------

test("greptile wait: first 200 is a new round and persists etag + seen; a 304 is N/A no change; the same round again is N/A", async () => {
  let r = await withFake(fakeGitHub().t, ["greptile", "wait", PR], {
    setup: gitExtension,
    inspect: (_d, ext) => {
      assert.equal(readFileSync(join(stateDir(ext), "etag"), "utf8").trim(), 'W/"etag-1"');
      assert.equal(readFileSync(join(stateDir(ext), "seen"), "utf8").trim(), ROUND);
    },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.by["greptile-wait"].verdict, "PASS");
  assert.match(r.by["greptile-wait"].message, new RegExp(`new round ${ROUND}`));
  assert.equal(r.json.data.changed, true);

  const { t, calls } = fakeGitHub({ conditional: { status: 304, etag: null, body: null } });
  r = await withFake(t, ["greptile", "wait", PR], {
    setup: (dir) => { const ext = gitExtension(dir); mkdirSync(stateDir(ext), { recursive: true }); writeFileSync(join(stateDir(ext), "etag"), 'W/"etag-1"\n'); return ext; },
  });
  assert.equal(r.by["greptile-wait"].verdict, "N/A");
  assert.match(r.by["greptile-wait"].message, /no change \(304\)/);
  assert.ok(calls.some((c) => c.endsWith('W/"etag-1"')), "the stored etag was sent as If-None-Match");

  r = await withFake(fakeGitHub().t, ["greptile", "wait", PR], {
    setup: (dir) => { const ext = gitExtension(dir); mkdirSync(stateDir(ext), { recursive: true }); writeFileSync(join(stateDir(ext), "seen"), `${ROUND}\n`); return ext; },
  });
  assert.equal(r.by["greptile-wait"].verdict, "N/A");
  assert.match(r.by["greptile-wait"].message, /no new round/);
});

test("greptile wait: a failed check is ERROR, never 'no change' (transport error, odd status, unparseable body)", async () => {
  const err = await withFake(fakeGitHub({ conditional: new RxError("gh api failed: HTTP 503", { id: "github" }) }).t, ["greptile", "wait", PR]);
  assert.equal(err.code, 2);
  assert.equal(err.by["greptile-wait"].verdict, "ERROR");
  assert.match(err.by["greptile-wait"].message, /not the same as no change/);
  const odd = await withFake(fakeGitHub({ conditional: { status: 202, etag: null, body: null } }).t, ["greptile", "wait", PR]);
  assert.equal(odd.by["greptile-wait"].verdict, "ERROR");
  const bad = await withFake(fakeGitHub({ conditional: { status: 200, etag: "x", body: "not a list" } }).t, ["greptile", "wait", PR], {
    inspect: (dir) => assert.ok(!existsSync(join(dir, "cache", "raycast-harness", "greptile", "raycast", "extensions", PR, "etag")), "state persists only after a successful parse"),
  });
  assert.equal(bad.by["greptile-wait"].verdict, "ERROR");
});

test("greptile fetch records the round as the wait baseline (Codex W4 B1-6): the first wait after a fetch is not a new round", async () => {
  const f = await withFake(fakeGitHub().t, ["greptile", "fetch", PR], {
    setup: gitExtension,
    inspect: (_d, ext) => assert.equal(readFileSync(join(stateDir(ext), "seen"), "utf8").trim(), ROUND, "fetch writes seen"),
  });
  assert.equal(f.code, 0, f.stdout);
});

// ---- can-reply -------------------------------------------------------------------------------

/**
 * @param {string} dir @param {{ disposition?: string, finding?: number, reply?: string, forbidden?: string, evidence?: string }} [o]
 */
function replyFiles(dir, o = {}) {
  const files = { forbidden: join(dir, "forbidden.txt"), reply: join(dir, "reply.md"), evidence: join(dir, "evidence.json") };
  writeFileSync(files.forbidden, o.forbidden ?? "# examples\nAbCdEfGhIjK\n");
  writeFileSync(files.reply, o.reply ?? "@greptile Declined: the limit is a deliberate safety bound (see the README's Limits section).");
  writeFileSync(files.evidence, o.evidence ?? JSON.stringify({ finding: o.finding ?? 1001, disposition: o.disposition ?? "declined", artifact: "README.md#limits", explanation: "page cap is intentional" }));
  return files;
}

/** @param {ReturnType<typeof replyFiles>} f @param {string[]} [extra] */
const replyArgv = (f, extra = []) => ["greptile", "can-reply", PR, "--round", ROUND, "--finding", "1001", "--expected-head", HEAD, "--forbidden", f.forbidden, "--reply", f.reply, "--evidence", f.evidence, ...extra];

test("P1-3: a decline-only round with an UNCHANGED head is authorized without any publication record", async () => {
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    storeRound(ext);
    const f = replyFiles(dir);
    const prev = setTransport(fakeGitHub().t);
    try {
      const out = await rx([...replyArgv(f), "--json"], { cwd: ext });
      const by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(out.code, 0, out.stdout);
      assert.equal(by["reply-round"].verdict, "PASS");
      assert.equal(by["reply-head"].verdict, "PASS");
      assert.equal(by["reply-evidence"].verdict, "PASS");
      assert.equal(by["reply-publication"].verdict, "N/A");
      assert.match(by["reply-publication"].message, /not a fix claim/);
      assert.equal(by["reply-scan"].verdict, "PASS");
      assert.equal(out.json.data.authorized, true);
      const rec = out.json.data.record;
      assert.deepEqual(Object.keys(rec).sort(), ["at", "authorized", "evidenceHash", "expectedHead", "finding", "forbiddenHash", "pr", "replyHash", "repo", "round"]);
      assert.match(rec.replyHash, /^sha256:/);
      const replies = JSON.parse(readFileSync(join(stateDir(ext), "replies.json"), "utf8"));
      assert.equal(replies.length, 1);
      assert.equal(replies[0].authorized, true);
      assert.deepEqual(readdirSync(stateDir(ext)).filter((n) => n.startsWith(".replies.")), [], "atomic write leaves no temp file behind");
      assert.ok(!existsSync(join(ext, ".git", "rx", "publication.json")), "no publication record was needed");
    } finally {
      setTransport(prev);
    }
  });
});

test("can-reply: a finding outside the stored round, or no stored round, FAILs reply-round", async () => {
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    storeRound(ext);
    const f = replyFiles(dir, { finding: 9999 });
    const prev = setTransport(fakeGitHub().t);
    try {
      const out = await rx([...replyArgv(f).map((a) => (a === "1001" ? "9999" : a)), "--json"], { cwd: ext });
      const by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(out.code, 1, out.stdout);
      assert.equal(by["reply-round"].verdict, "FAIL");
      assert.match(by["reply-round"].message, /9999 is not in round/);
      assert.equal(out.json.data.authorized, false);
      const none = await rx([...replyArgv(f).map((a) => (a === "1001" ? "9999" : a)), "--json"].map((a) => (a === ROUND ? "2000-01-01T00:00:00Z" : a)), { cwd: ext });
      assert.equal(none.json.results.find((x) => x.id === "reply-round").verdict, "FAIL");
      assert.match(none.json.results.find((x) => x.id === "reply-round").message, /no stored round/);
    } finally {
      setTransport(prev);
    }
  });
});

test("can-reply: a head that moved since the reply was written FAILs reply-head", async () => {
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    storeRound(ext);
    const f = replyFiles(dir);
    const prev = setTransport(fakeGitHub({ prHeadSha: "fedcba9876543210fedcba9876543210fedcba98" }).t);
    try {
      const out = await rx([...replyArgv(f), "--json"], { cwd: ext });
      const by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(by["reply-head"].verdict, "FAIL");
      assert.match(by["reply-head"].message, /stale head/);
      assert.equal(out.json.data.authorized, false);
    } finally {
      setTransport(prev);
    }
  });
});

test("can-reply: missing or mismatched evidence is ERROR reply-evidence, and the flag must agree with the disposition", async () => {
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    storeRound(ext);
    const prev = setTransport(fakeGitHub().t);
    try {
      const wrongFinding = replyFiles(dir, { finding: 1002 });
      let out = await rx([...replyArgv(wrongFinding), "--json"], { cwd: ext });
      assert.equal(out.code, 2);
      assert.deepEqual(out.json.results.map((x) => [x.verdict, x.id]), [["ERROR", "reply-evidence"]]);
      assert.match(out.json.results[0].message, /evidence\.finding \(1002\) is not --finding 1001/);

      const fixedNoFlag = replyFiles(dir, { disposition: "fixed" });
      out = await rx([...replyArgv(fixedNoFlag), "--json"], { cwd: ext });
      assert.equal(out.json.results[0].id, "reply-evidence");
      assert.match(out.json.results[0].message, /claims a fix; pass --claims-fix/);

      const declinedWithFlag = replyFiles(dir);
      out = await rx([...replyArgv(declinedWithFlag, ["--claims-fix"]), "--json"], { cwd: ext });
      assert.match(out.json.results[0].message, /--claims-fix with disposition "declined"/);

      const notJson = replyFiles(dir, { evidence: "{not json" });
      out = await rx([...replyArgv(notJson), "--json"], { cwd: ext });
      assert.equal(out.json.results[0].id, "reply-evidence");

      const missing = replyFiles(dir);
      out = await rx([...replyArgv({ ...missing, evidence: join(dir, "absent.json") }), "--json"], { cwd: ext });
      assert.deepEqual(out.json.results.map((x) => [x.verdict, x.id]), [["ERROR", "reply-evidence"]], "a missing evidence file is reply-evidence, not input");
      assert.match(out.json.results[0].message, /missing or unreadable/);
    } finally {
      setTransport(prev);
    }
  });
});

test("can-reply --claims-fix: needs publication.json naming this PR at the current head, newer than the reviewed commit", async () => {
  const newHead = "fedcba9876543210fedcba9876543210fedcba98";
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    storeRound(ext);
    const f = replyFiles(dir, { disposition: "fixed", reply: "@greptile Fixed in fedcba9: the empty state now renders a List.EmptyView." });
    const argv = replyArgv(f, ["--claims-fix"]).map((a) => (a === HEAD ? newHead : a));
    const pub = join(ext, ".git", "rx", "publication.json");
    const prev = setTransport(fakeGitHub({ prHeadSha: newHead }).t);
    try {
      // No record at all.
      let out = await rx([...argv, "--json"], { cwd: ext });
      let by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(out.code, 1, out.stdout);
      assert.equal(by["reply-publication"].verdict, "FAIL");
      assert.match(by["reply-publication"].message, /no publication record/);
      // Record for another PR.
      mkdirSync(join(ext, ".git", "rx"), { recursive: true });
      writeFileSync(pub, JSON.stringify({ repo: "raycast/extensions", pr: 999, remoteSha: newHead, at: "2026-10-02T10:00:00Z" }));
      out = await rx([...argv, "--json"], { cwd: ext });
      by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.match(by["reply-publication"].message, /#999, not raycast\/extensions#12345/);
      // Record at the reviewed commit: no new revision landed.
      writeFileSync(pub, JSON.stringify({ repo: "raycast/extensions", pr: 12345, remoteSha: HEAD, at: "2026-10-02T10:00:00Z" }));
      out = await rx([...argv, "--json"], { cwd: ext });
      by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(by["reply-publication"].verdict, "FAIL");
      assert.match(by["reply-publication"].message, /not the current head/);
      // Record at the new head: authorized.
      writeFileSync(pub, JSON.stringify({ repo: "raycast/extensions", pr: 12345, remoteSha: newHead, at: "2026-10-02T10:00:00Z" }));
      out = await rx([...argv, "--json"], { cwd: ext });
      by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(out.code, 0, out.stdout);
      assert.equal(by["reply-publication"].verdict, "PASS");
      assert.equal(out.json.data.authorized, true);
      assert.equal(JSON.parse(readFileSync(join(stateDir(ext), "replies.json"), "utf8")).length, 4, "every attempt is recorded");
    } finally {
      setTransport(prev);
    }
  });
  // A fix claim whose head equals the reviewed commit, with a record saying so, is still refused.
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    storeRound(ext);
    mkdirSync(join(ext, ".git", "rx"), { recursive: true });
    writeFileSync(join(ext, ".git", "rx", "publication.json"), JSON.stringify({ repo: "raycast/extensions", pr: 12345, remoteSha: HEAD, at: "2026-10-02T10:00:00Z" }));
    const f = replyFiles(dir, { disposition: "fixed" });
    const prev = setTransport(fakeGitHub().t);
    try {
      const out = await rx([...replyArgv(f, ["--claims-fix"]), "--json"], { cwd: ext });
      const by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(by["reply-publication"].verdict, "FAIL");
      assert.match(by["reply-publication"].message, /already reviewed; no new revision landed/);
    } finally {
      setTransport(prev);
    }
  });
});

test("can-reply --claims-fix reads the record with the writer's validator: `rx publication record`'s output PASSes; a malformed record is ERROR input", async () => {
  const newHead = "fedcba9876543210fedcba9876543210fedcba98";
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    storeRound(ext);
    const f = replyFiles(dir, { disposition: "fixed", reply: "@greptile Fixed in fedcba9: the empty state now renders a List.EmptyView." });
    const argv = replyArgv(f, ["--claims-fix"]).map((a) => (a === HEAD ? newHead : a));
    const pub = join(ext, ".git", "rx", "publication.json");
    const prev = setTransport(fakeGitHub({ prHeadSha: newHead }).t);
    try {
      const wrote = await rx(["publication", "record", "raycast/extensions", PR, newHead, "--json"], { cwd: ext });
      assert.equal(wrote.code, 0, wrote.stdout);
      let out = await rx([...argv, "--json"], { cwd: ext });
      assert.equal(out.code, 0, out.stdout);
      assert.equal(Object.fromEntries(out.json.results.map((x) => [x.id, x]))["reply-publication"].verdict, "PASS");
      // Each of these is a record `rx publication record` refuses to write; the reader refuses it too.
      const good = JSON.parse(readFileSync(pub, "utf8"));
      for (const bad of [{ ...good, at: "x" }, { ...good, pr: String(good.pr) }, { ...good, signature: "s" }, { ...good, remoteSha: newHead.toUpperCase() }]) {
        writeFileSync(pub, JSON.stringify(bad));
        out = await rx([...argv, "--json"], { cwd: ext });
        assert.equal(out.code, 2, JSON.stringify(bad));
        assert.deepEqual(out.json.results.filter((x) => x.verdict === "ERROR").map((x) => x.id), ["input"], JSON.stringify(bad));
        assert.match(out.stdout, /publication record .* is malformed/);
      }
    } finally {
      setTransport(prev);
    }
  });
});

test("can-reply --claims-fix reads the record `rx publication record` wrote from a multi-extension repository root, from an extension inside it: state is per repository", async () => {
  const newHead = "fedcba9876543210fedcba9876543210fedcba98";
  await withTempDir(async (dir) => {
    const repo = join(dir, "checkout");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const ext = fakeExtension(repo, "ext-a");
    fakeExtension(repo, "ext-b"); // two extensions: the root itself resolves to no single extension
    storeRound(repo); // the round lives in the repository's state, as `fetch` from either extension writes it
    const f = replyFiles(dir, { disposition: "fixed", reply: "@greptile Fixed in fedcba9: the empty state now renders a List.EmptyView." });
    const argv = replyArgv(f, ["--claims-fix"]).map((a) => (a === HEAD ? newHead : a));
    const prev = setTransport(fakeGitHub({ prHeadSha: newHead }).t);
    try {
      const wrote = await rx(["publication", "record", "raycast/extensions", PR, newHead, "--json"], { cwd: repo });
      assert.equal(wrote.code, 0, wrote.stdout);
      assert.ok(existsSync(join(repo, ".git", "rx", "publication.json")), "the record is in the repository's state");
      const out = await rx([...argv, "--json"], { cwd: ext });
      assert.equal(out.code, 0, out.stdout);
      assert.equal(Object.fromEntries(out.json.results.map((x) => [x.id, x]))["reply-publication"].verdict, "PASS");
    } finally {
      setTransport(prev);
    }
  });
});

test("can-reply: the exact reply bytes are scanned with the forbidden list; an empty list is N/A, never PASS", async () => {
  await withTempDir(async (dir) => {
    const ext = gitExtension(dir);
    storeRound(ext);
    const prev = setTransport(fakeGitHub().t);
    try {
      const leaky = replyFiles(dir, { reply: "@greptile Declined. Reproduce with video AbCdEfGhIjK as discussed." });
      let out = await rx([...replyArgv(leaky), "--json"], { cwd: ext });
      let by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(out.code, 1);
      assert.equal(by["reply-scan"].verdict, "FAIL");
      assert.deepEqual(by["reply-scan"].details.map((d) => d.text), ["forbidden list line 2"]);
      assert.ok(!JSON.stringify(by["reply-scan"]).includes("AbCdEfGhIjK"), "the literal is never echoed");
      assert.equal(out.json.data.authorized, false);
      const empty = replyFiles(dir, { forbidden: "# nothing\n\n" });
      out = await rx([...replyArgv(empty), "--json"], { cwd: ext });
      by = Object.fromEntries(out.json.results.map((x) => [x.id, x]));
      assert.equal(by["reply-scan"].verdict, "N/A");
      assert.match(by["reply-scan"].message, /forbidden list is empty/);
    } finally {
      setTransport(prev);
    }
  });
});

// ---- rules comparison: pure (ported tests) ---------------------------------------------------

const base = () => ({
  config: { strictness: 2, rules: [{ id: "a", severity: "low", scope: ["x"], rule: "A" }, { id: "b", severity: "high", scope: ["y"], rule: "B" }] },
  files: { files: [{ path: "docs/one.md", description: "one", scope: ["x"] }] },
  rules: "# Guidance\n\n## First\n\ntext\n",
});

test("compare: identical rule sets report nothing", () => {
  assert.deepEqual(diffRuleSets(base(), base()), []);
});

test("compare: added, removed and changed rules are named by id, one line per changed field", () => {
  const live = base();
  live.config.rules = [{ id: "a", severity: "medium", scope: ["x"], rule: "A2" }, { id: "c", severity: "low", scope: [], rule: "C" }];
  assert.deepEqual(diffRuleSets(base(), live), ["rule added c [low]", "rule removed b", "rule changed a severity", "rule changed a rule"]);
});

test("compare: settings, context files and rules.md sections are compared", () => {
  const live = base();
  live.config.strictness = 3;
  live.files.files = [{ path: "docs/two.md", description: "two", scope: ["x"] }];
  live.rules = "# Guidance\n\n## Second\n\ntext\n";
  assert.deepEqual(diffRuleSets(base(), live), [
    "setting changed strictness",
    "files changed docs/two.md (added)",
    "files changed docs/one.md (removed)",
    "rules.md changed; sections added: ## Second; sections removed: ## First",
  ]);
});

test("compare: malformed rule sets throw instead of comparing equal (duplicate ids, missing ids, non-array files)", () => {
  const dup = base();
  dup.config.rules.push({ id: "a", severity: "low", scope: [], rule: "A again" });
  assert.throws(() => diffRuleSets(base(), dup), /duplicate rule id: a/);
  const noId = base();
  noId.config.rules.push(/** @type {any} */ ({ severity: "low", scope: [], rule: "anon" }));
  assert.throws(() => diffRuleSets(base(), noId), /without an id/);
  const badFiles = base();
  badFiles.files = /** @type {any} */ ({ files: "nope" });
  assert.throws(() => diffRuleSets(base(), badFiles), /files/);
});

test("compare: liveSource reads main's current head, falls back to the open PR, and refuses a merged PR or a missing PR with no rules on main", async () => {
  const routes = (/** @type {Record<string, any>} */ r) => ({
    async getJson(/** @type {string} */ p) { for (const [k, v] of Object.entries(r)) if (p.includes(k)) return v; throw new Error(`404 ${p}`); },
    async getRaw(/** @type {string} */ p) { for (const [k, v] of Object.entries(r)) if (p.includes(k)) return v; const e = new Error(`404 ${p}`); /** @type {any} */ (e).status = 404; throw e; },
  });
  const C = "/commits?path=.greptile&sha=main&per_page=1";
  const M1 = "1".repeat(40);
  const P1 = "2".repeat(40);
  const main = await liveSource("r/e", 1, routes({ [C]: [{ sha: M1, commit: { committer: { date: LATER } } }] }));
  assert.deepEqual([main.source, main.sha, main.committed], ["main", M1, LATER]);
  const pr = await liveSource("r/e", 1, routes({ [C]: [], "/pulls/1": { state: "open", head: { sha: P1 } }, [`/commits/${P1}`]: { commit: { committer: { date: EARLIER } } } }));
  assert.deepEqual([pr.source, pr.sha, pr.committed], ["pr", P1, EARLIER]);
  // A commit without a usable date, or dated in the future, is refused rather than ordered.
  await assert.rejects(liveSource("r/e", 1, routes({ [C]: [{ sha: M1, commit: { committer: { date: "yesterday" } } }] })), /not an ISO-8601 commit time/);
  await assert.rejects(liveSource("r/e", 1, routes({ [C]: [{ sha: M1, commit: { committer: { date: "2999-01-01T00:00:00Z" } } }] })), /more than a day in the future/);
  await assert.rejects(liveSource("r/e", 1, routes({ [C]: [], "/pulls/1": { state: "closed", merged_at: "x", head: { sha: P1 } } })), /merged/);
  await assert.rejects(liveSource("r/e", null, routes({ [C]: [] })), /no commit on main touches \.greptile\//);
});

// ---- the rules lookup ------------------------------------------------------------------------

const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";
const SHA_D = "dddddddddddddddddddddddddddddddddddddddd";
const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The cache directory `rx greptile update` writes under, for a cache root. @param {string} cacheRoot */
const rulesCache = (cacheRoot) => join(cacheRoot, "raycast-harness", "greptile", "rules");

/**
 * Write a cache copy the way `rx greptile update` lays it out: the shipped files (optionally
 * changed) plus a SOURCE.json.
 * @param {string} cacheRoot
 * @param {{ name: string, sha: string, committed?: string, fetched?: string, source?: Record<string, unknown>, config?: (c: any) => void, files?: Record<string, string> }} o
 */
function cacheCopy(cacheRoot, o) {
  const dir = join(rulesCache(cacheRoot), o.name);
  mkdirSync(dir, { recursive: true });
  for (const f of ["config.json", "files.json", "rules.md"]) writeFileSync(join(dir, f), readFileSync(join(SNAPSHOT_DIR, f), "utf8"));
  if (o.config) {
    const c = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    o.config(c);
    writeFileSync(join(dir, "config.json"), JSON.stringify(c));
  }
  for (const [f, text] of Object.entries(o.files ?? {})) writeFileSync(join(dir, f), text);
  writeFileSync(join(dir, "SOURCE.json"), JSON.stringify(o.source ?? { repo: "raycast/extensions", source: "main", sha: o.sha, committed: o.committed ?? LATER, fetched: o.fetched ?? new Date().toISOString() }));
  return dir;
}

/**
 * Run fn with XDG_CACHE_HOME at <dir>/cache.
 * @template T @param {(dir: string, cacheRoot: string) => Promise<T> | T} fn
 */
async function withCache(fn) {
  return withTempDir(async (dir) => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    try {
      return await fn(dir, join(dir, "cache"));
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
}

test("lookup: with no cache copy the shipped rules are in use", async () => {
  await withCache(() => {
    const warnings = /** @type {string[]} */ ([]);
    const r = loadGreptileRules({ warn: (m) => warnings.push(m) });
    assert.equal(r.source.kind, "shipped");
    assert.equal(r.source.path, SNAPSHOT_DIR);
    assert.ok(Array.isArray(r.rules.config.rules) && r.rules.config.rules.length > 0);
    assert.deepEqual(warnings, []);
  });
});

test("lookup: the newest valid cache copy is preferred over the shipped one", async () => {
  await withCache((_dir, cache) => {
    // "zz-older" sorts last by name and was fetched last: neither decides, the commit date does.
    cacheCopy(cache, { name: "zz-older", sha: SHA_D, committed: "2026-11-04T00:00:00Z", fetched: "2026-11-06T00:00:00Z" });
    const newest = cacheCopy(cache, { name: "newer", sha: SHA_C, committed: LATER, fetched: "2026-11-05T00:00:00Z", config: (c) => c.rules.push({ id: "only-in-cache", severity: "low", scope: [], rule: "C" }) });
    mkdirSync(join(rulesCache(cache), ".tmp-1-dead"), { recursive: true }); // an interrupted write is never read
    const warnings = /** @type {string[]} */ ([]);
    const r = loadGreptileRules({ warn: (m) => warnings.push(m) });
    assert.equal(r.source.kind, "updated");
    assert.equal(r.source.sha, SHA_C);
    assert.equal(r.source.path, newest);
    assert.equal(r.source.origin, "main");
    assert.ok(r.rules.config.rules.some((/** @type {any} */ x) => x.id === "only-in-cache"));
    assert.deepEqual(warnings, []);
  });
});

test("lookup: an invalid cache copy is ignored with a warning naming it, never trusted", async () => {
  await withCache((_dir, cache) => {
    const good = cacheCopy(cache, { name: "good", sha: SHA_D, committed: "2026-11-04T00:00:00Z" });
    const dup = cacheCopy(cache, { name: "dup", sha: SHA_C, committed: LATER, config: (c) => c.rules.push({ ...c.rules[0] }) });
    const badSource = cacheCopy(cache, { name: "bad-source", sha: SHA_C, source: { repo: "raycast/extensions", source: "main", sha: "not-a-sha", committed: LATER, fetched: "2026-11-05" } });
    const warnings = /** @type {string[]} */ ([]);
    const r = loadGreptileRules({ warn: (m) => warnings.push(m) });
    assert.equal(r.source.path, good, "the newest VALID copy wins");
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.ok(warnings.some((w) => w.includes(dup) && /duplicate rule id/.test(w)), warnings.join("\n"));
    assert.ok(warnings.some((w) => w.includes(badSource) && /sha is not a 40-hex commit/.test(w)), warnings.join("\n"));

    // Only invalid copies: the shipped copy, still with the warnings.
    const warnings2 = /** @type {string[]} */ ([]);
    rmDir(good);
    assert.equal(loadGreptileRules({ warn: (m) => warnings2.push(m) }).source.kind, "shipped");
    assert.equal(warnings2.length, 2);
  });
});

test("lookup: a cache copy older than the shipped copy does not shadow it", async () => {
  await withCache((_dir, cache) => {
    cacheCopy(cache, { name: "ancient", sha: SHA_C, committed: EARLIER, fetched: new Date().toISOString() });
    assert.equal(loadGreptileRules({ warn: () => {} }).source.kind, "shipped");
  });
});

test("lookup: the CLI surfaces an invalid cache copy's warning on stderr", async () => {
  await withCache(async (dir, cache) => {
    const bad = cacheCopy(cache, { name: "bad", sha: SHA_C, files: { "files.json": "{ not json" } });
    const prev = setTransport(fakeGitHub({ mainHas: true, mainSha: MAIN }).t);
    try {
      const r = await rx(["greptile", "outdated", "--json"], { cwd: dir });
      assert.match(r.stderr, new RegExp(`ignoring the invalid Greptile rules copy in ${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.equal(r.json.data.inUse.kind, "shipped");
    } finally {
      setTransport(prev);
    }
  });
});

/** @param {string} dir */
function rmDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ---- outdated: command -----------------------------------------------------------------------

test("the shipped rules are the real raycast/extensions provenance (never a fixture) and SOURCE.json has the recorded shape", () => {
  const src = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "SOURCE.json"), "utf8"));
  const keys = Object.keys(src).sort();
  assert.deepEqual(keys.filter((k) => k !== "pr"), ["committed", "fetched", "repo", "sha", "source"]);
  assert.match(src.committed, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "the upstream commit date of sha (commit.committer.date)");
  if (src.source === "pr") assert.ok(Number.isInteger(src.pr), "a copy from a PR names it");
  assert.equal(src.repo, "raycast/extensions");
  assert.notEqual(src.sha, HEAD, "SOURCE.json carries the fixture PR head: a test wrote into the installed snapshot");
  assert.ok(!/^0123456789abcdef/.test(src.sha), "fixture SHA in SOURCE.json");
  assert.ok(["main", "pr"].includes(src.source));
  assert.match(src.sha, /^[0-9a-f]{40}$/);
  assert.match(src.fetched, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(readdirSync(SNAPSHOT_DIR).sort(), ["SOURCE.json", "config.json", "files.json", "rules.md"]);
  // The one validator the cache, update and update --dest use accepts the shipped copy, whose
  // severities are exactly the accepted set.
  const shipped = readRuleDir(SNAPSHOT_DIR, "shipped");
  assert.deepEqual([...new Set(shipped.set.config.rules.map((/** @type {any} */ r) => r.severity))].sort(), [...SEVERITIES].sort());
});

test("greptile outdated: PASS when the copy in use matches main; FAIL with one detail per change and the update hint", async () => {
  const same = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN }).t, ["greptile", "outdated"], {
    setup: (dir) => void cacheCopy(join(dir, "cache"), { name: "c", sha: SHA_C, fetched: "2099-01-02T03:04:05Z" }),
  });
  assert.equal(same.code, 0, same.stdout);
  assert.equal(same.by["greptile-outdated"].verdict, "PASS");
  assert.equal(same.by["greptile-outdated"].message, "the rules are current: raycast/extensions main @ ccccccc (2099-01-02, updated copy)");
  assert.deepEqual(same.json.data.live, { source: "main", sha: MAIN, committed: LATER });
  assert.equal(same.json.data.inUse.kind, "updated");

  const liveConfig = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "config.json"), "utf8"));
  liveConfig.rules[0].severity = liveConfig.rules[0].severity === "high" ? "low" : "high";
  liveConfig.rules.push({ id: "brand-new-rule", severity: "low", scope: ["extensions/**"], rule: "New" });
  const changed = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN, snapshotFiles: { "config.json": JSON.stringify(liveConfig) } }).t, ["greptile", "outdated"], {
    setup: (dir) => void cacheCopy(join(dir, "cache"), { name: "c", sha: SHA_C, fetched: "2099-01-02T03:04:05Z" }),
  });
  assert.equal(changed.code, 1, changed.stdout);
  assert.equal(changed.by["greptile-outdated"].verdict, "FAIL");
  assert.equal(changed.by["greptile-outdated"].message, "out of date: 2 change(s) since 2099-01-02; run rx greptile update");
  const texts = changed.by["greptile-outdated"].details.map((/** @type {any} */ d) => d.text);
  assert.deepEqual(texts, changed.json.data.changes, "details derive from data.changes");
  assert.deepEqual(texts.sort(), ["rule added brand-new-rule [low]", `rule changed ${liveConfig.rules[0].id} severity`].sort());
});

test("greptile outdated: a copy at the last commit that touched .greptile/ is current after one request, without fetching a file", async () => {
  const { t, calls } = fakeGitHub({ mainHas: true, mainSha: SHA_C });
  const r = await withFake(t, ["greptile", "outdated"], { setup: (dir) => void cacheCopy(join(dir, "cache"), { name: "c", sha: SHA_C }) });
  assert.equal(r.by["greptile-outdated"].verdict, "PASS");
  assert.deepEqual(calls, ["GET repos/raycast/extensions/commits?path=.greptile&sha=main&per_page=1"]);
});

test("greptile outdated: a copy from a PR whose rules are now on main reports source moved first", async () => {
  const r = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN }).t, ["greptile", "outdated"], {
    setup: (dir) => void cacheCopy(join(dir, "cache"), { name: "p", sha: SHA_C, source: { repo: "raycast/extensions", pr: 32933, source: "pr", sha: SHA_C, committed: "2026-11-04T00:00:00Z", fetched: "2099-01-01" } }),
  });
  assert.equal(r.by["greptile-outdated"].verdict, "FAIL");
  assert.equal(r.json.data.changes[0], "source moved pr → main (PR #32933 merged)");
});

test("greptile outdated: an unreadable live copy is ERROR, never 'current'", async () => {
  const { t } = fakeGitHub();
  t.getJson = async () => { throw new RxError("gh api failed (HTTP 503)", { id: "github" }); };
  const r = await withFake(t, ["greptile", "outdated"]);
  assert.equal(r.code, 2);
  assert.equal(r.by["greptile-outdated"].verdict, "ERROR");
  assert.match(r.by["greptile-outdated"].message, /could not read or compare/);
});

test("the old drift subcommand and check id are gone (renamed to outdated, no alias)", async () => {
  const old = await rx(["greptile", ["dr", "ift"].join(""), "--json"]);
  assert.equal(old.code, 2);
  assert.equal(old.json.results[0].id, "args");
  const reg = await rx(["commands", "--json"]);
  const text = JSON.stringify(reg.json.data);
  assert.ok(!/drift/i.test(text), "no command, flag, check id or help text says drift");
  const g = reg.json.data.commands.find((/** @type {any} */ c) => c.name === "greptile");
  assert.deepEqual(Object.keys(g.subcommands).sort(), ["can-reply", "fetch", "outdated", "update", "wait"]);
  assert.deepEqual(Object.keys(g.subcommands.outdated.checks), ["greptile-outdated"]);
  assert.deepEqual(Object.keys(g.subcommands.update.checks), ["greptile-update"]);
});

// ---- update: command -------------------------------------------------------------------------

test("greptile update: writes a new cache copy atomically, reports the changes, and the lookup then uses it", async () => {
  const liveRules = readFileSync(join(SNAPSHOT_DIR, "rules.md"), "utf8") + "\n## Added section\n\nnew text\n";
  /** @type {string[]} */
  let after = [];
  const r = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN, snapshotFiles: { "rules.md": liveRules } }).t, ["greptile", "update"], {
    // A minute ago: newer than the shipped copy, older than the one update writes now.
    setup: (dir) => void cacheCopy(join(dir, "cache"), { name: "c", sha: SHA_C, committed: "2026-11-04T00:00:00Z", fetched: new Date(Date.now() - 60_000).toISOString() }),
    inspect: (dir) => {
      after = readdirSync(rulesCache(join(dir, "cache"))).sort();
      const loaded = loadGreptileRules({ warn: (m) => assert.fail(m) });
      assert.equal(loaded.source.kind, "updated");
      assert.equal(loaded.source.sha, MAIN, "the copy just written is the one in use");
      assert.equal(loaded.rules.rules, liveRules);
      const written = JSON.parse(readFileSync(join(loaded.source.path, "SOURCE.json"), "utf8"));
      assert.deepEqual(Object.keys(written), ["repo", "source", "sha", "committed", "fetched"]);
      assert.deepEqual([written.repo, written.source, written.sha, written.committed], ["raycast/extensions", "main", MAIN, LATER]);
      assert.match(written.fetched, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.by["greptile-update"].verdict, "PASS");
  assert.equal(r.by["greptile-update"].message, "updated: ccccccc → aaaaaaa, 1 change(s)");
  assert.deepEqual(r.by["greptile-update"].details.map((/** @type {any} */ d) => d.text), ["rules.md changed; sections added: ## Added section"]);
  assert.equal(after.length, 2, `the old copy and the new one, no temp directory left: ${after.join(", ")}`);
  assert.ok(!after.some((n) => n.startsWith(".")), after.join(", "));
  assert.match(String(r.json.data.updated), /aaaaaaa$/);
});

test("greptile update: already current writes nothing", async () => {
  /** @type {string[]} */
  let after = [];
  const r = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN }).t, ["greptile", "update"], {
    setup: (dir) => void cacheCopy(join(dir, "cache"), { name: "c", sha: SHA_C }),
    inspect: (dir) => { after = readdirSync(rulesCache(join(dir, "cache"))); },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.by["greptile-update"].verdict, "PASS");
  assert.match(r.by["greptile-update"].message, /^already current: raycast\/extensions main @ ccccccc .* matches main @ aaaaaaa$/);
  assert.equal(r.json.data.updated, null);
  assert.deepEqual(after, ["c"]);
});

test("greptile update: a network or validation failure is ERROR and writes nothing", async () => {
  const { t } = fakeGitHub();
  t.getJson = async () => { throw new RxError("gh api failed (HTTP 503)", { id: "github" }); };
  const offline = await withFake(t, ["greptile", "update"], { inspect: (dir) => assert.ok(!existsSync(rulesCache(join(dir, "cache"))), "no cache directory created") });
  assert.equal(offline.code, 2);
  assert.equal(offline.by["greptile-update"].verdict, "ERROR");
  assert.match(offline.by["greptile-update"].message, /nothing written/);

  const liveConfig = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "config.json"), "utf8"));
  liveConfig.rules.push({ ...liveConfig.rules[0] });
  const invalid = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN, snapshotFiles: { "config.json": JSON.stringify(liveConfig) } }).t, ["greptile", "update"], {
    inspect: (dir) => assert.ok(!existsSync(rulesCache(join(dir, "cache"))), "no cache directory created"),
  });
  assert.equal(invalid.by["greptile-update"].verdict, "ERROR");
  assert.match(invalid.by["greptile-update"].message, /duplicate rule id/);
});

test("writeUpdatedCopy: a copy that fails validation leaves neither the copy nor its temp directory", async () => {
  await withCache((_dir, cache) => {
    const raw = Object.fromEntries(["config.json", "files.json", "rules.md"].map((f) => [f, readFileSync(join(SNAPSHOT_DIR, f), "utf8")]));
    raw["files.json"] = "{ not json";
    assert.throws(() => writeUpdatedCopy(raw, { repo: "raycast/extensions", source: "main", sha: MAIN, committed: LATER, fetched: "2026-11-05T00:00:00.000Z" }), /files\.json/);
    assert.deepEqual(readdirSync(rulesCache(cache)), []);
  });
});

test("greptile update --dest writes only into --dest/src/rules/greptile and refuses the installed package", async () => {
  const before = Object.fromEntries(readdirSync(SNAPSHOT_DIR).map((f) => [f, readFileSync(join(SNAPSHOT_DIR, f), "utf8")]));
  const shippedSource = JSON.parse(before["SOURCE.json"]);

  // The running package's own shipped copy is refused, spelled directly or through a symlink. The
  // transport here cannot serve live content, so a broken guard produces a different ERROR
  // instead of a write into src/rules/greptile/ (which happened once, 2026-10-30).
  const self = await withFake(unfetchable(), ["greptile", "update", "--dest", REPO]);
  assert.deepEqual(self.json.results.map((/** @type {any} */ x) => [x.verdict, x.id]), [["ERROR", "greptile-update"]]);
  assert.match(self.json.results[0].message, /own shipped rules directory/);
  await withTempDir(async (dir) => {
    const link = join(dir, "alias");
    symlinkSync(REPO, link);
    const viaLink = await withFake(unfetchable(), ["greptile", "update", "--dest", link]);
    assert.deepEqual(viaLink.json.results.map((/** @type {any} */ x) => [x.verdict, x.id]), [["ERROR", "greptile-update"]]);
    assert.match(viaLink.json.results[0].message, /own shipped rules directory/);
  });

  await withTempDir(async (dir) => {
    const notCheckout = await withFake(fakeGitHub().t, ["greptile", "update", "--dest", dir]);
    assert.equal(notCheckout.json.results[0].verdict, "ERROR");
    assert.match(notCheckout.json.results[0].message, /not a raycast-harness checkout/);

    const dest = join(dir, "checkout");
    mkdirSync(join(dest, "src", "rules", "greptile"), { recursive: true });
    for (const [f, text] of Object.entries(before)) writeFileSync(join(dest, "src", "rules", "greptile", f), text);
    const liveRules = before["rules.md"] + "\n## Added section\n\nnew text\n";
    const r = await withFake(fakeGitHub({ mainHas: true, mainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", snapshotFiles: { "rules.md": liveRules } }).t, ["greptile", "update", "--dest", dest], {
      inspect: (tmp) => assert.ok(!existsSync(rulesCache(join(tmp, "cache"))), "--dest writes no cache copy"),
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["greptile-update"].verdict, "PASS");
    assert.match(r.by["greptile-update"].message, new RegExp(`^updated: ${shippedSource.sha.slice(0, 7)} → bbbbbbb, \\d+ change\\(s\\) written to `));
    assert.equal(r.json.data.updated, join(dest, "src", "rules", "greptile"));
    const written = JSON.parse(readFileSync(join(dest, "src", "rules", "greptile", "SOURCE.json"), "utf8"));
    assert.deepEqual([written.repo, written.pr, written.source, written.sha, written.committed], [shippedSource.repo, shippedSource.pr, "main", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", LATER]);
    assert.match(written.fetched, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(readFileSync(join(dest, "src", "rules", "greptile", "rules.md"), "utf8"), liveRules);
  });
  // The installed shipped copy (this checkout's src/rules/greptile) was not touched.
  for (const [f, text] of Object.entries(before)) assert.equal(readFileSync(join(SNAPSHOT_DIR, f), "utf8"), text, `${f} unchanged`);
});

test("greptile: subcommand roots are as contracted (fetch/wait/can-reply optional, outdated/update none) and ids are declared", async () => {
  const r = await rx(["commands", "--json"]);
  const g = r.json.data.commands.find((/** @type {any} */ c) => c.name === "greptile");
  assert.equal(g.subcommands.fetch.root, "optional");
  assert.equal(g.subcommands["can-reply"].root, "optional");
  assert.equal(g.subcommands.outdated.root, "none");
  assert.equal(g.subcommands.update.root, "none");
  assert.deepEqual(Object.keys(g.subcommands["can-reply"].checks).sort(), ["reply-evidence", "reply-head", "reply-publication", "reply-round", "reply-scan"]);
  const p = r.json.data.commands.find((/** @type {any} */ c) => c.name === "pr");
  assert.equal(p.root, "none");
  assert.deepEqual(Object.keys(p.subcommands.body.checks).sort(), ["pr-body-diff", "pr-body-write"]);
});

// ---- Wave 9 Codex round 1: findings 2, 3, 4, 7 ---------------------------------------------------

test("lookup (W9 finding 2): copies are ordered by upstream commit date; an earlier-same-day cache copy fetched later does not shadow the newer shipped copy", async () => {
  await withCache((_dir, cache) => {
    const shipped = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "SOURCE.json"), "utf8"));
    const sameDayEarlier = shipped.committed.slice(0, 10) + "T00:00:01Z";
    assert.ok(sameDayEarlier < shipped.committed, "fixture: earlier the same day");
    cacheCopy(cache, { name: "same-day", sha: SHA_C, committed: sameDayEarlier, fetched: new Date().toISOString() });
    assert.equal(loadGreptileRules({ warn: (m) => assert.fail(m) }).source.kind, "shipped");
    // A tie on the commit date goes to the shipped copy, whatever the cache copy's name or fetch time.
    cacheCopy(cache, { name: "zzz-tie", sha: SHA_D, committed: shipped.committed, fetched: new Date().toISOString() });
    assert.equal(loadGreptileRules({ warn: (m) => assert.fail(m) }).source.kind, "shipped");
  });
});

test("lookup (W9 findings 2–4): a future or unparseable commit date, a foreign repo, or a malformed rule body makes a cache copy invalid; the shipped copy is used and audits still load", async () => {
  await withCache((_dir, cache) => {
    const bad = [
      cacheCopy(cache, { name: "future", sha: SHA_C, committed: "2999-01-01T00:00:00Z" }),
      cacheCopy(cache, { name: "no-date", sha: SHA_C, source: { repo: "raycast/extensions", source: "main", sha: SHA_C, fetched: "2026-11-05" } }),
      cacheCopy(cache, { name: "garbled-date", sha: SHA_C, committed: "last tuesday" }),
      cacheCopy(cache, { name: "foreign", sha: SHA_C, source: { repo: "someone/extensions", source: "main", sha: SHA_C, committed: LATER, fetched: "2026-11-05" } }),
      cacheCopy(cache, { name: "object-body", sha: SHA_C, config: (c) => { c.rules.find((/** @type {any} */ r) => r.id === "no-silent-failure").rule = {}; } }),
      cacheCopy(cache, { name: "no-body", sha: SHA_C, config: (c) => { delete c.rules[0].rule; } }),
      cacheCopy(cache, { name: "bad-severity", sha: SHA_C, config: (c) => { c.rules[0].severity = "critical"; } }),
      cacheCopy(cache, { name: "bad-scope", sha: SHA_C, config: (c) => { c.rules[0].scope = "extensions/**"; } }),
      cacheCopy(cache, { name: "bad-file", sha: SHA_C, files: { "files.json": JSON.stringify({ files: [{ path: "docs/x.md", scope: ["extensions/**"] }] }) } }),
    ];
    const warnings = /** @type {string[]} */ ([]);
    const r = loadGreptileRules({ warn: (m) => warnings.push(m) });
    assert.equal(r.source.kind, "shipped");
    const expect = [/more than a day in the future/, /committed is not an ISO-8601 commit time: undefined/, /not an ISO-8601 commit time: "last tuesday"/, /repo is "someone\/extensions", not raycast\/extensions/, /rule no-silent-failure has no rule text/, /has no rule text/, /severity "critical" is not one of low, medium, high/, /scope is not an array of strings/, /files\.json entry docs\/x\.md has no description string/];
    bad.forEach((dir, i) => assert.ok(warnings.some((w) => w.includes(dir) && expect[i].test(w)), `${dir}: ${warnings.join("\n")}`));
    assert.equal(warnings.length, bad.length);
  });
});

test("audit (W9 finding 4): a cache copy with `rule: {}` on a judgment id is skipped, so the judgment rules still load from the shipped copy", async () => {
  await withCache(async (_dir, cache) => {
    cacheCopy(cache, { name: "object-body", sha: SHA_C, config: (c) => { c.rules.find((/** @type {any} */ r) => r.id === "no-silent-failure").rule = {}; } });
    const { greptileJudgmentRules } = await import("../src/audit/greptile.mjs");
    const rules = greptileJudgmentRules();
    const shippedRule = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "config.json"), "utf8")).rules.find((/** @type {any} */ r) => r.id === "no-silent-failure");
    assert.equal(rules.find((r) => r.id === "no-silent-failure")?.title, shippedRule.rule.split("\n")[0].trim(), "the shipped rule's title");
    assert.ok(rules.every((r) => typeof r.title === "string" && r.title.length > 0));
  });
});

test("greptile update (W9 finding 4): a live copy with a malformed rule body is ERROR and nothing is written, to the cache or to --dest", async () => {
  const liveConfig = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "config.json"), "utf8"));
  liveConfig.rules[0].rule = {};
  const t = fakeGitHub({ mainHas: true, mainSha: MAIN, snapshotFiles: { "config.json": JSON.stringify(liveConfig) } }).t;
  const r = await withFake(t, ["greptile", "update"], { inspect: (dir) => assert.ok(!existsSync(rulesCache(join(dir, "cache"))) || readdirSync(rulesCache(join(dir, "cache"))).length === 0) });
  assert.equal(r.by["greptile-update"].verdict, "ERROR");
  assert.match(r.by["greptile-update"].message, /nothing written: .*has no rule text/);
  await withTempDir(async (dir) => {
    const dest = destCheckout(dir);
    const before = destBytes(dest);
    const d = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN, snapshotFiles: { "config.json": JSON.stringify(liveConfig) } }).t, ["greptile", "update", "--dest", dest]);
    assert.equal(d.by["greptile-update"].verdict, "ERROR");
    assert.match(d.by["greptile-update"].message, /nothing written: .*has no rule text/);
    assert.deepEqual(destBytes(dest), before);
  });
});

test("greptile (W9 finding 3): every upstream request names raycast/extensions, even with a foreign-repo copy in the cache", async () => {
  const { t, calls } = fakeGitHub({ mainHas: true, mainSha: MAIN, snapshotFiles: { "rules.md": "# changed\n" } });
  const r = await withFake(t, ["greptile", "outdated"], {
    setup: (dir) => void cacheCopy(join(dir, "cache"), { name: "foreign", sha: SHA_C, source: { repo: "someone/extensions", source: "main", sha: SHA_C, committed: LATER, fetched: "2026-11-05" } }),
  });
  assert.equal(r.json.data.inUse.kind, "shipped");
  assert.match(r.stderr, /repo is "someone\/extensions", not raycast\/extensions/);
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.match(c, /^(GET|RAW) repos\/raycast\/extensions\//, c);
});

test("greptile update (W9 finding 2): out of order — a copy from a later upstream commit already in the cache stays in use; update says so with a WARN, never PASS updated", async () => {
  /** @type {any} */
  let inUse = null;
  const r = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN, mainCommitted: "2026-11-04T00:00:00Z", snapshotFiles: { "rules.md": "# older upstream text\n" } }).t, ["greptile", "update"], {
    setup: (dir) => void cacheCopy(join(dir, "cache"), { name: "later", sha: SHA_D, committed: LATER, fetched: "2026-11-05T00:00:00.000Z" }),
    inspect: () => { inUse = loadGreptileRules({ warn: (m) => assert.fail(m) }).source; },
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.by["greptile-update"].verdict, "WARN");
  assert.match(r.by["greptile-update"].message, /^wrote .*aaaaaaa \(aaaaaaa, committed 2026-11-04T00:00:00Z\) but it is not the copy in use: raycast\/extensions main @ ddddddd .*committed 2026-11-05T00:00:00Z, sorts later/);
  assert.equal(r.json.data.inUse, false);
  assert.equal(inUse.sha, SHA_D, "the later commit is still the copy in use");
});

test("greptile update --dest (W9 finding 7): a write that fails part-way restores every file; ERROR nothing written; no stage directory left", async () => {
  if (process.getuid?.() === 0) return; // root ignores the read-only bit this test relies on
  await withTempDir(async (dir) => {
    const dest = destCheckout(dir);
    const before = destBytes(dest);
    const ro = join(dest, "src", "rules", "greptile", "SOURCE.json"); // written last, after the three rule files
    chmodSync(ro, 0o444);
    try {
      const liveRules = before["rules.md"] + "\n## Added section\n\nnew text\n";
      const r = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN, snapshotFiles: { "rules.md": liveRules } }).t, ["greptile", "update", "--dest", dest]);
      assert.equal(r.code, 2, r.stdout);
      assert.equal(r.by["greptile-update"].verdict, "ERROR");
      assert.match(r.by["greptile-update"].message, /^could not write --dest .*; nothing written: .*EACCES.*every file in .* was restored$/);
      assert.equal(r.json.data.updated, null);
    } finally {
      chmodSync(ro, 0o644);
    }
    assert.deepEqual(destBytes(dest), before, "the destination is byte-for-byte the old copy");
    assert.deepEqual(readdirSync(join(dest, "src", "rules")), ["greptile"], "no stage directory left beside the destination");
  });
});

test("greptile update --dest (W9 round 2 finding E): an older checkout whose SOURCE.json predates committed is updated, and the new SOURCE.json carries committed", async () => {
  await withTempDir(async (dir) => {
    const dest = destCheckout(dir);
    const sourcePath = join(dest, "src", "rules", "greptile", "SOURCE.json");
    const { committed: _drop, ...legacy } = JSON.parse(readFileSync(sourcePath, "utf8"));
    writeFileSync(sourcePath, JSON.stringify(legacy, null, 2) + "\n");
    const liveRules = readFileSync(join(SNAPSHOT_DIR, "rules.md"), "utf8") + "\n## Added section\n\nnew text\n";
    const r = await withFake(fakeGitHub({ mainHas: true, mainSha: MAIN, snapshotFiles: { "rules.md": liveRules } }).t, ["greptile", "update", "--dest", dest]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.by["greptile-update"].verdict, "PASS");
    assert.equal(r.json.data.previous.committed, "1970-01-01T00:00:00Z", "older than anything with a date");
    const written = JSON.parse(readFileSync(sourcePath, "utf8"));
    assert.equal(written.sha, MAIN);
    assert.match(written.committed, /^\d{4}-\d{2}-\d{2}T/);
    // Strict everywhere else: the same legacy SOURCE.json fails validation without the --dest allowance.
    writeFileSync(sourcePath, JSON.stringify(legacy, null, 2) + "\n");
    assert.throws(() => readRuleDir(join(dest, "src", "rules", "greptile"), "cached"), /committed is not an ISO-8601 commit time: undefined/);
  });
});

/**
 * An in-memory stand-in for the destination's files: `files.json`'s write truncates it and then
 * throws ENOSPC (what writeFileSync does on a full disk); `failRestore` names files whose
 * restoring write also fails; `silentRestore` names files whose restoring write "succeeds" but
 * leaves the file empty.
 * @param {string} destDir @param {string[]} [failRestore] @param {string[]} [silentRestore]
 */
function truncatingIo(destDir, failRestore = [], silentRestore = []) {
  /** @type {Map<string, Buffer>} */
  const mem = new Map(readdirSync(destDir).map((f) => [join(destDir, f), readFileSync(join(destDir, f))]));
  let thrown = false;
  return {
    mem,
    io: {
      readFileSync: (/** @type {string} */ f) => { const b = mem.get(f); if (!b) throw new Error(`ENOENT ${f}`); return Buffer.from(b); },
      writeFileSync: (/** @type {string} */ f, /** @type {string | Buffer} */ data) => {
        const name = f.slice(destDir.length + 1);
        if (name === "files.json" && !thrown) { thrown = true; mem.set(f, Buffer.alloc(0)); throw new Error("ENOSPC: no space left on device, write"); }
        if (thrown && failRestore.includes(name)) { mem.set(f, Buffer.alloc(0)); throw new Error("EIO"); }
        if (thrown && silentRestore.includes(name)) { mem.set(f, Buffer.alloc(0)); return; }
        mem.set(f, Buffer.from(data));
      },
    },
  };
}

test("greptile update --dest (W9 round 2 finding D): a write that truncates then throws is restored too and verified; a restoration that fails is named, never 'restored'", async () => {
  await withTempDir(async (dir) => {
    const destDir = join(destCheckout(dir), "src", "rules", "greptile");
    const before = Object.fromEntries(readdirSync(destDir).map((f) => [f, readFileSync(join(destDir, f))]));
    const raw = { "config.json": before["config.json"].toString(), "files.json": before["files.json"].toString(), "rules.md": before["rules.md"].toString() + "\n## Added\n\nnew\n" };
    const src = { repo: "raycast/extensions", source: /** @type {const} */ ("main"), sha: "a".repeat(40), committed: "2026-11-04T00:00:00Z", fetched: "2026-11-04" };
    const ok = truncatingIo(destDir);
    assert.throws(() => writeDestCopy(destDir, raw, src, /** @type {any} */ (ok.io)), (/** @type {any} */ e) => {
      assert.match(e.message, /^ENOSPC: no space left on device, write; every file in .* was restored$/);
      assert.notEqual(e.partial, true);
      return true;
    });
    for (const [f, b] of Object.entries(before)) assert.ok(ok.mem.get(join(destDir, f))?.equals(b), `${f} is byte-for-byte the original`);

    const bad = truncatingIo(destDir, ["files.json"]);
    assert.throws(() => writeDestCopy(destDir, raw, src, /** @type {any} */ (bad.io)), (/** @type {any} */ e) => {
      assert.match(e.message, /^ENOSPC: no space left on device, write; and could not restore files\.json in .*: check them by hand$/);
      assert.equal(e.partial, true);
      return true;
    });
    const silent = truncatingIo(destDir, [], ["files.json"]);
    assert.throws(() => writeDestCopy(destDir, raw, src, /** @type {any} */ (silent.io)), (/** @type {any} */ e) => {
      assert.match(e.message, /could not restore files\.json in /, "the read-back, not the write's return, decides");
      assert.equal(e.partial, true);
      return true;
    });
    assert.deepEqual(readdirSync(join(dir, "checkout", "src", "rules")), ["greptile"], "no stage directory left");
  });
});

/** A maintainer checkout with a copy of the shipped rules. @param {string} dir */
function destCheckout(dir) {
  const dest = join(dir, "checkout");
  mkdirSync(join(dest, "src", "rules", "greptile"), { recursive: true });
  for (const f of readdirSync(SNAPSHOT_DIR)) writeFileSync(join(dest, "src", "rules", "greptile", f), readFileSync(join(SNAPSHOT_DIR, f)));
  return dest;
}

/** @param {string} dest */
function destBytes(dest) {
  const d = join(dest, "src", "rules", "greptile");
  return Object.fromEntries(readdirSync(d).sort().map((f) => [f, readFileSync(join(d, f), "utf8")]));
}

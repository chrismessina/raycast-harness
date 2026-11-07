import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_DIR } from "../src/commands/greptile.mjs";
import { diffRuleSets, liveSource } from "../src/greptile/drift.mjs";
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

/**
 * Comment lists are served only through `getJsonPages` (`reviewPage2` adds a second page), so a
 * regression to a single-page `getJson` throws.
 * @param {Partial<{ issue: any[], review: any[], reviewPage2: any[], pull: any, conditional: { status: number, etag: string | null, body: any } | Error, snapshotFiles: Record<string, string>, mainHas: boolean, mainSha: string, prState: string, prHeadSha: string }>} [o]
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
      if (/\/commits\/main$/.test(path)) return { sha: o.mainSha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
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
  assert.ok(!("--root" in g.subcommands.drift.flags), "drift has no root");
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

// ---- drift: pure (ported tests) --------------------------------------------------------------

const base = () => ({
  config: { strictness: 2, rules: [{ id: "a", severity: "low", scope: ["x"], rule: "A" }, { id: "b", severity: "high", scope: ["y"], rule: "B" }] },
  files: { files: [{ path: "docs/one.md", description: "one", scope: ["x"] }] },
  rules: "# Guidance\n\n## First\n\ntext\n",
});

test("drift: identical rule sets report nothing", () => {
  assert.deepEqual(diffRuleSets(base(), base()), []);
});

test("drift: added, removed and changed rules are named by id, one line per changed field", () => {
  const live = base();
  live.config.rules = [{ id: "a", severity: "medium", scope: ["x"], rule: "A2" }, { id: "c", severity: "low", scope: [], rule: "C" }];
  assert.deepEqual(diffRuleSets(base(), live), ["rule added c [low]", "rule removed b", "rule changed a severity", "rule changed a rule"]);
});

test("drift: settings, context files and rules.md sections are compared", () => {
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

test("drift: malformed rule sets throw instead of comparing equal (duplicate ids, missing ids, non-array files)", () => {
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

test("drift: liveSource reads main's current head, falls back to the open PR, and refuses a merged PR with no rules on main", async () => {
  const routes = (/** @type {Record<string, any>} */ r) => ({
    async getJson(/** @type {string} */ p) { for (const [k, v] of Object.entries(r)) if (p.includes(k)) return v; throw new Error(`404 ${p}`); },
    async getRaw(/** @type {string} */ p) { for (const [k, v] of Object.entries(r)) if (p.includes(k)) return v; const e = new Error(`404 ${p}`); /** @type {any} */ (e).status = 404; throw e; },
  });
  const main = await liveSource("r/e", 1, routes({ "/commits/main": { sha: "m1" }, "config.json?ref=m1": "{}" }));
  assert.deepEqual([main.source, main.sha], ["main", "m1"]);
  const pr = await liveSource("r/e", 1, routes({ "/commits/main": { sha: "m2" }, "/pulls/1": { state: "open", head: { sha: "p1" } } }));
  assert.deepEqual([pr.source, pr.sha], ["pr", "p1"]);
  await assert.rejects(liveSource("r/e", 1, routes({ "/commits/main": { sha: "m3" }, "/pulls/1": { state: "closed", merged_at: "x", head: { sha: "p" } } })), /merged/);
});

// ---- drift: command --------------------------------------------------------------------------

test("the core snapshot is the real raycast/extensions provenance (never a fixture) and SOURCE.json has the recorded shape", () => {
  const src = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "SOURCE.json"), "utf8"));
  assert.deepEqual(Object.keys(src).sort(), ["fetched", "pr", "repo", "sha", "source"]);
  assert.equal(src.repo, "raycast/extensions");
  assert.notEqual(src.sha, HEAD, "SOURCE.json carries the fixture PR head: a test wrote into the installed snapshot");
  assert.ok(!/^0123456789abcdef/.test(src.sha), "fixture SHA in SOURCE.json");
  assert.ok(["main", "pr"].includes(src.source));
  assert.match(src.sha, /^[0-9a-f]{40}$/);
  assert.match(src.fetched, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(readdirSync(SNAPSHOT_DIR).sort(), ["SOURCE.json", "config.json", "files.json", "rules.md"]);
});

test("greptile drift: PASS when the live PR head matches the snapshot; FAIL with one detail per change; source moved is in data.changes", async () => {
  const src = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "SOURCE.json"), "utf8"));
  const same = await withFake(fakeGitHub({ prHeadSha: src.sha }).t, ["greptile", "drift"]);
  assert.equal(same.code, 0, same.stdout);
  assert.equal(same.by["greptile-drift"].verdict, "PASS");
  assert.deepEqual(same.json.data.live, { source: "pr", sha: src.sha });

  const liveConfig = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "config.json"), "utf8"));
  liveConfig.rules[0].severity = liveConfig.rules[0].severity === "high" ? "low" : "high";
  liveConfig.rules.push({ id: "brand-new-rule", severity: "low", scope: ["extensions/**"], rule: "New" });
  const changed = await withFake(fakeGitHub({ mainHas: true, snapshotFiles: { "config.json": JSON.stringify(liveConfig) } }).t, ["greptile", "drift"]);
  assert.equal(changed.code, 1, changed.stdout);
  assert.equal(changed.by["greptile-drift"].verdict, "FAIL");
  const texts = changed.by["greptile-drift"].details.map((d) => d.text);
  assert.equal(texts[0], "source moved pr → main (PR #32933 merged)");
  assert.equal(changed.json.data.changes[0], "source moved pr → main (PR #32933 merged)", "source moved is one of data.changes");
  assert.deepEqual(texts, changed.json.data.changes, "details derive from data.changes");
  assert.ok(texts.includes("rule added brand-new-rule [low]"));
  assert.ok(texts.includes(`rule changed ${liveConfig.rules[0].id} severity`));
  assert.ok(texts.includes("setting changed rules") === false);
});

test("greptile drift: an unreadable live copy is ERROR, never 'no drift'", async () => {
  const { t } = fakeGitHub();
  t.getJson = async () => { throw new RxError("gh api failed (HTTP 503)", { id: "github" }); };
  const r = await withFake(t, ["greptile", "drift"]);
  assert.equal(r.code, 2);
  assert.equal(r.by["greptile-drift"].verdict, "ERROR");
  assert.match(r.by["greptile-drift"].message, /could not read or compare/);
});

test("greptile drift --update writes only into --dest/src/rules/greptile and refuses without a valid --dest", async () => {
  const src = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "SOURCE.json"), "utf8"));
  const before = Object.fromEntries(readdirSync(SNAPSHOT_DIR).map((f) => [f, readFileSync(join(SNAPSHOT_DIR, f), "utf8")]));
  const noDest = await withFake(fakeGitHub().t, ["greptile", "drift", "--update"]);
  assert.equal(noDest.json.results[0].id, "args");
  assert.match(noDest.json.results[0].message, /requires --dest/);
  const destOnly = await withFake(fakeGitHub().t, ["greptile", "drift", "--dest", "/tmp"]);
  assert.equal(destOnly.json.results[0].id, "args");

  // The running package's own snapshot is refused, spelled directly or through a symlink. The
  // transport here cannot serve live content, so a broken guard produces a different ERROR
  // instead of a write into src/rules/greptile/ (which happened once, 2026-10-30).
  const self = await withFake(unfetchable(), ["greptile", "drift", "--update", "--dest", REPO]);
  assert.deepEqual(self.json.results.map((x) => [x.verdict, x.id]), [["ERROR", "greptile-drift"]]);
  assert.match(self.json.results[0].message, /own snapshot directory/);
  await withTempDir(async (dir) => {
    const link = join(dir, "alias");
    symlinkSync(REPO, link);
    const viaLink = await withFake(unfetchable(), ["greptile", "drift", "--update", "--dest", link]);
    assert.deepEqual(viaLink.json.results.map((x) => [x.verdict, x.id]), [["ERROR", "greptile-drift"]]);
    assert.match(viaLink.json.results[0].message, /own snapshot directory/);
  });

  await withTempDir(async (dir) => {
    const notCheckout = await withFake(fakeGitHub().t, ["greptile", "drift", "--update", "--dest", dir]);
    assert.equal(notCheckout.json.results[0].verdict, "ERROR");
    assert.match(notCheckout.json.results[0].message, /not a raycast-harness checkout/);

    const dest = join(dir, "checkout");
    mkdirSync(join(dest, "src", "rules", "greptile"), { recursive: true });
    for (const [f, text] of Object.entries(before)) writeFileSync(join(dest, "src", "rules", "greptile", f), text);
    const liveRules = before["rules.md"] + "\n## Added section\n\nnew text\n";
    const r = await withFake(fakeGitHub({ mainHas: true, mainSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", snapshotFiles: { "rules.md": liveRules } }).t, ["greptile", "drift", "--update", "--dest", dest]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["greptile-drift"].verdict, "PASS");
    assert.match(r.by["greptile-drift"].message, /rewritten from main @ bbbbbbb/);
    assert.equal(r.json.data.updated, join(dest, "src", "rules", "greptile"));
    const written = JSON.parse(readFileSync(join(dest, "src", "rules", "greptile", "SOURCE.json"), "utf8"));
    assert.deepEqual([written.repo, written.pr, written.source, written.sha], [src.repo, src.pr, "main", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
    assert.match(written.fetched, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(readFileSync(join(dest, "src", "rules", "greptile", "rules.md"), "utf8"), liveRules);
  });
  // The installed snapshot (this checkout's src/rules/greptile) was not touched.
  for (const [f, text] of Object.entries(before)) assert.equal(readFileSync(join(SNAPSHOT_DIR, f), "utf8"), text, `${f} unchanged`);
});

test("greptile: subcommand roots are as contracted (fetch/wait/can-reply optional, drift none) and ids are declared", async () => {
  const r = await rx(["commands", "--json"]);
  const g = r.json.data.commands.find((c) => c.name === "greptile");
  assert.equal(g.subcommands.fetch.root, "optional");
  assert.equal(g.subcommands["can-reply"].root, "optional");
  assert.equal(g.subcommands.drift.root, "none");
  assert.deepEqual(Object.keys(g.subcommands["can-reply"].checks).sort(), ["reply-evidence", "reply-head", "reply-publication", "reply-round", "reply-scan"]);
  const p = r.json.data.commands.find((c) => c.name === "pr");
  assert.equal(p.root, "none");
  assert.deepEqual(Object.keys(p.subcommands.body.checks).sort(), ["pr-body-diff", "pr-body-write"]);
});

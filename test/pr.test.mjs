import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checklistItems, lineDiff, missingChecklist, splice, wholeLineSpans } from "../src/pr/body.mjs";
import { setTransport } from "../src/pr/transport.mjs";
import { _setGapDelayMs } from "../src/commands/pr.mjs";
import { REPO, rx, withTempDir } from "./helpers.mjs";

// Nothing here reaches github.com: every test installs a fake transport serving the recorded,
// scrubbed payloads under test/fixtures/pr/.

const FIX = join(REPO, "test", "fixtures", "pr");
const fixture = (/** @type {string} */ f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const TEMPLATE = readFileSync(join(FIX, "pull_request_template.md"), "utf8");
const PR = "12345";

/**
 * A fake GitHub. `state.body` is the live body; `state.edits` the userContentEdits history
 * (newest first); `state.patches` what was sent. Hooks let a test move the body mid-run.
 * `files` is a list of pages; a lookup of the files endpoint through the single-page `getJson`
 * throws, so a regression to a first-page fetch fails loudly.
 * @param {Partial<{ pull: any, files: any[][], body: string, edits: string[], patchOk: boolean, template: string, onPatch: (body: string) => void, beforeRead: () => void }>} [o]
 */
function fakeGitHub(o = {}) {
  const pull = structuredClone(o.pull ?? fixture("pull.json"));
  const state = {
    pull,
    body: o.body ?? pull.body,
    edits: o.edits ?? [],
    patches: /** @type {string[]} */ ([]),
    reads: 0,
    graphql: /** @type {string[]} */ ([]),
    template: o.template ?? TEMPLATE,
  };
  const t = {
    async getJsonPages(path) {
      if (/\/pulls\/\d+\/files/.test(path)) return (o.files ?? [fixture("files.json")]).flat();
      throw new Error(`unexpected paginated GET ${path}`);
    },
    async getJson(path) {
      if (/\/pulls\/\d+$/.test(path)) {
        state.reads++;
        o.beforeRead?.();
        return { ...state.pull, body: state.body };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async getRaw(path) {
      if (path.endsWith("pull_request_template.md")) return state.template;
      throw new Error(`unexpected RAW ${path}`);
    },
    async getConditional() { throw new Error("not used by pr"); },
    async graphql(query) {
      state.graphql.push(query);
      if (query.includes("last:1")) return { data: { repository: { pullRequest: { userContentEdits: { totalCount: state.edits.length, nodes: state.edits.length ? [{ diff: state.edits[state.edits.length - 1] }] : [] } } } } };
      return { data: { repository: { pullRequest: { userContentEdits: { nodes: state.edits.slice(0, 3).map((d) => ({ diff: d })) } } } } };
    },
    async patch(_path, body) {
      state.patches.push(String(body.body));
      if (o.patchOk === false) return { ok: false, error: "HTTP 502" };
      o.onPatch?.(String(body.body));
      state.body = String(body.body);
      state.edits.unshift(state.body);
      return { ok: true, error: null };
    },
  };
  return { t, state };
}

/**
 * Run with a fake transport and a private cache dir. `inspect` runs before the temp dir is removed.
 * @param {ReturnType<typeof fakeGitHub>["t"]} t @param {string[]} argv @param {(cache: string) => void} [inspect]
 */
async function withFake(t, argv, inspect) {
  return withTempDir(async (dir) => {
    const prevCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    const prev = setTransport(t);
    _setGapDelayMs(0);
    try {
      const r = await rx([...argv, "--json"], { cwd: dir });
      inspect?.(join(dir, "cache"));
      return { ...r, by: Object.fromEntries((r.json?.results ?? []).map((x) => [x.id, x])) };
    } finally {
      setTransport(prev);
      _setGapDelayMs(2000);
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevCache;
    }
  });
}

// ---- verify ---------------------------------------------------------------------------------

test("pr verify: a matching draft PR passes all five checks", async () => {
  const { t } = fakeGitHub();
  const r = await withFake(t, ["pr", "verify", PR, "--author", "octo-author", "--extension", "sample-ext"]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(Object.keys(r.by).sort(), ["pr-author", "pr-base", "pr-draft", "pr-head", "pr-open"]);
  for (const x of r.json.results) assert.equal(x.verdict, "PASS", x.id);
  assert.deepEqual(r.json.data, { number: 12345, author: "octo-author", head: "ext/sample-ext", base: "raycast/extensions:main", draft: true, state: "open" });
});

test("pr verify: wrong author, wrong extension, not draft, closed, foreign base each FAIL their own check", async () => {
  const pull = fixture("pull.json");
  pull.user.login = "someone-else";
  pull.head.ref = "ext/other-ext";
  pull.draft = false;
  pull.state = "closed";
  pull.base.repo.full_name = "octo-author/extensions";
  const { t } = fakeGitHub({ pull });
  const r = await withFake(t, ["pr", "verify", PR, "--author", "octo-author", "--extension", "sample-ext"]);
  assert.equal(r.code, 1);
  assert.equal(r.by["pr-author"].verdict, "FAIL");
  assert.equal(r.by["pr-head"].verdict, "FAIL");
  assert.equal(r.by["pr-draft"].verdict, "FAIL");
  assert.equal(r.by["pr-open"].verdict, "FAIL");
  assert.equal(r.by["pr-base"].verdict, "FAIL");
});

test("pr verify: a non-numeric PR and a GitHub failure are ERRORs, exit 2", async () => {
  const { t } = fakeGitHub();
  const bad = await withFake(t, ["pr", "verify", "abc", "--author", "a", "--extension", "b"]);
  assert.equal(bad.code, 2);
  assert.equal(bad.json.results[0].id, "args");
  const { t: broken } = fakeGitHub();
  broken.getJson = async () => { const { RxError } = await import("../src/errors.mjs"); throw new RxError("gh api failed (HTTP 404)", { id: "github" }); };
  const r = await withFake(broken, ["pr", "verify", PR, "--author", "a", "--extension", "b"]);
  assert.equal(r.code, 2);
  assert.deepEqual(r.json.results.map((x) => [x.verdict, x.id]), [["ERROR", "github"]]);
});

// ---- files ----------------------------------------------------------------------------------

test("pr files: every path under extensions/<name>/ passes; a stray path (including a rename source) fails with details", async () => {
  const ok = await withFake(fakeGitHub().t, ["pr", "files", PR, "--extension", "sample-ext"]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.by["pr-files"].verdict, "PASS");
  assert.equal(ok.json.data.files.length, 3);
  const files = [[...fixture("files.json"), { filename: ".github/CODEOWNERS", status: "modified" }, { filename: "extensions/sample-ext/src/new.tsx", previous_filename: "extensions/other/src/old.tsx", status: "renamed" }]];
  const bad = await withFake(fakeGitHub({ files }).t, ["pr", "files", PR, "--extension", "sample-ext"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.by["pr-files"].verdict, "FAIL");
  assert.deepEqual(bad.json.data.stray, [".github/CODEOWNERS", "extensions/other/src/old.tsx"]);
  assert.deepEqual(bad.by["pr-files"].details.map((d) => d.file), [".github/CODEOWNERS", "extensions/other/src/old.tsx"]);
  const empty = await withFake(fakeGitHub({ files: [[]] }).t, ["pr", "files", PR, "--extension", "sample-ext"]);
  assert.equal(empty.by["pr-files"].verdict, "FAIL");
});

test("pr files: every page is fetched; a stray path only on page 2 FAILs", async () => {
  const pages = [fixture("files.json"), fixture("files-page2.json")];
  const r = await withFake(fakeGitHub({ files: pages }).t, ["pr", "files", PR, "--extension", "sample-ext"]);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.by["pr-files"].verdict, "FAIL");
  assert.deepEqual(r.json.data.stray, [".github/CODEOWNERS"]);
  assert.equal(r.json.data.files.length, 5, "both pages counted");
});

// ---- body: pure helpers ----------------------------------------------------------------------

test("wholeLineSpans: whole lines only, exactly-once detection, CRLF never split", () => {
  const body = "a\nb\na\nlong a line\n";
  assert.deepEqual(wholeLineSpans(body, "a"), [[0, 1], [4, 5]]);
  assert.deepEqual(wholeLineSpans(body, "long a line"), [[6, 17]]);
  assert.deepEqual(wholeLineSpans(body, "ong a line"), []);
  assert.deepEqual(wholeLineSpans(body, "b\na"), [[2, 5]]);
  const crlf = "x\r\ny\r\n";
  assert.deepEqual(wholeLineSpans(crlf, "x"), [[0, 1]]);
  assert.deepEqual(wholeLineSpans(crlf, "x\r"), [], "a find ending in half a CRLF is refused");
  assert.deepEqual(wholeLineSpans(crlf, "x\r\n"), [[0, 3]]);
  assert.deepEqual(wholeLineSpans(body, ""), []);
});

test("splice: anchors located in the original and applied at once; missing, duplicate and overlapping anchors refuse", () => {
  const base = "one\ntwo\nthree\n";
  const r = splice(base, [{ find: "one", replace: "two" }, { find: "two", replace: "ONE" }]);
  assert.ok(r.ok);
  assert.equal(r.ok && r.body, "two\nONE\nthree\n", "a replacement cannot create another's anchor");
  const missing = splice(base, [{ find: "four", replace: "x" }]);
  assert.ok(!missing.ok && /0x as whole lines/.test(missing.problems[0]));
  const dup = splice("a\na\n", [{ find: "a", replace: "x" }]);
  assert.ok(!dup.ok && /2x/.test(dup.problems[0]));
  const overlap = splice(base, [{ find: "one\ntwo", replace: "x" }, { find: "two\nthree", replace: "y" }]);
  assert.ok(!overlap.ok && /overlap/.test(overlap.problems[0]));
  const crlf = splice("a\r\nb\r\n", [{ find: "b", replace: "c" }]);
  assert.equal(crlf.ok && crlf.body, "a\r\nc\r\n", "CRLF survives");
});

test("checklistItems reads Raycast's template; missingChecklist needs every item verbatim as a whole, unticked line", () => {
  const items = checklistItems(TEMPLATE);
  assert.equal(items.length, 5, items.join("\n"));
  assert.ok(items.every((i) => i.startsWith("- [ ] I ")));
  assert.deepEqual(missingChecklist(`## Description\n\nx\n\n## Checklist\n\n${items.join("\n")}\n`, items), []);
  assert.deepEqual(missingChecklist(`## Checklist\r\n\r\n${items.join("\r\n")}\r\n`, items), [], "CRLF body still matches");
  const ticked = items.map((i, k) => (k === 0 ? i.replace("[ ]", "[x]") : i));
  assert.deepEqual(missingChecklist(ticked.join("\n"), items), [items[0]], "a pre-ticked box is not the template verbatim");
  assert.deepEqual(missingChecklist(items.slice(1).join("\n"), items), [items[0]]);
  assert.deepEqual(checklistItems("no checklist here"), []);
});

test("lineDiff shows removed and added lines, CR visible", () => {
  assert.deepEqual(lineDiff("a\nb\n", "a\nc\n"), ["-b", "+c"]);
  assert.deepEqual(lineDiff("a\r\n", "a\n"), ["-a\\r", "+a"]);
});

// ---- body: command ---------------------------------------------------------------------------

/** @param {string} body */
const withTemplate = (body) => `${body}\n## Checklist\n\n${checklistItems(TEMPLATE).join("\n")}\n`;

test("pr body --initial: dry run shows the diff, writes nothing, backs up the live body in the cache", async () => {
  const { t, state } = fakeGitHub();
  await withTempDir(async (dir) => {
    const file = join(dir, "body.md");
    writeFileSync(file, withTemplate("## Description\n\nAdds Sample Ext.\n"));
    let backups = 0;
    const r = await withFake(t, ["pr", "body", PR, "--initial", file], (cache) => {
      const dirOf = join(cache, "raycast-harness", "pr-body", "raycast", "extensions", PR);
      const names = readdirSync(dirOf);
      backups = names.length;
      assert.equal(readFileSync(join(dirOf, names[0]), "utf8"), fixture("pull.json").body);
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["pr-body-diff"].verdict, "PASS");
    assert.ok(r.by["pr-body-diff"].details.some((d) => d.text === "+Adds Sample Ext."), JSON.stringify(r.by["pr-body-diff"].details));
    assert.equal(r.by["pr-body-write"].verdict, "N/A");
    assert.match(r.by["pr-body-write"].message, /--apply/);
    assert.equal(state.patches.length, 0);
    assert.equal(r.json.data.applied, false);
    assert.match(r.json.data.before, /^sha256:[0-9a-f]{64}$/);
    assert.equal(backups, 1, "one live read, one backup");
  });
});

test("pr body --splice --prospective <file>: the dry run writes the whole composed body so it can be scanned before --apply (Codex W4 r2 A2)", async () => {
  const { t, state } = fakeGitHub();
  await withTempDir(async (dir) => {
    const live = fixture("pull.json").body;
    const firstLine = live.split("\n").find((l) => l.trim());
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: firstLine, replace: `${firstLine} (edited)` }]));
    const out = join(dir, "prospective.md");
    const r = await withFake(t, ["pr", "body", PR, "--splice", edits, "--prospective", out]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["pr-body-write"].verdict, "N/A");
    assert.equal(state.patches.length, 0);
    const prospective = readFileSync(out, "utf8");
    assert.equal(prospective, live.replace(firstLine, `${firstLine} (edited)`), "the file is the exact body a later --apply would send");
    assert.match(r.by["pr-body-diff"].message, /prospective body written to/);
  });
});

test("pr body --initial --apply: writes once onto an unedited body and verifies through the edit history", async () => {
  const { t, state } = fakeGitHub();
  await withTempDir(async (dir) => {
    const file = join(dir, "body.md");
    const proposed = withTemplate("## Description\n\nAdds Sample Ext.\n");
    writeFileSync(file, proposed);
    const r = await withFake(t, ["pr", "body", PR, "--initial", file, "--apply"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["pr-body-write"].verdict, "PASS");
    assert.deepEqual(state.patches, [proposed]);
    assert.equal(state.body, proposed);
    assert.equal(r.json.data.applied, true);
    assert.equal(r.json.data.overwritten, false);
  });
});

test("pr body --initial refuses an edited body (FAIL, nothing written)", async () => {
  const live = "## Description\n\nChris edited this by hand\n";
  const { t, state } = fakeGitHub({ body: live, edits: [live, fixture("pull.json").body] });
  await withTempDir(async (dir) => {
    const file = join(dir, "body.md");
    writeFileSync(file, withTemplate("## Description\n\nours\n"));
    const r = await withFake(t, ["pr", "body", PR, "--initial", file, "--apply"]);
    assert.equal(r.code, 1);
    assert.equal(r.by["pr-body-diff"].verdict, "FAIL");
    assert.match(r.by["pr-body-diff"].message, /edited since the PR was created/);
    assert.equal(state.patches.length, 0);
  });
});

test("pr body --initial accepts a body equal to the oldest history entry (the PR's own original)", async () => {
  const original = fixture("pull.json").body;
  const { t, state } = fakeGitHub({ body: original, edits: [original] });
  await withTempDir(async (dir) => {
    const file = join(dir, "body.md");
    writeFileSync(file, withTemplate("## Description\n\nours\n"));
    const r = await withFake(t, ["pr", "body", PR, "--initial", file, "--apply"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(state.patches.length, 1);
  });
});

test("pr body --initial refuses a body without Raycast's template checklist verbatim (fetched at run time)", async () => {
  const { t, state } = fakeGitHub();
  await withTempDir(async (dir) => {
    const file = join(dir, "body.md");
    writeFileSync(file, "## Description\n\nours\n\n## Checklist\n\n- [ ] I read the guidelines\n");
    const r = await withFake(t, ["pr", "body", PR, "--initial", file, "--apply"]);
    assert.equal(r.code, 1);
    assert.equal(r.by["pr-body-diff"].verdict, "FAIL");
    assert.match(r.by["pr-body-diff"].message, /lacks 5 of 5 template checklist item/);
    assert.equal(r.by["pr-body-diff"].details.length, 5);
    assert.equal(state.patches.length, 0);
    // A template without a checklist cannot authorize anything: ERROR, not PASS.
    const { t: t2 } = fakeGitHub({ template: "## Description\n" });
    writeFileSync(file, withTemplate("x"));
    const r2 = await withFake(t2, ["pr", "body", PR, "--initial", file]);
    assert.equal(r2.code, 2);
    assert.equal(r2.json.results.find((x) => x.verdict === "ERROR").id, "github");
  });
});

test("pr body --splice: whole-line anchors against the LIVE body; CRLF survives; a fragment is refused", async () => {
  const live = "## Description\r\n\r\nFirst bullet\r\n- [ ] box\r\n";
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: "First bullet", replace: "First bullet\r\nSecond bullet" }]));
    const { t, state } = fakeGitHub({ body: live, edits: [live] });
    const r = await withFake(t, ["pr", "body", PR, "--splice", edits, "--apply"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(state.body, "## Description\r\n\r\nFirst bullet\r\nSecond bullet\r\n- [ ] box\r\n");
    assert.equal(r.json.data.edits, 1);
    writeFileSync(edits, JSON.stringify([{ find: "bullet", replace: "x" }]));
    const { t: t2, state: s2 } = fakeGitHub({ body: live });
    const r2 = await withFake(t2, ["pr", "body", PR, "--splice", edits, "--apply"]);
    assert.equal(r2.code, 1);
    assert.equal(r2.by["pr-body-diff"].verdict, "FAIL");
    assert.match(r2.by["pr-body-diff"].details[0].text, /0x as whole lines/);
    assert.equal(s2.patches.length, 0);
  });
});

test("pr body --splice: malformed edits are ERROR input; both or neither mode is ERROR args", async () => {
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: "", replace: "x" }]));
    const r = await withFake(fakeGitHub().t, ["pr", "body", PR, "--splice", edits]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results.find((x) => x.verdict === "ERROR").id, "input");
    const r2 = await withFake(fakeGitHub().t, ["pr", "body", PR]);
    assert.equal(r2.json.results[0].id, "args");
    const r3 = await withFake(fakeGitHub().t, ["pr", "body", PR, "--initial", edits, "--splice", edits]);
    assert.equal(r3.json.results[0].id, "args");
  });
});

test("pr body: no change is PASS diff + N/A write", async () => {
  const live = fixture("pull.json").body;
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: "Update Sample Ext", replace: "Update Sample Ext" }]));
    const r = await withFake(fakeGitHub({ body: live }).t, ["pr", "body", PR, "--splice", edits, "--apply"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.by["pr-body-diff"].message, /no change/);
    assert.equal(r.by["pr-body-write"].verdict, "N/A");
  });
});

test("pr body --apply: the re-read before the write catches a moved body (FAIL, nothing written)", async () => {
  const live = "a\nb\n";
  let reads = 0;
  const fake = fakeGitHub({ body: live, beforeRead: () => { if (++reads === 2) fake.state.body = "a\nb\nchris added this\n"; } });
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: "b", replace: "c" }]));
    const r = await withFake(fake.t, ["pr", "body", PR, "--splice", edits, "--apply"]);
    assert.equal(r.code, 1);
    assert.equal(r.by["pr-body-write"].verdict, "FAIL");
    assert.match(r.by["pr-body-write"].message, /changed while this ran/);
    assert.equal(fake.state.patches.length, 0);
  });
});

test("pr body --apply: an edit landing in the gap between re-read and write is detected through the history (FAIL, overwritten version in details)", async () => {
  const live = "a\nb\n";
  const fake = fakeGitHub({ body: live, edits: [live], onPatch: () => { fake.state.edits.unshift("a\nb\nlanded in the gap\n"); } });
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: "b", replace: "c" }]));
    const r = await withFake(fake.t, ["pr", "body", PR, "--splice", edits, "--apply"]);
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.by["pr-body-write"].verdict, "FAIL");
    assert.match(r.by["pr-body-write"].message, /overwritten/);
    assert.ok(r.by["pr-body-write"].details.some((d) => d.text === "landed in the gap"));
    assert.equal(r.json.data.overwritten, true);
    assert.equal(fake.state.patches.length, 1, "never retried");
  });
});

test("pr body --apply: a failed PATCH is never retried; the outcome is reported as ERROR after a re-read", async () => {
  const fake = fakeGitHub({ body: "a\nb\n", patchOk: false });
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: "b", replace: "c" }]));
    const r = await withFake(fake.t, ["pr", "body", PR, "--splice", edits, "--apply"]);
    assert.equal(r.code, 2);
    assert.equal(r.by["pr-body-write"].verdict, "ERROR");
    assert.match(r.by["pr-body-write"].message, /NOT retried/);
    assert.match(r.by["pr-body-write"].message, /did not land/);
    assert.equal(fake.state.patches.length, 1);
  });
});

test("pr body --apply: history that never catches up is WARN, not PASS", async () => {
  const fake = fakeGitHub({ body: "a\nb\n" });
  fake.t.graphql = async (q) => (q.includes("last:1") ? { data: { repository: { pullRequest: { userContentEdits: { totalCount: 0, nodes: [] } } } } } : { data: { repository: { pullRequest: { userContentEdits: { nodes: [] } } } } });
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: "b", replace: "c" }]));
    const r = await withFake(fake.t, ["pr", "body", PR, "--splice", edits, "--apply"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.by["pr-body-write"].verdict, "WARN");
    assert.match(r.by["pr-body-write"].message, /had not caught up/);
  });
});

test("pr: every emitted id is declared (no protocol ERROR) and --repo is validated", async () => {
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: "b", replace: "c" }]));
    const r = await withFake(fakeGitHub().t, ["pr", "body", PR, "--splice", edits, "--repo", "not-a-slug"]);
    assert.equal(r.json.results[0].id, "args");
    mkdirSync(join(dir, "x"));
    const ok = await withFake(fakeGitHub().t, ["pr", "verify", PR, "--author", "octo-author", "--extension", "sample-ext"]);
    assert.ok(!ok.json.results.some((x) => x.id === "protocol"));
  });
});

test("pr body --apply --prospective <file>: the write is bound to the scanned file; a recomposition that differs refuses, nothing written (Codex W4 r3 A2)", async () => {
  const live = fixture("pull.json").body;
  const firstLine = live.split("\n").find((l) => l.trim());
  await withTempDir(async (dir) => {
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify([{ find: firstLine, replace: `${firstLine} (edited)` }]));
    const out = join(dir, "prospective.md");
    // 1. the dry run writes the prospective body (what the caller then scans)
    const dry = fakeGitHub();
    const r1 = await withFake(dry.t, ["pr", "body", PR, "--splice", edits, "--prospective", out]);
    assert.equal(r1.code, 0, r1.stdout);
    const scanned = readFileSync(out, "utf8");
    // 2. the live body moved in between (the anchor still resolves), so --apply recomposes a
    //    different body: it must refuse rather than send bytes nobody scanned
    const moved = fakeGitHub({ body: `${live}\nChris added a line\n` });
    const r2 = await withFake(moved.t, ["pr", "body", PR, "--splice", edits, "--prospective", out, "--apply"]);
    assert.equal(r2.code, 1, r2.stdout);
    assert.equal(r2.by["pr-body-write"].verdict, "FAIL");
    assert.match(r2.by["pr-body-write"].message, /differs from the scanned prospective body/);
    assert.equal(moved.state.patches.length, 0, "nothing written");
    assert.equal(readFileSync(out, "utf8"), scanned, "the scanned file is left as it was");
    // 3. unchanged live body: the recomposition equals the file and the write goes through
    const same = fakeGitHub();
    const r3 = await withFake(same.t, ["pr", "body", PR, "--splice", edits, "--prospective", out, "--apply"]);
    assert.equal(r3.code, 0, r3.stdout);
    assert.deepEqual(same.state.patches, [scanned]);
    assert.match(r3.by["pr-body-write"].message, /scanned prospective body/);
    // 4. --apply --prospective pointing at a file that was never written is an input error
    const r4 = await withFake(fakeGitHub().t, ["pr", "body", PR, "--splice", edits, "--prospective", join(dir, "missing.md"), "--apply"]);
    assert.notEqual(r4.code, 0);
    assert.match(r4.stdout + r4.stderr, /missing\.md/);
    assert.equal(same.state.patches.length, 1);
  });
});

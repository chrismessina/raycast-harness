import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { nothingToShip } from "../src/payload-identity.mjs";
import { join } from "node:path";
import { fakeExtension, rx, withTempDir } from "./helpers.mjs";
import { bodyHash, parseChangelog, placeholderProblems, sameEntry, stampProblem } from "../src/changelog/parse.mjs";
import { FIXTURES, commit, g, initRepo, startMerge } from "./upstream-fixtures.mjs";

const FIX = join(FIXTURES, "changelog");
const by = (/** @type {any} */ r) => Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));

test("parseChangelog: entries, bodies without trailing blanks, placeholders, closing-ATX headings", () => {
  const log = parseChangelog("# T\n\nintro\n\n## [A] - {PR_MERGE_DATE} ##\n\n- one\n- two\n\n\n## [B] - 2026-01-02\n\ntext\n* three\n");
  assert.equal(log.preamble, "# T\n\nintro\n");
  assert.equal(log.placeholders, 1);
  assert.deepEqual(log.entries.map((e) => [e.title, e.date, e.line, e.bullets.length]), [["A", "{PR_MERGE_DATE}", 5, 2], ["B", "2026-01-02", 11, 1]]);
  assert.equal(log.entries[0].body, "- one\n- two");
  assert.equal(log.entries[1].body, "text\n* three");
  assert.ok(sameEntry(log.entries[0], { ...log.entries[0], date: "2026-05-05" }), "stamped vs placeholder is the same entry");
  assert.ok(!sameEntry(log.entries[0], log.entries[1]));
  assert.ok(!sameEntry({ ...log.entries[1], date: "2026-01-03" }, log.entries[1]), "two different real dates are different entries");
  assert.match(bodyHash("x"), /^sha256:[0-9a-f]{64}$/);
});

test("changelog-placeholder and changelog-bullets across the placeholder fixtures (expected.json)", async () => {
  const expected = JSON.parse(readFileSync(join(FIX, "placeholders", "expected.json"), "utf8"));
  for (const [name, want] of Object.entries(expected)) {
    await withTempDir(async (dir) => {
      const ext = fakeExtension(dir, "ext");
      cpSync(join(FIX, "placeholders", name), join(ext, "CHANGELOG.md"));
      const r = await rx(["changelog", "--json"], { cwd: ext });
      assert.equal(r.code, want.exit, `${name}: ${r.stdout}`);
      const got = by(r);
      for (const [id, verdict] of Object.entries(want)) if (id !== "exit") assert.equal(got[id]?.verdict, verdict, `${name} ${id}: ${JSON.stringify(got[id])}`);
      assert.equal(got["changelog-history"].verdict, "N/A", "no --published → N/A with reason");
      assert.match(got["changelog-history"].message, /^no published copy given; pass --published <dir> \(rx stale prints it\)/);
      assert.doesNotMatch(got["changelog-history"].message, /not published/, "a missing flag is not a fact about publication");
      if (name === "long-bullet.md") assert.equal(got["changelog-bullets"].details[0].line, 5);
      if (name === "zero.md") assert.match(got["changelog-placeholder"].message, /zero placeholders is not a pass/);
    });
  }
});

test("changelog-history (Codex R5): trailing spaces or a CR added to a published heading is an edit, not the published heading", async () => {
  await withTempDir(async (dir) => {
    const pub = join(dir, "pub");
    mkdirSync(pub);
    const base = "# Changelog\n\n## [Fix] - 2026-08-02\n\n- Fixed it\n\n## [Initial Version] - 2026-08-01\n\n- First release\n";
    writeFileSync(join(pub, "CHANGELOG.md"), base);
    for (const [name, local] of [["spaces", base.replace("## [Fix] - 2026-08-02\n", "## [Fix] - 2026-08-02  \n")], ["crlf", base.replace("## [Fix] - 2026-08-02\n", "## [Fix] - 2026-08-02\r\n")]]) {
      const ext = fakeExtension(dir, name);
      writeFileSync(join(ext, "CHANGELOG.md"), local.replace("# Changelog\n\n", "# Changelog\n\n## [New] - {PR_MERGE_DATE}\n\n- New\n\n"));
      const got = by(await rx(["changelog", "--published", pub, "--json"], { cwd: ext }));
      assert.equal(got["changelog-history"].verdict, "FAIL", `${name}: ${JSON.stringify(got["changelog-history"])}`);
      assert.match(got["changelog-history"].details[0].text, /byte for byte/);
    }
    const same = fakeExtension(dir, "same");
    writeFileSync(join(same, "CHANGELOG.md"), base.replace("# Changelog\n\n", "# Changelog\n\n## [New] - {PR_MERGE_DATE}\n\n- New\n\n"));
    assert.equal(by(await rx(["changelog", "--published", pub, "--json"], { cwd: same }))["changelog-history"].verdict, "PASS");
  });
});

test("changelog-history (F5): an authorized historical redaction passes; an unrelated edit and an unstamped entry fail", async () => {
  const expected = JSON.parse(readFileSync(join(FIX, "redaction", "expected.json"), "utf8"));
  const published = join(FIX, "redaction", "published");
  const redactions = join(FIX, "redaction", "redactions.json");
  for (const [variant, want] of Object.entries(expected)) {
    await withTempDir(async (dir) => {
      const ext = fakeExtension(dir, "ext");
      cpSync(join(FIX, "redaction", variant, "CHANGELOG.md"), join(ext, "CHANGELOG.md"));
      const r = await rx(["changelog", "--published", published, "--redactions", redactions, "--json"], { cwd: ext });
      assert.equal(r.code, want.exit, `${variant}: ${r.stdout}`);
      const got = by(r);
      for (const [id, verdict] of Object.entries(want)) if (id !== "exit") assert.equal(got[id]?.verdict, verdict, `${variant} ${id}: ${JSON.stringify(got[id])}`);
      const fix = r.json.data.entries.find((/** @type {any} */ e) => e.heading.startsWith("## [Download Fix]"));
      if (variant === "local-redacted") {
        assert.match(got["changelog-history"].message, /1 recorded redaction/);
        assert.deepEqual({ changed: fix.changed, redacted: fix.redacted }, { changed: true, redacted: true });
      }
      if (variant === "local-unrelated-edit") {
        assert.match(got["changelog-history"].details[0].text, /no redaction authorizes it/);
        assert.deepEqual({ changed: fix.changed, redacted: fix.redacted }, { changed: true, redacted: false });
      }
      if (variant === "local-unstamped") assert.match(got["changelog-history"].details[0].text, /stamp the merged date/);
    });
  }
  // The same redacted file without the redactions file is a FAIL: the authorization is the record, not the diff.
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    cpSync(join(FIX, "redaction", "local-redacted", "CHANGELOG.md"), join(ext, "CHANGELOG.md"));
    const r = await rx(["changelog", "--published", published, "--json"], { cwd: ext });
    assert.equal(by(r)["changelog-history"].verdict, "FAIL");
  });
  // A published entry deleted locally is a FAIL too.
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    writeFileSync(join(ext, "CHANGELOG.md"), "# Example Changelog\n\n## [New Feature] - {PR_MERGE_DATE}\n\n- Added a thing\n\n## [Initial Version] - 2026-08-01\n\n- First release\n");
    const r = await rx(["changelog", "--published", published, "--json"], { cwd: ext });
    assert.equal(by(r)["changelog-history"].verdict, "FAIL");
    assert.match(by(r)["changelog-history"].details[0].text, /missing locally/);
  });
});

test("--redactions must be well formed (ERROR input)", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    cpSync(join(FIX, "placeholders", "one.md"), join(ext, "CHANGELOG.md"));
    writeFileSync(join(dir, "bad.json"), JSON.stringify([{ heading: "## [X]", originalHash: "a" }]));
    const r = await rx(["changelog", "--redactions", join(dir, "bad.json"), "--json"], { cwd: ext });
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "input");
    assert.match(r.json.results[0].message, /replacementHash/);
  });
});

/**
 * A repo whose HEAD holds ours.md and whose MERGE_HEAD holds `theirs`, merge in progress with a
 * CHANGELOG conflict.
 * @param {string} dir @param {string} theirs fixture file name
 */
async function mergeRepo(dir, theirs) {
  const repo = await initRepo(join(dir, "ext"));
  const pkg = JSON.stringify({ name: "ext", commands: [] });
  await commit(repo, { "package.json": pkg, "CHANGELOG.md": readFileSync(join(FIX, "merge", "base.md"), "utf8") }, "base");
  await g(repo, ["branch", "theirs"]);
  await commit(repo, { "CHANGELOG.md": readFileSync(join(FIX, "merge", "ours.md"), "utf8") }, "ours");
  await g(repo, ["checkout", "-q", "theirs"]);
  await commit(repo, { "CHANGELOG.md": readFileSync(join(FIX, "merge", theirs), "utf8") }, "theirs");
  await g(repo, ["checkout", "-q", "main"]);
  const code = await startMerge(repo, "theirs");
  assert.equal(code, 1, "the fixture must conflict");
  return repo;
}

test("changelog --merge (Q6): stamped-vs-placeholder boundary rebuilds; an unrelated incoming heading is ERROR and writes nothing", async () => {
  const expected = JSON.parse(readFileSync(join(FIX, "merge", "expected.json"), "utf8"));
  for (const [theirs, want] of Object.entries(expected)) {
    await withTempDir(async (dir) => {
      const repo = await mergeRepo(dir, theirs);
      const before = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
      assert.match(before, /^<{7} /m, "working file holds conflict markers before --merge");
      const r = await rx(["changelog", "--merge", "--json"], { cwd: repo });
      assert.equal(r.code, want.exit, `${theirs}: ${r.stdout}`);
      const got = by(r);
      assert.equal(got["changelog-merge"].verdict, want["changelog-merge"]);
      if (want.written) {
        assert.equal(readFileSync(join(repo, "CHANGELOG.md"), "utf8"), readFileSync(join(FIX, "merge", want.written), "utf8"));
        assert.equal(got["changelog-placeholder"].verdict, want["changelog-placeholder"]);
        assert.equal(r.json.data.merged, true);
        assert.equal(r.json.data.placeholders, 1);
        assert.match(got["changelog-merge"].message, /1 entry from HEAD, 2 from MERGE_HEAD/);
      } else {
        assert.equal(readFileSync(join(repo, "CHANGELOG.md"), "utf8"), before, "nothing written on an ambiguous boundary");
        assert.equal(r.json.data.merged, false);
        assert.equal(got["changelog-merge"].details.length, 2, "both headings in details");
        assert.match(got["changelog-merge"].details[0].text, /Contributor Fix/);
        assert.match(got["changelog-merge"].details[0].file, /MERGE_HEAD/);
        assert.match(got["changelog-merge"].message, /ambiguous boundary/);
      }
    });
  }
});

test("changelog --merge without a merge in progress is ERROR changelog-merge; a conflicted file without --merge FAILs the placeholder check", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(join(dir, "ext"));
    await commit(repo, { "package.json": JSON.stringify({ name: "ext", commands: [] }), "CHANGELOG.md": readFileSync(join(FIX, "placeholders", "one.md"), "utf8") }, "x");
    const r = await rx(["changelog", "--merge", "--json"], { cwd: repo });
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.results.map((/** @type {any} */ x) => [x.id, x.verdict]), [["changelog-merge", "ERROR"]]);
    assert.match(r.json.results[0].message, /no MERGE_HEAD/);
  });
  await withTempDir(async (dir) => {
    const repo = await mergeRepo(dir, "theirs-stamped.md");
    const r = await rx(["changelog", "--json"], { cwd: repo });
    assert.equal(by(r)["changelog-placeholder"].verdict, "FAIL");
    assert.match(by(r)["changelog-placeholder"].message, /conflict markers/);
    assert.ok(existsSync(join(repo, "CHANGELOG.md")));
  });
});

test("changelog fixture directories each carry an expected.json", () => {
  for (const d of ["placeholders", "redaction", "merge"]) assert.ok(readdirSync(join(FIX, d)).includes("expected.json"), d);
});

test("placeholderProblems: the shared predicate (zero, two, misplaced, conflict markers, pass)", () => {
  const ok = placeholderProblems("# C\n\n## [Fix] - {PR_MERGE_DATE}\n\n- a\n\n## [Old] - 2026-10-01\n\n- b\n");
  assert.deepEqual(ok, { count: 1, topHasPlaceholder: true, conflictMarkers: false, problems: [] });
  assert.match(placeholderProblems("# C\n\n## [Fix] - 2026-10-01\n\n- a\n").problems[0], /zero placeholders is not a pass/);
  const two = placeholderProblems("# C\n\n## [A] - {PR_MERGE_DATE}\n\n## [B] - {PR_MERGE_DATE}\n");
  assert.equal(two.count, 2);
  assert.match(two.problems[0], /2 occurrences/);
  const misplaced = placeholderProblems("# C\n\n## [A] - 2026-10-01\n\n## [B] - {PR_MERGE_DATE}\n");
  assert.deepEqual([misplaced.count, misplaced.topHasPlaceholder], [1, false]);
  assert.match(misplaced.problems[0], /not in the top entry/);
  const body = placeholderProblems("# C\n\n## [A] - 2026-10-01\n\n- see {PR_MERGE_DATE}\n");
  assert.deepEqual([body.count, body.topHasPlaceholder], [1, false], "an occurrence in a body is not on the heading");
  const markers = placeholderProblems("<<<<<<< HEAD\n## [A] - {PR_MERGE_DATE}\n=======\n## [A] - 2026-10-01\n>>>>>>> theirs\n");
  assert.equal(markers.conflictMarkers, true);
  assert.match(markers.problems[0], /conflict markers/);
});

test("bytes are preserved: CRLF history differs from LF history; equal CRLF bodies hash equal", async () => {
  const lf = readFileSync(join(FIX, "redaction", "published", "CHANGELOG.md"), "utf8");
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = parseChangelog(lf).entries[0];
  const b = parseChangelog(crlf).entries[0];
  assert.equal(a.title, b.title);
  assert.equal(a.heading, b.heading, "the heading identity is trimmed");
  assert.notEqual(a.body, b.body, "the body keeps its CR bytes");
  assert.notEqual(bodyHash(a.body), bodyHash(b.body));
  assert.equal(parseChangelog(crlf).entries[0].body, parseChangelog(crlf).entries[0].body);
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(dir, "pub"));
    writeFileSync(join(dir, "pub", "CHANGELOG.md"), crlf);
    // Local LF copy with a new placeholder entry on top: every dated body differs by its line endings.
    writeFileSync(join(ext, "CHANGELOG.md"), "# Example Changelog\n\n## [New] - {PR_MERGE_DATE}\n\n- x\n\n" + lf.slice("# Example Changelog\n\n".length));
    let r = await rx(["changelog", "--published", join(dir, "pub"), "--json"], { cwd: ext });
    assert.equal(by(r)["changelog-history"].verdict, "FAIL");
    assert.equal(by(r)["changelog-history"].details.length, 2);
    // The same file with CRLF endings everywhere matches byte for byte.
    writeFileSync(join(ext, "CHANGELOG.md"), ("# Example Changelog\n\n## [New] - {PR_MERGE_DATE}\n\n- x\n\n" + lf.slice("# Example Changelog\n\n".length)).replace(/\n/g, "\r\n"));
    r = await rx(["changelog", "--published", join(dir, "pub"), "--json"], { cwd: ext });
    assert.equal(by(r)["changelog-history"].verdict, "PASS", r.stdout);
    assert.equal(by(r)["changelog-placeholder"].verdict, "PASS");
  });
});

test("--merge reads and validates --published before writing: an unreadable published copy is ERROR input and CHANGELOG.md is untouched", async () => {
  await withTempDir(async (dir) => {
    const repo = await mergeRepo(dir, "theirs-stamped.md");
    const before = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
    mkdirSync(join(dir, "pub", "CHANGELOG.md"), { recursive: true }); // a directory where a file is expected: unreadable
    const r = await rx(["changelog", "--merge", "--published", join(dir, "pub"), "--json"], { cwd: repo });
    assert.equal(r.code, 2, r.stdout);
    assert.deepEqual(r.json.results.map((/** @type {any} */ x) => [x.id, x.verdict]), [["input", "ERROR"]]);
    assert.equal(readFileSync(join(repo, "CHANGELOG.md"), "utf8"), before, "nothing written");
    // A missing published CHANGELOG.md is not an error: the rebuild proceeds and history is N/A.
    mkdirSync(join(dir, "pub2"));
    const r2 = await rx(["changelog", "--merge", "--published", join(dir, "pub2"), "--json"], { cwd: repo });
    assert.equal(by(r2)["changelog-merge"].verdict, "PASS");
    assert.equal(by(r2)["changelog-history"].verdict, "N/A");
  });
});

test("stampProblem: accepts exactly one placeholder heading becoming a date, line untrimmed", () => {
  const before = "# T\n\n## [A] - {PR_MERGE_DATE}\n\n- one\n";
  const r = stampProblem(before, before.replace("{PR_MERGE_DATE}", "2026-11-23"));
  assert.deepEqual(r, { problem: null, line: 2, unstamped: "## [A] - {PR_MERGE_DATE}", stamped: "## [A] - 2026-11-23" });
});

test("stampProblem: CRLF content keeps the \\r as part of the line", () => {
  const before = "# T\r\n\r\n## [A] - {PR_MERGE_DATE}\r\n\r\n- one\r\n";
  const r = stampProblem(before, before.replace("{PR_MERGE_DATE}", "2026-11-23"));
  assert.deepEqual(r, { problem: null, line: 2, unstamped: "## [A] - {PR_MERGE_DATE}\r", stamped: "## [A] - 2026-11-23\r" });
});

test("rx changelog: identical to the published copy is N/A nothing to ship under --published, FAIL without it or with a difference", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    writeFileSync(join(ext, "CHANGELOG.md"), "# Changelog\n\n## [Update] - 2026-02-03\n\n- Shipped\n");
    cpSync(ext, join(dir, "pub"), { recursive: true });
    const same = await rx(["changelog", "--published", join(dir, "pub"), "--json"], { cwd: ext });
    assert.equal(by(same)["changelog-placeholder"].verdict, "N/A", same.stdout);
    assert.equal(by(same)["changelog-placeholder"].message, "nothing to ship: the payload is identical to the published copy");
    const solo = await rx(["changelog", "--json"], { cwd: ext });
    assert.equal(by(solo)["changelog-placeholder"].verdict, "FAIL", solo.stdout);
    writeFileSync(join(ext, "extra.txt"), "x");
    const diff = await rx(["changelog", "--published", join(dir, "pub"), "--json"], { cwd: ext });
    assert.equal(by(diff)["changelog-placeholder"].verdict, "FAIL", diff.stdout);
  });
});

test("nothingToShip: identical true; extra file either side, symlink, mode, content, empty false; skip list ignored", async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, "a"), b = join(dir, "b");
    for (const d of [a, b]) {
      mkdirSync(join(d, "src"), { recursive: true });
      writeFileSync(join(d, "src", "x.ts"), "x");
    }
    mkdirSync(join(a, "node_modules"));
    writeFileSync(join(a, "node_modules", "junk.js"), "junk");
    assert.equal(nothingToShip(a, b), true, "node_modules is on the ray publish skip list");
    writeFileSync(join(a, "more.txt"), "m");
    assert.equal(nothingToShip(a, b), false, "extra local file");
    assert.equal(nothingToShip(b, a), false, "extra published file");
    writeFileSync(join(b, "more.txt"), "m");
    assert.equal(nothingToShip(a, b), true);
    writeFileSync(join(b, "more.txt"), "n");
    assert.equal(nothingToShip(a, b), false, "bytes differ");
    writeFileSync(join(b, "more.txt"), "m");
    chmodSync(join(b, "more.txt"), 0o755);
    assert.equal(nothingToShip(a, b), false, "executable bit differs");
    chmodSync(join(b, "more.txt"), 0o644);
    symlinkSync("x.ts", join(a, "src", "ln"));
    symlinkSync("x.ts", join(b, "src", "ln"));
    assert.equal(nothingToShip(a, b), false, "a symlink on both sides");
    mkdirSync(join(dir, "e1"));
    mkdirSync(join(dir, "e2"));
    assert.equal(nothingToShip(join(dir, "e1"), join(dir, "e2")), false, "empty payloads");
  });
});

test("nothingToShip: the executable bit is git's (owner execute): 0755 vs 0655 differ, 0644 vs 0654 match", async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, "a"), b = join(dir, "b");
    for (const d of [a, b]) {
      mkdirSync(join(d, "src"), { recursive: true });
      writeFileSync(join(d, "src", "x.ts"), "x");
    }
    chmodSync(join(a, "src", "x.ts"), 0o755);
    chmodSync(join(b, "src", "x.ts"), 0o655);
    assert.equal(nothingToShip(a, b), false, "0755 is 100755 in git, 0655 is 100644");
    chmodSync(join(a, "src", "x.ts"), 0o644);
    chmodSync(join(b, "src", "x.ts"), 0o654);
    assert.equal(nothingToShip(a, b), true, "both are 100644 in git");
  });
});

test("nothingToShip: a skip-list path only on the published side is ignored; an unreadable file is false, not a throw", async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, "a"), b = join(dir, "b");
    for (const d of [a, b]) {
      mkdirSync(join(d, "src"), { recursive: true });
      writeFileSync(join(d, "src", "x.ts"), "x");
    }
    mkdirSync(join(b, "node_modules"));
    writeFileSync(join(b, "node_modules", "junk.js"), "junk");
    assert.equal(nothingToShip(a, b), true, "node_modules on the published side only");

    chmodSync(join(b, "src", "x.ts"), 0o000);
    try {
      assert.equal(nothingToShip(a, b), false, "an unreadable published file fails closed");
    } finally {
      chmodSync(join(b, "src", "x.ts"), 0o644);
    }
  });
});

test("stampProblem: rejects anything that is not exactly the stamp", () => {
  const before = "# T\n\n## [A] - {PR_MERGE_DATE}\n\n- one\n";
  const stamped = before.replace("{PR_MERGE_DATE}", "2026-11-23");
  const why = (/** @type {string} */ b, /** @type {string} */ a) => {
    const r = stampProblem(b, a);
    assert.equal(r.line, null);
    return r.problem;
  };
  assert.equal(why(before, before), "leaves <path> unchanged");
  assert.equal(why(before, stamped + "- two\n"), "changes the line count of <path> (6 → 7), not just a date");
  assert.equal(why(before, stamped.replace("# T", "# U")), "changes 2 lines of <path>, not just a date");
  assert.equal(why(before, before.replace("- one", "- uno")), 'changes line 5 of <path> ("- one" → "- uno"), not a {PR_MERGE_DATE} date stamp');
  assert.equal(why(before, before.replace("## [A] - {PR_MERGE_DATE}", "## [B] - {PR_MERGE_DATE}")), 'changes line 3 of <path> ("## [A] - {PR_MERGE_DATE}" → "## [B] - {PR_MERGE_DATE}"), not a {PR_MERGE_DATE} date stamp');
  assert.equal(why(before, before.replace("{PR_MERGE_DATE}", "2026-1-5")), 'changes line 3 of <path> ("## [A] - {PR_MERGE_DATE}" → "## [A] - 2026-1-5"), not a {PR_MERGE_DATE} date stamp');
});

test("stampProblem: a literal <path> in the changed line stays verbatim; subject names the file", () => {
  const before = "# T\n\n## Fix <path> handling - {PR_MERGE_DATE}\n";
  const after = before.replace("handling", "parsing");
  assert.equal(
    stampProblem(before, after, "CHANGELOG.md").problem,
    'changes line 3 of CHANGELOG.md ("## Fix <path> handling - {PR_MERGE_DATE}" → "## Fix <path> parsing - {PR_MERGE_DATE}"), not a {PR_MERGE_DATE} date stamp',
  );
});

// rx preflight: the legacy scripts/preflight.test.mjs ported to the CLI (every check through
// `rx preflight --preset legacy-compat --json`), the Phase 3 fixes (T3, T4, T5, Q9, Q10, Q12) and
// new checks (§4.1), the core/preset split (F6), and the checked-in fixtures against expected.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CHECK_IDS } from "../src/preflight/catalog.mjs";
import { gitignoreMatcher } from "../src/preflight/gitignore.mjs";
import { stripComments } from "../src/preflight/lexer.mjs";
import { extractEmbeds, stripCode } from "../src/preflight/markdown.mjs";
import { REPO, rx, withTempDir } from "./helpers.mjs";
import { GOOD_PKG, HOUSE_PRESET, LEGACY_PRESET, LOCK, makeExt, png, preflight } from "./preflight-helpers.mjs";

/** @param {Record<string, any>} [overrides] */
const ext = (dir, overrides) => makeExt(join(dir, "ext"), overrides);

test("every catalog id is emitted exactly once, as PASS/FAIL/WARN/N/A, on a compliant extension", async () => {
  await withTempDir(async (dir) => {
    const r = await preflight(ext(dir));
    assert.equal(r.code, 0, r.stdout);
    const ids = r.json.results.map((/** @type {any} */ x) => x.id);
    assert.deepEqual(ids, CHECK_IDS);
    assert.deepEqual(r.fails, []);
    assert.deepEqual(r.warns, []);
    assert.deepEqual(Object.keys(r.json.data).sort(), ["checks", "preset", "published", "publishedDir", "root", "selfAuthored"]);
    assert.equal(r.json.data.checks.prettierrc, "preset");
    assert.equal(r.json.data.checks.schema, "core");
  });
});

test("P1-2: an unknown argument is ERROR args, exit 2; an empty --published value too", async () => {
  await withTempDir(async (dir) => {
    const root = ext(dir);
    const r = await rx(["preflight", "--root", root, "--published", "x y", "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "input");
    const u = await rx(["preflight", "--root", root, "--pubished", root]);
    assert.equal(u.code, 2);
    assert.match(u.stdout, /ERROR {2}args/);
  });
});

test("schema: missing $schema fails", async () => {
  await withTempDir(async (dir) => {
    const pkg = { ...GOOD_PKG, $schema: undefined }; // JSON.stringify drops the key
    assert.ok((await preflight(ext(dir, { files: { "package.json": JSON.stringify(pkg) } }))).fails.includes("schema"));
  });
});

test("categories: missing, wrong case, or unknown fails; Other warns", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { pkg: { categories: [] } }))).fails.includes("categories"));
    assert.ok((await preflight(makeExt(join(dir, "b"), { pkg: { categories: ["productivity"] } }))).fails.includes("categories"));
    assert.ok((await preflight(makeExt(join(dir, "c"), { pkg: { categories: ["Developer tools"] } }))).fails.includes("categories"));
    assert.ok((await preflight(makeExt(join(dir, "d"), { pkg: { categories: ["Other"] } }))).warns.includes("categories"));
  });
});

test("platforms: anything but macOS and Windows fails", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { pkg: { platforms: ["macOS", "Linux"] } }))).fails.includes("platforms"));
    assert.ok(!(await preflight(makeExt(join(dir, "b"), { pkg: { platforms: ["macOS", "Windows"] } }))).fails.includes("platforms"));
  });
});

test("preference-type: number and unknown types fail, at extension and command level; none → N/A", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { pkg: { preferences: [{ name: "n", title: "N", type: "number", required: false }] } }))).fails.includes("preference-type"));
    const cmd = { name: "index", title: "Search Items", mode: "view", preferences: [{ name: "x", title: "X", type: "int" }] };
    assert.ok((await preflight(makeExt(join(dir, "b"), { pkg: { commands: [cmd] } }))).fails.includes("preference-type"));
    assert.equal((await preflight(makeExt(join(dir, "c"), { pkg: { preferences: [] } }))).verdict("preference-type"), "N/A");
  });
});

test("changelog: missing file fails and the dependent checks say why they did not run", async () => {
  await withTempDir(async (dir) => {
    const r = await preflight(ext(dir, { files: { "CHANGELOG.md": null } }));
    assert.ok(r.fails.includes("changelog-exists"));
    assert.equal(r.verdict("changelog-order"), "N/A");
    assert.equal(r.verdict("changelog-placeholder"), "N/A");
  });
});

test("changelog-order: Unreleased or ascending dates fail; changelog-placeholder: two placeholders or a misplaced one fail (Q10)", async () => {
  await withTempDir(async (dir) => {
    const order = ["## [Unreleased]\n\n## [Initial Version] - 2026-01-02\n", "## [B] - 2026-01-02\n\n## [A] - 2026-03-04\n", "## Unreleased\n\n## [Initial Version] - 2026-01-02\n", "## [Unreleased] ##\n\n## [Initial Version] - 2026-01-02\n"];
    for (const [i, log] of order.entries()) assert.ok((await preflight(makeExt(join(dir, `o${i}`), { files: { "CHANGELOG.md": `# Changelog\n\n${log}` } }))).fails.includes("changelog-order"), log);
    const placeholder = ["## [Update] - 2026-02-01\n\n## [Initial Version] - {PR_MERGE_DATE}\n", "## [B] - {PR_MERGE_DATE}\n\n## [A] - {PR_MERGE_DATE}\n"];
    for (const [i, log] of placeholder.entries()) assert.ok((await preflight(makeExt(join(dir, `p${i}`), { files: { "CHANGELOG.md": `# Changelog\n\n${log}` } }))).fails.includes("changelog-placeholder"), log);
    // Q10: zero placeholders is a FAIL, where the legacy script accepted it.
    const none = await preflight(makeExt(join(dir, "z"), { files: { "CHANGELOG.md": "# Changelog\n\n## [Update] - 2026-03-01\n\n## [Initial Version] - 2026-01-02\n" } }));
    assert.equal(none.verdict("changelog-placeholder"), "FAIL");
    assert.equal(none.verdict("changelog-order"), "PASS");
    const ok = await preflight(makeExt(join(dir, "ok"), { files: { "CHANGELOG.md": "# Changelog\n\n## [Fix Unreleased-Link Rendering] - {PR_MERGE_DATE}\n\n## [Initial Version] - 2026-01-02\n" } }));
    assert.equal(ok.verdict("changelog-order"), "PASS");
    assert.equal(ok.verdict("changelog-placeholder"), "PASS");
    // The predicate shared with rx changelog: occurrences anywhere count, placement is the top heading, conflict markers fail first.
    const body = await preflight(makeExt(join(dir, "body"), { files: { "CHANGELOG.md": "# Changelog\n\n## [Update] - 2026-03-01\n\n- mentions {PR_MERGE_DATE} in a bullet\n" } }));
    assert.equal(body.verdict("changelog-placeholder"), "FAIL");
    assert.match(body.by["changelog-placeholder"].message, /not in the top entry's heading/);
    assert.deepEqual(body.by["changelog-placeholder"].details.map((d) => d.line), [5]);
    const twice = await preflight(makeExt(join(dir, "twice"), { files: { "CHANGELOG.md": "# Changelog\n\n## [Update] - {PR_MERGE_DATE}\n\n- see {PR_MERGE_DATE}\n" } }));
    assert.match(twice.by["changelog-placeholder"].message, /2 occurrences/);
    const conflict = await preflight(makeExt(join(dir, "conflict"), { files: { "CHANGELOG.md": "# Changelog\n\n<<<<<<< HEAD\n## [A] - {PR_MERGE_DATE}\n=======\n## [A] - 2026-03-01\n>>>>>>> theirs\n" } }));
    assert.equal(conflict.verdict("changelog-placeholder"), "FAIL");
    assert.match(conflict.by["changelog-placeholder"].message, /conflict markers/);
  });
});

test("file checks with --published: a renamed file (same count, no published counterpart) is a change, not a crash", async () => {
  await withTempDir(async (dir) => {
    const pub = makeExt(join(dir, "pub"), { files: { "docs/old.md": "x\n" } });
    const r = await preflight(makeExt(join(dir, "local"), { files: { "docs/new.md": "x\n" } }), { published: pub });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.verdict("dev-material"), "WARN");
    assert.deepEqual(r.by["dev-material"].details.map((d) => d.file), ["docs"]);
  });
});

test("several applicable rules binding one check with different options: every option set runs and the strictest outcome stands", async () => {
  await withTempDir(async (dir) => {
    const presetFile = join(dir, "p.json");
    const base = JSON.parse(readFileSync(HOUSE_PRESET, "utf8"));
    const strict = { ...base.rules.find((r) => r.id === "pref-description-length"), id: "pref-description-length-strict", anchor: "house-anchors.md#pref-description-length", severity: "report", bindings: [{ kind: "rx", check: "pref-description-length", coverage: "full", options: { max: 50 } }] };
    base.rules.push(strict);
    writeFileSync(presetFile, JSON.stringify(base));
    const root = makeExt(join(dir, "ext"), { pkg: { preferences: [{ name: "p", title: "P", type: "textfield", required: false, description: "x".repeat(60) }] } });
    const r = await preflight(root, { preset: presetFile });
    assert.equal(r.verdict("pref-description-length"), "WARN", r.by["pref-description-length"].message);
    assert.match(r.by["pref-description-length"].message, /over 50 characters/);
    assert.ok(!/over 80/.test(r.by["pref-description-length"].message), "the lenient set found nothing; the strict set decides");
    // A block rule whose own set fails makes the check FAIL.
    base.rules.push({ ...strict, id: "pref-description-length-block", severity: "block", bindings: [{ kind: "rx", check: "pref-description-length", coverage: "full", options: { max: 40 } }] });
    writeFileSync(presetFile, JSON.stringify(base));
    const b = await preflight(root, { preset: presetFile });
    assert.equal(b.verdict("pref-description-length"), "FAIL");
    // N1: a passing block rule (max 80) beside a failing report rule (max 40) is a WARN: each
    // binding's severity applies to that binding's own findings.
    const n1 = JSON.parse(readFileSync(HOUSE_PRESET, "utf8"));
    n1.rules = n1.rules.map((r) => (r.id === "pref-description-length" ? { ...r, severity: "block" } : r));
    n1.rules.push({ ...strict, id: "pref-description-length-report-40", severity: "report", bindings: [{ kind: "rx", check: "pref-description-length", coverage: "full", options: { max: 40 } }] });
    writeFileSync(presetFile, JSON.stringify(n1));
    const mixed = await preflight(root, { preset: presetFile });
    assert.equal(mixed.verdict("pref-description-length"), "WARN", mixed.by["pref-description-length"].message);
    // Two rules binding the same option set: the stricter severity wins for that set.
    n1.rules.push({ ...strict, id: "pref-description-length-block-40", severity: "block", bindings: [{ kind: "rx", check: "pref-description-length", coverage: "full", options: { max: 40 } }] });
    writeFileSync(presetFile, JSON.stringify(n1));
    assert.equal((await preflight(root, { preset: presetFile })).verdict("pref-description-length"), "FAIL");
  });
});

test("N6: a .prettierrc holding JSON null, an array or a string FAILs prettierrc and the run continues", async () => {
  await withTempDir(async (dir) => {
    for (const [i, text] of ["null", "[]", '"x"'].entries()) {
      const r = await preflight(makeExt(join(dir, `p${i}`), { files: { ".prettierrc": text } }));
      assert.equal(r.code, 1, `${text}: ${r.stdout}`);
      assert.equal(r.verdict("prettierrc"), "FAIL", text);
      assert.match(r.by.prettierrc.message, /must be a JSON object/);
      assert.equal(r.verdict("schema"), "PASS", "the run continued");
    }
  });
});

test("N3/N4/N5: list-contained code is excluded while a list paragraph's image renders; shortcut references nested in a link are extracted; HTML comments are not", async () => {
  await withTempDir(async (dir) => {
    const listCode = await preflight(makeExt(join(dir, "listcode"), { files: { "README.md": "# L\n\n- item\n\n        ![code](metadata/good-1.png)\n\n- other\n\n    paragraph in the item\n\n    ![real](metadata/good-1.png)\n\n1. numbered\n\n   ![also real](metadata/good-1.png)\n\n       ![code too](metadata/good-1.png)\n" } }));
    assert.equal(listCode.verdict("readme-assets"), "FAIL");
    assert.deepEqual(listCode.by["readme-assets"].details.map((d) => d.line), [11, 15], JSON.stringify(listCode.by["readme-assets"].details));
    const nested = await preflight(makeExt(join(dir, "nested"), { files: { "README.md": "# N\n\n[![shot]](https://example.com/)\n\n[shot]: metadata/good-1.png\n" } }));
    assert.equal(nested.verdict("readme-assets"), "FAIL", JSON.stringify(nested.by["readme-assets"]));
    assert.deepEqual(nested.by["readme-assets"].details.map((d) => [d.line, d.text]), [[3, "metadata/good-1.png"]]);
    const comment = await preflight(makeExt(join(dir, "comment"), { files: { "README.md": "# C\n\n<!-- ![example](metadata/good-1.png) -->\n<!--\n<img src=\"assets/icon.png\">\n[x](docs/nope.md)\n-->\n\n![Real](media/shot.png)\n" } }));
    assert.equal(comment.verdict("readme-assets"), "PASS", JSON.stringify(comment.by["readme-assets"]));
    assert.equal(comment.verdict("readme-links"), "PASS");
    // Line numbers survive the comment removal.
    const after = await preflight(makeExt(join(dir, "after"), { files: { "README.md": "# C\n\n<!--\nx\n-->\n![shot](metadata/good-1.png)\n" } }));
    assert.deepEqual(after.by["readme-assets"].details.map((d) => d.line), [6]);
  });
});

test("--published inside the upstream cache is read under the cache lock; elsewhere no lock is taken", async () => {
  const { _setUpstreamForTests, lockHeld } = await import("../src/upstream.mjs");
  await withTempDir(async (dir) => {
    const prevXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    _setUpstreamForTests({ lockWaitMs: 40, lockStaleMs: 600_000 });
    try {
      const upstream = join(dir, "cache", "raycast-harness", "upstream");
      const pub = makeExt(join(upstream, "extensions", "good"));
      const local = makeExt(join(dir, "local"));
      const free = await preflight(local, { published: pub });
      assert.equal(free.code, 0, free.stdout);
      assert.ok(!existsSync(join(upstream, ".rx-lock")), "the lock is released afterward");
      assert.equal(lockHeld(), false);
      mkdirSync(join(upstream, ".rx-lock"));
      const held = await rx(["preflight", "--root", local, "--published", pub, "--json"]);
      assert.equal(held.code, 2, held.stdout);
      assert.equal(held.json.results[0].id, "github");
      assert.match(held.json.results[0].message, /upstream cache lock/);
      // A published directory outside the cache is read without the lock, even while the lock is held.
      const elsewhere = makeExt(join(dir, "elsewhere"));
      const outside = await preflight(local, { published: elsewhere });
      assert.equal(outside.code, 0, outside.stdout);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prevXdg;
      _setUpstreamForTests({ lockWaitMs: null, lockStaleMs: null });
    }
  });
});

test("read-only commands leave no .git/rx behind", async () => {
  await withTempDir(async (dir) => {
    const root = makeExt(join(dir, "ext"), { pkg: { author: "testowner" } });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const r = await preflight(root, { preset: HOUSE_PRESET });
    assert.equal(r.code, 0, r.stdout);
    assert.ok(!existsSync(join(root, ".git", "rx")), ".git/rx was created by a read-only run");
  });
});

test("changelog-updated: with --published, an unchanged top entry fails and a new one passes; without it N/A", async () => {
  await withTempDir(async (dir) => {
    const published = makeExt(join(dir, "pub"), { files: { "CHANGELOG.md": "# Changelog\n\n## [Initial Version] - 2026-01-02\n" } });
    const same = makeExt(join(dir, "same"), { files: { "CHANGELOG.md": "# Changelog\n\n## [Initial Version] - 2026-01-02\n" } });
    assert.ok((await preflight(same, { published })).fails.includes("changelog-updated"));
    assert.equal((await preflight(makeExt(join(dir, "new")), { published })).verdict("changelog-updated"), "PASS");
    assert.equal((await preflight(makeExt(join(dir, "alone")))).verdict("changelog-updated"), "N/A");
  });
});

test("screenshots: a view command with no metadata PNGs fails; a no-view extension is N/A", async () => {
  await withTempDir(async (dir) => {
    const r = await preflight(makeExt(join(dir, "a"), { files: { "metadata/good-1.png": null } }));
    assert.ok(r.fails.includes("screenshots"));
    assert.equal(r.verdict("screenshot-count"), "N/A", "metadata/ absent");
    const cmd = { name: "index", title: "Do Thing", mode: "no-view" };
    assert.equal((await preflight(makeExt(join(dir, "b"), { pkg: { commands: [cmd] }, files: { "metadata/good-1.png": null } }))).verdict("screenshots"), "N/A");
  });
});

test("§4.1 screenshot-size, screenshot-count, screenshot-format, icon-size", async () => {
  await withTempDir(async (dir) => {
    const size = await preflight(makeExt(join(dir, "size"), { files: { "metadata/good-1.png": png(1000, 625) } }));
    assert.equal(size.verdict("screenshot-size"), "FAIL");
    assert.equal(size.verdict("screenshots"), "PASS", "presence is a separate check");
    const many = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`metadata/s-${i}.png`, png(2000, 1250)]));
    assert.equal((await preflight(makeExt(join(dir, "count"), { files: many }))).verdict("screenshot-count"), "FAIL");
    const fmt = await preflight(makeExt(join(dir, "fmt"), { files: { "metadata/shot.jpg": "x", "metadata/shot.webp": "x" } }));
    assert.equal(fmt.verdict("screenshot-format"), "FAIL");
    assert.deepEqual(fmt.by["screenshot-format"].details.map((d) => d.file).sort(), ["metadata/shot.jpg", "metadata/shot.webp"]);
    assert.equal((await preflight(makeExt(join(dir, "icon"), { files: { "assets/icon.png": png(256, 256) } }))).verdict("icon-size"), "FAIL");
    assert.equal((await preflight(makeExt(join(dir, "noicon"), { files: { "assets/icon.png": null } }))).verdict("icon-size"), "FAIL");
    const pkg = { ...GOOD_PKG, icon: undefined };
    assert.equal((await preflight(makeExt(join(dir, "nofield"), { files: { "package.json": JSON.stringify(pkg) } }))).verdict("icon-size"), "FAIL");
  });
});

test("readme-assets (legacy forms): metadata/, URL-encoded metadata/, assets/ image fail; media/ passes; prose mentions do not count", async () => {
  await withTempDir(async (dir) => {
    const readme = async (name, body) => preflight(makeExt(join(dir, name), { files: { "README.md": `# Good\n\n${body}\n` } }));
    assert.ok((await readme("a", "![shot](metadata/good-1.png)")).fails.includes("readme-assets"));
    assert.ok((await readme("b", "![shot](metadata%2Fgood-1.png)")).fails.includes("readme-assets"));
    assert.ok((await readme("c", '<img src="./assets/icon.png">')).fails.includes("readme-assets"));
    assert.ok(!(await readme("d", "![shot](media/shot.png)")).fails.includes("readme-assets"));
    assert.ok(!(await readme("e", "Screenshots live in `metadata/` and the icon in assets/icon.png.")).fails.includes("readme-assets"));
    const link = await readme("f", "[a link](metadata/good-1.png) [Download](assets/icon.png)");
    assert.equal(link.verdict("readme-assets"), "PASS", "a plain link to an asset is not an embedded image");
    assert.equal(link.verdict("readme-links"), "PASS", "and readme-links resolves it");
    assert.equal((await preflight(makeExt(join(dir, "g"), { files: { "README.md": null } }))).verdict("readme-assets"), "FAIL", "README.md is a required artifact");
  });
});

test("T3: reference definitions, angle-bracket destinations, attribute whitespace and query strings are embeds", async () => {
  await withTempDir(async (dir) => {
    const readme = async (name, body) => (await preflight(makeExt(join(dir, name), { files: { "README.md": `# T3\n\n${body}\n` } }))).by["readme-assets"];
    const ref = await readme("ref", "![shot][s]\n\n[s]: metadata/good-1.png");
    assert.equal(ref.verdict, "FAIL");
    assert.equal(ref.details[0].line, 3, "the embed line, not the definition line");
    assert.equal((await readme("ref2", "![good-1][]\n\n[good-1]: <metadata/good-1.png>")).verdict, "FAIL");
    assert.equal((await readme("angle", '![shot](<metadata/my shot.png> "title")')).verdict, "FAIL");
    assert.equal((await readme("ws", "<img\n  src = 'assets/icon.png' />")).verdict, "FAIL");
    assert.equal((await readme("query", "![shot](metadata/good-1.png?raw=true#frag)")).verdict, "FAIL");
    assert.equal((await readme("title", '![shot](metadata/good-1.png "Store shot")')).verdict, "FAIL");
  });
});

test("srcset candidates, multi-line destinations and balanced parentheses are extracted; indented code is not", async () => {
  await withTempDir(async (dir) => {
    const srcset = await preflight(makeExt(join(dir, "srcset"), { files: { "README.md": '# S\n\n<picture>\n  <source srcset="media/shot.png 1x, metadata/good-1.png 2x">\n  <img src="media/shot.png">\n</picture>\n' } }));
    assert.equal(srcset.verdict("readme-assets"), "FAIL");
    assert.deepEqual(srcset.by["readme-assets"].details.map((d) => [d.line, d.text]), [[4, "metadata/good-1.png"]]);
    const multi = await preflight(makeExt(join(dir, "multi"), { files: { "README.md": "# M\n\n![shot](\n  metadata/good-1.png\n  \"Store shot\"\n)\n" } }));
    assert.equal(multi.verdict("readme-assets"), "FAIL");
    assert.equal(multi.by["readme-assets"].details[0].line, 3);
    const parens = await preflight(makeExt(join(dir, "parens"), { files: { "README.md": "# P\n\n[download](media/a(b).png) [esc](media/c\\).png) ![img](media/a(b).png)\n", "media/a(b).png": png(1, 1), "media/c).png": png(1, 1) } }));
    assert.equal(parens.verdict("readme-links"), "PASS", JSON.stringify(parens.by["readme-links"]));
    assert.equal(parens.verdict("readme-assets"), "PASS");
    const broken = await preflight(makeExt(join(dir, "parens2"), { files: { "README.md": "# P\n\n[download](media/x(y).png)\n" } }));
    assert.deepEqual(broken.by["readme-links"].details.map((d) => d.text), ["media/x(y).png"], "the destination is the whole balanced path, not the text before the first )");
    const indented = await preflight(makeExt(join(dir, "indented"), { files: { "README.md": "# I\n\nExample:\n\n    ![shot](metadata/good-1.png)\n    <img src=\"assets/icon.png\">\n\n    still code\n\nBut a list continuation renders:\n\n- item\n\n    ![real](metadata/good-1.png)\n" } }));
    assert.equal(indented.verdict("readme-assets"), "FAIL");
    assert.deepEqual(indented.by["readme-assets"].details.map((d) => d.line), [14], "only the list-continuation image, not the indented code block");
  });
});

test("T4: a fenced or inline code example of the forbidden form passes", async () => {
  await withTempDir(async (dir) => {
    const body = "Do not:\n\n```md\n![shot](metadata/shot.png)\n<img src=\"assets/icon.png\">\n```\n\nNor `![s](metadata/a.png)` or ``<img src='assets/x.png'>`` inline.\n\n~~~\n![x](metadata/y.png)\n~~~\n\n![Real](media/shot.png)";
    const r = await preflight(makeExt(join(dir, "fenced"), { files: { "README.md": `# T4\n\n${body}\n` } }));
    assert.equal(r.verdict("readme-assets"), "PASS", JSON.stringify(r.by["readme-assets"]));
    // A fence that is not closed blanks the rest of the file, as a renderer would.
    const open = await preflight(makeExt(join(dir, "open"), { files: { "README.md": "# T4\n\n```\n![shot](metadata/good-1.png)\n" } }));
    assert.equal(open.verdict("readme-assets"), "PASS");
  });
});

test("markdown extraction unit: code stripping keeps line numbers; nested badge-in-link is a link", () => {
  const md = "a\n```\nb\n```\nc `x` d\n[![Badge](https://img/x.svg)](docs/a.md)";
  assert.equal(stripCode(md).split("\n").length, md.split("\n").length);
  const embeds = extractEmbeds(md);
  assert.deepEqual(embeds.map((e) => [e.kind, e.target, e.line]), [["link", "docs/a.md", 6], ["image", "https://img/x.svg", 6]]);
});

test("Q9 readme-links: links without ./ or ../, a bare LICENSE, docs-relative paths and root-absolute paths; external and anchors skipped", async () => {
  await withTempDir(async (dir) => {
    const bad = await preflight(makeExt(join(dir, "bad"), { files: {
      "README.md": "# L\n\n[docs](docs/a.md) [lic](LICENSE) [ok](media/shot.png) [ext](https://x.example/) [anchor](#setup) [mail](mailto:a@b.c)\n",
      "docs/guide.md": "# G\n\n![d](./diagram.png) [up](../README.md) [root](/package.json)\n",
    } }));
    assert.equal(bad.verdict("readme-links"), "FAIL");
    assert.deepEqual(bad.by["readme-links"].details.map((d) => `${d.file}:${d.line} ${d.text}`), ["README.md:3 docs/a.md", "README.md:3 LICENSE", "docs/guide.md:3 ./diagram.png"]);
    const good = await preflight(makeExt(join(dir, "good"), { files: { "README.md": "# L\n\n[lic](LICENSE) [docs](docs/a.md#top)\n", LICENSE: "MIT\n", "docs/a.md": "# A\n" } }));
    assert.equal(good.verdict("readme-links"), "PASS");
    assert.equal((await preflight(makeExt(join(dir, "none"), { files: { "README.md": null } }))).verdict("readme-links"), "N/A");
  });
});

test("unused-dependencies: a dependency no source file imports fails; subpath and require count as use", async () => {
  await withTempDir(async (dir) => {
    const deps = { "@raycast/api": "^2.1.0", "@raycast/utils": "^2.0.0" };
    assert.ok((await preflight(makeExt(join(dir, "a"), { pkg: { dependencies: deps } }))).fails.includes("unused-dependencies"));
    const used = makeExt(join(dir, "b"), { pkg: { dependencies: { ...deps, lodash: "^4" } }, files: { "src/a.ts": 'import { getFavicon } from "@raycast/utils/dist/x";\nconst _ = require("lodash");\n' } });
    assert.ok(!(await preflight(used)).fails.includes("unused-dependencies"));
  });
});

test("native-fetch: importing node-fetch fails, dynamic import too, with file:line details", async () => {
  await withTempDir(async (dir) => {
    const r = await preflight(makeExt(join(dir, "a"), { pkg: { dependencies: { "@raycast/api": "^2.1.0", "node-fetch": "^3" } }, files: { "src/a.ts": 'import fetch from "node-fetch";\n' } }));
    assert.ok(r.fails.includes("native-fetch"));
    assert.deepEqual(r.by["native-fetch"].details, [{ file: "src/a.ts", line: 1, text: "src/a.ts:1" }]);
    assert.ok((await preflight(makeExt(join(dir, "b"), { files: { "src/a.ts": 'const fetch = (await import("node-fetch")).default;\n' } }))).fails.includes("native-fetch"));
  });
});

test("eslint-config: legacy .eslintrc or defineConfig from 'eslint' fails; eslint/config passes; none at all fails", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { files: { ".eslintrc.json": "{}" } }))).fails.includes("eslint-config"));
    assert.ok((await preflight(makeExt(join(dir, "b"), { files: { "eslint.config.js": 'import { defineConfig } from "eslint";\nexport default defineConfig([]);\n' } }))).fails.includes("eslint-config"));
    assert.ok(!(await preflight(makeExt(join(dir, "c"), { files: { "eslint.config.js": 'import { defineConfig } from "eslint/config";\nexport default defineConfig([]);\n' } }))).fails.includes("eslint-config"));
    assert.ok((await preflight(makeExt(join(dir, "d"), { files: { "eslint.config.js": null } }))).fails.includes("eslint-config"));
  });
});

test("prettierrc (compat preset): wrong values fail; the four-key form passes; YAML is read; quoted YAML keys too", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { files: { ".prettierrc": '{"printWidth":80,"singleQuote":true}' } }))).fails.includes("prettierrc"));
    const four = JSON.stringify({ printWidth: 120, singleQuote: false, plugins: ["@ianvs/prettier-plugin-sort-imports"], importOrder: ["<BUILTIN_MODULES>"] });
    assert.ok(!(await preflight(makeExt(join(dir, "b"), { files: { ".prettierrc": four } }))).fails.includes("prettierrc"));
    assert.ok(!(await preflight(makeExt(join(dir, "c"), { files: { ".prettierrc": "printWidth: 120\nsingleQuote: false\n" } }))).fails.includes("prettierrc"));
    assert.ok((await preflight(makeExt(join(dir, "d"), { files: { ".prettierrc": "printWidth: 80\nsingleQuote: true\n" } }))).fails.includes("prettierrc"));
    assert.ok(!(await preflight(makeExt(join(dir, "e"), { files: { ".prettierrc": '"printWidth": 120\n"singleQuote": false\n' } }))).fails.includes("prettierrc"));
    assert.ok((await preflight(makeExt(join(dir, "f"), { files: { ".prettierrc": null } }))).fails.includes("prettierrc"));
  });
});

test("prettierrc (house preset, F6): the plugin and its devDependency are a matched pair; the adopted four-key form must be exact; forks are N/A", async () => {
  await withTempDir(async (dir) => {
    const four = { printWidth: 120, singleQuote: false, plugins: ["@ianvs/prettier-plugin-sort-imports"], importOrder: ["<BUILTIN_MODULES>", "<THIRD_PARTY_MODULES>", "^@raycast/(.*)$", "^[.]"] };
    const house = { preset: HOUSE_PRESET };
    assert.equal((await preflight(makeExt(join(dir, "pair"), { files: { ".prettierrc": JSON.stringify(four) } }), house)).verdict("prettierrc"), "FAIL", "listed but not declared");
    const ok = makeExt(join(dir, "ok"), { pkg: { devDependencies: { "@ianvs/prettier-plugin-sort-imports": "^4.7.0" } }, files: { ".prettierrc": JSON.stringify(four) } });
    assert.equal((await preflight(ok, house)).verdict("prettierrc"), "PASS");
    const drift = makeExt(join(dir, "drift"), { pkg: { devDependencies: { "@ianvs/prettier-plugin-sort-imports": "^4.7.0" } }, files: { ".prettierrc": JSON.stringify({ ...four, importOrder: ["<BUILTIN_MODULES>"] }) } });
    assert.equal((await preflight(drift, house)).verdict("prettierrc"), "FAIL");
    assert.equal((await preflight(makeExt(join(dir, "two")), house)).verdict("prettierrc"), "PASS", "the plain two-key file is not a failure");
    const fork = makeExt(join(dir, "fork"), { pkg: { author: "someone-else" }, files: { ".prettierrc": '{"printWidth":80}' } });
    const f = await preflight(fork, house);
    assert.equal(f.verdict("prettierrc"), "N/A");
    assert.match(f.by.prettierrc.message, /does not apply: self-authored/);
  });
});

test("F6: core without a preset enforces no preset-class check (N/A with reason), and still runs every core check", async () => {
  await withTempDir(async (dir) => {
    const r = await preflight(makeExt(join(dir, "a"), { files: { ".prettierrc": '{"printWidth":80}', "dist/index.js": "x", "src/a.ts": "interface Preferences { a: string }\n" } }), { preset: null });
    for (const id of ["prettierrc", "hand-typed-preferences", "title-case", "agent-scaffolding", "dev-material", "generated-files", "logger"]) {
      assert.equal(r.verdict(id), "N/A", id);
      assert.match(r.by[id].message, /no preset/);
    }
    assert.equal(r.json.data.preset, null);
    assert.equal(r.json.data.selfAuthored, null);
    assert.equal(r.verdict("schema"), "PASS");
  });
});

test("severity cap: a report rule turns a preset-class FAIL into WARN; a block rule keeps the check's own levels", async () => {
  await withTempDir(async (dir) => {
    const src = "interface Preferences { apiKey: string }\nconst p = getPreferenceValues<Preferences>();\n";
    const legacy = await preflight(makeExt(join(dir, "a"), { files: { "src/a.ts": src } }));
    assert.equal(legacy.verdict("hand-typed-preferences"), "FAIL");
    const house = await preflight(makeExt(join(dir, "b"), { files: { "src/a.ts": src } }), { preset: HOUSE_PRESET });
    assert.equal(house.verdict("hand-typed-preferences"), "WARN");
    assert.deepEqual(house.by["hand-typed-preferences"].details.map((d) => d.line), [1]);
  });
});

test("hand-typed-preferences: an inline getPreferenceValues type fails; a scoped generated type passes; comments never count", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { files: { "src/a.ts": "const { apiKey } = getPreferenceValues<{ apiKey: string }>();\n" } }))).fails.includes("hand-typed-preferences"));
    assert.ok(!(await preflight(makeExt(join(dir, "b"), { files: { "src/a.ts": "const p = getPreferenceValues<Preferences.Search>();\n" } }))).fails.includes("hand-typed-preferences"));
    const r = await preflight(makeExt(join(dir, "c"), { files: { "src/a.ts": "// interface Preferences { apiKey: string }\n/* import fetch from \"node-fetch\"; */\n" } }));
    assert.ok(!r.fails.includes("hand-typed-preferences") && !r.fails.includes("native-fetch"));
  });
});

test("shortcut-platform-case: lowercase or quoted lowercase keys fail; proper keys pass; no shortcuts → N/A", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { files: { "src/a.tsx": 'shortcut={{ windows: { modifiers: ["ctrl"], key: "h" }, macos: { modifiers: ["cmd"], key: "h" } }}\n' } }))).fails.includes("shortcut-platform-case"));
    assert.ok((await preflight(makeExt(join(dir, "b"), { files: { "src/a.tsx": 'shortcut={{ "windows": { modifiers: ["ctrl"], key: "h" } }}\n' } }))).fails.includes("shortcut-platform-case"));
    assert.equal((await preflight(makeExt(join(dir, "c"), { files: { "src/a.tsx": 'shortcut={{ Windows: { modifiers: ["ctrl"], key: "h" }, macOS: { modifiers: ["cmd"], key: "h" } }}\n' } }))).verdict("shortcut-platform-case"), "PASS");
    assert.equal((await preflight(makeExt(join(dir, "d")))).verdict("shortcut-platform-case"), "N/A");
  });
});

test("title-case (compat preset): lowercase significant words warn; small words and brand casing do not", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { pkg: { title: "Tab width configuration" } }))).warns.includes("title-case"));
    assert.ok(!(await preflight(makeExt(join(dir, "b"), { pkg: { title: "Search in the macOS Menu for iPhone Apps" } }))).warns.includes("title-case"));
  });
});

test("launch-command: a Store-page link or a comment does not warn; a command deeplink does", async () => {
  await withTempDir(async (dir) => {
    assert.ok(!(await preflight(makeExt(join(dir, "a"), { files: { "src/a.ts": 'open("raycast://extensions/someone/their-ext");\n' } }))).warns.includes("launch-command"));
    assert.ok(!(await preflight(makeExt(join(dir, "b"), { files: { "src/a.ts": " * Format: raycast://extensions/{author}/{extension}/{command}\n// raycast://extensions/a/b/c\n" } }))).warns.includes("launch-command"));
    assert.ok((await preflight(makeExt(join(dir, "c"), { files: { "src/a.tsx": '<Action.Open title="Open Preferences" target="raycast://extensions/me/ext/settings" />\n' } }))).warns.includes("launch-command"));
  });
});

test("malformed input fails cleanly: bad JSON, null, an array, a string, non-array preferences, null members; the rest is N/A, never silent", async () => {
  await withTempDir(async (dir) => {
    const r = await preflight(makeExt(join(dir, "a"), { files: { "package.json": '{"name":' } }));
    assert.ok(r.fails.includes("package-json"));
    assert.equal(r.json.results.length, CHECK_IDS.length);
    assert.equal(r.verdict("schema"), "N/A");
    for (const [i, text] of ["null", "[]", '"brew"', "42"].entries()) {
      const bad = await preflight(makeExt(join(dir, `nonobject${i}`), { files: { "package.json": text } }));
      assert.equal(bad.verdict("package-json"), "FAIL", `${text}: ${bad.by["package-json"].message}`);
      assert.match(bad.by["package-json"].message, /must be a JSON object/);
      assert.equal(bad.verdict("schema"), "N/A", text);
      assert.equal(bad.code, 1, text);
    }
    assert.ok((await preflight(makeExt(join(dir, "b"), { pkg: { preferences: {} } }))).fails.includes("package-json"));
    assert.ok((await preflight(makeExt(join(dir, "c"), { pkg: { commands: [null] } }))).fails.includes("package-json"));
    assert.ok((await preflight(makeExt(join(dir, "d"), { pkg: { preferences: [null] } }))).fails.includes("package-json"));
  });
});

test("comments are stripped lexically: trailing comments, strings containing /*, continuation lines, regex literals, true line numbers", async () => {
  await withTempDir(async (dir) => {
    assert.ok(!(await preflight(makeExt(join(dir, "a"), { files: { "src/a.ts": "const x = 1; /* raycast://extensions/a/b/c */\n" } }))).warns.includes("launch-command"));
    assert.ok((await preflight(makeExt(join(dir, "b"), { files: { "src/a.ts": 'const glob = `src/*.ts`;\nimport fetch from "node-fetch";\n' } }))).fails.includes("native-fetch"));
    assert.ok((await preflight(makeExt(join(dir, "c"), { files: { "src/a.ts": 'const n = 2\n  * (await import("node-fetch")).default.length;\n' } }))).fails.includes("native-fetch"));
    assert.ok((await preflight(makeExt(join(dir, "d"), { files: { "src/a.ts": 'const r = /a\\/*b/;\nimport fetch from "node-fetch";\n' } }))).fails.includes("native-fetch"));
    const multi = await preflight(makeExt(join(dir, "e"), { files: { "src/a.ts": '/*\n a\n b\n*/\nimport fetch from "node-fetch";\n' } }));
    assert.deepEqual(multi.by["native-fetch"].details.map((d) => d.line), [5]);
  });
});

test("stripComments: a regex after a keyword and nested template literals keep their content", () => {
  const kw = 'function f(s) { return /[//]/.test(s) && import("node-fetch"); }';
  assert.equal(stripComments(kw), kw);
  assert.equal(stripComments("const u = `x ${`raycast://extensions/a/b/c`} y`; // tail"), "const u = `x ${`raycast://extensions/a/b/c`} y`;        ");
  assert.equal(stripComments("const s = `${a /* c */ + b}`;"), "const s = `${a         + b}`;");
});

test("warn-only heuristics: raycast:// deeplinks, hand-built favicon URLs, shell trash, locale sniffing", async () => {
  await withTempDir(async (dir) => {
    const src = ['open("raycast://extensions/me/ext/cmd");', "const icon = `https://www.google.com/s2/favicons?sz=64&domain=${d}`;", 'execSync(`mv ${p} ~/.Trash`);', "const locale = navigator.language;"].join("\n");
    const r = await preflight(makeExt(join(dir, "a"), { files: { "src/a.ts": src } }));
    for (const id of ["launch-command", "favicon", "trash", "localization"]) assert.ok(r.warns.includes(id), id);
  });
});

test("command-renamed: with --published, a vanished name fails when a new one appears, warns when only removed; a retitle is fine; malformed published manifests warn", async () => {
  await withTempDir(async (dir) => {
    const two = [{ name: "index", title: "Search Items", mode: "view" }, { name: "list", title: "List Items", mode: "view" }];
    const published = makeExt(join(dir, "pub"), { pkg: { commands: two } });
    const renamed = [two[0], { name: "browse", title: "List Items", mode: "view" }];
    assert.ok((await preflight(makeExt(join(dir, "ren"), { pkg: { commands: renamed } }), { published })).fails.includes("command-renamed"));
    const removed = await preflight(makeExt(join(dir, "rem"), { pkg: { commands: [two[0]] } }), { published });
    assert.equal(removed.verdict("command-renamed"), "WARN");
    assert.equal((await preflight(makeExt(join(dir, "ret"), { pkg: { commands: [two[0], { ...two[1], title: "Browse Items" }] } }), { published })).verdict("command-renamed"), "PASS");
    for (const [i, pubFiles] of [{ "package.json": null }, { "package.json": "{" }, { "package.json": "null" }, { "package.json": '{"commands":{}}' }].entries())
      assert.equal((await preflight(makeExt(join(dir, `x${i}`)), { published: makeExt(join(dir, `p${i}`), { files: pubFiles }) })).verdict("command-renamed"), "WARN", String(i));
    const odd = makeExt(join(dir, "odd"), { files: { "package.json": JSON.stringify({ ...GOOD_PKG, commands: [{}, GOOD_PKG.commands[0]] }) } });
    assert.equal((await preflight(makeExt(join(dir, "y")), { published: odd })).verdict("command-renamed"), "WARN");
    const mixed = makeExt(join(dir, "mixed"), { files: { "package.json": JSON.stringify({ ...GOOD_PKG, commands: [null, { name: 123 }, { name: "gone" }] }) } });
    const m = await preflight(makeExt(join(dir, "z")), { published: mixed });
    assert.equal(m.verdict("command-renamed"), "FAIL");
    assert.match(m.by["command-renamed"].message, /no string name/);
  });
});

test("lockfile: any lock file other than package-lock.json fails; a missing lockfile fails", async () => {
  await withTempDir(async (dir) => {
    for (const f of ["yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]) assert.ok((await preflight(makeExt(join(dir, f), { files: { [f]: "" } }))).fails.includes("lockfile"), f);
    assert.ok((await preflight(makeExt(join(dir, "none"), { files: { "package-lock.json": null } }))).fails.includes("lockfile"));
  });
});

test("npm-registry: .npmrc and lockfile registries, as npm parses them", async () => {
  await withTempDir(async (dir) => {
    let n = 0;
    const rc = async (s) => (await preflight(makeExt(join(dir, `rc${n++}`), { files: { ".npmrc": s } }))).fails.includes("npm-registry");
    const lockOf = (url) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/x": { resolved: url } } });
    const lock = async (l) => (await preflight(makeExt(join(dir, `lk${n++}`), { files: { "package-lock.json": l } }))).fails.includes("npm-registry");
    assert.ok(await rc("registry=https://registry.npmmirror.com/\n"));
    assert.ok(await rc("@acme:registry=https://npm.pkg.github.com\n"));
    assert.ok(!(await rc("legacy-peer-deps=true\nregistry=https://registry.npmjs.org/\n; registry=https://example.com\n")));
    assert.ok(await lock(lockOf("https://registry.npmmirror.com/x/-/x-1.0.0.tgz")));
    assert.ok(!(await lock(lockOf("https://registry.npmjs.org/x/-/x-1.0.0.tgz"))));
    for (const url of ["https://registry.npmjs.org.evil.example/x.tgz", "https://registry.npmjs.org@evil.example/x.tgz"]) assert.ok(await lock(lockOf(url)), url);
    assert.ok(!(await rc('registry="https://registry.npmjs.org/"\n')));
    assert.ok(await rc('"registry"=https://mirror.example/\n'));
    assert.ok(await lock('{"lockfileVersion":3,"packages":{"node_modules/x":{"resolved":"https:\\/\\/mirror.example\\/x.tgz"}}}'));
    assert.ok(await lock(JSON.stringify({ lockfileVersion: 1, dependencies: { a: { resolved: "https://registry.npmjs.org/a", dependencies: { b: { resolved: "https://mirror.example/b" } } } } })));
    const shrink = await preflight(makeExt(join(dir, "shrink"), { files: { "npm-shrinkwrap.json": lockOf("https://mirror.example/x.tgz") } }));
    assert.ok(shrink.fails.includes("lockfile") && shrink.fails.includes("npm-registry"));
    assert.ok(await rc("registry=https://registry.npmmirror.com/ # previously ${NPM_REGISTRY}\n"));
    assert.ok(!(await rc("registry=https://registry.npmjs.org ; use npm\n")));
    assert.ok(!(await rc("registry=https://mirror.example/\nregistry=https://registry.npmjs.org/\n")));
    assert.ok(await rc("@acme:registry=https://gitlab.com/api/v4/projects/${CI_PROJECT_ID}/packages/npm/\n"));
    assert.ok((await preflight(makeExt(join(dir, "env"), { files: { ".npmrc": "registry=${NPM_REGISTRY}\n" } }))).warns.includes("npm-registry"));
    assert.ok(await lock("\uFEFF" + lockOf("https://registry.npmmirror.com/x.tgz")));
    assert.ok(!(await rc("registry=https://registry.npmjs.org; use public npm\n")));
    assert.ok(await rc("registry=https://mirror.example/#mirror\n"));
    assert.ok(!(await rc('registry="https://registry.npmjs.org/#public" ; note\n')));
  });
});

test("agent-scaffolding: agent and planning files warn; a nested Greptile config fails; gitignored ones don't ship; ship.keep exempts a named path", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { files: { "AGENTS.md": "# Agents\n" } }))).warns.includes("agent-scaffolding"));
    assert.ok((await preflight(makeExt(join(dir, "b"), { files: { "CONTEXT-notes.md": "x" } }))).warns.includes("agent-scaffolding"));
    assert.ok((await preflight(makeExt(join(dir, "c"), { files: { ".claude/settings.json": "{}" } }))).warns.includes("agent-scaffolding"));
    assert.ok((await preflight(makeExt(join(dir, "d"), { files: { ".greptile/config.json": "{}" } }))).fails.includes("agent-scaffolding"));
    assert.ok((await preflight(makeExt(join(dir, "e"), { files: { "greptile.json": "{}" } }))).fails.includes("agent-scaffolding"));
    assert.equal((await preflight(makeExt(join(dir, "f"), { files: { "TODO.md": "x", ".gitignore": "node_modules\n/TODO.md\n" } }))).verdict("agent-scaffolding"), "PASS");
    const kept = await preflight(makeExt(join(dir, "g"), { pkg: { name: "keeps-todo" }, files: { "TODO.md": "x" } }), { preset: HOUSE_PRESET });
    assert.equal(kept.verdict("agent-scaffolding"), "PASS");
    assert.match(kept.by["agent-scaffolding"].message, /kept on purpose: TODO.md/);
    assert.equal((await preflight(makeExt(join(dir, "h"), { pkg: { name: "other" }, files: { "TODO.md": "x" } }), { preset: HOUSE_PRESET })).verdict("agent-scaffolding"), "WARN");
  });
});

test("file checks with --published: identical files are not flagged, changed or added ones are; ignored-but-published still ships; bytes compared", async () => {
  await withTempDir(async (dir) => {
    const pub = makeExt(join(dir, "pub"), { files: { "AGENTS.md": "# Agents\n", ".claude/settings.json": "{}", LICENSE: "MIT\n", ".greptile/config.json": "{}", "dist/index.js": "x", "dist/a": Buffer.from([0x80]) } });
    const same = await preflight(makeExt(join(dir, "same"), { files: { "AGENTS.md": "# Agents\n", ".claude/settings.json": "{}", LICENSE: "MIT\n", ".greptile/config.json": "{}", "dist/index.js": "x", "dist/a": Buffer.from([0x80]) } }), { published: pub });
    for (const id of ["agent-scaffolding", "dev-material", "generated-files"]) assert.equal(same.verdict(id), "PASS", id);
    assert.ok((await preflight(makeExt(join(dir, "fresh"), { files: { "AGENTS.md": "# Agents, freshened\n" } }), { published: pub })).warns.includes("agent-scaffolding"));
    assert.ok((await preflight(makeExt(join(dir, "add"), { files: { ".claude/settings.json": "{}", ".claude/new.json": "{}" } }), { published: pub })).warns.includes("agent-scaffolding"));
    assert.ok((await preflight(makeExt(join(dir, "ign"), { files: { "AGENTS.md": "new\n", ".gitignore": "AGENTS.md\n" } }), { published: pub })).warns.includes("agent-scaffolding"));
    assert.ok((await preflight(makeExt(join(dir, "bytes"), { files: { "dist/a": Buffer.from([0x81]) } }), { published: pub })).fails.includes("generated-files"));
    assert.equal((await preflight(makeExt(join(dir, "lic"), { files: { LICENSE: "MIT\n" } }), { published: pub })).verdict("dev-material"), "PASS");
  });
});

test("dev-material and generated-files: LICENSE, contributor docs, docs/, tools/ warn; dist/.build fail; .DS_Store warns; ignored and never-copied paths pass", async () => {
  await withTempDir(async (dir) => {
    for (const f of [["LICENSE", "MIT\n"], ["CONTRIBUTING.md", "x"], ["docs/setup.md", "x"], ["tools/test.mjs", "x"]])
      assert.ok((await preflight(makeExt(join(dir, f[0].replace(/\W/g, "_")), { files: { [f[0]]: f[1] } }))).warns.includes("dev-material"), f[0]);
    assert.ok((await preflight(makeExt(join(dir, "dist"), { files: { "dist/index.js": "x" } }))).fails.includes("generated-files"));
    assert.ok((await preflight(makeExt(join(dir, "build"), { files: { ".build/x": "x" } }))).fails.includes("generated-files"));
    assert.ok((await preflight(makeExt(join(dir, "ds"), { files: { "metadata/.DS_Store": "x" } }))).warns.includes("generated-files"));
    assert.equal((await preflight(makeExt(join(dir, "ign"), { files: { "dist/index.js": "x", ".DS_Store": "x", ".gitignore": "/dist\n.DS_Store\n" } }))).verdict("generated-files"), "PASS");
    for (const f of ["node_modules/x/i.js", ".swiftpm/x", "compiled_raycast_rust/x", "raycast-env.d.ts"])
      assert.equal((await preflight(makeExt(join(dir, f.replace(/\W/g, "_")), { files: { [f]: "x" } }))).verdict("generated-files"), "PASS", f);
  });
});

test("gitignore matcher: negation, **/, dir/*, leading spaces, CRLF, escapes and classes behave as in git; exotic patterns neither crash nor mistranslate", async () => {
  await withTempDir(async (dir) => {
    assert.ok((await preflight(makeExt(join(dir, "a"), { files: { "AGENTS.md": "x", ".gitignore": "*.md\n!AGENTS.md\n" } }))).warns.includes("agent-scaffolding"));
    assert.equal((await preflight(makeExt(join(dir, "b"), { files: { ".DS_Store": "x", ".gitignore": "**/.DS_Store\n" } }))).verdict("generated-files"), "PASS");
    assert.equal((await preflight(makeExt(join(dir, "c"), { files: { ".claude/settings.json": "{}", ".gitignore": ".claude/*\n" } }))).verdict("agent-scaffolding"), "PASS");
    assert.ok((await preflight(makeExt(join(dir, "d"), { files: { "AGENTS.md": "x", ".gitignore": " AGENTS.md\n" } }))).warns.includes("agent-scaffolding"));
    assert.equal((await preflight(makeExt(join(dir, "e"), { files: { "AGENTS.md": "x", ".gitignore": "AGENTS.md\r\n" } }))).verdict("agent-scaffolding"), "PASS");
    assert.equal((await preflight(makeExt(join(dir, "f"), { files: { ".gitignore": "\\[notes]/\n" } }))).code, 0);
    assert.equal((await preflight(makeExt(join(dir, "g"), { files: { "dist/a.js": "x", ".gitignore": "di[s]t/\n" } }))).verdict("generated-files"), "PASS");
    assert.equal((await preflight(makeExt(join(dir, "h"), { files: { ".claude/s.json": "{}", ".gitignore": "\\.claude/\n" } }))).verdict("agent-scaffolding"), "PASS");
    assert.ok((await preflight(makeExt(join(dir, "i"), { files: { "dist/a.js": "x", ".gitignore": "di[!s]t/\n" } }))).fails.includes("generated-files"));
    assert.equal((await preflight(makeExt(join(dir, "j"), { files: { ".gitignore": "[z-a]\n" } }))).code, 0);
    assert.equal((await preflight(makeExt(join(dir, "k"), { files: { "dist/a.js": "x", ".gitignore": "di[[:alpha:]]t/\n" } }))).verdict("generated-files"), "PASS");
    assert.ok((await preflight(makeExt(join(dir, "l"), { files: { ".claude/p/settings.json": "{}", ".gitignore": ".claude**/settings.json\n" } }))).warns.includes("agent-scaffolding"));
  });
});

test("gitignore matcher agrees with git check-ignore --no-index; the fallback skips what it cannot translate", async () => {
  await withTempDir(async (dir) => {
    const rules = ["node_modules/", "/dist", "*.d.ts", "**/.DS_Store", ".claude/*", "!.claude/keep.json", "*.md", "!AGENTS.md", "\\[notes]/", "di[s]t2/", "\\.envrc", "build[!x]/", "docs/**/draft.md", " spaced.md", "\\#hash", "\\!bang", "a?c", "logs/", "!logs/keep.log"].join("\n");
    const paths = ["node_modules/x", "dist/a.js", "src/x.d.ts", ".DS_Store", "metadata/.DS_Store", ".claude/s.json", ".claude/keep.json", "README.md", "AGENTS.md", "[notes]/a", "dist2/a", ".envrc", "builda/x", "buildx/x", "docs/a/b/draft.md", "docs/draft.md", " spaced.md", "spaced.md", "#hash", "!bang", "abc", "a/c", "logs/keep.log", "logs/other.log"];
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), rules + "\n");
    const ours = gitignoreMatcher(rules);
    for (const p of paths) {
      let git = true;
      try { execFileSync("git", ["check-ignore", "-q", "--no-index", "--", p], { cwd: dir, stdio: "ignore" }); } catch { git = false; }
      assert.equal(ours(p, false), git, p);
    }
    assert.equal(gitignoreMatcher("[z-a]\n*.md\n")("x.md", false), true);
  });
});

test("T5 / Q12 logger checks: scopes from the preset, full-block comparison, absence is N/A", async () => {
  await withTempDir(async (dir) => {
    const house = { preset: HOUSE_PRESET };
    const verbose = { name: "verboseLogging", title: "Debug Logging", label: "Enable extra diagnostics in the console", description: "Show detailed logs in the console for debugging.", type: "checkbox", required: false, default: false };
    const strict = { name: "strictRedaction", type: "checkbox", required: false, title: "Strict Redaction", label: "Also hide URL query strings and fragments in logs", description: "Turn on before reproducing an issue, then share only the new log lines.", default: false };
    const web = 'import { Logger } from "@chrismessina/raycast-logger";\nexport const f = () => fetch("https://x");\n';
    const deps = { "@raycast/api": "^2.1.0", "@chrismessina/raycast-logger": "^1.5.0" };
    const lock15 = LOCK("2.1.0", { "node_modules/@chrismessina/raycast-logger": { version: "1.5.0", resolved: "https://registry.npmjs.org/@chrismessina/raycast-logger/-/raycast-logger-1.5.0.tgz" } });
    const lock14 = LOCK("2.1.0", { "node_modules/@chrismessina/raycast-logger": { version: "1.4.0", resolved: "https://registry.npmjs.org/@chrismessina/raycast-logger/-/raycast-logger-1.4.0.tgz" } });

    // No web requests: logger does not apply.
    const offline = await preflight(makeExt(join(dir, "offline")), house);
    assert.equal(offline.verdict("logger"), "N/A");
    assert.match(offline.by.logger.message, /does not apply: makes web requests/);
    assert.equal(offline.verdict("logger-verbose-copy"), "N/A");
    assert.match(offline.by["logger-verbose-copy"].message, /declares `verboseLogging`/);

    // Web requests, no logger: FAIL naming each missing piece.
    const missing = await preflight(makeExt(join(dir, "missing"), { files: { "src/a.ts": 'export const f = () => fetch("https://x");\n' } }), house);
    assert.equal(missing.verdict("logger"), "FAIL");
    assert.match(missing.by.logger.message, /not in dependencies.*imports.*no preference named verboseLogging/);

    // Full compliance.
    const good = await preflight(makeExt(join(dir, "good"), { pkg: { dependencies: deps, preferences: [verbose, strict] }, files: { "src/a.ts": web, "package-lock.json": lock15 } }), house);
    assert.equal(good.verdict("logger"), "PASS");
    assert.equal(good.verdict("logger-verbose-copy"), "PASS");
    assert.equal(good.verdict("logger-strict-redaction"), "PASS");

    // Q12: a block that matches title and description but drifts in `default` and carries an extra field still fails.
    const drift = await preflight(makeExt(join(dir, "drift"), { pkg: { dependencies: deps, preferences: [{ ...verbose, default: true, placeholder: "x" }] }, files: { "src/a.ts": web, "package-lock.json": lock15 } }), house);
    assert.equal(drift.verdict("logger-verbose-copy"), "FAIL");
    assert.deepEqual(drift.by["logger-verbose-copy"].details.map((d) => d.text.replace(/^verboseLogging \(extension\) /, "")), ["default: expected false, has true", "has an extra field placeholder"]);
    assert.equal(drift.verdict("logger-strict-redaction"), "WARN", "report-only: missing strictRedaction on logger 1.5.0");

    // T5: strict-redaction scope is the installed logger, not the range; below 1.5.0 it does not apply.
    const old = await preflight(makeExt(join(dir, "old"), { pkg: { dependencies: deps, preferences: [verbose] }, files: { "src/a.ts": web, "package-lock.json": lock14 } }), house);
    assert.equal(old.verdict("logger-strict-redaction"), "N/A");
    assert.match(old.by["logger-strict-redaction"].message, /1\.4\.0 is below 1\.5\.0/);

    // T5: on a fork, logger and strict-redaction do not apply, but the verbose block (declared) is still checked.
    const fork = await preflight(makeExt(join(dir, "fork"), { pkg: { author: "someone-else", dependencies: deps, preferences: [{ ...verbose, title: "Verbose Logging" }] }, files: { "src/a.ts": web, "package-lock.json": lock15 } }), house);
    assert.equal(fork.verdict("logger"), "N/A");
    assert.equal(fork.verdict("logger-strict-redaction"), "N/A");
    assert.equal(fork.verdict("logger-verbose-copy"), "FAIL");
  });
});

test("pref-description-length / pref-label-length: budgets from the preset, report-only, command-level counted, absent → N/A", async () => {
  await withTempDir(async (dir) => {
    const house = { preset: HOUSE_PRESET };
    const long = await preflight(makeExt(join(dir, "long"), { pkg: { commands: [{ name: "index", title: "Search", mode: "view", preferences: [{ name: "p", title: "P", type: "textfield", required: false, description: "x".repeat(81), label: "y".repeat(50) }] }] } }), house);
    assert.equal(long.verdict("pref-description-length"), "WARN");
    assert.equal(long.verdict("pref-label-length"), "WARN");
    assert.match(long.by["pref-description-length"].message, /p \(command index\) 81/);
    const fit = await preflight(makeExt(join(dir, "fit"), { pkg: { preferences: [{ name: "p", title: "P", type: "textfield", required: false, description: "x".repeat(80), label: "y".repeat(49) }] } }), house);
    assert.equal(fit.verdict("pref-description-length"), "PASS");
    assert.equal(fit.verdict("pref-label-length"), "PASS");
    const none = await preflight(makeExt(join(dir, "none")), house);
    assert.equal(none.verdict("pref-description-length"), "N/A");
  });
});

test("§11.1 agents-md checks: paths, npm scripts, /Users/ paths, symbols; forks and absent docs are N/A", async () => {
  await withTempDir(async (dir) => {
    const house = { preset: HOUSE_PRESET };
    const doc = "# Agents\n\nEntry `src/index.tsx`, missing `src/lib/nope.ts`, dir `src/`, helper `helper.ts` (anywhere in the tree). Run `npm run build`, `npm run nope`.\n\nCalls `load()`, `util.helper()`, `ghost()`. Package `@raycast/api` is not a path; neither is `text/plain` nor `environment.supportPath/pasted`. Path `/Users/someone/x` is banned.\n";
    const r = await preflight(makeExt(join(dir, "a"), { pkg: { scripts: { build: "ray build" } }, files: { "AGENTS.md": doc, "src/index.tsx": "export function load() { return helper(); }\nfunction helper() {}\n", "src/lib/helper.ts": "export const x = 1;\n" } }), house);
    assert.deepEqual(r.by["agents-md-paths"].details.map((d) => d.text), ["src/lib/nope.ts"]);
    assert.deepEqual(r.by["agents-md-scripts"].details.map((d) => d.text), ["npm run nope"]);
    assert.deepEqual(r.by["agents-md-no-home-paths"].details.map((d) => d.line), [5]);
    assert.deepEqual(r.by["agents-md-symbols"].details.map((d) => d.text), ["ghost()"]);
    for (const id of ["agents-md-paths", "agents-md-scripts", "agents-md-no-home-paths", "agents-md-symbols"]) assert.equal(r.verdict(id), "FAIL", id);
    const clean = await preflight(makeExt(join(dir, "b"), { pkg: { scripts: { build: "ray build" } }, files: { "CONCEPTS.md": "# Concepts\n\n`src/index.tsx` and `npm run build`; `load()`.\n", "src/index.tsx": "export function load() {}\n" } }), house);
    for (const id of ["agents-md-paths", "agents-md-scripts", "agents-md-no-home-paths", "agents-md-symbols"]) assert.equal(clean.verdict(id), "PASS", id);
    assert.equal((await preflight(makeExt(join(dir, "c")), house)).verdict("agents-md-paths"), "N/A");
    assert.equal((await preflight(makeExt(join(dir, "d"), { pkg: { author: "someone-else" }, files: { "AGENTS.md": doc } }), house)).verdict("agents-md-paths"), "N/A");
  });
});

test("agents-md-paths: a path whose extension no extension repo holds (another repo's PHP files) is not checked; a missing .ts path still is", async () => {
  await withTempDir(async (dir) => {
    const house = { preset: HOUSE_PRESET };
    const doc = "# Agents\n\nThe companion server routes uploads through `server/app/Http/Controllers/UploadController.php` and boots from `server/bootstrap/start.php`.\nLocal entry: `src/index.tsx`.\n";
    const r = await preflight(makeExt(join(dir, "a"), { files: { "AGENTS.md": doc, "src/index.tsx": "export default function Command() {}\n" } }), house);
    assert.equal(r.verdict("agents-md-paths"), "PASS", r.by["agents-md-paths"].message);
    assert.match(r.by["agents-md-paths"].message, /^1 backticked path/);
    const missing = await preflight(makeExt(join(dir, "b"), { files: { "AGENTS.md": `${doc}Helper: \`src/lib/gone.ts\`.\n`, "src/index.tsx": "export default function Command() {}\n" } }), house);
    assert.equal(missing.verdict("agents-md-paths"), "FAIL");
    assert.deepEqual(missing.by["agents-md-paths"].details.map((d) => d.text), ["src/lib/gone.ts"]);
  });
});

test("agents-md: <!-- rx-ignore agents-md --> on the line or alone on the line above exempts paths, symbols and scripts, never home paths", async () => {
  await withTempDir(async (dir) => {
    const house = { preset: HOUSE_PRESET };
    const MARK = "<!-- rx-ignore agents-md -->";
    const doc = [
      "# Agents",
      "",
      `The server measures uploads with \`imagesize()\` before storing them. ${MARK}`,
      MARK,
      "Deploy it with `npm run deploy-server`; its routes live in `server/routes/api.ts`.",
      "Local entry: `src/index.tsx`.",
      "",
    ].join("\n");
    const r = await preflight(makeExt(join(dir, "a"), { files: { "AGENTS.md": doc, "src/index.tsx": "export default function Command() {}\n" } }), house);
    assert.equal(r.verdict("agents-md-paths"), "PASS", r.by["agents-md-paths"].message);
    assert.equal(r.verdict("agents-md-symbols"), "N/A", r.by["agents-md-symbols"].message);
    assert.equal(r.verdict("agents-md-scripts"), "N/A", r.by["agents-md-scripts"].message);

    // A marker two lines above, or not alone on the line above, exempts nothing; the failure names the escape.
    const far = ["# Agents", MARK, "", "The server measures uploads with `imagesize()`.", `Note ${MARK}`, "Deploy it with `npm run deploy-server`.", ""].join("\n");
    const f = await preflight(makeExt(join(dir, "b"), { files: { "AGENTS.md": far, "src/index.tsx": "export default function Command() {}\n" } }), house);
    assert.equal(f.verdict("agents-md-symbols"), "FAIL");
    assert.equal(f.verdict("agents-md-scripts"), "FAIL");
    assert.match(f.by["agents-md-symbols"].message, /mark a reference to another repository with <!-- rx-ignore agents-md -->/);
    assert.match(f.by["agents-md-scripts"].message, /mark a reference to another repository with <!-- rx-ignore agents-md -->/);
    const missing = await preflight(makeExt(join(dir, "c"), { files: { "AGENTS.md": "# Agents\n\nSee `src/lib/gone.ts`.\n" } }), house);
    assert.match(missing.by["agents-md-paths"].message, /mark a reference to another repository with <!-- rx-ignore agents-md -->/);

    // The marker never exempts a home-directory path.
    const home = await preflight(makeExt(join(dir, "d"), { files: { "AGENTS.md": `# Agents\n\nThe server lives at /Users/someone/server. ${MARK}\n` } }), house);
    assert.equal(home.verdict("agents-md-no-home-paths"), "FAIL");
  });
});

test("without --published, changelog-updated and command-renamed say no published copy was given, not that the extension is unpublished", async () => {
  await withTempDir(async (dir) => {
    const r = await preflight(ext(dir));
    for (const id of ["changelog-updated", "command-renamed"]) {
      assert.equal(r.verdict(id), "N/A", id);
      assert.equal(r.by[id].message, "no published copy given; pass --published <dir> (rx stale prints it)", id);
    }
  });
});

test("applicability: an unknown context value (published, before rx stale) makes the bound check N/A naming the missing value; --published supplies it", async () => {
  await withTempDir(async (dir) => {
    const r = await preflight(makeExt(join(dir, "a"), { files: { LICENSE: "MIT\n" } }), { preset: HOUSE_PRESET });
    assert.equal(r.verdict("dev-material"), "N/A");
    assert.match(r.by["dev-material"].message, /published is unknown; run rx stale/);
    const pub = makeExt(join(dir, "pub"));
    const withPub = await preflight(makeExt(join(dir, "b"), { files: { LICENSE: "MIT\n" } }), { preset: HOUSE_PRESET, published: pub });
    assert.equal(withPub.verdict("dev-material"), "WARN");
  });
});

test("preset with a binding that lacks a required option is ERROR input, not a silent pass", async () => {
  await withTempDir(async (dir) => {
    const preset = join(dir, "p.json");
    const base = JSON.parse(readFileSync(HOUSE_PRESET, "utf8"));
    base.rules = base.rules.map((r) => (r.id === "pref-description-length" ? { ...r, bindings: [{ kind: "rx", check: "pref-description-length", coverage: "full", options: { max: 80 } }, { kind: "rx", check: "pref-label-length", coverage: "full" }] } : r));
    writeFileSync(preset, JSON.stringify(base));
    const r = await rx(["preflight", "--root", makeExt(join(dir, "ext")), "--preset", preset, "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "input");
    assert.match(r.json.results[0].message, /invalid|lacks options/);
  });
});

// Checked-in fixtures: each expected.json names the verdicts it exists to prove; any FAIL it does
// not name is a regression.
const FIXTURE_DIRS = ["extensions", "real"].flatMap((base) => {
  const d = join(REPO, "test", "fixtures", base);
  return existsSync(d) ? readdirSync(d).map((n) => join(d, n)).filter((p) => existsSync(join(p, "expected.json"))) : [];
});
const PRESETS = { "legacy-compat": LEGACY_PRESET, house: HOUSE_PRESET };
for (const fixture of FIXTURE_DIRS) {
  const expected = JSON.parse(readFileSync(join(fixture, "expected.json"), "utf8"));
  if (!expected.verdicts) continue; // another command's fixture
  test(`fixture ${fixture.slice(REPO.length + 1)}${expected.why ? `: ${expected.why}` : ""}`, async () => {
    const r = await preflight(fixture, { preset: expected.preset ? PRESETS[expected.preset] : null });
    for (const [id, v] of Object.entries(expected.verdicts)) assert.equal(r.verdict(id), v, `${id}: ${r.by[id]?.message}`);
    for (const [id, texts] of Object.entries(expected.details ?? {})) for (const t of texts) assert.ok(r.by[id].details.some((d) => d.text === t || d.file === t), `${id} detail ${t} in ${JSON.stringify(r.by[id].details)}`);
    for (const [id, texts] of Object.entries(expected.notDetails ?? {})) for (const t of texts) assert.ok(!r.by[id].details.some((d) => d.text === t || d.file === t), `${id} must not detail ${t}`);
    const unexpectedFails = r.fails.filter((id) => expected.verdicts[id] !== "FAIL");
    assert.deepEqual(unexpectedFails, [], `unexpected FAILs: ${unexpectedFails.map((id) => `${id}: ${r.by[id].message}`).join(" | ")}`);
    if (expected.noFail) assert.deepEqual(r.fails, []);
    if (expected.noWarn) assert.deepEqual(r.warns, []);
  });
}

test("fixture directories carry no /Users/ path and no real-looking video id", () => {
  for (const fixture of FIXTURE_DIRS) {
    for (const f of readdirSync(fixture, { recursive: true, withFileTypes: true })) {
      if (!f.isFile()) continue;
      const p = join(f.parentPath ?? f.path, f.name);
      if (/\.png$/.test(p)) continue;
      const text = readFileSync(p, "utf8");
      assert.ok(!/\/Users\//.test(text) || /agents-md-stale/.test(p), `${p} contains /Users/`);
    }
  }
});

test("N2 (gate): comment delimiters inside code are inert, so a rendered image between them is still checked", async () => {
  await withTempDir(async (dir) => {
    const inline = await preflight(makeExt(join(dir, "inline"), { files: { "README.md": "# C\n\nOpen with `<!--` and close with `-->`.\n\n![Hidden](metadata/good-1.png)\n" } }));
    assert.equal(inline.verdict("readme-assets"), "FAIL", JSON.stringify(inline.by["readme-assets"]));
    assert.deepEqual(inline.by["readme-assets"].details.map((d) => d.line), [5]);
    const fenced = await preflight(makeExt(join(dir, "fenced"), { files: { "README.md": "# C\n\n```html\n<!--\n```\n\n![Hidden](metadata/good-1.png)\n\n```html\n-->\n```\n" } }));
    assert.equal(fenced.verdict("readme-assets"), "FAIL", JSON.stringify(fenced.by["readme-assets"]));
    assert.deepEqual(fenced.by["readme-assets"].details.map((d) => d.line), [7]);
  });
});

test("N3 (gate): --published outside the cache on a machine with no cache runs clean and creates no cache directory", async () => {
  await withTempDir(async (dir) => {
    const prevXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    try {
      const r = await preflight(makeExt(join(dir, "local")), { published: makeExt(join(dir, "elsewhere")) });
      assert.equal(r.code, 0, r.stdout);
      assert.ok(!existsSync(join(dir, "cache")), "a read-only command must not create the cache directory");
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prevXdg;
    }
  });
});

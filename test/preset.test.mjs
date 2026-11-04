// rx preset check | table (plan 4.16): schema, duplicate ids, anchors, binding registries,
// severity downgrades, and the generated matrix region.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _setEslintPlugin } from "../src/commands/preset.mjs";
import { validate } from "../src/preset/schema.mjs";
import { loadSchema } from "../src/preset/load.mjs";
import { evaluate, render } from "../src/preset/applies.mjs";
import { fakeExtension, rx, withTempDir } from "./helpers.mjs";
import { CHRIS_PRESET, HOUSE_PRESET, LEGACY_PRESET } from "./preflight-helpers.mjs";

const by = (/** @type {any} */ r) => Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));

/** Write a preset variant and its anchors file into dir. @param {string} dir @param {(p: any) => void} mutate */
function variant(dir, mutate, base = HOUSE_PRESET) {
  const p = JSON.parse(readFileSync(base, "utf8"));
  mutate(p);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(base, "..", "house-anchors.md"), join(dir, "house-anchors.md"));
  copyFileSync(join(base, "..", "legacy-anchors.md"), join(dir, "legacy-anchors.md"));
  const file = join(dir, "preset.json");
  writeFileSync(file, JSON.stringify(p, null, 2));
  return file;
}

test("preset check passes on the house test preset and on the legacy compatibility preset", async () => {
  for (const file of [HOUSE_PRESET, LEGACY_PRESET]) {
    const r = await rx(["preset", "check", file, "--json"]);
    assert.equal(r.code, 0, r.stdout);
    const b = by(r);
    for (const id of ["preset-schema", "preset-ids", "preset-anchors", "preset-bindings", "preset-severity"]) assert.equal(b[id].verdict, "PASS", `${id}: ${b[id].message}`);
  }
});

test("preset check passes on chrismessina.json (Phase 3 Done-when)", { skip: !existsSync(CHRIS_PRESET) && "worktree preset not present" }, async () => {
  const r = await rx(["preset", "check", CHRIS_PRESET, "--json"]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.data.rules, 56); // 51 house-style rules, 4 Greptile-anchored preset-class checks, the 11.1 AGENTS.md contract
});

test("preset check fails on a planted duplicate id (Phase 3 Done-when)", async () => {
  await withTempDir(async (dir) => {
    const file = variant(dir, (p) => p.rules.push({ ...p.rules[0] }));
    const r = await rx(["preset", "check", file, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(by(r)["preset-ids"].verdict, "FAIL");
    assert.match(by(r)["preset-ids"].message, /duplicate rule id: prettierrc/);
  });
});

test("preset check: an unknown field, an unknown applicability condition and a missing required option are schema FAILs with paths", async () => {
  await withTempDir(async (dir) => {
    const unknownField = variant(join(dir, "a"), (p) => { p.rules[0].shade = "red"; });
    let r = await rx(["preset", "check", unknownField, "--json"]);
    assert.equal(by(r)["preset-schema"].verdict, "FAIL");
    assert.ok(by(r)["preset-schema"].details.some((d) => /rules\[0\]\.shade: unknown property/.test(d.text)), JSON.stringify(by(r)["preset-schema"].details));
    assert.equal(by(r)["preset-ids"].verdict, "N/A");
    const unknownCond = variant(join(dir, "b"), (p) => { p.rules[0].applies = { isFork: true }; });
    r = await rx(["preset", "check", unknownCond, "--json"]);
    assert.equal(by(r)["preset-schema"].verdict, "FAIL");
    const noOptions = variant(join(dir, "c"), (p) => { delete p.rules[0].bindings[0].options; });
    r = await rx(["preset", "check", noOptions, "--json"]);
    assert.equal(by(r)["preset-schema"].verdict, "FAIL");
    assert.ok(by(r)["preset-schema"].details.some((d) => /options/.test(d.text)));
    const strayOptions = variant(join(dir, "d"), (p) => { p.rules[1].bindings[0].options = { max: 1 }; });
    r = await rx(["preset", "check", strayOptions, "--json"]);
    assert.equal(by(r)["preset-schema"].verdict, "FAIL", "options on a check that takes none");
  });
});

test("preset check: an unresolved anchor, a bindingless non-build rule, an unknown rx check and an unknown judgment each FAIL their check", async () => {
  await withTempDir(async (dir) => {
    const file = variant(dir, (p) => {
      p.rules[0].anchor = "house-anchors.md#nowhere";
      p.rules[1].bindings = [];
      p.rules[2].bindings.push({ kind: "rx", check: "no-such-check", coverage: "full" });
      p.rules[3].bindings.push({ kind: "judgment", check: "unlisted", coverage: "full" });
    });
    const r = await rx(["preset", "check", file, "--json"]);
    const b = by(r);
    assert.equal(b["preset-anchors"].verdict, "FAIL");
    assert.equal(b["preset-bindings"].verdict, "FAIL");
    const texts = b["preset-bindings"].details.map((d) => d.text).join("\n");
    assert.match(texts, /no-hand-preferences: a lint rule has no binding/);
    assert.match(texts, /"no-such-check" is not in rx commands --json/);
    assert.match(texts, /"unlisted" is neither/);
  });
});

test("preset check: a judgment binding declared in judgments[] resolves", async () => {
  await withTempDir(async (dir) => {
    const file = variant(dir, (p) => {
      p.judgments = [{ id: "by-eye", question: "Does it look right?" }];
      p.rules[2].bindings.push({ kind: "judgment", check: "by-eye", coverage: "partial" });
    });
    const r = await rx(["preset", "check", file, "--json"]);
    assert.equal(by(r)["preset-bindings"].verdict, "PASS", by(r)["preset-bindings"].message);
  });
});

test("preset check: a report rule binding a core check that FAILs is a severity downgrade; binding a WARN-level or preset-class check is not", async () => {
  await withTempDir(async (dir) => {
    const bad = variant(join(dir, "a"), (p) => { p.rules[1].bindings.push({ kind: "rx", check: "schema", coverage: "full" }); });
    let r = await rx(["preset", "check", bad, "--json"]);
    assert.equal(by(r)["preset-severity"].verdict, "FAIL");
    assert.match(by(r)["preset-severity"].details[0].text, /binds core check schema/);
    const ok = variant(join(dir, "b"), (p) => { p.rules[1].bindings.push({ kind: "rx", check: "favicon", coverage: "partial" }); });
    r = await rx(["preset", "check", ok, "--json"]);
    assert.equal(by(r)["preset-severity"].verdict, "PASS");
  });
});

test("preset check: eslint bindings validate against eslint-plugin/index.mjs; an unloadable registry the preset needs is ERROR preset-bindings; no eslint bindings → registry not consulted", async () => {
  await withTempDir(async (dir) => {
    const file = variant(dir, (p) => { p.rules[2].bindings.push({ kind: "eslint", check: "copy-error-pairing", coverage: "partial" }); });
    const plugin = join(import.meta.dirname, "..", "eslint-plugin", "index.mjs");
    assert.ok(existsSync(plugin), "Agent E's plugin is expected to exist");
    let r = await rx(["preset", "check", file, "--json"]);
    assert.equal(by(r)["preset-bindings"].verdict, "PASS", by(r)["preset-bindings"].message);
    assert.equal(r.json.data.eslintRegistry, "present");
    const bogus = variant(join(dir, "b"), (p) => { p.rules[2].bindings.push({ kind: "eslint", check: "no-such-rule", coverage: "partial" }); });
    r = await rx(["preset", "check", bogus, "--json"]);
    assert.equal(by(r)["preset-bindings"].verdict, "FAIL");
    assert.match(by(r)["preset-bindings"].details[0].text, /"no-such-rule" is not in eslint-plugin/);
    // Registry missing while the preset has eslint bindings: ERROR, exit 2, not a pass.
    _setEslintPlugin(join(dir, "missing-plugin.mjs"));
    try {
      r = await rx(["preset", "check", file, "--json"]);
      assert.equal(r.code, 2);
      assert.equal(r.json.results.at(-1).id, "preset-bindings");
      assert.equal(r.json.results.at(-1).verdict, "ERROR");
      assert.match(r.json.results.at(-1).message, /ESLint plugin registry .* is not present/);
      // A registry that loads but exports no rules is the same error.
      writeFileSync(join(dir, "broken.mjs"), "export default 42;\n");
      _setEslintPlugin(join(dir, "broken.mjs"));
      r = await rx(["preset", "check", file, "--json"]);
      assert.equal(r.code, 2);
      assert.match(r.json.results.at(-1).message, /failed to load/);
      // Without eslint bindings the registry is not needed, so its absence is fine.
      _setEslintPlugin(join(dir, "missing-plugin.mjs"));
      r = await rx(["preset", "check", HOUSE_PRESET, "--json"]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.json.data.eslintRegistry, "not needed");
    } finally {
      _setEslintPlugin(plugin);
    }
  });
});

test("preset check: capability comes from the registry's levels: a report rule may bind an advisory check (api-currency, api-floor-manifest) but not one that can FAIL (api-floor-lockfile), and a check with no declared levels is assumed able to FAIL", async () => {
  await withTempDir(async (dir) => {
    const commands = (await rx(["commands", "--json"])).json.data.commands;
    const preflight = commands.find((c) => c.name === "preflight");
    assert.deepEqual(preflight.checks.schema.levels, ["PASS", "FAIL", "WARN", "N/A"], "preflight publishes its catalog levels");
    assert.deepEqual(commands.find((c) => c.name === "api-floor").checks["api-currency"].levels, ["PASS", "WARN", "N/A"]);
    const ok = variant(join(dir, "a"), (p) => { p.rules[1].bindings.push({ kind: "rx", check: "api-currency", coverage: "full" }, { kind: "rx", check: "api-floor-manifest", coverage: "full" }); });
    let r = await rx(["preset", "check", ok, "--json"]);
    assert.equal(by(r)["preset-severity"].verdict, "PASS", by(r)["preset-severity"].message);
    const bad = variant(join(dir, "b"), (p) => { p.rules[1].bindings.push({ kind: "rx", check: "api-floor-lockfile", coverage: "full" }); });
    r = await rx(["preset", "check", bad, "--json"]);
    assert.equal(by(r)["preset-severity"].verdict, "FAIL");
    assert.match(by(r)["preset-severity"].details[0].text, /api-floor-lockfile.*FAILs on its own/);
    // N2: a check of another command that declares no levels is assumed able to FAIL, and the
    // message names the declaration that would allow the binding.
    const allChecks = Object.fromEntries(commands.flatMap((c) => [...Object.entries(c.checks), ...Object.values(c.subcommands).flatMap((s) => Object.entries(s.checks))]));
    const undeclared = Object.keys(allChecks).find((id) => !id.endsWith("*") && typeof allChecks[id] === "string" && !(id in preflight.checks));
    assert.ok(undeclared, "some command still declares a check as a bare description");
    const assumed = variant(join(dir, "c"), (p) => { p.rules[1].bindings.push({ kind: "rx", check: undeclared, coverage: "partial" }); });
    r = await rx(["preset", "check", assumed, "--json"]);
    assert.equal(by(r)["preset-severity"].verdict, "FAIL", by(r)["preset-severity"].message);
    assert.match(by(r)["preset-severity"].details[0].text, new RegExp(`declares no \`levels\`.*checks\\["${undeclared}"\\] = \\{ description, levels:`));
  });
});

test("preset table: duplicate, nested or reversed markers are ERROR preset-table and nothing is written; a symlinked destination inside an extension is refused", async () => {
  await withTempDir(async (dir) => {
    const file = variant(join(dir, "p"), () => {});
    const cases = {
      "dup-start.md": "# x\n<!-- rx:matrix:start -->\nkeep me\n<!-- rx:matrix:start -->\nold\n<!-- rx:matrix:end -->\n",
      "dup-end.md": "# x\n<!-- rx:matrix:start -->\nold\n<!-- rx:matrix:end -->\nkeep me\n<!-- rx:matrix:end -->\n",
      "reversed.md": "# x\n<!-- rx:matrix:end -->\nold\n<!-- rx:matrix:start -->\n",
    };
    for (const [name, text] of Object.entries(cases)) {
      const into = join(dir, name);
      writeFileSync(into, text);
      const r = await rx(["preset", "table", file, "--into", into, "--json"]);
      assert.equal(r.code, 2, name);
      assert.equal(r.json.results[0].id, "preset-table", name);
      assert.equal(readFileSync(into, "utf8"), text, `${name} was written`);
    }
    const ext = fakeExtension(dir, "ext");
    writeFileSync(join(ext, "ref.md"), "<!-- rx:matrix:start -->\n<!-- rx:matrix:end -->\n");
    const link = join(dir, "outside.md");
    symlinkSync(join(ext, "ref.md"), link);
    const r = await rx(["preset", "table", file, "--into", link, "--json"]);
    assert.equal(r.code, 2);
    assert.match(r.json.results[0].message, /inside the extension/);
    assert.equal(readFileSync(join(ext, "ref.md"), "utf8"), "<!-- rx:matrix:start -->\n<!-- rx:matrix:end -->\n");
  });
});

test("preset check: unreadable file is ERROR input; bad JSON too; missing positional is ERROR args", async () => {
  await withTempDir(async (dir) => {
    let r = await rx(["preset", "check", join(dir, "nope.json"), "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "input");
    writeFileSync(join(dir, "bad.json"), "{");
    r = await rx(["preset", "check", join(dir, "bad.json"), "--json"]);
    assert.equal(r.code, 2);
    r = await rx(["preset", "check", "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "args");
  });
});

test("preset table: regenerates the region (non-build rules anchored in --into, sorted by anchor order, Rule column kept); --check detects drift; markers missing is ERROR", async () => {
  await withTempDir(async (dir) => {
    const file = variant(dir, () => {});
    const into = join(dir, "house-anchors.md");
    let r = await rx(["preset", "table", file, "--into", into, "--check", "--json"]);
    assert.equal(r.code, 1, "stale region");
    assert.equal(by(r)["preset-table"].verdict, "FAIL");
    r = await rx(["preset", "table", file, "--into", into, "--json"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.data.changed, true);
    const text = readFileSync(into, "utf8");
    const region = text.slice(text.indexOf("<!-- rx:matrix:start -->"), text.indexOf("<!-- rx:matrix:end -->"));
    const rows = region.split("\n").filter((l) => l.startsWith("| Test"));
    assert.equal(rows.length, 11, region); // 12 rules minus the build-only one
    assert.match(region, /^\| Rule \| ID \| Tag \| Applies \| Severity \| Binding \|$/m);
    assert.match(region, /\| `logger` \| `both` \| self-authored, makes web requests \| \*\*block\*\* \| rx `logger` \|/);
    assert.match(region, /\| `pref-description-length` \| `both` \| all \| \*\*report\*\* \| rx `pref-description-length`; rx `pref-label-length` \|/);
    assert.ok(!/build-only-rule/.test(region), "build rules have no row");
    assert.ok(region.indexOf("`prettierrc`") < region.indexOf("`logger`"), "file order of anchors");
    assert.ok(text.startsWith("# Test house style"), "text outside the region is untouched");
    r = await rx(["preset", "table", file, "--into", into, "--check", "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.data.changed, false);
    r = await rx(["preset", "table", file, "--into", into, "--json"]);
    assert.equal(r.json.data.changed, false, "idempotent");
    writeFileSync(join(dir, "nomarkers.md"), "# none\n");
    r = await rx(["preset", "table", file, "--into", join(dir, "nomarkers.md"), "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "preset-table");
  });
});

test("preset table refuses a destination inside an extension root", async () => {
  await withTempDir(async (dir) => {
    const file = variant(join(dir, "p"), () => {});
    const ext = fakeExtension(dir, "ext");
    writeFileSync(join(ext, "ref.md"), "<!-- rx:matrix:start -->\n<!-- rx:matrix:end -->\n");
    const r = await rx(["preset", "table", file, "--into", join(ext, "ref.md"), "--json"]);
    assert.equal(r.code, 2);
    assert.match(r.json.results[0].message, /inside the extension/);
  });
});

test("preset table on chrismessina.json against a copy of house-style.md writes 42 rows in heading order and leaves the rest of the file alone", { skip: !existsSync(CHRIS_PRESET) && "worktree preset not present" }, async () => {
  await withTempDir(async (dir) => {
    const refDir = join(dir, "plugins", "raycast-extensions", "reference");
    const presetDir = join(dir, "plugins", "raycast-extensions", "presets");
    mkdirSync(refDir, { recursive: true });
    mkdirSync(presetDir, { recursive: true });
    const srcRef = join(CHRIS_PRESET, "..", "..", "reference");
    const original = readFileSync(join(srcRef, "house-style.md"), "utf8");
    // Since Wave 4 the live file carries the marker pair around its generated matrix; the copy is written as-is,
    // and the parts outside the region must survive the rewrite byte for byte.
    const tableStart = original.indexOf("<!-- rx:matrix:start -->");
    const tableEnd = original.indexOf("<!-- rx:matrix:end -->", tableStart);
    assert.ok(tableStart !== -1 && tableEnd !== -1, "the live house-style.md carries one matrix marker pair");
    writeFileSync(join(refDir, "house-style.md"), original);
    copyFileSync(join(srcRef, "greptile-rules.md"), join(refDir, "greptile-rules.md"));
    copyFileSync(CHRIS_PRESET, join(presetDir, "chrismessina.json"));
    const r = await rx(["preset", "table", join(presetDir, "chrismessina.json"), "--into", join(refDir, "house-style.md"), "--json"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.data.rows, 42);
    const text = readFileSync(join(refDir, "house-style.md"), "utf8");
    assert.ok(text.startsWith(original.slice(0, tableStart)));
    assert.ok(text.endsWith(original.slice(tableEnd)));
    assert.match(text, /\| `prettierrc` \| `both` \| self-authored \| \*\*block\*\* \| rx `prettierrc` \(partial\); judgment `prettierrc` \(partial\) \|/);
    assert.ok(!text.includes("| `manifest-title-case` |"), "rules anchored in greptile-rules.md are not rows of house-style's table");
  });
});

test("schema validator unit: type, const, enum, pattern, required, nested $ref and anyOf error reporting", () => {
  const schema = loadSchema();
  assert.deepEqual(validate({ schema: 1, owner: "x", rules: [] }, schema), []);
  const errs = validate({ schema: 2, owner: "-bad-", rules: [{}] }, schema);
  assert.ok(errs.some((e) => e.path === "$.schema"));
  assert.ok(errs.some((e) => e.path === "$.owner"));
  assert.ok(errs.some((e) => e.path === "$.rules[0]" && /missing required property/.test(e.message)));
  const applies = { all: [{ selfAuthored: true }, { dependency: { name: "x", minVersion: "1.2.3" } }, { not: { manual: "t" } }] };
  assert.equal(validate(applies, { ...schema, $ref: "#/$defs/applies" }).length, 0);
  assert.ok(validate({ dependency: { name: "x", minVersion: "1.2" } }, { ...schema, $ref: "#/$defs/applies" }).length > 0);
});

test("applicability evaluator unit: three-valued all/any/not, dependency floors, rendering", () => {
  /** @type {import("../src/preset/applies.mjs").ApplyContext} */
  const ctx = { selfAuthored: true, platforms: ["macOS"], published: null, webRequests: false, preferences: ["verboseLogging"], resolved: (n) => (n === "lg" ? "1.4.0" : null), commandModes: ["view", "no-view"], declaresInterval: false, writesFiles: true, callsAI: false };
  assert.equal(evaluate(true, ctx).value, true);
  assert.equal(evaluate({ all: [{ selfAuthored: true }, { webRequests: true }] }, ctx).value, false);
  assert.equal(evaluate({ all: [{ selfAuthored: true }, { published: true }] }, ctx).value, "unknown");
  assert.equal(evaluate({ any: [{ webRequests: true }, { published: true }] }, ctx).value, "unknown");
  assert.equal(evaluate({ any: [{ webRequests: true }, { writesFiles: true }] }, ctx).value, true);
  assert.equal(evaluate({ not: { published: true } }, ctx).value, "unknown");
  assert.equal(evaluate({ not: { callsAI: true } }, ctx).value, true);
  assert.equal(evaluate({ dependency: { name: "lg", minVersion: "1.5.0" } }, ctx).value, false);
  assert.equal(evaluate({ dependency: { name: "lg" } }, ctx).value, true);
  assert.equal(evaluate({ dependency: { name: "zz" } }, ctx).value, false);
  assert.equal(evaluate({ commandMode: "menu-bar" }, ctx).value, false);
  assert.equal(evaluate({ platform: "Windows" }, ctx).value, false);
  assert.equal(evaluate({ manual: "exports CSV" }, ctx).value, "unknown");
  assert.equal(render({ all: [{ selfAuthored: true }, { dependency: { name: "lg", minVersion: "1.5.0" } }] }), "self-authored, installed `lg` ≥ 1.5.0");
  assert.equal(render({ any: [{ commandMode: "no-view" }, { manual: "exports CSV" }] }), "a `no-view` command or exports CSV");
});

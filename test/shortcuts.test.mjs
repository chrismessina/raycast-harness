import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, fakeExtension, rx, rxProcess, withTempDir } from "./helpers.mjs";
import { _setRuntimePaths } from "../src/commands/shortcuts.mjs";
import { blankComments, declaredPlatforms, exclusive, parseShortcutLiteral, scanExtension, scanSource, scanText } from "../src/shortcuts/scan.mjs";
import { loadTypeScript } from "../src/typescript.mjs";
import { extractCommonTable, fingerprintShim, formatBinding, loadTable, normalizeBinding, reservedMatch } from "../src/shortcuts/table.mjs";

const FIX = join(REPO, "test", "fixtures", "shortcuts");
const TABLE = join(FIX, "table-2.10.1.0.json");
const SHIM = join(FIX, "shim", "index.js");
const PLIST = join(FIX, "shim", "Info.plist");

/** @param {{ id: string, verdict: string, message: string, details: { file?: string, line?: number, text: string }[] }[]} results */
const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));

/** Run with the cross-repo cache pointed at a temp dir and the shim/plist at `paths`. */
async function withRuntime(paths, fn) {
  return withTempDir(async (dir) => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "xdg");
    _setRuntimePaths(paths);
    try {
      return await fn(dir);
    } finally {
      _setRuntimePaths();
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
}

// ---- fixtures vs expected.json -------------------------------------------------------------

for (const name of readdirSync(FIX).filter((n) => existsSync(join(FIX, n, "expected.json")))) {
  test(`fixture ${name} matches expected.json`, async () => {
    const expected = JSON.parse(readFileSync(join(FIX, name, "expected.json"), "utf8"));
    // expected.command carries the table path relative to the repo; the no-shortcut fixture needs none
    const argv = expected.command.map((a) => (a.startsWith("test/") ? join(REPO, a) : a));
    const r = await rx([...argv, "--root", join(FIX, name), "--json"]);
    assert.ok(r.json, `no JSON envelope: ${r.stdout}\n${r.stderr}`);
    const got = Object.fromEntries(r.json.results.map((x) => [x.id, x.verdict]));
    // several FAIL lines share one id; expected names one verdict per id
    const collapsed = {};
    for (const x of r.json.results) collapsed[x.id] = collapsed[x.id] === "FAIL" ? "FAIL" : x.verdict;
    assert.deepEqual(collapsed, expected.verdicts, JSON.stringify(got));
    assert.equal(r.code, expected.exit);
    if (expected.conflicts !== undefined) assert.equal(r.json.data.conflicts.length, expected.conflicts, JSON.stringify(r.json.data.conflicts));
    if (expected.reserved !== undefined) assert.equal(r.json.data.reserved.length, expected.reserved);
    if (expected.declared !== undefined) assert.equal(r.json.data.declared, expected.declared);
    if (expected.unresolved !== undefined) assert.equal(r.json.data.unresolved.length, expected.unresolved);
    if (expected.conflictPlatforms) assert.deepEqual(r.json.data.conflicts[0].platforms, expected.conflictPlatforms);
  });
}

test("collision fixture: one FAIL per pair, each with both sites as file:line details", async () => {
  const r = await rx(["shortcuts", "check", "--root", join(FIX, "collision"), "--table", TABLE, "--json"]);
  const fails = r.json.results.filter((x) => x.id === "shortcut-ambiguous");
  assert.equal(fails.length, 4);
  for (const f of fails) {
    assert.equal(f.details.length, 2);
    assert.ok(f.details.every((d) => d.file === "src/index.tsx" && typeof d.line === "number"));
  }
  assert.match(fails[0].message, /"Copy as Markdown" and .* "Copy URL" both resolve to ⌘⇧C on macOS/);
  // the two "Copy as PNG" actions on opposite ternary sides are never paired
  assert.ok(!fails.some((f) => /Copy as PNG/.test(f.message)));
});

// ---- F4: unavailable runtime evidence is an ERROR, never an N/A ------------------------------

test("check: shortcuts declared and no shim on this machine → ERROR runtime evidence unavailable, exit 2", async () => {
  await withRuntime({ shim: join(FIX, "does-not-exist.js") }, async () => {
    const r = await rx(["shortcuts", "check", "--root", join(FIX, "collision"), "--json"]);
    assert.equal(r.code, 2);
    const t = byId(r.json.results)["shortcut-runtime-table"];
    assert.equal(t.verdict, "ERROR");
    assert.match(t.message, /^runtime evidence unavailable/);
    assert.ok(!r.json.results.some((x) => x.verdict === "N/A"), "no N/A may stand in for missing evidence");
    assert.equal(r.json.data.declared, 9);
    assert.match(t.message, /looked in .*does-not-exist\.js/);
  });
});

test("check: shortcuts arriving only by props spread still require the table (ERROR, not N/A) and are listed in data.unresolved before the early return", async () => {
  await withRuntime({ shim: join(FIX, "does-not-exist.js") }, async () => {
    const r = await rx(["shortcuts", "check", "--root", join(FIX, "spread"), "--json"]);
    assert.equal(r.code, 2);
    assert.equal(byId(r.json.results)["shortcut-runtime-table"].verdict, "ERROR");
    assert.equal(r.json.data.declared, 2);
    assert.deepEqual(r.json.data.unresolved.map((u) => [u.file, u.line, u.source]), [["src/index.tsx", 8, "<Action.CopyToClipboard {...copyProps} />"]]);
  });
});

test("runtime: --app points at a bundle; discovery message names both search locations when nothing is installed", async () => {
  await withRuntime({}, async (dir) => {
    const app = join(dir, "Raycast.app");
    mkdirSync(join(app, "Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources/api/node_modules/@raycast/api"), { recursive: true });
    writeFileSync(join(app, "Contents/Resources/macos-app_RaycastDesktopApp.bundle/Contents/Resources/api/node_modules/@raycast/api/index.js"), readFileSync(SHIM));
    writeFileSync(join(app, "Contents", "Info.plist"), readFileSync(PLIST));
    const r = await rx(["shortcuts", "runtime", "--app", app, "--json"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.data.appVersion, "2.10.1.0");
    assert.equal(r.json.data.shimFingerprint, fingerprintShim(SHIM));
    assert.equal(r.json.fingerprint, null);
    const missing = await rx(["shortcuts", "runtime", "--app", join(dir, "Nope.app"), "--json"]);
    assert.equal(missing.code, 2);
    assert.match(byId(missing.json.results)["shortcut-runtime-table"].message, /looked in .*Nope\.app/);
  });
});

test("runtime: with no override and no --app the search covers /Applications and ~/Applications", async () => {
  const { APP_CANDIDATES } = await import("../src/shortcuts/table.mjs");
  const list = APP_CANDIDATES();
  assert.equal(list.length, 2);
  assert.equal(list[0], "/Applications/Raycast.app");
  assert.match(list[1], /\/Applications\/Raycast\.app$/);
  assert.notEqual(list[1], list[0]);
});

test("check: shim present but no cached table for it → ERROR naming `rx shortcuts runtime`", async () => {
  await withRuntime({ shim: SHIM, plist: PLIST }, async () => {
    const r = await rx(["shortcuts", "check", "--root", join(FIX, "clean"), "--json"]);
    assert.equal(r.code, 2);
    const t = byId(r.json.results)["shortcut-runtime-table"];
    assert.equal(t.verdict, "ERROR");
    assert.match(t.message, /runtime evidence unavailable: .*run `rx shortcuts runtime`/);
  });
});

test("check: a cached table whose fingerprint is not the installed shim's → ERROR", async () => {
  await withRuntime({ shim: SHIM, plist: PLIST }, async (dir) => {
    const fp = fingerprintShim(SHIM);
    const cacheDir = join(dir, "xdg", "raycast-harness", "shortcuts");
    mkdirSync(cacheDir, { recursive: true });
    const stale = JSON.parse(readFileSync(TABLE, "utf8"));
    stale.shimFingerprint = "0".repeat(64);
    writeFileSync(join(cacheDir, `${fp}.json`), JSON.stringify(stale));
    const r = await rx(["shortcuts", "check", "--root", join(FIX, "clean"), "--json"]);
    assert.equal(r.code, 2);
    assert.match(byId(r.json.results)["shortcut-runtime-table"].message, /records shim 000000000000 but the installed app's shim is/);
  });
});

test("check: no shortcuts declared → N/A on all three ids with the reason, no table needed, exit 0", async () => {
  await withRuntime({ shim: join(FIX, "does-not-exist.js") }, async () => {
    const r = await rx(["shortcuts", "check", "--root", join(FIX, "none"), "--json"]);
    assert.equal(r.code, 0);
    for (const id of ["shortcut-runtime-table", "shortcut-ambiguous", "shortcut-reserved"]) {
      assert.equal(byId(r.json.results)[id].verdict, "N/A");
      assert.match(byId(r.json.results)[id].message, /declares no shortcuts/);
    }
  });
});

test("check: --table with a malformed file is ERROR shortcut-runtime-table", async () => {
  await withTempDir(async (dir) => {
    const bad = join(dir, "t.json");
    writeFileSync(bad, JSON.stringify({ appVersion: "x", shimFingerprint: "abc", shortcuts: { Copy: { macOS: { modifiers: ["cmd"], key: "c" } } } }));
    const r = await rx(["shortcuts", "check", "--root", join(FIX, "clean"), "--table", bad, "--json"]);
    assert.equal(r.code, 2);
    assert.equal(byId(r.json.results)["shortcut-runtime-table"].verdict, "ERROR");
    assert.match(byId(r.json.results)["shortcut-runtime-table"].message, /Common\.Copy\.Windows is not/);
  });
});

// ---- runtime extraction against the recorded shim ------------------------------------------

test("runtime: extracts 17 constants from the recorded shim, writes cache/shortcuts/<fingerprint>.json, then check uses it", async () => {
  await withRuntime({ shim: SHIM, plist: PLIST }, async (dir) => {
    const r = await rx(["shortcuts", "runtime", "--json"]);
    assert.equal(r.code, 0, r.stdout);
    const fp = fingerprintShim(SHIM);
    assert.equal(r.json.fingerprint, null, "the envelope fingerprint is reserved for gates/guard/audit; the shim hash is data");
    assert.equal(r.json.data.shimFingerprint, fp);
    assert.equal(r.json.data.count, 17);
    assert.equal(r.json.data.appVersion, "2.10.1.0");
    assert.equal(r.json.data.path, join(dir, "xdg", "raycast-harness", "shortcuts", `${fp}.json`));
    const written = JSON.parse(readFileSync(r.json.data.path, "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["appVersion", "shimFingerprint", "shortcuts"]);
    assert.deepEqual(written, JSON.parse(readFileSync(TABLE, "utf8")), "the recorded table fixture is exactly what runtime writes");
    assert.deepEqual(written.shortcuts.Duplicate, { macOS: { modifiers: ["cmd"], key: "d" }, Windows: { modifiers: ["ctrl", "shift"], key: "s" } });
    assert.deepEqual(written.shortcuts.Remove.macOS, { modifiers: ["ctrl"], key: "x" });

    const c = await rx(["shortcuts", "check", "--root", join(FIX, "clean"), "--json"]);
    assert.equal(c.code, 0, c.stdout);
    assert.equal(byId(c.json.results)["shortcut-runtime-table"].verdict, "PASS");
    assert.equal(c.json.data.table.shimFingerprint, fp);
    assert.equal(c.json.fingerprint, null);
  });
});

test("runtime: no shim → ERROR shortcut-runtime-table, exit 2", async () => {
  await withRuntime({ shim: join(FIX, "does-not-exist.js") }, async () => {
    const r = await rx(["shortcuts", "runtime", "--json"]);
    assert.equal(r.code, 2);
    const t = byId(r.json.results)["shortcut-runtime-table"];
    assert.equal(t.verdict, "ERROR");
    assert.match(t.message, /shim not found/);
  });
});

test("runtime: a shim with no Common table is ERROR, not an empty table", async () => {
  await withRuntime({}, async (dir) => {
    const shim = join(dir, "shim.js");
    writeFileSync(shim, "var x = { Copy: 1 };\n");
    _setRuntimePaths({ shim });
    const r = await rx(["shortcuts", "runtime", "--json"]);
    assert.equal(r.code, 2);
    assert.match(byId(r.json.results)["shortcut-runtime-table"].message, /no `<ident>\.Common=\{` table/);
  });
});

test("subcommand protocol: no subcommand, unknown subcommand and unknown flag are ERROR args, exit 2", async () => {
  for (const argv of [["shortcuts"], ["shortcuts", "bogus"], ["shortcuts", "check", "--tabel", "x"], ["shortcuts", "runtime", "--root", "."]]) {
    const r = await rxProcess([...argv, "--json"]);
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(JSON.parse(r.stdout).results[0].id, "args");
  }
});

test("rx commands --json lists shortcuts with both subcommands, their root rules and checks", async () => {
  const r = await rx(["commands", "--json"]);
  const cmd = r.json.data.commands.find((c) => c.name === "shortcuts");
  assert.ok(cmd);
  assert.equal(cmd.subcommands.runtime.root, "none");
  assert.equal(cmd.subcommands.check.root, "required");
  assert.deepEqual(Object.keys(cmd.subcommands.check.checks).sort(), ["shortcut-ambiguous", "shortcut-reserved", "shortcut-runtime-table"]);
  assert.deepEqual(Object.keys(cmd.subcommands.runtime.checks), ["shortcut-runtime-table"]);
  assert.ok("--table" in cmd.subcommands.check.flags);
});

// ---- table module ----------------------------------------------------------------------------

test("table: extraction does not pin the minified identifier, normalizes opt/alt and order, formats per platform", () => {
  const t = extractCommonTable('x;(Q=>(Q.Common={Save:{macOS:{modifiers:["cmd"],key:"s"},Windows:{modifiers:["ctrl"],key:"s"}}}))(y)');
  assert.deepEqual(Object.keys(t), ["Save"]);
  assert.equal(normalizeBinding({ modifiers: ["opt", "cmd"], key: "C" }), normalizeBinding({ modifiers: ["cmd", "alt"], key: "c" }));
  assert.notEqual(normalizeBinding({ modifiers: ["cmd"], key: "c" }), normalizeBinding({ modifiers: ["ctrl"], key: "c" }));
  assert.equal(formatBinding({ modifiers: ["cmd", "shift"], key: "arrowUp" }, "macOS"), "⌘⇧↑");
  assert.equal(formatBinding({ modifiers: ["ctrl", "alt"], key: "d" }, "Windows"), "ctrl+alt+d");
  assert.deepEqual(reservedMatch({ modifiers: ["shift", "cmd"], key: "enter" }, "Form"), { why: "the secondary action's default in a Form", certain: true });
  assert.equal(reservedMatch({ modifiers: ["cmd"], key: "k" }, "Form"), null);
  assert.equal(loadTable(TABLE).appVersion, "2.10.1.0");
  assert.throws(() => extractCommonTable('A.Common={Bad:{macOS:{modifiers:["hyper"],key:"s"},Windows:{modifiers:[],key:"s"}}}'), /Common\.Bad\.macOS is not/);
});

// ---- scanner ---------------------------------------------------------------------------------

test("scan: comments are blanked with offsets kept; a URL's // is not a comment", () => {
  const src = 'const a = "x // y"; // gone\n/* multi\nline */ const u = "https://r.com"; <T>see https://x.y</T>';
  const out = blankComments(src);
  assert.equal(out.length, src.length);
  assert.ok(out.includes('"x // y"'));
  assert.ok(!out.includes("gone") && !out.includes("multi"));
  assert.ok(out.includes("https://x.y"));
  assert.equal(out.split("\n").length, src.split("\n").length);
});

test("scan: literal forms, Common forms, platform objects, lowercase windows, unresolved expressions, type annotations", () => {
  assert.deepEqual(parseShortcutLiteral("{ modifiers: ['cmd', \"shift\"], key: 'c', }")?.bindings.macOS, { modifiers: ["cmd", "shift"], key: "c" });
  assert.equal(parseShortcutLiteral("{ macOS: { modifiers: ['cmd'], key: 'd' }, windows: { modifiers: ['ctrl'], key: 'd' } }")?.bindings.Windows?.key, "d");
  assert.equal(parseShortcutLiteral("{ modifiers: mods, key: 'c' }"), null);
  const groups = [];
  const found = scanSource(
    [
      "interface P { shortcut: Keyboard.Shortcut; other: number }",
      "const shortcut = pick();",
      "<ActionPanel>",
      '  <Action title="A" shortcut={Shortcut.Common.Copy} />',
      '  <Action title={"B"} shortcut={{ modifiers: ["cmd"], key: "b" }} />',
      '  <Action title="C" shortcut={cond ? x : y} />',
      "</ActionPanel>",
      'showToast({ primaryAction: { title: "T", shortcut: Keyboard.Shortcut.Common.Open } })',
    ].join("\n"),
    "f.tsx",
    groups,
  );
  assert.deepEqual(found.map((s) => [s.line, s.kind, s.title, s.name ?? null]), [
    [4, "common", "A", "Copy"],
    [5, "single", "B", null],
    [6, "unresolved", "C", null],
    [8, "common", "T", "Open"],
  ]);
  assert.equal(groups[found[0].group].kind, "panel");
  assert.equal(groups[found[3].group].kind, "toast");
  assert.equal(found[0].group, found[2].group);
});

test("scan: props spreads on actions and composed panel children are unresolved declarations; prop-nested elements and panel parts are not", () => {
  const groups = [];
  const found = scanSource(
    [
      "<ActionPanel>",
      '  <ActionPanel.Section title="S">',
      '    <Action.Push title="Push" target={<DetailView item={x} />} shortcut={{ modifiers: ["cmd"], key: "p" }} />',
      '    <Action.CopyToClipboard {...copyProps} />',
      "    <ItemActions item={x} />",
      "    <React.Fragment><Action title=\"Plain\" onAction={f} /></React.Fragment>",
      "  </ActionPanel.Section>",
      "</ActionPanel>",
      "<Action {...looseProps} />",
      "<Other {...notAnAction} />",
    ].join("\n"),
    "f.tsx",
    groups,
  );
  assert.deepEqual(found.map((s) => [s.line, s.kind]), [[3, "single"], [4, "unresolved"], [5, "unresolved"], [9, "unresolved"]]);
  assert.equal(found[0].source, '{ modifiers: ["cmd"], key: "p" }');
  assert.ok(found[1].source.startsWith("<Action.CopyToClipboard {...copyProps}"));
  assert.equal(found[2].source, "<ItemActions item={x} />");
  assert.equal(found[3].source, "<Action {...looseProps} />");
  assert.equal(groups[found[1].group].kind, "panel");
  assert.equal(groups[found[3].group].kind, "loose");
});

test("scan: a ternary inside a repeated render within the panel is not exclusive; one outside the repeat is", () => {
  const groups = [];
  const src = [
    "<ActionPanel>",
    "  {items.map((it) =>",
    '    it.a ? (<Action title="A" shortcut={Common.Copy} />) : (<Action title="B" shortcut={Common.Copy} />)',
    "  )}",
    "</ActionPanel>",
    "{rows.map((r) => (",
    "  <ActionPanel>",
    '    {r.a ? (<Action title="C" shortcut={Common.Copy} />) : (<Action title="D" shortcut={Common.Copy} />)}',
    "  </ActionPanel>",
    "))}",
    "<ActionPanel>",
    '  {for_ ? (<Action title="E" shortcut={Common.Copy} />) : (<Action title="F" shortcut={Common.Copy} />)}',
    "</ActionPanel>",
  ].join("\n");
  const found = scanSource(src, "f.tsx", groups);
  const by = Object.fromEntries(found.map((s) => [s.title, s]));
  assert.ok(!exclusive(by.A, by.B), "map inside the panel: both branches can co-render");
  const g2 = [];
  const other = scanSource(
    [
      "<ActionPanel>",
      '  {Array.from(items, (it) => it.a ? (<Action title="G" shortcut={Common.Copy} />) : (<Action title="H" shortcut={Common.Copy} />))}',
      '  {render(function (it) { return it.a ? (<Action title="I" shortcut={Common.Copy} />) : (<Action title="J" shortcut={Common.Copy} />); })}',
      '  {(() => { for (const it of items) { out.push(it.a ? (<Action title="K" shortcut={Common.Copy} />) : (<Action title="L" shortcut={Common.Copy} />)); } return out; })()}',
      "</ActionPanel>",
    ].join("\n"),
    "g.tsx",
    g2,
  );
  const by2 = Object.fromEntries(other.map((s) => [s.title, s]));
  assert.ok(!exclusive(by2.G, by2.H), "Array.from mapper: a callback body withholds exclusivity");
  assert.ok(!exclusive(by2.I, by2.J), "an unknown helper's function callback withholds exclusivity");
  assert.ok(!exclusive(by2.K, by2.L), "a for body withholds exclusivity");
  assert.ok(exclusive(by.C, by.D), "map outside the panel: one panel per item, ternary evaluated once");
  assert.ok(exclusive(by.E, by.F));
});

test("scan: nested panels, self-closing panels, and ternary exclusivity", () => {
  const groups = [];
  const found = scanSource(
    [
      "<ActionPanel />",
      "<ActionPanel>",
      "  {a ? (",
      '    <Action title="X" shortcut={{ modifiers: ["cmd"], key: "x" }} />',
      "  ) : (",
      '    <Action title="Y" shortcut={{ modifiers: ["cmd"], key: "x" }} />',
      "  )}",
      '  {b && <Action title="Z" shortcut={{ modifiers: ["cmd"], key: "x" }} />}',
      "</ActionPanel>",
      '<Action title="Loose" shortcut={{ modifiers: ["cmd"], key: "x" }} />',
    ].join("\n"),
    "f.tsx",
    groups,
  );
  assert.equal(groups.filter((g) => g.kind === "panel").length, 1, "the self-closing panel has no children and is not a group");
  assert.deepEqual(found.map((s) => s.title), ["X", "Y", "Z", "Loose"]);
  assert.ok(exclusive(found[0], found[1]));
  assert.ok(!exclusive(found[0], found[2]) && !exclusive(found[1], found[2]));
  assert.equal(groups[found[3].group].kind, "loose");
});

test("declaredPlatforms: absent → macOS only; both → both; unknown names ignored", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(declaredPlatforms(fakeExtension(dir, "a")), ["macOS"]);
    assert.deepEqual(declaredPlatforms(fakeExtension(dir, "b", { platforms: ["macOS", "Windows"] })), ["macOS", "Windows"]);
    assert.deepEqual(declaredPlatforms(fakeExtension(dir, "c", { platforms: ["Linux"] })), ["macOS"]);
    assert.deepEqual(declaredPlatforms(fakeExtension(dir, "d", { platforms: ["Windows"] })), ["Windows"]);
  });
});

// ---- The parser path (src/shortcuts/ast-scan.mjs), with rx's own typescript -------------------

const TS = loadTypeScript(REPO);

test("parser scan: the same literal forms, Common forms, platform objects, unresolved expressions and type annotations as the text scan", () => {
  assert.ok(TS, "rx's own typescript devDependency loads");
  const groups = [];
  const found = scanSource(
    [
      "interface P { shortcut: Keyboard.Shortcut; other: number }",
      "const shortcut = pick();",
      "export const v = (<ActionPanel>",
      '  <Action title="A" shortcut={Shortcut.Common.Copy} />',
      '  <Action title={"B"} shortcut={{ modifiers: ["cmd"], key: "b" }} />',
      '  <Action title="C" shortcut={cond ? x : y} />',
      "</ActionPanel>);",
      'showToast({ primaryAction: { title: "T", shortcut: Keyboard.Shortcut.Common.Open } });',
      'export const w = { title: "W", shortcut: { macOS: { modifiers: ["cmd"], key: "d" }, windows: { modifiers: ["ctrl"], key: "d" } } };',
    ].join("\n"),
    "f.tsx",
    groups,
    TS,
  );
  assert.deepEqual(found.map((s) => [s.line, s.kind, s.title, s.name ?? null]), [
    [4, "common", "A", "Copy"],
    [5, "single", "B", null],
    [6, "unresolved", "C", null],
    [8, "common", "T", "Open"],
    [9, "platform", "W", null],
  ]);
  assert.equal(found[4].bindings.Windows?.key, "d");
  assert.equal(groups[found[0].group].kind, "panel");
  assert.equal(groups[found[3].group].kind, "toast");
  assert.equal(groups[found[4].group].kind, "loose");
  assert.equal(found[0].group, found[2].group);
});

test("parser scan: props spreads on actions and composed panel children are unresolved declarations; prop-nested elements and panel parts are not", () => {
  const groups = [];
  const found = scanSource(
    [
      "export const a = (<ActionPanel>",
      '  <ActionPanel.Section title="S">',
      '    <Action.Push title="Push" target={<DetailView item={x} />} shortcut={{ modifiers: ["cmd"], key: "p" }} />',
      "    <Action.CopyToClipboard {...copyProps} />",
      "    <ItemActions item={x} />",
      '    <React.Fragment><Action title="Plain" onAction={f} /></React.Fragment>',
      "  </ActionPanel.Section>",
      "</ActionPanel>);",
      "export const b = <Action {...looseProps} />;",
      "export const c = <Other {...notAnAction} />;",
    ].join("\n"),
    "f.tsx",
    groups,
    TS,
  );
  assert.deepEqual(found.map((s) => [s.line, s.kind]), [[3, "single"], [4, "unresolved"], [5, "unresolved"], [9, "unresolved"]]);
  assert.equal(found[0].source, '{ modifiers: ["cmd"], key: "p" }');
  assert.equal(found[1].source, "<Action.CopyToClipboard {...copyProps} />");
  assert.equal(found[2].source, "<ItemActions item={x} />");
  assert.equal(found[3].source, "<Action {...looseProps} />");
  assert.equal(groups[found[1].group].kind, "panel");
  assert.equal(groups[found[3].group].kind, "loose");
});

test("parser scan: ternary exclusivity, repeated renders, nested and self-closing panels", () => {
  const wrap = (/** @type {string[]} */ lines) => ["export const v = (<>", ...lines, "</>);"].join("\n");
  const g1 = [];
  const found = scanSource(
    wrap([
      "<ActionPanel>",
      "  {items.map((it) =>",
      '    it.a ? (<Action title="A" shortcut={Common.Copy} />) : (<Action title="B" shortcut={Common.Copy} />)',
      "  )}",
      "</ActionPanel>",
      "{rows.map((r) => (",
      "  <ActionPanel>",
      '    {r.a ? (<Action title="C" shortcut={Common.Copy} />) : (<Action title="D" shortcut={Common.Copy} />)}',
      "  </ActionPanel>",
      "))}",
      "<ActionPanel>",
      '  {for_ ? (<Action title="E" shortcut={Common.Copy} />) : (<Action title="F" shortcut={Common.Copy} />)}',
      "</ActionPanel>",
      "<ActionPanel>",
      '  {Array.from(items, (it) => it.a ? (<Action title="G" shortcut={Common.Copy} />) : (<Action title="H" shortcut={Common.Copy} />))}',
      '  {render(function (it) { return it.a ? (<Action title="I" shortcut={Common.Copy} />) : (<Action title="J" shortcut={Common.Copy} />); })}',
      '  {(() => { for (const it of items) { out.push(it.a ? (<Action title="K" shortcut={Common.Copy} />) : (<Action title="L" shortcut={Common.Copy} />)); } return out; })()}',
      "</ActionPanel>",
    ]),
    "f.tsx",
    g1,
    TS,
  );
  const by = Object.fromEntries(found.map((s) => [s.title, s]));
  assert.ok(!exclusive(by.A, by.B), "map inside the panel");
  assert.ok(exclusive(by.C, by.D), "map outside the panel: one panel per item");
  assert.ok(exclusive(by.E, by.F));
  assert.ok(!exclusive(by.G, by.H) && !exclusive(by.I, by.J) && !exclusive(by.K, by.L), "a callback or loop body withholds exclusivity");
  const g2 = [];
  const nested = scanSource(
    wrap([
      "<ActionPanel />",
      "<ActionPanel>",
      "  {a ? (",
      '    <Action title="X" shortcut={{ modifiers: ["cmd"], key: "x" }} />',
      "  ) : (",
      '    <Action title="Y" shortcut={{ modifiers: ["cmd"], key: "x" }} />',
      "  )}",
      '  {b && <Action title="Z" shortcut={{ modifiers: ["cmd"], key: "x" }} />}',
      "</ActionPanel>",
      '<Action title="Loose" shortcut={{ modifiers: ["cmd"], key: "x" }} />',
    ]),
    "f.tsx",
    g2,
    TS,
  );
  assert.equal(g2.filter((g) => g.kind === "panel").length, 1, "the self-closing panel is not a group");
  assert.deepEqual(nested.map((s) => s.title), ["X", "Y", "Z", "Loose"]);
  assert.ok(exclusive(nested[0], nested[1]));
  assert.ok(!exclusive(nested[0], nested[2]) && !exclusive(nested[1], nested[2]));
  assert.equal(g2[nested[3].group].kind, "loose");
});

test("parser scan: text inside strings, JSX attribute text and regex literals is never a shortcut or a bracket (Codex, 2026-11-17)", () => {
  // A JSX string that shows a shortcut is text: the text scan reads it as a declaration.
  const jsx = 'export const v = <Detail markdown="Bind it with shortcut={Keyboard.Shortcut.Common.Copy}" />;\n';
  assert.equal(scanSource(jsx, "f.tsx", [], TS).length, 0);
  assert.equal(scanText(jsx, "f.tsx", []).length, 1, "the text scan's known misread");
  // A regex's `)` does not end the toast call: the action stays in the toast group.
  const toast = 'showToast({ title: "x", message: /\\)/.source, primaryAction: { title: "P", shortcut: Keyboard.Shortcut.Common.Copy } });\n';
  const g = [];
  const [p] = scanSource(toast, "f.ts", g, TS);
  assert.equal(g[p.group].kind, "toast");
  const gt = [];
  const [t] = scanText(toast, "f.ts", gt);
  assert.equal(gt[t.group].kind, "loose", "the text scan's known misread");
  // `{ shortcut }` shorthand is a declaration the scan cannot read, not an absence.
  const [s] = scanSource('export const a = { title: "S", shortcut };\n', "f.ts", [], TS);
  assert.equal(s.kind, "unresolved");
});

test("parser scan: a file that does not parse falls back to the text scan, and scanExtension names it", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "src"), { recursive: true });
    writeFileSync(join(ext, "src", "ok.tsx"), 'export const a = <Action title="A" shortcut={Keyboard.Shortcut.Common.Copy} />;\n');
    writeFileSync(join(ext, "src", "broken.tsx"), 'export const b = <Action title="B" shortcut={Keyboard.Shortcut.Common.Open} /\n');
    const scan = scanExtension(ext, TS);
    assert.match(scan.parser ?? "", /^typescript \d/);
    assert.deepEqual(scan.textScanned, ["src/broken.tsx"]);
    assert.deepEqual(scan.shortcuts.map((s) => [s.file, s.name]).sort(), [["src/broken.tsx", "Open"], ["src/ok.tsx", "Copy"]]);
    const none = scanExtension(ext, null);
    assert.equal(none.parser, null);
    assert.deepEqual(none.textScanned, ["src/broken.tsx", "src/ok.tsx"]);
  });
});

test("parser scan agrees with the text scan on every recorded fixture", () => {
  for (const name of readdirSync(FIX)) {
    const dir = join(FIX, name);
    if (!existsSync(join(dir, "src"))) continue;
    const parsed = scanExtension(dir, TS);
    const text = scanExtension(dir, null);
    assert.deepEqual(parsed.textScanned, [], `${name}: every fixture file parses`);
    const shape = (/** @type {any} */ s) => s.shortcuts.map((x) => [x.file, x.line, x.kind, x.name ?? null, x.title, s.groups[x.group].kind, JSON.stringify(x.bindings)]);
    assert.deepEqual(shape(parsed), shape(text), name);
    const pairs = (/** @type {any} */ s) => s.shortcuts.flatMap((a, i) => s.shortcuts.slice(i + 1).filter((b) => exclusive(a, b)).map((b) => `${a.line}|${b.line}`));
    assert.deepEqual(pairs(parsed), pairs(text), `${name}: exclusive pairs`);
  }
});

test("parser scan: JSON scalars inside a shortcut literal keep its bindings, as the text scan reads them (Codex S1)", () => {
  const src = [
    "export const v = (<ActionPanel>",
    '  <Action title="A" shortcut={{ macOS: { modifiers: ["cmd"], key: "x" }, Windows: null }} />',
    '  <Action title="B" shortcut={{ modifiers: ["cmd"], key: "x", extra: true, n: -1, m: 2 }} />',
    "</ActionPanel>);",
  ].join("\n");
  const parsed = scanSource(src, "f.tsx", [], TS);
  const text = scanText(src, "f.tsx", []);
  assert.deepEqual(parsed.map((s) => [s.kind, JSON.stringify(s.bindings)]), text.map((s) => [s.kind, JSON.stringify(s.bindings)]));
  assert.deepEqual(parsed.map((s) => s.kind), ["platform", "single"]);
});

test("literal edge cases: a __proto__ member makes the shortcut unresolved, never a silent binding (S3, R4-1); commas and colons inside strings survive the text scan's rewrite (S4)", () => {
  // JavaScript gives this object an inherited Windows binding, which Raycast reads; the scan cannot.
  const proto = 'export const v = <Action shortcut={{ macOS: { modifiers: ["cmd"], key: "x" }, "__proto__": { Windows: { modifiers: ["ctrl"], key: "x" } } }} />;\n';
  const [pp] = scanSource(proto, "f.tsx", [], TS);
  assert.equal(pp.kind, "unresolved");
  assert.deepEqual(pp.bindings, {});
  const comma = 'export const v = <Action shortcut={{ modifiers: ["cmd"], key: ",}", note: "a, b: c" }} />;\n';
  const [p] = scanSource(comma, "f.tsx", [], TS);
  const [t] = scanText(comma, "f.tsx", []);
  assert.equal(p.bindings.macOS?.key, ",}");
  assert.deepEqual(t.bindings, p.bindings);
});

test("shortcuts check runs no extension code unless --extension-typescript is given", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "src"), { recursive: true });
    writeFileSync(join(ext, "src", "a.tsx"), 'export const a = <Action title="A" shortcut={Keyboard.Shortcut.Common.Copy} />;\n');
    const pkg = join(ext, "node_modules", "typescript");
    mkdirSync(pkg, { recursive: true });
    const marker = join(dir, "loaded");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typescript", version: "0.0.0", main: "index.js" }));
    writeFileSync(join(pkg, "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1"); module.exports = {};\n`);
    const off = await rx(["shortcuts", "check", "--root", ext, "--table", TABLE, "--json"]);
    assert.equal(existsSync(marker), false, "the extension's typescript must not be loaded");
    assert.equal(off.json.data.parser, null);
    assert.match(byId(off.json.results)["shortcut-ambiguous"].message, /--extension-typescript was not given/);
    await rx(["shortcuts", "check", "--root", ext, "--table", TABLE, "--extension-typescript", "--json"]);
    assert.equal(existsSync(marker), true, "with the flag it is loaded");
  });
});

// ---- shortcut-reserved knows the view that hosts the panel ----------------------------------

test("reserved table: ↵ is reserved in List, Grid and Detail, ⌘⇧↵ in Form, ⌘↵ in both; an unknown view is a WARN for the first two", () => {
  const ret = { modifiers: [], key: "return" };
  const cmd = { modifiers: ["cmd"], key: "return" };
  const cmdShift = { modifiers: ["cmd", "shift"], key: "enter" };
  assert.equal(reservedMatch(ret, "Form"), null, "↵ is no Form default");
  assert.equal(reservedMatch(cmdShift, "Detail"), null, "⌘⇧↵ is no Detail default");
  for (const host of ["List", "List.Item", "List.EmptyView", "Grid", "Grid.Item", "Grid.EmptyView", "Detail"]) assert.equal(reservedMatch(ret, host)?.certain, true, host);
  assert.equal(reservedMatch(cmdShift, "Form")?.certain, true);
  assert.equal(reservedMatch(cmd, "Form")?.certain, true);
  assert.equal(reservedMatch(cmd, null)?.certain, true, "⌘↵ is a default in every view");
  assert.equal(reservedMatch(ret, null)?.certain, false);
  assert.equal(reservedMatch(cmdShift, null)?.certain, false);
  assert.equal(reservedMatch(ret, "MyWrapper")?.certain, false, "an element rx does not know is an unknown view");
});

test("parser scan: a panel's group records the element whose actions= holds it, else null", () => {
  const groups = [];
  scanSource(
    [
      'import { Form, List, ActionPanel, Action } from "@raycast/api";',
      "export const a = <Form actions={<ActionPanel><Action.SubmitForm title=\"S\" shortcut={{ modifiers: [], key: \"return\" }} /></ActionPanel>} />;",
      "export const b = <List.Item title=\"x\" actions={ok ? (<ActionPanel><Action title=\"A\" shortcut={{ modifiers: [\"cmd\"], key: \"a\" }} /></ActionPanel>) : null} />;",
      "export function C() { return (<ActionPanel><Action title=\"C\" shortcut={{ modifiers: [\"cmd\"], key: \"c\" }} /></ActionPanel>); }",
    ].join("\n"),
    "f.tsx",
    groups,
    TS,
  );
  assert.deepEqual(groups.filter((g) => g.kind === "panel").map((g) => g.host), ["Form", "List.Item", null]);
  const text = [];
  scanText('export const a = <Form actions={<ActionPanel><Action title="S" shortcut={{ modifiers: [], key: "return" }} /></ActionPanel>} />;\n', "f.tsx", text);
  assert.equal(text[0].host, null, "the text scan does not read the host");
});

test("parser scan: a host counts only when its name is imported from @raycast/api unrenamed (Codex H1)", () => {
  const panel = '<ActionPanel><Action title="O" shortcut={{ modifiers: [], key: "return" }} /></ActionPanel>';
  const hosts = (src) => {
    const g = [];
    scanSource(src, "f.tsx", g, TS);
    return g.filter((x) => x.kind === "panel").map((x) => x.host);
  };
  assert.deepEqual(hosts(`import { List as Form, ActionPanel, Action } from "@raycast/api";\nexport const a = <Form actions={${panel}} />;\n`), [null], "a renamed import is not the view its local name says");
  assert.deepEqual(hosts(`import { ActionPanel, Action } from "@raycast/api";\nconst Form = (p) => <List {...p} />;\nexport const a = <Form actions={${panel}} />;\n`), [null], "a local component named Form is not a Form");
  assert.deepEqual(hosts(`import { List, ActionPanel, Action } from "@raycast/api";\nexport const a = <List.Item title="x" actions={${panel}} />;\n`), ["List.Item"]);
  // Any other binding of the root name anywhere in the file makes the view unknown (Codex r2/r3).
  const imp = 'import { Form, List, ActionPanel, Action } from "@raycast/api";\n';
  const shadows = {
    "inner const": `function V() { const Form = List; return <Form actions={${panel}} />; }`,
    "destructured param": `function V({ Form }) { return <Form actions={${panel}} />; }`,
    "destructured alias": `function V() { const { Item: Form } = List; return <Form actions={${panel}} />; }`,
    "catch param": `function V() { try { return null; } catch (Form) { return <Form actions={${panel}} />; } }`,
    "for-of": `function V(xs) { for (const Form of xs) return <Form actions={${panel}} />; }`,
    "named function expression": `const V = function Form() { return <Form actions={${panel}} />; };`,
    "named class expression": `const V = class Form {}; export const a = <Form actions={${panel}} />;`,
    "enum member": `enum E { Form = 1 } export const a = <Form actions={${panel}} />;`,
    "default import": `import Form2, * as Form3 from "x"; import Form from "y"; export const a = <Form actions={${panel}} />;`,
  };
  for (const [label, body] of Object.entries(shadows)) assert.deepEqual(hosts(imp + body + "\n"), [null], label);
  assert.deepEqual(hosts(imp + `function V() { const form = 1; return <Form actions={${panel}} />; }\n`), ["Form"], "an unrelated lowercase name is not a shadow");
});

test("shortcuts check: reserved FAILs only for the hosting view's defaults, and WARNs when the view is unknown", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "src"), { recursive: true });
    mkdirSync(join(ext, "node_modules"), { recursive: true });
    symlinkSync(join(REPO, "node_modules", "typescript"), join(ext, "node_modules", "typescript"), "dir");
    const action = (title, mods, key) => `<Action title="${title}" shortcut={{ modifiers: ${JSON.stringify(mods)}, key: "${key}" }} onAction={() => {}} />`;
    const imp = 'import { Action, ActionPanel, Detail, Form } from "@raycast/api";\n';
    writeFileSync(join(ext, "src", "form.tsx"), imp + `export const f = <Form actions={<ActionPanel>${action("Submit", [], "return")}${action("Other", ["cmd", "shift"], "return")}</ActionPanel>} />;\n`);
    writeFileSync(join(ext, "src", "detail.tsx"), imp + `export const d = <Detail markdown="x" actions={<ActionPanel>${action("Try", ["cmd", "shift"], "enter")}</ActionPanel>} />;\n`);
    writeFileSync(join(ext, "src", "parts.tsx"), imp + `export function P() { return <ActionPanel>${action("Try", ["cmd", "shift"], "enter")}${action("Next", ["cmd"], "enter")}</ActionPanel>; }\n`);
    const r = await rx(["shortcuts", "check", "--root", ext, "--table", TABLE, "--extension-typescript", "--json"]);
    const reserved = r.json.results.filter((x) => x.id === "shortcut-reserved");
    const at = (verdict) => reserved.filter((x) => x.verdict === verdict).map((x) => x.details[0].file + ":" + x.message.match(/"(\w+)"/)[1]).sort();
    assert.deepEqual(at("FAIL"), ["src/form.tsx:Other", "src/parts.tsx:Next"]);
    assert.deepEqual(at("WARN"), ["src/parts.tsx:Try"]);
    assert.match(reserved.find((x) => x.verdict === "WARN").message, /could not tell which view hosts this panel/);
    assert.deepEqual(r.json.data.reserved.map((x) => [x.site.file, x.host, x.certain]).sort(), [["src/form.tsx", "Form", true], ["src/parts.tsx", null, false], ["src/parts.tsx", null, true]]);
    // Without the flag nothing is parsed, so no view is known: ↵ in the Form becomes a WARN, never a PASS.
    const off = await rx(["shortcuts", "check", "--root", ext, "--table", TABLE, "--json"]);
    const offWarn = off.json.results.filter((x) => x.id === "shortcut-reserved" && x.verdict === "WARN").map((x) => x.details[0].file).sort();
    assert.deepEqual(offWarn, ["src/detail.tsx", "src/form.tsx", "src/form.tsx", "src/parts.tsx"].sort());
  });
});

test("shortcuts check: a certain match on one platform is not hidden by an uncertain one on another (Codex H2)", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext", { platforms: ["macOS", "Windows"] });
    mkdirSync(join(ext, "src"), { recursive: true });
    const sc = (mac, win) => `shortcut={{ macOS: { modifiers: ${JSON.stringify(mac)}, key: "return" }, Windows: { modifiers: ${JSON.stringify(win)}, key: "return" } }}`;
    writeFileSync(join(ext, "src", "parts.tsx"), `export function P() { return <ActionPanel><Action title="A" ${sc([], ["cmd"])} /><Action title="B" ${sc(["cmd"], [])} /></ActionPanel>; }\n`);
    const r = await rx(["shortcuts", "check", "--root", ext, "--table", TABLE, "--json"]);
    const reserved = r.json.results.filter((x) => x.id === "shortcut-reserved").map((x) => `${x.verdict} ${x.message.match(/"(\w)"/)[1]}`).sort();
    assert.deepEqual(reserved, ["FAIL A", "FAIL B", "WARN A", "WARN B"], "each distinct binding is judged on its own");
    assert.deepEqual(r.json.data.reserved.map((x) => [x.site.title, x.platforms, x.certain]).sort(), [["A", ["Windows"], true], ["A", ["macOS"], false], ["B", ["Windows"], false], ["B", ["macOS"], true]].sort());
  });
});

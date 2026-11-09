// The output boundary (docs/commands.md §1 "Output formats"): `--format text|json|md`, `--json` as
// its alias, the Markdown renderer and its escaping, byte-identical text and JSON against the
// renderer before the boundary existed (test/fixtures/output, captured from rx 93dc9f5), and the
// guard's hook transport, which only an explicit format turns off.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, VERSION } from "../src/cli.mjs";
import { GLOBAL_FLAGS } from "../src/args.mjs";
import { denyDocument } from "../src/commands/guard.mjs";
import { escapeMarkdown, renderEnvelope } from "../src/output.mjs";
import { Results, envelope } from "../src/verdict.mjs";
import { REPO, rx, withTempDir } from "./helpers.mjs";

const FIXTURES = join(REPO, "test", "fixtures");
const LINKS = join(FIXTURES, "extensions", "readme-links-missing");

/**
 * Run the CLI against a scratch commands directory holding one module.
 * @param {string} dir @param {string} source @param {string[]} argv
 */
async function scratch(dir, source, argv) {
  writeFileSync(join(dir, "zz-scratch.mjs"), source);
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, { cwd: dir, commandsDir: dir, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

/** @param {string} name */
const golden = (name) => readFileSync(join(FIXTURES, "output", name), "utf8");
/** @param {string} s */
const normalize = (s) => s.split(REPO).join("<REPO>").replace(`"version": "${VERSION}"`, '"version": "<VERSION>"');

test("text and JSON are byte-identical to the renderer before --format existed, for three commands", async () => {
  /** @type {Array<[string, string[]]>} */
  const cases = [
    ["preflight", ["preflight", "--root", "test/fixtures/extensions/readme-links-missing"]],
    ["preset-check", ["preset", "check", "test/fixtures/presets/house.json"]],
    ["args-error", ["doctor", "--published", "x"]],
  ];
  for (const [name, argv] of cases) {
    const text = await rx(argv, { cwd: REPO });
    assert.equal(text.stdout, golden(`${name}.txt`), `${name} text`);
    const explicitText = await rx([...argv, "--format", "text"], { cwd: REPO });
    assert.equal(explicitText.stdout, golden(`${name}.txt`), `${name} --format text`);
    const json = await rx([...argv, "--json"], { cwd: REPO });
    assert.equal(normalize(json.stdout), golden(`${name}.json`), `${name} --json`);
    const formatJson = await rx([...argv, "--format=json"], { cwd: REPO });
    assert.equal(formatJson.stdout, json.stdout, `${name} --format=json is --json`);
    assert.equal(text.code, json.code);
  }
});

test("--format md renders a real command's results: heading, one table row per result, details, exit code", async () => {
  const md = await rx(["preflight", "--root", LINKS, "--format", "md"]);
  const json = await rx(["preflight", "--root", LINKS, "--json"]);
  assert.equal(md.code, 1);
  assert.equal(md.code, json.code, "same exit as --json");
  const lines = md.stdout.split("\n");
  assert.equal(lines[0], "# rx preflight");
  assert.equal(lines[2], "| Verdict | Check | Message |");
  assert.equal(lines[3], "| --- | --- | --- |");
  const rows = lines.filter((l) => /^\| (PASS|FAIL|WARN|N\/A|ERROR) \|/.test(l));
  assert.deepEqual(
    rows.map((l) => l.split(" | ")[0].slice(2)),
    json.json.results.map((/** @type {any} */ r) => r.verdict),
    "one row per result, in order, with the same verdicts",
  );
  assert.ok(rows.includes("| FAIL | readme-links | 3 relative links do not resolve |"));
  assert.match(md.stdout, /\n## Details\n\n- FAIL readme-links\n {2}- `README\.md:3` docs\/missing\.md\n {2}- `README\.md:3` LICENSE\n {2}- `docs\/guide\.md:3` \.\/diagram\.png\n/);
  assert.ok(md.stdout.endsWith("\nExit code: 1\n"));
  assert.ok(!md.stdout.includes("publishedDir"), "data is not rendered");
  assert.equal(md.stderr, json.stderr, "stderr is the same progress in every format");
});

test("Markdown escapes every interpolated string, keeps table cells on one line, and fences file:line", async () => {
  await withTempDir(async (dir) => {
    const source = `export const spec = { name: "zz-scratch", summary: "s", root: "none", checks: { "zz-pipe": "p" } };
export async function run({ results }) {
  results.warn("zz-pipe", "a | b uses \`code\` and *stars* _under_ <tag> [link]", [
    { file: "src/a\`b.ts", line: 7, text: "row | with\\nnewline" },
    { text: "plain [x](y)" },
  ]);
}
`;
    const r = await scratch(dir, source, ["zz-scratch", "--format", "md"]);
    assert.equal(r.code, 0);
    assert.equal(
      r.stdout,
      [
        "# rx zz-scratch",
        "",
        "| Verdict | Check | Message |",
        "| --- | --- | --- |",
        "| WARN | zz-pipe | a \\| b uses \\`code\\` and \\*stars\\* \\_under\\_ \\<tag\\> \\[link\\] |",
        "",
        "## Details",
        "",
        "- WARN zz-pipe",
        "  - ``src/a`b.ts:7`` row \\| with newline",
        "  - plain \\[x\\](y)",
        "",
        "Exit code: 0",
        "",
      ].join("\n"),
    );
  });
  assert.equal(escapeMarkdown("a\r\nb\\c"), "a b\\\\c");
});

// Each expected string was verified by parsing the rendered table cell and list item with a real
// CommonMark parser (mdast-util-from-markdown 2.1.0): the visible text equals the source, after
// the whitespace rule, and no structure but text appears. rx has no dependencies, so the parser
// check ran outside the suite; these assertions pin the verified bytes.
test("escapeMarkdown neutralizes block syntax, entity references and leading whitespace (parser-verified cases)", () => {
  /** @type {Array<[string, string]>} */
  const cases = [
    ["+ added.d.ts", "\\+ added.d.ts"], // api-diff's added-file detail: was a nested list item
    ["- removed.d.ts", "\\- removed.d.ts"], // api-diff's removed-file detail: was a nested list item
    ["# diagnostic", "\\# diagnostic"], // was a heading
    ["&copy; 2026", "\\&copy; 2026"], // was rendered as ©
    ["&#169; and &amp;", "\\&#169; and \\&amp;"],
    ["1. item", "1\\. item"], // was an ordered list
    ["1) item", "1\\) item"],
    ["\tleading tab", "leading tab"], // was an indented code block
    ["    four leading spaces", "four leading spaces"], // was an indented code block
    ["a\ttab inside", "a tab inside"],
    ["> a quote", "\\> a quote"], // a block quote
    ["```js fence", "\\`\\`\\`js fence"], // a fenced code block
    ["~~~ tilde fence", "\\~\\~\\~ tilde fence"], // was a fenced code block
    ["=== setext", "\\=== setext"],
    ["--- rule", "\\--- rule"],
    ["{attr} ~~strike~~ !bang (paren)", "{attr} \\~\\~strike\\~\\~ \\!bang (paren)"],
    ["trailing spaces   ", "trailing spaces"],
    ["2026-11-07 is a date, not a list", "2026-11-07 is a date, not a list"],
    ["readme-links", "readme-links"], // a hyphen inside a word stays readable
  ];
  for (const [source, escaped] of cases) assert.equal(escapeMarkdown(source), escaped, JSON.stringify(source));
});

test("--format md: api-diff's `+ ` and `- ` file details stay distinguishable list text", () => {
  const results = new Results();
  results.fail("api-diff-files", "2 files differ", [{ text: "+ added.d.ts" }, { text: "- removed.d.ts" }]);
  const md = renderEnvelope(envelope({ command: "api-diff", version: "0.0.0", results }), { format: "md" });
  assert.match(md, /\n- FAIL api-diff-files\n {2}- \\\+ added\.d\.ts\n {2}- \\- removed\.d\.ts\n/);
});

test("--json with --format text or md is ERROR args naming both flags; --json with --format json is fine", async () => {
  for (const argv of [["doctor", "--json", "--format", "md"], ["doctor", "--format", "text", "--json"], ["doctor", "--format=md", "--json"]]) {
    const r = await rx(argv, { cwd: REPO });
    assert.equal(r.code, 2, argv.join(" "));
    const env = JSON.parse(r.stdout);
    assert.deepEqual(env.results.map((/** @type {any} */ x) => [x.verdict, x.id]), [["ERROR", "args"]]);
    assert.match(env.results[0].message, /^(--json and --format (md|text)|--format (md|text) and --json) conflict: --json is --format json; give one output format$/);
  }
  const both = await rx(["preset", "check", "test/fixtures/presets/house.json", "--json", "--format", "json"], { cwd: REPO });
  assert.equal(both.code, 0);
  assert.equal(JSON.parse(both.stdout).command, "preset");
});

test("a bad --format value is ERROR args, printed as text (or as JSON with --json), and invalidates like any argument error", async () => {
  const r = await rx(["doctor", "--format", "xml"], { cwd: REPO });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, 'ERROR  args  --format must be one of text, json, md, got "xml"\n');
  const missing = await rx(["doctor", "--format"], { cwd: REPO });
  assert.equal(missing.stdout, "ERROR  args  --format needs a value\n");
  const md = await rx(["bogus", "--format", "md"]);
  assert.equal(md.stdout, '# rx bogus\n\n| Verdict | Check | Message |\n| --- | --- | --- |\n| ERROR | args | unknown command "bogus"; run \\`rx commands\\` |\n\nExit code: 2\n', "an error before parsing uses the requested format");
  await withTempDir(async (dir) => {
    const marker = join(dir, "invalidated");
    const source = `import { writeFileSync } from "node:fs";
export const spec = { name: "zz-scratch", summary: "s", root: "none", checks: { zz: "zz" } };
export async function invalidate() { writeFileSync(${JSON.stringify(marker)}, "x"); }
export async function run({ results }) { results.pass("zz", "ok"); }
`;
    const bad = await scratch(dir, source, ["zz-scratch", "--format", "xml", "--json"]);
    assert.equal(bad.code, 2);
    assert.match(JSON.parse(bad.stdout).results[0].message, /--format must be one of/);
    assert.ok(existsSync(marker), "a bad --format value runs invalidate, as every argument error does");
  });
});

test("--help with --format md or json is ERROR args; with --format text it prints help", async () => {
  const md = await rx(["doctor", "--help", "--format", "md"], { cwd: REPO });
  assert.equal(md.code, 2);
  assert.match(md.stdout, /--help prints text; it cannot be combined with --format md/);
  const j = await rx(["doctor", "--help", "--json"], { cwd: REPO });
  assert.match(JSON.parse(j.stdout).results[0].message, /^--help prints text; it cannot be combined with --json$/);
  const t = await rx(["doctor", "--help", "--format", "text"], { cwd: REPO });
  assert.equal(t.code, 0);
  assert.match(t.stdout, /--format <text\|json\|md>/);
});

test("rx commands --json lists --format beside --json for every command and subcommand", async () => {
  const r = await rx(["commands", "--json"]);
  assert.equal(r.code, 0);
  /** @param {any} c @param {string} at */
  const check = (c, at) => {
    assert.deepEqual(c.flags["--format"], GLOBAL_FLAGS["--format"], at);
    assert.deepEqual(c.flags["--json"], GLOBAL_FLAGS["--json"], at);
    for (const [n, s] of Object.entries(c.subcommands)) check(s, `${at} ${n}`);
  };
  for (const c of r.json.data.commands) check(c, c.name);
  assert.equal(GLOBAL_FLAGS["--format"].value, "<text|json|md>");
});

test("renderEnvelope: the same envelope in every format; an unknown format throws", () => {
  const results = new Results().pass("a", "ok").fail("b", "bad", [{ file: "x.ts", line: 2, text: "t" }]);
  const env = envelope({ command: "zz", version: "0.0.0", results });
  assert.equal(renderEnvelope(env, { format: "json" }), JSON.stringify(env, null, 2) + "\n");
  assert.equal(renderEnvelope(env, { format: "text" }), "PASS   a  ok\nFAIL   b  bad\n       x.ts:2  t\n");
  assert.match(renderEnvelope(env, { format: "md" }), /Exit code: 1\n$/);
  assert.throws(() => renderEnvelope(env, { format: /** @type {any} */ ("html") }), /not an output format/);
});

/** A PreToolUse payload for a Bash command. @param {string} command */
const bash = (command) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: REPO });

test("guard: the default invocation keeps the hook transport; an explicit --format selects the report", async () => {
  // Default: allow prints nothing, block prints the deny document; both exit 0.
  const allow = await rx(["guard"], { stdin: bash("ls") });
  assert.deepEqual([allow.code, allow.stdout], [0, ""]);
  const block = await rx(["guard"], { stdin: bash("gh pr ready 1") });
  assert.equal(block.code, 0);
  const doc = JSON.parse(block.stdout);
  assert.equal(doc.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(block.stdout, denyDocument(doc.hookSpecificOutput.permissionDecisionReason));

  // Explicit formats: the report, exit per the verdict.
  const text = await rx(["guard", "--format", "text"], { stdin: bash("gh pr ready 1") });
  assert.equal(text.code, 1);
  assert.match(text.stdout, /^FAIL {3}guard {2}marking a PR ready for review is Chris's click/);
  const md = await rx(["guard", "--format", "md"], { stdin: bash("gh pr ready 1") });
  assert.equal(md.code, 1);
  assert.match(md.stdout, /^# rx guard\n\n\| Verdict \| Check \| Message \|\n\| --- \| --- \| --- \|\n\| FAIL \| guard \| /);
  const fj = await rx(["guard", "--format", "json"], { stdin: bash("gh pr ready 1") });
  const j = await rx(["guard", "--json"], { stdin: bash("gh pr ready 1") });
  assert.equal(fj.code, 1);
  assert.equal(fj.stdout, j.stdout, "--format json is --json for the guard too");
  const allowText = await rx(["guard", "--format", "text"], { stdin: bash("ls") });
  assert.deepEqual([allowText.code, allowText.stdout], [0, "N/A    guard  not a publish or ready command\n"]);

  // A protocol error still outranks the transport by default: a bad payload is ERROR, exit 2.
  const badPayload = await rx(["guard"], { stdin: "not json" });
  assert.equal(badPayload.code, 2);
  assert.match(badPayload.stdout, /^ERROR {2}input {2}hook payload on stdin is not JSON/);
});

test("dispatcher: a command's transport is written only when no format was given", async () => {
  await withTempDir(async (dir) => {
    const source = `export const spec = { name: "zz-scratch", summary: "s", root: "none", checks: { zz: "zz" } };
export async function run({ results }) { results.fail("zz", "blocked"); return { transport: { stdout: '{"deny":true}\\n', exit: 0 } }; }
`;
    const plain = await scratch(dir, source, ["zz-scratch"]);
    assert.deepEqual([plain.code, plain.stdout], [0, '{"deny":true}\n']);
    const text = await scratch(dir, source, ["zz-scratch", "--format", "text"]);
    assert.deepEqual([text.code, text.stdout], [1, "FAIL   zz  blocked\n"]);
    const md = await scratch(dir, source, ["zz-scratch", "--format=md"]);
    assert.equal(md.code, 1);
    assert.match(md.stdout, /^# rx zz-scratch\n/);
  });
});

test("guard.run: returns the transport only when neither --format nor --json was parsed", async () => {
  const { run: guardRun } = await import("../src/commands/guard.mjs");
  /** @param {Partial<import("../src/args.mjs").ParsedArgs>} over */
  const call = async (over) => {
    const results = new Results();
    const args = { subcommand: null, positionals: {}, flags: {}, json: false, format: null, help: false, ...over };
    return /** @type {any} */ (await guardRun({ args, root: null, cwd: REPO, env: process.env, results, stdin: async () => bash("gh pr ready 1"), log: () => {}, version: VERSION }));
  };
  assert.equal((await call({})).transport.exit, 0);
  for (const format of /** @type {const} */ (["text", "md", "json"])) assert.equal((await call({ format, json: format === "json" })).transport, undefined, format);
});

test("escapeMarkdown neutralizes GitHub-flavored autolinks: scheme URLs, www. addresses and emails (GFM-verified)", () => {
  assert.equal(escapeMarkdown("see https://example.com_foo now"), "see https\\://example.com\\_foo now");
  assert.equal(escapeMarkdown("www.example.com"), "www\\.example.com");
  assert.equal(escapeMarkdown("mail me at user@example.com"), "mail me at user\\@example.com");
  assert.equal(escapeMarkdown("<https://example.com>"), "\\<https\\://example.com\\>");
});

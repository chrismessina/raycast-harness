import { test } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseArgs } from "../src/args.mjs";
import { ArgError } from "../src/errors.mjs";

/** @type {import("../src/args.mjs").ArgSchema} */
const schema = {
  name: "demo",
  summary: "demo",
  positionals: [{ name: "pr", required: true, help: "PR number" }],
  flags: {
    "--root": { type: "string", value: "<dir>", help: "root" },
    "--pr-text": { type: "string", value: "<file>", repeat: true, help: "text" },
    "--apply": { type: "boolean", help: "apply" },
    "--round": { type: "int", help: "round" },
    "--forbidden": { type: "string", required: true, help: "forbidden" },
  },
};

test("parses positionals, string, repeat, boolean and int flags, plus --json", () => {
  const p = parseArgs(["42", "--root", "x", "--pr-text", "a", "--pr-text=b", "--apply", "--round", "7", "--forbidden", "f", "--json"], schema);
  assert.deepEqual(p.positionals, { pr: "42" });
  assert.deepEqual(p.flags, { "--root": "x", "--pr-text": ["a", "b"], "--apply": true, "--round": 7, "--forbidden": "f" });
  assert.equal(p.json, true);
});

test("unknown argument is an ArgError", () => {
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--x"], schema), (e) => e instanceof ArgError && /unknown argument "--x"/.test(e.message));
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "extra"], schema), /unexpected argument "extra"/);
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "-x"], schema), /unknown argument "-x"/);
});

test("a flag without its value, or with an empty value, is an ArgError (the zsh word-splitting case)", () => {
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--root"], schema), /--root needs a value/);
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--root", ""], schema), /--root has an empty value/);
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--root", "--apply"], schema), /--root needs a value/);
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--apply=yes"], schema), /--apply takes no value/);
});

test("missing required positional or flag is an ArgError; --help short-circuits that", () => {
  assert.throws(() => parseArgs(["--forbidden", "f"], schema), /missing <pr>/);
  assert.throws(() => parseArgs(["42"], schema), /missing --forbidden/);
  assert.equal(parseArgs(["--help"], schema).help, true);
});

test("int flags must be integers; a flag given twice is an error", () => {
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--round", "x"], schema), /--round must be an integer/);
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--root", "a", "--root", "b"], schema), /--root given twice/);
});

test("subcommands select their own schema; unknown or missing subcommand is an ArgError", () => {
  /** @type {import("../src/args.mjs").ArgSchema} */
  const s = {
    name: "pr",
    summary: "pr",
    subcommands: {
      verify: { name: "verify", summary: "v", positionals: [{ name: "pr", required: true, help: "" }], flags: { "--author": { type: "string", required: true, help: "" } } },
      files: { name: "files", summary: "f", positionals: [{ name: "pr", required: true, help: "" }] },
    },
  };
  const p = parseArgs(["verify", "9", "--author", "me"], s);
  assert.equal(p.subcommand, "verify");
  assert.deepEqual(p.flags, { "--author": "me" });
  assert.throws(() => parseArgs(["files", "9", "--author", "me"], s), /unknown argument "--author"/);
  assert.throws(() => parseArgs(["bogus", "9"], s), /unknown pr subcommand "bogus"/);
  assert.throws(() => parseArgs([], s), /needs a subcommand: verify, files/);
  assert.equal(parseArgs(["--help"], s).help, true);
});

test("help text names usage, flags, root, network and state", () => {
  const h = helpText({ ...schema, root: "required", network: "none", state: "none" });
  assert.match(h, /Usage: rx demo <pr> \[--root <dir>\]/);
  assert.match(h, /--forbidden <value>.*\(required\)/);
  assert.match(h, /--pr-text <file>.*\(repeatable\)/);
  assert.match(h, /Root: {4}--root <dir> wins/);
});

test("a boolean flag given twice is an error too, including --json", () => {
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--apply", "--apply"], schema), /--apply given twice/);
  assert.throws(() => parseArgs(["42", "--forbidden", "f", "--json", "--json"], schema), /--json given twice/);
});

test("--help still rejects unknown tokens; it only waives missing required inputs", () => {
  assert.throws(() => parseArgs(["--help", "--bogus"], schema), /unknown argument "--bogus"/);
  assert.equal(parseArgs(["--help"], schema).help, true);
  /** @type {import("../src/args.mjs").ArgSchema} */
  const s = { name: "pr", summary: "pr", subcommands: { verify: { name: "verify", summary: "v" } } };
  assert.throws(() => parseArgs(["--bogus", "--help"], s), /unknown argument "--bogus"/);
});

test("a valued flag before the subcommand does not have its value taken as the subcommand", () => {
  /** @type {import("../src/args.mjs").ArgSchema} */
  const s = {
    name: "audit",
    summary: "a",
    subcommands: {
      record: { name: "record", summary: "r", flags: { "--root": { type: "string", help: "" }, "--entries": { type: "string", help: "" } } },
      show: { name: "show", summary: "s", flags: { "--root": { type: "string", help: "" } } },
    },
  };
  const p = parseArgs(["--root", "/path", "show"], s);
  assert.equal(p.subcommand, "show");
  assert.deepEqual(p.flags, { "--root": "/path" });
  assert.equal(parseArgs(["--root=/path", "record", "--entries", "e.json"], s).subcommand, "record");
  assert.throws(() => parseArgs(["--root", "/path"], s), /needs a subcommand/);
});

test("parent-command help validates every token like a subcommand would", () => {
  /** @type {import("../src/args.mjs").ArgSchema} */
  const s = { name: "audit", summary: "a", subcommands: { show: { name: "show", summary: "s", flags: { "--root": { type: "string", help: "" } } } } };
  assert.throws(() => parseArgs(["--help", "--help"], s), /--help given twice/);
  assert.throws(() => parseArgs(["--root", "--help"], s), /--root needs a value/);
  assert.throws(() => parseArgs(["--help=true"], s), /--help takes no value/);
  const p = parseArgs(["--help", "--json"], s);
  assert.equal(p.help, true);
  assert.equal(p.json, true, "json is preserved so the CLI can reject help + json");
});

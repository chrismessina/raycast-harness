// `rx publication record <repo> <pr> <sha> [--root <dir>]` (docs/commands.md): write the publication
// record, `repo/publication.json` = { repo, pr, remoteSha, at }, after a publish succeeded. The
// caller (the plugin's ship flow) decides WHEN a publish succeeded; rx owns the record's shape,
// where it lives and how it is written. `rx greptile can-reply --claims-fix` reads it.
//
// The record is per git repository (`git rev-parse --git-path rx`), not per extension, so this
// command needs no extension root: it records into the repository containing `--root <dir>` when
// given, else the one containing the working directory. That works from an extension, from any
// directory inside one, and from a repository root that holds no extension (a multi-extension
// checkout). Outside a git repository it is ERROR root and writes nothing.
//
// A plain record: no attestation, no binding, no network. `at` is the time of recording. A
// malformed operand is `ERROR args` and leaves any previous record untouched.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { RootError, RxError } from "../errors.mjs";
import { gitPath } from "../git.mjs";
import { recordFromOperands, writePublication } from "../publication.mjs";

const STATE = "writes repo/publication.json (`git rev-parse --git-path rx` of the git repository containing --root, else the working directory)";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "publication",
  summary: "record which pull request and remote head a successful publish produced",
  root: "none",
  network: "none",
  state: STATE,
  subcommands: {
    record: {
      name: "record",
      summary: "write repo/publication.json { repo, pr, remoteSha, at } for `rx greptile can-reply --claims-fix`",
      root: "none",
      network: "none",
      state: STATE,
      positionals: [
        { name: "repo", required: true, help: "the repository the pull request is in, owner/name (raycast/extensions)" },
        { name: "pr", required: true, help: "the pull request number, a positive integer" },
        { name: "sha", required: true, help: "the remote head the publish produced: a full 40-hex lowercase commit SHA" },
      ],
      flags: { "--root": { type: "string", value: "<dir>", help: "any directory inside the git repository whose state holds the record (default: the working directory); no extension is needed" } },
      checks: { "publication-record": { description: "the record was validated and written", levels: ["PASS", "ERROR"] } },
      data: { file: "absolute path of the record written", record: "{ repo, pr, remoteSha, at }" },
      examples: ["rx publication record raycast/extensions 31000 0123456789abcdef0123456789abcdef01234567"],
    },
  },
};

/**
 * The directory whose git repository holds the record: `--root` when given, else cwd. It must be a
 * directory inside a git repository; otherwise ERROR root.
 * @param {string | undefined} given @param {string} cwd
 */
async function repositoryDir(given, cwd) {
  const dir = resolve(cwd, given ?? ".");
  const named = given === undefined ? `the working directory ${dir}` : `--root ${JSON.stringify(given)}`;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new RootError(`${named} is not a directory`, "bad-root");
  try {
    await gitPath(dir, "rx");
  } catch (e) {
    // git that cannot start is a tooling failure, not a directory outside a repository.
    if (e instanceof RxError && /is not installed or not on PATH/.test(e.message)) throw e;
    throw new RootError(`${named} is not inside a git repository, so there is no repo state to record into`, "none");
  }
  return dir;
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, cwd, results }) {
  const p = args.positionals;
  const given = typeof args.flags["--root"] === "string" ? args.flags["--root"] : undefined;
  const record = recordFromOperands({ repo: p.repo, pr: p.pr, remoteSha: p.sha, at: new Date().toISOString() });
  const dir = await repositoryDir(given, cwd);
  const file = await writePublication(dir, record);
  results.pass("publication-record", `recorded ${record.repo}#${record.pr} at ${record.remoteSha.slice(0, 7)} in ${file}`);
  return { data: { file, record } };
}

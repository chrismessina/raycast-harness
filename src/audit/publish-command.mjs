// The guard's command reader: an exact-shape allowlist, not a shell parser.
//
// A Bash command is one of five things to `rx guard`:
//
//   ready     its text mentions marking a PR ready for review (`pr ready`, `draft=false`,
//             `ready_for_review=`, `markPullRequestReadyForReview`), anywhere, in any quoting:
//             always blocked; marking ready is Chris's click.
//   state     its text (same normalization, then `/./` and repeated `/` collapsed until stable)
//             mentions `.git/rx` (not followed by another name character, so `.git/rx-old` is not
//             a mention) or `raycast-harness/attest.key`; or (classifyCommand, async) one of its
//             words that contains `/` or starts with `.` or `~` resolves, against the payload cwd
//             (`~` = home), to a protected path by the same checkProtectedPath the Write rule uses
//             (src/audit/protected-paths.mjs: a repository's rx state, a worktree's or separate
//             git dir's rx state, the whole $XDG_CONFIG_HOME/raycast-harness/ directory). Words are
//             split at whitespace and `; & | < > ( )` after quotes and backslashes are stripped
//             (case kept), and the part after a word's first `=` (`--out=<path>`) is checked too.
//             Always blocked; rx state, the key and the generations are written only by rx, and
//             read with `rx audit show`. rx's own calls (`rx gates --preset …`, `audit record
//             --entries <file outside the root>`, `git rev-parse --git-path rx`) name none of
//             them, so they pass.
//   publish   the WHOLE command is one of the canonical publish shapes:
//                 npm run publish
//                 ray publish
//             optionally preceded by exactly one `cd <literal dir> &&` (the dir absolute, explicitly
//             relative `./…`/`../…`, or `~`/`~/…`; never a bare name, which CDPATH could redirect,
//             and never `~user`) and followed by plain output redirections (`> file`, `>> file`,
//             `2> file`, `2>&1`, `&> file`) whose targets are literal words. Nothing else: no other commands in the line, no options, no quotes
//             around the words, no `npx`, no wrappers, no variables, no newline. The publish is
//             then checked against the extension that resolves from the `cd` directory (resolved
//             against the hook payload's cwd) or from the cwd itself.
//   unknown   its text mentions the word `publish` (as a whole word, after quotes and backslashes
//             are stripped and backslash-newline continuations joined) but it is not one of those
//             shapes: blocked with the instruction to write the publish as a plain command. This
//             is deliberately broad: `npm run "publish"`, `FOO=1 npm run publish`,
//             `npx ray publish`, `npm run publish; npm test`, `git commit -m "ray publish"` and
//             `echo publish` all block. The cost is one retry with a reworded or split command;
//             the gain is that there is no shell grammar to argue with. Words that merely contain
//             `publish` (`--published`, `publishRange`, `--record-publication`, `publishing`) are
//             not mentions, so the plugin's own `rx preflight --published` and
//             `rx.mjs --record-publication` calls pass.
//   other     anything else: allowed without reading any state.
//
// Out of the threat model, and documented as such in docs/commands.md §4.9: a command that builds
// the word `publish` or `ready` at run time (`"$(printf pub)lish"`, `$X`, `eval` over a file). The
// guard is a seatbelt for an agent following the ship skill, which spells the publish exactly as
// this allowlist admits and never writes under .git/rx/ (plugins/raycast-extensions/skills/ship/
// SKILL.md states both); it is not a sandbox. The receipt and audit it checks carry an attestation
// keyed outside the repository (src/attest.mjs) and a binding to their checkout and gates attempt
// (src/binding.mjs), and the `state` rule above blocks the plain Bash routes to them, but a command
// that builds the path at run time is out of the threat model for the same reason as the words
// above (the provenance limitation, also in §4.9).

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkProtectedPath } from "./protected-paths.mjs";

/** A literal word: no quotes, no `$`, no backtick, no tilde, no glob character, no whitespace, no `=`. */
const WORD = String.raw`[A-Za-z0-9_./+:,@-]+`;
/**
 * A literal directory for the one `cd` the shapes admit. It must say where it points without the
 * shell's help: absolute (`/…`), explicitly relative (`./…`, `../…`, `.`, `..`), or under the home
 * directory (`~`, `~/…`). A bare name (`cd src`) is refused because CDPATH could send it elsewhere;
 * `~user` is refused because only the shell knows that user's home; a word starting with `-` is
 * refused (`cd -` is the previous directory, `-P`/`-L` are options). A quoted form is accepted for
 * the absolute and explicitly relative forms only, with nothing the shell would expand inside (no
 * `" ' backtick $ \ newline`); a quoted `"~"` stays literal in bash, so it is refused.
 */
const DIR_BARE = String.raw`(?:/(?:${WORD})?|\.\.?(?:/(?:${WORD})?)?|~(?:/(?:${WORD})?)?)`;
/** What a quoted directory may hold: one character the shell would not expand. */
const Q = String.raw`[^"'\x60$\\\n]`;
const DIR_QUOTED_BODY = String.raw`(?:/${Q}*|\.\.?(?:/${Q}*)?)`;
const DIR = String.raw`(?:${DIR_BARE}|"${DIR_QUOTED_BODY}"|'${DIR_QUOTED_BODY}')`;
/** One output redirection with a literal target (a tilde target is refused: `~user` again). */
const REDIR = String.raw`(?:[ \t]*(?:[12]?>>?|&>)[ \t]*(?:${WORD}|&[12]))`;
const SHAPE = new RegExp(String.raw`^[ \t]*(?:cd[ \t]+(${DIR})[ \t]*&&[ \t]*)?(npm[ \t]+run[ \t]+publish|ray[ \t]+publish)${REDIR}*[ \t]*$`);

// `ready_for_review` counts only when something is assigned to it (`-f ready_for_review=true`): the
// ship skill's attribution query READS timeline events of that name, and a read is not a mention.
const READY_MENTIONS = [/\bpr[ \t]+ready(?![\w-])/, /\bdraft[ \t]*=[ \t]*false\b/, /ready_for_review[ \t]*=/, /markpullrequestreadyforreview/];
const PUBLISH_MENTION = /\bpublish\b/;
const STATE_MENTIONS = [/\.git\/rx(?![a-z0-9_.-])/, /raycast-harness\/attest\.key/];

/**
 * The text a mention check reads: continuations joined, quotes and backslashes removed, lowercase.
 * `gh pr "re""ady"` and `gh pr re\ady` both read as `gh pr ready`.
 * @param {string} command
 */
export function normalize(command) {
  return command.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "").toLowerCase();
}

/** Does the command's text mention marking a PR ready, in any quoting? @param {string} command */
export function mentionsReady(command) {
  const text = normalize(command);
  return READY_MENTIONS.some((re) => re.test(text));
}

/**
 * Collapse `/./` and runs of `/` to one `/`, repeatedly, so `.git/./rx` and `.git//rx` read as
 * `.git/rx`.
 * @param {string} text
 */
export function collapseSeparators(text) {
  let prev;
  do {
    prev = text;
    text = text.replace(/\/{2,}/g, "/").replace(/\/\.\//g, "/");
  } while (text !== prev);
  return text;
}

/** Does the command's text mention rx state (`.git/rx`) or the attestation key, in any quoting? @param {string} command */
export function mentionsState(command) {
  const text = collapseSeparators(normalize(command));
  return STATE_MENTIONS.some((re) => re.test(text));
}

/**
 * The words of a command that look like paths: continuations joined, quotes and backslashes
 * stripped (case kept), separators collapsed, split at whitespace and `; & | < > ( )`; a word is
 * kept when it contains `/` or starts with `.` or `~`, and the part after its first `=` is
 * considered on its own too.
 * @param {string} command
 * @returns {string[]}
 */
export function pathWords(command) {
  const text = collapseSeparators(command.replace(/\\\r?\n/g, "").replace(/["'\\]/g, ""));
  /** @type {Set<string>} */
  const out = new Set();
  for (const w of text.split(/[\s;&|<>()]+/)) {
    const eq = w.indexOf("=");
    for (const c of eq >= 0 ? [w, w.slice(eq + 1)] : [w]) if (c && (c.includes("/") || c.startsWith(".") || c.startsWith("~"))) out.add(c);
  }
  return [...out];
}

/**
 * Does any path-like word of the command resolve to a protected path? `~` and `~/…` are the home
 * directory; `~user` is skipped (only the shell knows that home); everything else resolves
 * against `cwd`.
 * @param {string} command
 * @param {string} cwd
 */
export async function mentionsProtectedPath(command, cwd) {
  for (const w of pathWords(command)) {
    const p = w === "~" ? homedir() : w.startsWith("~/") ? join(homedir(), w.slice(2)) : w.startsWith("~") ? null : w;
    if (p === null) continue;
    if ((await checkProtectedPath(p, cwd)).protected) return true;
  }
  return false;
}

/** Does the command's text mention the word `publish`, in any quoting? @param {string} command */
export function mentionsPublish(command) {
  return PUBLISH_MENTION.test(normalize(command));
}

/**
 * Resolve the `cd` target of an allowed shape. Quotes are stripped; `~` and `~/…` are the home
 * directory; everything else resolves against `cwd`.
 * @param {string} dir
 * @param {string} cwd
 */
function resolveDir(dir, cwd) {
  const bare = /^["']/.test(dir) ? dir.slice(1, -1) : dir;
  if (bare === "~" || bare === "~/") return homedir();
  if (bare.startsWith("~/")) return resolve(homedir(), bare.slice(2));
  return resolve(cwd, bare);
}

/**
 * @typedef {{ kind: "ready" } | { kind: "state" } | { kind: "publish", dir: string, program: "npm" | "ray" } | { kind: "unknown", reason: string } | { kind: "other" }} CommandReading
 */

/**
 * Read a Bash command for the guard.
 * @param {string} command the `tool_input.command` of the hook payload
 * @param {string} cwd the hook payload's cwd
 * @returns {CommandReading}
 */
export function readCommand(command, cwd) {
  if (mentionsReady(command)) return { kind: "ready" };
  if (mentionsState(command)) return { kind: "state" };
  if (!mentionsPublish(command)) return { kind: "other" };
  const m = command.match(SHAPE);
  if (!m) {
    return {
      kind: "unknown",
      reason: "the guard allows a publish only as the whole command `npm run publish` or `ray publish`, optionally after `cd <dir> &&` and before plain output redirections; write it that way (and keep the word publish out of other commands)",
    };
  }
  return { kind: "publish", dir: m[1] ? resolveDir(m[1], cwd) : cwd, program: m[2].startsWith("npm") ? "npm" : "ray" };
}

/**
 * readCommand plus the path-aware state rule (mentionsProtectedPath), in the guard's order: ready,
 * then state (text or path), then publish / unknown / other.
 * @param {string} command
 * @param {string} cwd
 * @returns {Promise<CommandReading>}
 */
export async function classifyCommand(command, cwd) {
  const read = readCommand(command, cwd);
  if (read.kind === "ready" || read.kind === "state") return read;
  if (await mentionsProtectedPath(command, cwd)) return { kind: "state" };
  return read;
}

// The guard's command reader: an exact-shape allowlist, not a shell parser.
//
// A Bash command is one of four things to `rx guard`:
//
//   ready     its text mentions marking a PR ready for review (`pr ready`, `draft=false`,
//             `ready_for_review=`, `markPullRequestReadyForReview`), anywhere, in any quoting:
//             always blocked; marking ready is Chris's click.
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
// guard is a seatbelt for an agent following the ship skill, which (once rewritten for rx, Phase 5)
// must spell the publish exactly as this allowlist admits and must never write under .git/rx/; it is
// not a sandbox, and the receipt and audit it checks are files that same agent could write (the
// provenance limitation, also in §4.9).

import { homedir } from "node:os";
import { resolve } from "node:path";

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
 * @typedef {{ kind: "ready" } | { kind: "publish", dir: string, program: "npm" | "ray" } | { kind: "unknown", reason: string } | { kind: "other" }} CommandReading
 */

/**
 * Read a Bash command for the guard.
 * @param {string} command the `tool_input.command` of the hook payload
 * @param {string} cwd the hook payload's cwd
 * @returns {CommandReading}
 */
export function readCommand(command, cwd) {
  if (mentionsReady(command)) return { kind: "ready" };
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

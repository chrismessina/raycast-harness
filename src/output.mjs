// The output boundary (docs/commands.md §1 "Output formats"). Commands record semantic results in
// `Results` and return domain `data`; this module is the only place that turns an envelope into
// bytes on stdout. Verdicts and the exit code are computed in verdict.mjs and are the same in
// every format.
//
//   text  one verdict line per result, details indented beneath it (the default)
//   json  the envelope, pretty-printed (`--json` is an alias of `--format json`)
//   md    a Markdown report of the results; `data` is not rendered, because domain data has no
//         common presentation schema

import { envelope } from "./verdict.mjs";

/** @typedef {"text" | "json" | "md"} Format */

/** Every value `--format` accepts, in the order the help lists them. */
export const FORMATS = /** @type {const} */ (["text", "json", "md"]);

/** @typedef {ReturnType<typeof envelope>} Envelope */

/**
 * Render an envelope in one format.
 * @param {Envelope} env
 * @param {{ format: Format }} opts
 * @returns {string}
 */
export function renderEnvelope(env, { format }) {
  if (format === "json") return JSON.stringify(env, null, 2) + "\n";
  if (format === "md") return renderMarkdown(env);
  if (format === "text") return renderText(env.results);
  throw new TypeError(`not an output format: ${JSON.stringify(format)}`);
}

/**
 * Text form: one line per result, details indented beneath it.
 * @param {import("./verdict.mjs").Result[]} items
 */
export function renderText(items) {
  const width = Math.min(28, items.reduce((w, r) => Math.max(w, r.id.length), 0));
  const lines = [];
  for (const r of items) {
    lines.push(`${r.verdict.padEnd(5)}  ${r.id.padEnd(width)}  ${r.message}`);
    for (const d of r.details) {
      const where = d.file ? `${d.file}${d.line !== undefined ? `:${d.line}` : ""}  ` : "";
      lines.push(`       ${where}${d.text}`);
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

/** Characters that form an inline construct anywhere in a line: always backslash-escaped. */
const INLINE_PUNCTUATION = /[\\`*_[\]<>|~&!]/g;

/**
 * Escape a string so it renders as literal text in a table cell or a list item, whatever it holds.
 *   - Line breaks and tabs become spaces, and leading and trailing spaces are dropped, so a value
 *     can never leave its cell or item and can never become an indented code block.
 *   - `\`, backticks, `*`, `_`, `[`, `]`, `<`, `>`, `|`, `~`, `&` and `!` are backslash-escaped
 *     everywhere: they form code spans, emphasis, links, images, raw HTML, autolinks, table
 *     cells, strikethrough, fences and entity references (`&copy;`) wherever they appear.
 *   - A block marker that only means something at the start of a line is escaped there: a
 *     leading `#`, `+`, `-` or `=` (headings, list items, thematic breaks, setext underlines) and
 *     the `.` or `)` after leading digits (ordered list items, `1. item`). Since the value is one
 *     line, its start is the only place a block can begin.
 *   - GitHub-flavored Markdown's extended autolinks are neutralized: the `:` of `scheme://`, the
 *     `.` after `www` and every `@` are escaped, so a bare URL, `www.` address or email address
 *     stays text instead of becoming a link whose visible text would show the escapes.
 * Parser-verified (CommonMark and GFM) for the cases in test/output.test.mjs.
 * @param {string} s
 */
export function escapeMarkdown(s) {
  const flat = String(s).replace(/\r\n|\r|\n|\t/g, " ").replace(/^ +| +$/g, "");
  return flat
    .replace(INLINE_PUNCTUATION, (c) => `\\${c}`)
    .replace(/^[#+\-=]/, (c) => `\\${c}`)
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/:(?=\/\/)/g, "\\:")
    .replace(/\b(www)\./gi, "$1\\.")
    .replace(/@/g, "\\@");
}

/**
 * A `file:line` location as inline code. The fence is one backtick longer than the longest run of
 * backticks inside the location, padded with spaces when the location starts or ends with one, so
 * any path renders literally.
 * @param {string} where
 */
function inlineCode(where) {
  const flat = where.replace(/\r\n|\r|\n/g, " ");
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * Markdown form: a heading naming the command, a `| Verdict | Check | Message |` table with one row
 * per result in order, then a "Details" section with one sub-list per result that has details
 * (`file:line` as inline code, then the text), and the exit code last.
 * @param {Envelope} env
 */
export function renderMarkdown(env) {
  const lines = [`# rx ${escapeMarkdown(env.command)}`, ""];
  if (env.results.length) {
    lines.push("| Verdict | Check | Message |", "| --- | --- | --- |");
    for (const r of env.results) lines.push(`| ${r.verdict} | ${escapeMarkdown(r.id)} | ${escapeMarkdown(r.message)} |`);
    lines.push("");
  }
  const withDetails = env.results.filter((r) => r.details.length);
  if (withDetails.length) {
    lines.push("## Details", "");
    for (const r of withDetails) {
      lines.push(`- ${r.verdict} ${escapeMarkdown(r.id)}`);
      for (const d of r.details) {
        const where = d.file ? `${inlineCode(`${d.file}${d.line !== undefined ? `:${d.line}` : ""}`)} ` : "";
        lines.push(`  - ${where}${escapeMarkdown(d.text)}`);
      }
    }
    lines.push("");
  }
  lines.push(`Exit code: ${env.exit}`);
  return lines.join("\n") + "\n";
}

/**
 * Print the results in one format and return the exit code. Commands never call process.exit.
 * @param {{ command: string, version: string, fingerprint?: string | null, data?: object, results: import("./verdict.mjs").Results, format: Format, write: (s: string) => void }} p
 */
export function emit({ command, version, fingerprint = null, data = {}, results, format, write }) {
  write(renderEnvelope(envelope({ command, version, fingerprint, data, results }), { format }));
  return results.exit;
}

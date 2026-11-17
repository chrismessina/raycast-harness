// shortcut-platform-case: a Keyboard.Shortcut platform key spelled anything but `macOS` / `Windows`.
//
// The extension's own TypeScript parses each source file, so strings, regex literals, templates and
// JSX attribute text can never pose as a shortcut. A hit is a property named windows / macos (any
// miscasing below) whose value, after unwrapping parentheses, `as`, `satisfies` and `<T>` assertions,
// is an object literal with both `modifiers` and `key` (Keyboard.Shortcut requires both). Spreads,
// computed names and values held in variables are outside the contract.
//
// Fail-safe, never fail-blind:
// - a file the parser reports syntax errors in is not trusted to be fully inspected: WARN with the
//   first error's line (its clean siblings still FAIL definitively);
// - the caller passes no compiler (it may not run the extension's code: only `rx gates` does), or
//   the extension's typescript cannot be loaded or lacks an API used here: the pre-parser
//   per-line text scan runs and its hits are WARN, never FAIL; no hits is a WARN that the keys were
//   not checked, never a PASS.

import { readFileSync } from "node:fs";
import { grepSources } from "./context.mjs";
import { lineOf, parse, propertyName, unwrap } from "../typescript.mjs";

const MISCASED = new Set(["windows", "macos", "MacOS", "Macos", "MacOs"]);
const HEURISTIC = /[{,]\s*["']?(windows|macos|MacOS|Macos|MacOs)["']?\s*:\s*\{/;

/**
 * Miscased platform keys holding a shortcut-shaped object literal, as 1-based lines.
 * @param {any} ts @param {any} sf
 * @returns {number[]}
 */
function miscasedKeys(ts, sf) {
  /** @type {number[]} */
  const lines = [];
  const visit = (/** @type {any} */ node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(ts, node.name);
      const value = unwrap(ts, node.initializer);
      if (name !== null && MISCASED.has(name) && ts.isObjectLiteralExpression(value)) {
        const props = new Set();
        for (const p of value.properties) {
          if (ts.isPropertyAssignment(p)) props.add(propertyName(ts, p.name));
          else if (ts.isShorthandPropertyAssignment(p)) props.add(p.name.text);
        }
        if (props.has("modifiers") && props.has("key")) lines.push(lineOf(sf, node.name.getStart(sf)));
      }
    }
    ts.forEachChild(node, visit);
    return undefined; // a truthy return would stop forEachChild early
  };
  visit(sf);
  return lines;
}

/**
 * @param {string} root
 * @param {{ file: string, rel: string, code: string }[]} sources
 * @param {{ fail: Function, warn: Function, na: Function, pass: Function }} c
 * @param {any} ts the extension's compiler, or null to use the text scan
 * @param {string} [why] why there is no compiler (worded for the WARN)
 */
export function shortcutPlatformCase(root, sources, c, ts, why = "the extension's typescript could not be loaded") {
  const ID = "shortcut-platform-case";
  const declared = grepSources(sources, /\bshortcut\s*[=:]/).length > 0;
  /** @param {{ file: string, line: number }[]} hits */
  const details = (hits) => hits.map((h) => ({ file: h.file, line: h.line, text: `${h.file}:${h.line}` }));

  if (!ts) {
    const hits = grepSources(sources, HEURISTIC);
    if (!declared && !hits.length) return c.na(ID, "no shortcuts declared in src/");
    if (hits.length) return c.warn(ID, `possibly miscased platform keys (a text scan, nothing was parsed: ${why}); shortcut platform keys are macOS and Windows`, details(hits));
    return c.warn(ID, `shortcut keys not checked by the parser: ${why}`);
  }

  /** @type {{ file: string, line: number }[]} */
  const hits = [];
  /** @type {{ file: string, line: number }[]} */
  const unparsed = [];
  for (const s of sources) {
    let text;
    try { text = readFileSync(s.file, "utf8"); } catch { unparsed.push({ file: s.rel, line: 1 }); continue; }
    const { sf, ok, errorLine } = parse(ts, s.file, text);
    if (!ok) {
      unparsed.push({ file: s.rel, line: errorLine });
      continue;
    }
    for (const line of miscasedKeys(ts, sf)) hits.push({ file: s.rel, line });
  }
  if (hits.length) c.fail(ID, "platform keys are Windows and macOS", details(hits));
  if (unparsed.length) c.warn(ID, `${unparsed.length} source file${unparsed.length === 1 ? "" : "s"} did not parse cleanly, so their platform keys were not fully checked`, details(unparsed));
  if (!declared && !hits.length && !unparsed.length) return c.na(ID, "no shortcuts declared in src/");
  c.pass(ID, `platform keys are spelled macOS and Windows (parsed with typescript ${ts.version})`);
}

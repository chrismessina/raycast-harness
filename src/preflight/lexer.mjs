// Replace every comment in JS/TS source with spaces, keeping newlines so line numbers stay true.
// A small lexer, not a regex: `/*` or `//` inside a string, a template literal (including its
// `${}` parts, which are lexed as code), or a regex literal is not a comment, and a line starting
// with `*` can be multiplication. Known limit: a regex literal directly after `)` (`if (x) /re/`)
// reads as division, because telling the two apart needs a parser; that style is rare in
// extension code. Ported behavior-for-behavior from the plugin's scripts/preflight.mjs.

const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else",
  "yield", "await",
]);

/** @param {string} src */
export function stripComments(src) {
  /** @type {string[]} */
  const out = [];
  lexCode(src, 0, out, false);
  return out.join("");
}

/**
 * Lex code from i. With inTemplate, stop after the `}` that closes a template's `${`.
 * @param {string} src @param {number} i @param {string[]} out @param {boolean} inTemplate
 */
function lexCode(src, i, out, inTemplate) {
  let prev = ""; // last significant character, to tell a regex from division
  let word = ""; // the identifier that ended at prev, if any
  let depth = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inTemplate) {
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) { out.push("}"); return i + 1; }
        depth--;
      }
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") { out.push(" "); i++; }
      continue;
    }
    if (c === "/" && n === "*") {
      out.push("  ");
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out.push(src[i] === "\n" ? "\n" : " "); i++; }
      if (i < src.length) { out.push("  "); i += 2; }
      continue;
    }
    if (c === "`") {
      out.push(c);
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") { out.push(src[i] + (src[i + 1] ?? "")); i += 2; }
        else if (src[i] === "$" && src[i + 1] === "{") { out.push("${"); i = lexCode(src, i + 2, out, true); }
        else { out.push(src[i]); i++; }
      }
      if (src[i] === "`") { out.push("`"); i++; }
      prev = "`";
      word = "";
      continue;
    }
    if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") { out.push(src[i] + (src[i + 1] ?? "")); i += 2; }
        else { out.push(src[i]); i++; }
      }
      if (src[i] === c) { out.push(c); i++; }
      prev = c;
      word = "";
      continue;
    }
    const regexContext = prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_AFTER_WORD.has(word);
    if (c === "/" && regexContext) {
      out.push(c);
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        const d = src[i];
        if (d === "\\") { out.push(d + (src[i + 1] ?? "")); i += 2; }
        else {
          out.push(d);
          i++;
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
        }
      }
      prev = "/";
      word = "";
      continue;
    }
    out.push(c);
    if (/[A-Za-z0-9_$]/.test(c)) word = /[A-Za-z0-9_$]/.test(prev) ? word + c : c;
    else if (!/\s/.test(c)) word = "";
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return i;
}

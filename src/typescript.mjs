// The extension's own TypeScript compiler API, for checks that must read source structure
// (src/preflight/platform-keys.mjs, src/shortcuts/ast-scan.mjs). rx ships no parser of its own (its
// one runtime dependency is pngjs); every Raycast extension carries `typescript` as a
// devDependency. Loading it runs that package's code, so a command calls loadTypeScript only under
// an explicit `--extension-typescript`; `rx gates`, which runs the extension's build and lint
// anyway, is the one caller that passes it.

import { createRequire } from "node:module";
import { join } from "node:path";

/** Every node kind that binds a value name (a census of these finds shadows of an import). */
export const BINDER_PREDICATES = [
  "isVariableDeclaration", "isParameter", "isBindingElement", "isFunctionDeclaration", "isFunctionExpression",
  "isClassDeclaration", "isClassExpression", "isEnumDeclaration", "isEnumMember", "isModuleDeclaration",
  "isImportSpecifier", "isImportClause", "isNamespaceImport", "isImportEqualsDeclaration",
];

const REQUIRED_FUNCTIONS = [...BINDER_PREDICATES,
  "createSourceFile", "forEachChild", "isPropertyAssignment", "isShorthandPropertyAssignment", "isObjectLiteralExpression",
  "isArrayLiteralExpression", "isIdentifier", "isStringLiteral", "isNoSubstitutionTemplateLiteral", "isParenthesizedExpression",
  "isAsExpression", "isJsxAttribute", "isJsxElement", "isJsxSelfClosingElement", "isJsxOpeningElement", "isJsxExpression",
  "isJsxSpreadAttribute", "isJsxFragment", "isCallExpression", "isNewExpression", "isPropertyAccessExpression",
  "isArrowFunction", "isObjectBindingPattern", "isArrayBindingPattern", "isBlock", "isCatchClause", "isCaseBlock", "isModuleBlock",
  "isVariableStatement", "isExportDeclaration", "isNamedExports", "isExportAssignment",
  "isConditionalExpression", "isBinaryExpression", "isImportDeclaration", "isNamedImports", "isFunctionLike", "isIterationStatement",
];

/**
 * The compiler API resolved from the extension root (so a hoisted install counts), or null when it
 * cannot be loaded or lacks an API rx uses. Callers fall back, never pass blind.
 * @param {string} root
 * @returns {any}
 */
export function loadTypeScript(root) {
  let ts;
  try {
    ts = createRequire(join(root, "package.json"))("typescript");
  } catch {
    return null;
  }
  if (!ts || REQUIRED_FUNCTIONS.some((f) => typeof ts[f] !== "function")) return null;
  if (typeof ts.ScriptTarget?.Latest !== "number" || ["TS", "TSX", "JS", "JSX"].some((k) => typeof ts.ScriptKind?.[k] !== "number")) return null;
  return ts;
}

/** The script kind for a file name. @param {any} ts @param {string} file */
export function scriptKind(ts, file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Parse a file; `ok` is false when the parser reported syntax errors (or cannot say), so the tree
 * is not trusted to be complete. `parseDiagnostics` is where createSourceFile leaves them; when a
 * compiler does not expose it, the public transpileModule reports the same syntactic diagnostics.
 * @param {any} ts @param {string} file @param {string} text
 * @returns {{ sf: any, ok: boolean, errorLine: number }}
 */
export function parse(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
  /** @type {{ start?: number }[]} */
  let errors = [{}];
  if (Array.isArray(sf.parseDiagnostics)) errors = sf.parseDiagnostics;
  else if (typeof ts.transpileModule === "function") {
    try {
      errors = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit?.Preserve } }).diagnostics ?? [];
    } catch { /* stays untrusted */ }
  }
  const start = typeof errors[0]?.start === "number" ? errors[0].start : 0;
  return { sf, ok: errors.length === 0, errorLine: errors.length ? sf.getLineAndCharacterOfPosition(start).line + 1 : 0 };
}

/** Strip parentheses, `as`, `satisfies` and `<T>` assertions. @param {any} ts @param {any} node */
export function unwrap(ts, node) {
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
    else if (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node)) node = node.expression;
    else if (typeof ts.isTypeAssertionExpression === "function" && ts.isTypeAssertionExpression(node)) node = node.expression;
    else return node;
  }
}

/** A property name's text (identifier, string or plain template), or null. @param {any} ts @param {any} name */
export function propertyName(ts, name) {
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) return name.text;
  return null;
}

/** 1-based line of a position. @param {any} sf @param {number} pos */
export function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

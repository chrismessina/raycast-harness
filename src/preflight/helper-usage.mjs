// Greptile helper checks. failure-toasts uses the extension's TypeScript when authorized;
// the original text heuristic remains the fallback. script-utils stays a text check.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { BINDER_PREDICATES, lineOf, parse, propertyName, unwrap } from "../typescript.mjs";

/** @typedef {{ rel: string, code: string }} Source */
/** @typedef {{ file: string, line: number, text: string }} Hit */

// The osascript binary as a whole value: a literal that opens an argument list, an array element
// or an assignment and closes it, so `execFile("/usr/bin/osascript", …)` and `const BIN =
// "osascript"` match while the word quoted inside a longer message does not.
const OSASCRIPT_LITERAL = /(?:^|[(,[=:]|\breturn)\s*(["'`])(?:\/usr\/bin\/)?osascript\1(?=\s*(?:[,)\];}]|$))/gm;
// Any module load of the package, across lines: `from`, `require(`, `import(` and a side-effect `import "…"`.
const RUN_APPLESCRIPT_PKG = /(?:\bfrom|\brequire\s*\(|\bimport\s*\(|\bimport)\s*["']run-applescript["']/g;

/** @param {Source[]} sources @returns {Hit[]} */
export function handRolledScripts(sources) {
  /** @type {Hit[]} */
  const hits = [];
  // A test may drive osascript itself to set up the system it checks; it never ships to a user.
  for (const s of sources.filter((x) => !/\.test\.[cm]?[jt]sx?$/.test(x.rel))) {
    const lines = new Set();
    for (const re of [OSASCRIPT_LITERAL, RUN_APPLESCRIPT_PKG]) {
      // Report the line of the quoted token, not of a `(` or `require(` on an earlier line.
      for (const m of s.code.matchAll(re)) lines.add(lineAt(s.code, /** @type {number} */ (m.index) + m[0].search(/["'`]/)));
    }
    for (const line of [...lines].sort((a, b) => a - b)) hits.push({ file: s.rel, line, text: `${s.rel}:${line}` });
  }
  return hits;
}

/** @param {string} code @param {number} index */
const lineAt = (code, index) => code.slice(0, index).split("\n").length;

/**
 * Index of the bracket closing the one at `open`, or the end of the code when unbalanced.
 * @param {string} code @param {number} open
 */
function matching(code, open) {
  const pair = /** @type {Record<string, string>} */ ({ "{": "}", "(": ")" });
  const o = code[open], c = pair[o];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < code.length && code[i] !== ch && code[i] !== "\n"; i++) if (code[i] === "\\") i++;
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return code.length;
}

/** @param {string} code @returns {[number, number][]} */
function catchBlocks(code) {
  /** @type {[number, number][]} */
  const out = [];
  for (const m of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    const open = /** @type {number} */ (m.index) + m[0].length - 1;
    out.push([open, matching(code, open)]);
  }
  return out;
}

/**
 * Named function bodies: `function name(…) {` and `const name = (async) (…) => {`.
 * @param {string} code @returns {{ name: string, start: number, end: number }[]}
 */
function namedFunctions(code) {
  const out = [];
  const heads = [
    ...[...code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g)].map((m) => ({ name: m[1], paren: /** @type {number} */ (m.index) + m[0].length - 1 })),
    ...[...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g)].map((m) => ({ name: m[1], paren: /** @type {number} */ (m.index) + m[0].length - 1 })),
  ];
  for (const { name, paren } of heads) {
    const close = matching(code, paren);
    // Up to the body's `{`: an optional return type, and `=>` for an arrow.
    const rest = /^\s*(?::[^{=;]+?)?\s*(?:=>\s*)?\{/.exec(code.slice(close + 1));
    if (!rest) continue;
    const open = close + rest[0].length;
    out.push({ name, start: open, end: matching(code, open) });
  }
  return out;
}

/** @param {Source[]} sources @returns {Hit[]} */
function textFailureToasts(sources) {
  const files = sources.map((s) => ({ s, catches: catchBlocks(s.code), fns: namedFunctions(s.code) }));
  /** @param {number} i @param {[number, number][]} blocks */
  const inside = (i, blocks) => blocks.some(([a, b]) => i > a && i < b);
  /** Where `name(` is called inside a catch block, as file:line, or null. @param {string} name */
  const calledFromCatch = (name) => {
    const call = new RegExp(String.raw`(?<!function\s*)(?<![\w$.])${name.replace(/\$/g, "\\$")}\s*\(`, "g");
    for (const f of files) for (const m of f.s.code.matchAll(call)) if (inside(/** @type {number} */ (m.index), f.catches)) return `${f.s.rel}:${lineAt(f.s.code, /** @type {number} */ (m.index))}`;
    return null;
  };
  /** @type {Hit[]} */
  const hits = [];
  for (const f of files) {
    for (const m of f.s.code.matchAll(/\bstyle\s*:\s*Toast\.Style\.Failure\b/g)) {
      const i = /** @type {number} */ (m.index);
      const at = `${f.s.rel}:${lineAt(f.s.code, i)}`;
      if (inside(i, f.catches)) { hits.push({ file: f.s.rel, line: lineAt(f.s.code, i), text: `${at} (in a catch block)` }); continue; }
      const enclosing = f.fns.filter((fn) => i > fn.start && i < fn.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      const caller = enclosing ? calledFromCatch(enclosing.name) : null;
      if (enclosing && caller) hits.push({ file: f.s.rel, line: lineAt(f.s.code, i), text: `${at} (${enclosing.name}, called from a catch at ${caller})` });
    }
  }
  return hits;
}

/**
 * Parsed catch paths and one-hop identifier calls. Scopes bind declarations before calls are
 * resolved, so declaration order does not hide a shadow. Imports resolve only to parsed src
 * files; relative re-exports follow at most eight edges (no namespace/method calls).
 * @param {string} root
 * @param {{ file: string, rel: string, code: string }[]} sources
 * @param {{ warn: Function, pass: Function }} c
 * @param {any} ts
 */
export function handBuiltFailureToasts(root, sources, c, ts) {
  const ID = "failure-toast-helper";
  const advice = "show a caught error with showFailureToast(message, { title, primaryAction: Copy Error }) from @raycast/utils, not a hand-built showToast Failure";
  if (!ts) {
    const hits = textFailureToasts(sources);
    if (hits.length) c.warn(ID, `${advice} (text scan only; pass --extension-typescript for the parsed check)`, hits);
    return c.pass(ID, "no hand-built Failure toast found by the text scan (pass --extension-typescript, as rx gates does, for the parsed check)");
  }

  /** @typedef {{ parent: Scope | null, functionScope: boolean, bindings: Map<string, any> }} Scope */
  /** @type {Map<string, any>} */
  const files = new Map();
  /** @type {Hit[]} */
  const unparsed = [];
  // The shared preflight census predates .mts/.cts. Supplement it here without changing
  // the input or behavior of the other checks (including the text fallback).
  const parsedSources = [...sources];
  const supplement = (/** @type {string} */ dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const file = join(dir, e.name);
      if (e.isDirectory()) supplement(file);
      else if (/\.[mc]ts$/.test(e.name)) parsedSources.push({ file, rel: relative(root, file), code: "" });
    }
  };
  supplement(join(root, "src"));
  for (const s of parsedSources) {
    let text;
    try { text = readFileSync(s.file, "utf8"); } catch { unparsed.push({ file: s.rel, line: 1, text: `${s.rel}:1 (not fully inspected)` }); continue; }
    const { sf, ok, errorLine } = parse(ts, s.file, text);
    if (!ok) {
      unparsed.push({ file: s.rel, line: errorLine, text: `${s.rel}:${errorLine} (syntax error; not fully inspected)` });
      continue;
    }
    files.set(resolve(s.file), { s, sf, scopes: new WeakMap(), exports: new Map(), reexports: new Map(), stars: [], hits: [], calls: [] });
  }
  const isFunction = (/** @type {any} */ n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
  /** @param {Scope} scope @param {any} name @param {any} binding */
  const bind = (scope, name, binding) => {
    if (!name) return;
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, binding);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const e of name.elements) if (ts.isBindingElement(e)) bind(scope, e.name, null);
    }
  };
  /** @param {Scope | null} scope @param {string} name @returns {any} */
  const lookup = (scope, name) => {
    for (; scope; scope = scope.parent) if (scope.bindings.has(name)) return scope.bindings.get(name);
    return null;
  };
  const exported = (/** @type {any} */ n, /** @type {number} */ kind) => n.modifiers?.some((/** @type {any} */ m) => m.kind === kind);
  const isFailure = (/** @type {any} */ n) => {
    if (!ts.isPropertyAssignment(n) || propertyName(ts, n.name) !== "style") return false;
    const v = unwrap(ts, n.initializer);
    return ts.isPropertyAccessExpression(v) && v.name.text === "Failure" && ts.isPropertyAccessExpression(v.expression)
      && v.expression.name.text === "Style" && ts.isIdentifier(v.expression.expression) && v.expression.expression.text === "Toast";
  };
  for (const f of files.values()) {
    /** @type {Scope} */
    const top = { parent: null, functionScope: true, bindings: new Map() };
    f.top = top;
    /** @param {any} n @param {Scope} outer */
    const visit = (n, outer) => {
      // A declaration binds outside the scope its own body introduces.
      if (ts.isFunctionDeclaration(n)) bind(outer, n.name, n);
      else if (ts.isVariableDeclaration(n)) {
        let target = outer;
        if (!ts.isCatchClause(n.parent) && !(n.parent.flags & ts.NodeFlags.BlockScoped)) while (!target.functionScope && target.parent) target = target.parent;
        const value = n.initializer && unwrap(ts, n.initializer);
        bind(target, n.name, value && isFunction(value) ? value : null);
      } else if (ts.isImportClause(n) && !n.isTypeOnly) {
        bind(outer, n.name, { module: n.parent.moduleSpecifier.text, imported: "default" });
      } else if (ts.isImportSpecifier(n) && !n.isTypeOnly && !n.parent.parent.isTypeOnly) {
        bind(outer, n.name, { module: n.parent.parent.parent.moduleSpecifier.text, imported: (n.propertyName ?? n.name).text });
      } else if (BINDER_PREDICATES.some(p => ts[p](n)) && !ts.isBindingElement(n) && !ts.isFunctionExpression(n) && !ts.isClassExpression(n)) bind(outer, n.name, null);

      let scope = outer;
      if (ts.isFunctionLike(n) || ts.isBlock(n) || ts.isCatchClause(n) || ts.isIterationStatement(n, false)
        || ts.isCaseBlock(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isModuleBlock(n)) {
        scope = { parent: outer, functionScope: ts.isFunctionLike(n), bindings: new Map() };
        if (ts.isFunctionExpression(n)) bind(scope, n.name, n);
        if (ts.isClassExpression(n)) bind(scope, n.name, null);
      }
      f.scopes.set(n, scope);
      if (isFailure(n)) f.hits.push(n);
      if (ts.isCallExpression(n)) f.calls.push(n);
      ts.forEachChild(n, (/** @type {any} */ child) => { visit(child, scope); });
    };
    visit(f.sf, top);
    for (const n of f.sf.statements) {
      if (exported(n, ts.SyntaxKind.ExportKeyword)) {
        if (isFunction(n)) {
          if (exported(n, ts.SyntaxKind.DefaultKeyword)) f.exports.set("default", n);
          else if (n.name) f.exports.set(n.name.text, n);
        } else if (ts.isVariableStatement(n)) {
          for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) f.exports.set(d.name.text, lookup(top, d.name.text));
        } else if ((ts.isClassDeclaration(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
          // A local non-function value (for example a class) also shadows export *.
          f.exports.set(exported(n, ts.SyntaxKind.DefaultKeyword) ? "default" : n.name.text, lookup(top, n.name.text));
        }
      }
      if (ts.isExportDeclaration(n) && !n.moduleSpecifier && !n.isTypeOnly && n.exportClause && ts.isNamedExports(n.exportClause)) {
        for (const e of n.exportClause.elements) if (!e.isTypeOnly) f.exports.set(e.name.text, lookup(top, (e.propertyName ?? e.name).text));
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && !n.isTypeOnly) {
        const module = n.moduleSpecifier.text;
        if (!n.exportClause) f.stars.push({ module });
        else if (ts.isNamedExports(n.exportClause)) {
          for (const e of n.exportClause.elements) if (!e.isTypeOnly) {
            f.reexports.set(e.name.text, { module, imported: (e.propertyName ?? e.name).text });
          }
        }
      }
      if (ts.isExportAssignment(n) && !n.isExportEquals) {
        const value = unwrap(ts, n.expression);
        f.exports.set("default", ts.isIdentifier(value) ? lookup(top, value.text) : value);
      }
    }
  }
  /** @param {any} node */
  const inCatch = (node) => {
    for (let n = node; n.parent; n = n.parent) {
      if (ts.isCatchClause(n.parent) && n.parent.block === n) return true;
      if (isFunction(n)) {
        let arg = n;
        while (arg.parent && unwrap(ts, arg.parent) === n) arg = arg.parent;
        const call = arg.parent;
        if (ts.isCallExpression(call) && call.arguments[0] === arg && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "catch") return true;
      }
    }
    return false;
  };
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  /** @param {any} f @param {string} module @returns {any} */
  const resolveModule = (f, module) => {
    if (!/^\.\.?\//.test(module)) return null;
    const base = resolve(dirname(f.s.file), module);
    const src = resolve(root, "src");
    if (base !== src && !base.startsWith(`${src}/`)) return null;
    return [base, ...extensions.map(e => base + e), ...extensions.map(e => `${base}/index${e}`)].map(p => files.get(p)).find(Boolean);
  };
  /**
   * Track (file, export name), so cycles terminate without hiding other names or star branches.
   * The initial import is free; at most eight re-export edges may be followed.
   * @param {any} f @param {string} name @param {Set<string>} visited @param {number} depth
   * @returns {{ f: any, fn: any } | null}
   */
  const resolveExport = (f, name, visited, depth) => {
    const key = `${f.s.file}\0${name}`;
    if (visited.has(key)) return null;
    visited.add(key);
    if (f.exports.has(name)) return target(f, f.exports.get(name), visited, depth);
    if (depth >= 8) return null;
    if (f.reexports.has(name)) return target(f, f.reexports.get(name), visited, depth + 1);
    // export * never forwards default, and export * as ns was not indexed above.
    if (name === "default") return null;
    for (const star of f.stars) {
      const result = target(f, { ...star, imported: name }, new Set(visited), depth + 1);
      if (result) return result;
    }
    return null;
  };
  /**
   * @param {any} f @param {any} binding @param {Set<string>} [visited] @param {number} [depth]
   * @returns {{ f: any, fn: any } | null}
   */
  const target = (f, binding, visited = new Set(), depth = 0) => {
    if (!binding) return null;
    if (isFunction(binding)) return { f, fn: binding };
    if (typeof binding.module !== "string") return null;
    const dest = resolveModule(f, binding.module);
    return dest ? resolveExport(dest, binding.imported, visited, depth) : null;
  };
  /** @type {Map<any, Hit>} */
  const hits = new Map();
  const record = (/** @type {any} */ f, /** @type {any} */ n, /** @type {string} */ reason) => {
    const line = lineOf(f.sf, n.name.getStart(f.sf));
    hits.set(n, { file: f.s.rel, line, text: `${f.s.rel}:${line} (${reason})` });
  };
  for (const f of files.values()) for (const n of f.hits) if (inCatch(n)) record(f, n, "in a catch block");
  for (const f of files.values()) for (const call of f.calls) {
    const expression = unwrap(ts, call.expression);
    const handler = ts.isPropertyAccessExpression(expression) && expression.name.text === "catch" && call.arguments[0]
      ? unwrap(ts, call.arguments[0]) : null;
    const identifier = handler && ts.isIdentifier(handler) ? handler
      : inCatch(call) && ts.isIdentifier(expression) ? expression : null;
    if (!identifier) continue;
    const name = identifier.text;
    const dest = target(f, lookup(f.scopes.get(call), name));
    if (!dest?.fn.body) continue;
    for (const n of dest.f.hits) {
      if (hits.has(n)) continue;
      for (let parent = n.parent; parent; parent = parent.parent) {
        if (parent === dest.fn.body) {
          record(dest.f, n, `${name}, called from a catch at ${f.s.rel}:${lineOf(f.sf, call.getStart(f.sf))}`);
          break;
        }
      }
    }
  }
  if (hits.size || unparsed.length) return c.warn(ID, [hits.size ? advice : "", unparsed.length ? `${unparsed.length} source file(s) did not parse cleanly and were not fully inspected` : ""].filter(Boolean).join("; "), [...hits.values(), ...unparsed]);
  c.pass(ID, `no hand-built Failure toast on a catch path in src/ (parsed with typescript ${ts.version})`);
}

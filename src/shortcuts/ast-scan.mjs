// The shortcut scan of src/shortcuts/scan.mjs, read from the extension's own TypeScript syntax tree
// instead of from text. Same output contract (Shortcut, Group, branches); scan.mjs falls back to
// its text scan per file when no compiler can be loaded or a file does not parse cleanly.
//
// Why: a text scan has to guess where strings, regex literals, templates and JSX text start and
// end, and every guess was a false PASS or a false FAIL (a `}` in a regex closing an object early,
// `shortcut={Keyboard.Shortcut.Common.Copy}` inside a JSX string read as a real shortcut). The
// parser already knows.
//
// WHAT IT RESOLVES (as the text scan documents)
//   shortcut={Keyboard.Shortcut.Common.X} / Shortcut.Common.X / Common.X  → the table's X
//   shortcut={{ modifiers: [...], key: "x" }}                              → one binding, every platform
//   shortcut={{ macOS: {...}, Windows: {...} }}  (`windows` accepted)       → one binding per platform
//   shortcut: {...} or shortcut: Common.X as a property of an object literal (a toast action)
//   `{ shortcut }` shorthand, or any other expression                      → unresolved (declared)
// A panel is a `<ActionPanel>…</ActionPanel>` element (a self-closing one has no children); a toast
// is a `showToast(…)` / `showFailureToast(…)` / `Toast(…)` / `new Toast(…)` call. A site belongs to
// the innermost panel or toast that contains it, else to the file's loose group.
// Exclusivity: the two sides of `cond ? (<JSX…>) : …` never render together, unless a function or
// loop between the ternary and its group may run it once per item.
// Unresolved declarations: a props spread on `Action`, `Action.*` or `ActionPanel.Submenu`, and a
// capitalized component rendered as a panel child (not a prop value, not an ActionPanel part, not
// a Fragment).

import { PLATFORMS, readBinding } from "./table.mjs";
import { BINDER_PREDICATES, lineOf, propertyName, unwrap } from "../typescript.mjs";

const COMMON_RE = /^(?:Keyboard\.)?(?:Shortcut\.)?Common\.([A-Z][A-Za-z]*)$/;
const TOAST_CALLS = new Set(["showToast", "showFailureToast", "Toast"]);

/**
 * A literal expression as plain data, or undefined: strings and plain templates (decoded as the
 * runtime sees them), null, booleans, numbers (any notation TypeScript reads, `-` allowed), and
 * arrays and objects of them. This is the runtime value, so it accepts more than the text scan's
 * JSON reading (`"\x78"` is `"x"`); where the text scan reads a literal at all, the two agree.
 * @param {any} ts @param {any} node
 * @returns {unknown}
 */
function literalValue(ts, node) {
  node = unwrap(ts, node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  const K = ts.SyntaxKind;
  if (node.kind === K.NullKeyword) return null;
  if (node.kind === K.TrueKeyword) return true;
  if (node.kind === K.FalseKeyword) return false;
  if (node.kind === K.NumericLiteral) return Number(node.text);
  if (node.kind === K.PrefixUnaryExpression && node.operator === K.MinusToken && node.operand.kind === K.NumericLiteral) return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node)) {
    const out = node.elements.map((/** @type {any} */ e) => literalValue(ts, e));
    return out.every((v) => v !== undefined) ? out : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const name = propertyName(ts, p.name);
      const value = literalValue(ts, p.initializer);
      // In a JavaScript object literal `__proto__: {…}` sets the prototype, and Raycast reads the
      // bindings it inherits; that is not a static value, so the shortcut is unresolved.
      if (name === null || name === "__proto__" || value === undefined) return undefined;
      out[name] = value;
    }
    return out;
  }
  return undefined;
}

/**
 * The bindings a shortcut literal declares, as parseShortcutLiteral reads them.
 * @param {unknown} obj
 * @returns {{ kind: "single" | "platform", bindings: Partial<Record<"macOS" | "Windows", import("./table.mjs").Binding>> } | null}
 */
export function bindingsOf(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const single = readBinding(obj);
  if (single) return { kind: "single", bindings: { macOS: single, Windows: single } };
  /** @type {Partial<Record<"macOS" | "Windows", import("./table.mjs").Binding>>} */
  const bindings = {};
  for (const p of PLATFORMS) {
    const raw = /** @type {any} */ (obj)[p] ?? (p === "Windows" ? /** @type {any} */ (obj).windows : undefined);
    if (raw === undefined) continue;
    const b = readBinding(raw);
    if (!b) return null;
    bindings[p] = b;
  }
  return Object.keys(bindings).length ? { kind: "platform", bindings } : null;
}

/** The text of a tag name (`Action.Push`). @param {any} node */
const tagName = (node) => node.tagName.getText();

/** The `title` attribute of a JSX opening or self-closing element, when it is a plain string. @param {any} ts @param {any} el */
function jsxTitle(ts, el) {
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a) || propertyName(ts, a.name) !== "title" || !a.initializer) continue;
    let v = a.initializer;
    if (ts.isJsxExpression(v)) v = v.expression;
    if (v && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) return v.text;
    return null;
  }
  return null;
}

/** The `title` property of an object literal, when it is a plain string. @param {any} ts @param {any} obj */
function objectTitle(ts, obj) {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || propertyName(ts, p.name) !== "title") continue;
    const v = unwrap(ts, p.initializer);
    return ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? v.text : null;
  }
  return null;
}

/**
 * Scan one parsed file.
 * @param {any} ts
 * @param {any} sf a source file from typescript.mjs parse(), parsed cleanly
 * @param {string} file display path
 * @param {import("./scan.mjs").Group[]} groups accumulates groups (ids continue across files)
 * @returns {import("./scan.mjs").Shortcut[]}
 */
export function scanTree(ts, sf, file, groups) {
  /** @type {{ node: any, kind: "panel" | "toast", id: number }[]} */
  const panels = [];
  /** @type {{ node: any, kind: "panel" | "toast", id: number }[]} */
  const toasts = [];
  /** @type {any[]} */
  const ternaries = [];
  /** @type {{ node: any, at: number, op: "jsx" | "prop" }[]} */
  const sites = [];
  /** @type {any[]} */
  const tags = [];

  const visit = (/** @type {any} */ node) => {
    if (ts.isJsxElement(node) && tagName(node.openingElement) === "ActionPanel") panels.push({ node, kind: "panel", id: -1 });
    else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name !== null && TOAST_CALLS.has(name) && (name === "Toast" || ts.isCallExpression(node))) toasts.push({ node, kind: "toast", id: -1 });
    }
    if (ts.isConditionalExpression(node) && ts.isParenthesizedExpression(node.whenTrue)) {
      const inner = node.whenTrue.expression;
      if (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner) || ts.isJsxFragment(inner)) ternaries.push(node);
    }
    if (ts.isJsxAttribute(node) && propertyName(ts, node.name) === "shortcut" && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      sites.push({ node, at: node.name.getStart(sf), op: "jsx" });
    } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && propertyName(ts, node.name) === "shortcut" && ts.isObjectLiteralExpression(node.parent)) {
      sites.push({ node, at: node.name.getStart(sf), op: "prop" });
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) tags.push(node);
    ts.forEachChild(node, visit);
    return undefined; // a truthy return would stop forEachChild early
  };
  visit(sf);

  // Names imported from @raycast/api under their own name, and bound nowhere else in the file: only
  // these identify a view. A renamed import (`List as Form`), a local component called `Form`, or
  // any other binding of the name in any scope makes the host unknown (Codex H1). A whole-file
  // census instead of scope resolution: an unrelated binding only costs a WARN.
  /** @type {Set<string>} */
  const apiNames = new Set();
  const apiSpecifiers = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || st.moduleSpecifier.text !== "@raycast/api" || st.importClause?.isTypeOnly) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly && (!el.propertyName || el.propertyName.text === el.name.text)) {
      apiNames.add(el.name.text);
      apiSpecifiers.add(el);
    }
  }
  const binders = BINDER_PREDICATES.map((f) => ts[f]);
  const census = (/** @type {any} */ node) => {
    if (!apiSpecifiers.has(node) && node.name && ts.isIdentifier(node.name) && binders.some((is) => is(node))) apiNames.delete(node.name.text);
    ts.forEachChild(node, census);
    return undefined;
  };
  if (apiNames.size) census(sf);

  /**
   * The element whose `actions={…}` holds `panel`, through parentheses, `cond ? … : …` and `a && …`;
   * null when the panel is anywhere else (returned by a component, assigned to a variable) or the
   * element's root name is not an unrenamed @raycast/api import.
   * @param {any} panel
   */
  const hostOf = (panel) => {
    let p = panel.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p))) p = p.parent;
    if (!p || !ts.isJsxExpression(p) || !p.parent || !ts.isJsxAttribute(p.parent) || propertyName(ts, p.parent.name) !== "actions") return null;
    const el = p.parent.parent?.parent;
    if (!el || !(ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el))) return null;
    const name = tagName(el);
    return apiNames.has(name.split(".")[0]) ? name : null;
  };

  // Group ids in the text scan's order: panels, then toasts, then the loose group on demand.
  const ranges = [...panels, ...toasts];
  for (const r of ranges) {
    r.id = groups.length;
    groups.push({ id: r.id, kind: r.kind, file, line: lineOf(sf, r.node.getStart(sf)), host: r.kind === "panel" ? hostOf(r.node) : null });
  }
  /** @type {number | null} */
  let looseId = null;
  /** The innermost panel or toast containing `node`, or the loose group. @param {any} node */
  const groupFor = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      const r = ranges.find((x) => x.node === p);
      if (r) return { id: r.id, node: r.node };
    }
    if (looseId === null) {
      looseId = groups.length;
      groups.push({ id: looseId, kind: "loose", file, line: 1, host: null });
    }
    return { id: looseId, node: null };
  };
  /** Does a function or loop sit between `inner` and `outer` (so `inner` may run once per item)? @param {any} inner @param {any} outer */
  const repeatedBetween = (inner, outer) => {
    for (let p = inner.parent; p && p !== outer; p = p.parent) if (ts.isFunctionLike(p) || ts.isIterationStatement(p, false)) return true;
    return false;
  };
  /** Ternary sides holding `node`. @param {any} node @param {any} groupNode */
  const branchesFor = (node, groupNode) => {
    /** @type {string[]} */
    const out = [];
    ternaries.forEach((t, i) => {
      if (groupNode && repeatedBetween(t, groupNode)) return;
      for (let p = node; p; p = p.parent) {
        if (p === t.whenTrue) { out.push(`${i}:a`); break; }
        if (p === t.whenFalse) { out.push(`${i}:b`); break; }
        if (p === t) break;
      }
    });
    return out;
  };
  const oneLine = (/** @type {string} */ s) => s.replace(/\s+/g, " ").slice(0, 120);

  /** @type {import("./scan.mjs").Shortcut[]} */
  const out = [];
  for (const { node, at, op } of sites) {
    const expr = op === "jsx" ? node.initializer.expression : ts.isShorthandPropertyAssignment(node) ? node.name : node.initializer;
    const { id: group, node: groupNode } = groupFor(node);
    const title = op === "jsx" ? jsxTitle(ts, node.parent.parent) : objectTitle(ts, node.parent);
    /** @type {import("./scan.mjs").Shortcut} */
    const sc = { file, line: lineOf(sf, at), group, title, source: oneLine(expr.getText(sf)), kind: "unresolved", bindings: {}, branches: branchesFor(node, groupNode) };
    const value = unwrap(ts, expr);
    const common = COMMON_RE.exec(value.getText(sf).replace(/\s+/g, ""));
    if (common && !ts.isShorthandPropertyAssignment(node)) { sc.kind = "common"; sc.name = common[1]; }
    else if (ts.isObjectLiteralExpression(value)) {
      const lit = bindingsOf(literalValue(ts, value));
      if (lit) { sc.kind = lit.kind; sc.bindings = lit.bindings; }
    }
    out.push(sc);
  }

  for (const el of tags) {
    const name = tagName(el);
    const actionLike = name === "Action" || name.startsWith("Action.") || name === "ActionPanel.Submenu";
    const panelPart = name === "ActionPanel" || name.startsWith("ActionPanel.") || name === "Fragment" || name.endsWith(".Fragment");
    const { id: group, node: groupNode } = groupFor(el);
    if (actionLike) {
      if (!el.attributes.properties.some((/** @type {any} */ a) => ts.isJsxSpreadAttribute(a))) continue;
    } else {
      if (panelPart || !/^[A-Z]/.test(name) || groupNode === null || groups[group].kind !== "panel") continue;
      let prop = false;
      for (let p = el.parent; p && p !== groupNode; p = p.parent) if (ts.isJsxAttribute(p)) { prop = true; break; }
      if (prop) continue; // a prop value such as target={<View/>}
    }
    out.push({ file, line: lineOf(sf, el.getStart(sf)), group, title: jsxTitle(ts, el), source: oneLine(el.getText(sf)), kind: "unresolved", bindings: {}, branches: branchesFor(el, groupNode) });
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

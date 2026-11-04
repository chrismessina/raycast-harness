/**
 * ESLint rule: never `hide()` a toast from a `useEffect` cleanup.
 *
 * A Toast handle has no identity: there is one toast slot, `showToast` replaces whatever occupies
 * it, and `hide()` dismisses whatever is visible now (house-style `toast-no-id`). An effect cleanup
 * is deferred, so it fires exactly when the slot has moved on: it dismisses the failure toast that
 * replaced the spinner, or the next run's toast. Put the toast inside the promise and hide it
 * there, guarded by a per-run ownership token.
 *
 * Reports `x.hide()` (any object) inside a function that is returned from the first argument of
 * `useEffect` / `useLayoutEffect` (also `React.useEffect`), through any nesting such as
 * `return () => { if (toast) toast.hide(); }`, and inside a function bound in the effect body and
 * returned by name (`const cleanup = () => toast.hide(); return cleanup;`, `function cleanup() {}`),
 * resolved through the scope manager so a same-named function in another scope is not confused.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow toast.hide() in a useEffect cleanup, which dismisses whatever toast is on screen by then",
      recommended: true,
    },
    schema: [],
    messages: {
      hideInCleanup:
        "`{{text}}` runs in an effect cleanup, after the toast slot has moved on; it will dismiss whatever toast is visible then. Hide inside the promise with an ownership guard instead.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    const FN = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);

    /** @param {any} node */
    const isEffectCall = (node) => {
      if (node?.type !== "CallExpression") return false;
      const c = node.callee;
      const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : null;
      return name === "useEffect" || name === "useLayoutEffect";
    };

    /**
     * Is `fn` returned by `outer`: directly, as an arrow's expression body, or by the name it is
     * bound to in `outer`'s body (`const cleanup = () => …; return cleanup;`)?
     * @param {any} fn @param {any} outer
     */
    const returnedBy = (fn, outer) => {
      const p = fn.parent;
      if (p === outer && outer.type === "ArrowFunctionExpression" && outer.body === fn) return true;
      if (p?.type === "ReturnStatement" && nearestFunction(p) === outer) return true;
      // Bound by name: resolve the binding through the scope manager and look for a `return <id>`
      // in `outer` that references this very variable (never a same-spelled variable elsewhere).
      const decl = fn.type === "FunctionDeclaration" && fn.id ? fn : p?.type === "VariableDeclarator" && p.id.type === "Identifier" && p.init === fn ? p : null;
      if (!decl) return false;
      const variable = sourceCode.getDeclaredVariables(decl)[0];
      if (!variable) return false;
      return variable.references.some((ref) => {
        const id = ref.identifier;
        const ret = /** @type {any} */ (id).parent;
        return ret?.type === "ReturnStatement" && ret.argument === id && nearestFunction(ret) === outer;
      });
    };

    /** @param {any} node */
    const nearestFunction = (node) => {
      for (let n = node.parent; n; n = n.parent) if (FN.has(n.type)) return n;
      return null;
    };

    return {
      /** @param {any} node */
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== "MemberExpression" || c.computed || c.property.name !== "hide") return;
        // Walk outward: the cleanup is a function returned by the effect callback, which is the
        // first argument of useEffect. Intermediate functions (an `if` is not one) are not allowed,
        // but nested blocks are.
        const cleanup = nearestFunction(node);
        if (!cleanup) return;
        const effectCb = nearestFunction(cleanup);
        if (!effectCb || !returnedBy(cleanup, effectCb)) return;
        if (!isEffectCall(effectCb.parent) || effectCb.parent.arguments[0] !== effectCb) return;
        context.report({ node, messageId: "hideInCleanup", data: { text: sourceCode.getText(node) } });
      },
    };
  },
};

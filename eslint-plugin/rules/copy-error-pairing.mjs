/**
 * ESLint rule: every failure toast carries a "Copy Error" primary action, checked per call site.
 *
 * The house-style rule (`copy-error`) is a pairing review, not a count: one compliant toast can mask
 * ten that are not, so each failure site is read on its own. Three ways a failure toast is made:
 *
 *   showToast({ style: Toast.Style.Failure, … })   → the same object needs `primaryAction: { title: "Copy Error", … }`
 *   new Toast({ style: Toast.Style.Failure, … })    → same
 *   toast.style = Toast.Style.Failure               → the same block needs `toast.primaryAction = { title: "Copy Error", … }`
 *   showFailureToast(error, { … })                  → the options need that `primaryAction`; its own default is
 *                                                     Report Error / Copy Logs, not Copy Error
 *
 * Helper forms are accepted: a call to a name in `helpers` (default `showError` and `failToast`, the
 * @chrismessina/raycast-kit helpers that attach Copy Error themselves) is compliant without
 * inspection, and so is `showFailureToast` when its name is listed there (a local wrapper). A
 * `primaryAction` or `title` that is not a literal (a variable, a helper's return) is accepted: the
 * rule reports only what it can read. Spreads respect property order: `{ ...opts, primaryAction:
 * { title: "Retry" } }` is known wrong (the explicit property wins), while `{ primaryAction: …,
 * ...opts }` defers, since the spread may override.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Every failure toast sets a primaryAction titled \"Copy Error\" at the same call site",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          /** Callee names that build a compliant failure toast themselves. */
          helpers: { type: "array", items: { type: "string" } },
          /** The required action title. */
          title: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing: "Failure toast without a {{title}} primaryAction; add `primaryAction: { title: \"{{title}}\", onAction: () => Clipboard.copy(message) }` on this toast.",
      missingOptions: "showFailureToast attaches Report Error / Copy Logs, not {{title}}; pass `{ primaryAction: { title: \"{{title}}\", … } }` as its second argument.",
      missingAssignment: "`{{object}}.style = Toast.Style.Failure` without `{{object}}.primaryAction = { title: \"{{title}}\", … }` in the same block.",
    },
  },

  create(context) {
    const options = /** @type {{ helpers?: string[], title?: string } | undefined} */ (context.options[0]);
    const helpers = new Set(options?.helpers ?? ["showError", "failToast"]);
    const title = options?.title ?? "Copy Error";
    const sourceCode = context.sourceCode;

    /** @param {any} node */
    const calleeName = (node) => (node.type === "Identifier" ? node.name : node.type === "MemberExpression" && !node.computed ? node.property.name : null);

    /** `Toast.Style.Failure` (or `X.Style.Failure`). @param {any} node */
    const isFailureStyle = (node) =>
      node?.type === "MemberExpression" && !node.computed && node.property.name === "Failure" && node.object?.type === "MemberExpression" && node.object.property?.name === "Style";

    /**
     * The effective definition of `name` in an object literal, honoring source order: the last
     * explicit property wins unless a spread comes after it, in which case the value is unknown.
     * @param {any} obj @param {string} name
     * @returns {{ kind: "absent" } | { kind: "unknown" } | { kind: "value", node: any }}
     */
    const lastOf = (obj, name) => {
      /** @type {{ kind: "absent" } | { kind: "unknown" } | { kind: "value", node: any }} */
      let state = { kind: "absent" };
      for (const p of obj.properties) {
        if (p.type === "SpreadElement") state = { kind: "unknown" };
        else if (p.type === "Property" && keyName(p) === name) state = { kind: "value", node: p.value };
      }
      return state;
    };

    /** The property name of a non-computed Identifier or string-literal key (`title` and `"title"` alike). @param {any} p */
    const keyName = (p) => (p.computed ? null : p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" && typeof p.key.value === "string" ? p.key.value : null);

    /**
     * Does an ObjectExpression carry a compliant `primaryAction`? Unknown (spread-overridable) and
     * non-literal forms are accepted.
     * @param {any} obj
     */
    const hasCopyError = (obj) => {
      const action = lastOf(obj, "primaryAction");
      if (action.kind === "absent") return false;
      if (action.kind === "unknown") return true;
      if (action.node.type !== "ObjectExpression") return true; // a variable or helper result
      const t = lastOf(action.node, "title");
      if (t.kind === "absent") return false;
      if (t.kind === "unknown") return true;
      if (t.node.type === "Literal") return t.node.value === title;
      if (t.node.type === "TemplateLiteral" && t.node.expressions.length === 0) return t.node.quasis[0].value.cooked === title;
      return true; // not a literal: accepted
    };

    return {
      /** @param {any} node */
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || helpers.has(name)) return;
        if (name === "showFailureToast") {
          const opts = node.arguments[1];
          if (!opts) return context.report({ node, messageId: "missingOptions", data: { title } });
          if (opts.type !== "ObjectExpression") return; // options built elsewhere: accepted
          if (!hasCopyError(opts)) context.report({ node, messageId: "missingOptions", data: { title } });
          return;
        }
        if (name === "showToast") checkOptions(node, node.arguments[0]);
      },
      /** @param {any} node */
      NewExpression(node) {
        if (calleeName(node.callee) === "Toast") checkOptions(node, node.arguments[0]);
      },
      /** @param {any} node */
      AssignmentExpression(node) {
        if (node.operator !== "=" || node.left.type !== "MemberExpression" || node.left.computed || node.left.property.name !== "style") return;
        if (!isFailureStyle(node.right)) return;
        const objectText = sourceCode.getText(node.left.object);
        const block = sourceCode.getAncestors(node).reverse().find((a) => a.type === "BlockStatement" || a.type === "Program");
        const paired = /** @type {any} */ (block).body.some((/** @type {any} */ st) => {
          if (st.type !== "ExpressionStatement") return false;
          let e = st.expression;
          if (e.type === "AwaitExpression") e = e.argument;
          if (e.type !== "AssignmentExpression" || e.left.type !== "MemberExpression" || e.left.computed || e.left.property.name !== "primaryAction") return false;
          if (sourceCode.getText(e.left.object) !== objectText) return false;
          if (e.right.type !== "ObjectExpression") return true;
          return hasCopyError({ properties: [{ type: "Property", computed: false, key: { type: "Identifier", name: "primaryAction" }, value: e.right }] });
        });
        if (!paired) context.report({ node, messageId: "missingAssignment", data: { object: objectText, title } });
      },
    };

    /** @param {any} report @param {any} opts */
    function checkOptions(report, opts) {
      if (!opts || opts.type !== "ObjectExpression") return; // options built elsewhere: accepted
      const style = lastOf(opts, "style");
      if (style.kind !== "value" || !isFailureStyle(style.node)) return; // not a failure, or a later spread may change it
      if (!hasCopyError(opts)) context.report({ node: report, messageId: "missing", data: { title } });
    }
  },
};

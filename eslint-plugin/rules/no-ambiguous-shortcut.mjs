/**
 * ESLint rule: on an extension that targets macOS and Windows, a single-form shortcut that uses an
 * ambiguous modifier must name both platforms.
 *
 * Raycast's keyboard reference: "If the shortcut contains some 'ambiguous' modifiers (eg. `ctrl`,
 * or `cmd`, or `windows`), you will need to specify the shortcut for both platforms." A bare `cmd`
 * does not exist on Windows and a bare `ctrl` is a different key on each platform. `opt`/`alt` and
 * `shift` are unambiguous and may stay a plain object.
 *
 * Covers the `shortcut` JSX prop and every `shortcut:` object property (a toast's `primaryAction`
 * and `secondaryAction`, an action object built in a helper). Reads `platforms` from the rule
 * option, else from the nearest package.json above the linted file; an absent field means macOS only (the field postdates
 * Windows support) and the rule then reports nothing. The `table` option (a file written by
 * `rx shortcuts runtime`) lets the message name the `Common` constant a literal spells out, so the
 * fix is the constant rather than a hand-written second platform. It also reports the deprecated
 * lowercase `windows` platform key (`@raycast/api` 2.x: "Use Windows instead").
 *
 */
import { commonMatches, isAmbiguous, isShortcutValue, platformsFor, readShortcutObject, tableFor } from "../lib/shortcut-ast.mjs";

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "On a macOS + Windows extension, a shortcut using cmd/ctrl/windows must name both platforms",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          /** The platforms the extension targets; defaults to `platforms` in <cwd>/package.json, else ["macOS"]. */
          platforms: { type: "array", items: { enum: ["macOS", "Windows"] } },
          /** A Keyboard.Shortcut.Common table written by `rx shortcuts runtime`, used to name the constant a literal matches. */
          table: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      ambiguous:
        "This extension targets macOS and Windows; a shortcut using {{modifiers}} must name both platforms: `{ macOS: {…}, Windows: {…} }`.",
      ambiguousMatchesCommon:
        "This extension targets macOS and Windows; a shortcut using {{modifiers}} must name both platforms. The literal is {{match}} — if that is the meaning, use the constant; otherwise write `{ macOS: {…}, Windows: {…} }`.",
      lowercaseWindows: "Platform key `windows` is deprecated in @raycast/api 2.x; write `Windows`.",
    },
  },

  create(context) {
    const options = /** @type {{ platforms?: string[], table?: string } | undefined} */ (context.options[0]);
    const cwd = context.cwd ?? process.cwd();
    const platforms = platformsFor(options, context.filename && context.filename !== "<input>" ? context.filename : cwd);
    const crossPlatform = platforms.includes("macOS") && platforms.includes("Windows");
    const table = tableFor(options?.table, cwd);

    return {
      /** @param {any} node */
      ObjectExpression(node) {
        if (!isShortcutValue(node)) return;
        const value = readShortcutObject(node);
        if (!value) return;
        if (value.lowercaseWindows) context.report({ node, messageId: "lowercaseWindows" });
        if (!crossPlatform || value.kind !== "single") return;
        const binding = /** @type {import("../lib/shortcut-ast.mjs").Binding} */ (value.bindings.macOS);
        if (!isAmbiguous(binding)) return;
        const modifiers = binding.modifiers.filter((m) => ["cmd", "ctrl", "windows"].includes(m)).map((m) => `\`${m}\``).join(" and ");
        const matches = table ? commonMatches(binding, table) : [];
        if (matches.length) {
          const match = matches.map((m) => `Keyboard.Shortcut.Common.${m.name}'s ${m.platform} binding`).join(" and ");
          context.report({ node, messageId: "ambiguousMatchesCommon", data: { modifiers, match } });
        } else {
          context.report({ node, messageId: "ambiguous", data: { modifiers } });
        }
      },
    };
  },
};

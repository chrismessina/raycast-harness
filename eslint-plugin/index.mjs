// eslint-plugin-raycast-harness: the ESLint half of raycast-harness, for extensions that run lint
// with a TypeScript parser (the `rx shortcuts check` text scan is the parser-free path).
//
//   import raycastHarness from "raycast-harness/eslint-plugin";
//   export default [raycastHarness.configs.recommended];
//
// or pick rules: `plugins: { "raycast-harness": raycastHarness }` and
// `"raycast-harness/no-ambiguous-shortcut": ["error", { table: ".cache/shortcuts.json" }]`.
// The rules that compare against Keyboard.Shortcut.Common take an explicit `table` path written by
// `rx shortcuts runtime`; no table ships with the package.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import copyErrorPairing from "./rules/copy-error-pairing.mjs";
import noAmbiguousShortcut from "./rules/no-ambiguous-shortcut.mjs";
import noMultilineEmptyviewDescription from "./rules/no-multiline-emptyview-description.mjs";
import noToastHideInCleanup from "./rules/no-toast-hide-in-cleanup.mjs";

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

const rules = {
  "no-multiline-emptyview-description": noMultilineEmptyviewDescription,
  "no-ambiguous-shortcut": noAmbiguousShortcut,
  "copy-error-pairing": copyErrorPairing,
  "no-toast-hide-in-cleanup": noToastHideInCleanup,
};

/**
 * @typedef {{
 *   meta: { name: string, version: string },
 *   rules: Record<keyof typeof rules, import("eslint").Rule.RuleModule>,
 *   configs: { recommended: import("eslint").Linter.Config },
 * }} Plugin
 */

/** @type {Plugin} */
const plugin = {
  meta: { name: "eslint-plugin-raycast-harness", version: pkg.version },
  rules,
  configs: /** @type {Plugin["configs"]} */ ({}),
};

/** @type {import("eslint").Linter.Config} */
const recommended = {
  name: "raycast-harness/recommended",
  plugins: { "raycast-harness": /** @type {import("eslint").ESLint.Plugin} */ (/** @type {unknown} */ (plugin)) },
  rules: Object.fromEntries(Object.keys(rules).map((r) => [`raycast-harness/${r}`, "error"])),
};
plugin.configs.recommended = recommended;

export default plugin;

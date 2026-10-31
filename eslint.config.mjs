import js from "@eslint/js";
import globals from "./eslint-globals.mjs";

export default [
  js.configs.recommended,
  {
    files: ["**/*.mjs", "scripts/commit-msg"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  { ignores: ["node_modules/", "test/fixtures/"] },
];

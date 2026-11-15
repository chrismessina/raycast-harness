// The registry of every check `rx preflight` emits: its class (docs/check-classes.md), the level
// the check itself produces on a finding (what a `report` severity caps to WARN), and a one-line
// description for `spec.checks`. Every id here is emitted on every run.

/**
 * @typedef {{ class: "core" | "preset", level: "FAIL" | "WARN", description: string }} CheckInfo
 */

/** @type {Record<string, CheckInfo>} */
export const CHECKS = {
  // legacy core
  "package-json": { class: "core", level: "FAIL", description: "package.json parses and its list fields are arrays of objects" },
  schema: { class: "core", level: "FAIL", description: "package.json $schema is Raycast's extension schema URL" },
  categories: { class: "core", level: "FAIL", description: "at least one category from Raycast's list; Other only as a last resort (WARN)" },
  platforms: { class: "core", level: "FAIL", description: "platforms is declared and contains only macOS and Windows (missing on main too → WARN)" },
  "preference-type": { class: "core", level: "FAIL", description: "every preference type is one Raycast defines" },
  "shortcut-platform-case": { class: "core", level: "FAIL", description: "shortcut platform keys are spelled macOS and Windows" },
  "changelog-exists": { class: "core", level: "FAIL", description: "CHANGELOG.md exists" },
  "changelog-order": { class: "core", level: "FAIL", description: "changelog dates descend, are YYYY-MM-DD, and there is no Unreleased section" },
  "changelog-updated": { class: "core", level: "FAIL", description: "with --published, the top changelog entry is new" },
  "command-renamed": { class: "core", level: "FAIL", description: "with --published, no published command name vanished (rename-shaped → FAIL, removal → WARN)" },
  "eslint-config": { class: "core", level: "FAIL", description: "flat ESLint config; no .eslintrc*; defineConfig from eslint/config" },
  lockfile: { class: "core", level: "FAIL", description: "package-lock.json is the only lock file" },
  "npm-registry": { class: "core", level: "FAIL", description: ".npmrc and the lockfile resolve packages only from registry.npmjs.org" },
  "native-fetch": { class: "core", level: "FAIL", description: "no node-fetch / cross-fetch / isomorphic-fetch import" },
  "unused-dependencies": { class: "core", level: "FAIL", description: "every dependency is imported under src/ (FAIL); a package src/ appears to import at runtime but lists only in devDependencies is a heuristic WARN" },
  "readme-assets": { class: "core", level: "FAIL", description: "README images live in media/, not metadata/ or assets/ (Markdown-aware)" },
  screenshots: { class: "core", level: "FAIL", description: "an extension with a view or menu-bar command has at least one PNG screenshot in metadata/ (a published extension whose only such commands are menu-bar ones → WARN)" },
  "launch-command": { class: "core", level: "WARN", description: "heuristic: prefer launchCommand() over a raycast://extensions deeplink" },
  favicon: { class: "core", level: "WARN", description: "heuristic: prefer getFavicon() over a hand-built favicon URL" },
  trash: { class: "core", level: "WARN", description: "heuristic: prefer trash() over a shell command" },
  localization: { class: "core", level: "WARN", description: "heuristic: no locale sniffing; Raycast is US English" },
  // legacy preset-class
  prettierrc: { class: "preset", level: "FAIL", description: ".prettierrc matches the preset's values (and its import-sorting plugin pairs with devDependencies)" },
  "hand-typed-preferences": { class: "preset", level: "FAIL", description: "no hand-written Preferences / Arguments types" },
  "title-case": { class: "preset", level: "WARN", description: "manifest titles are Title Case (heuristic)" },
  "agent-scaffolding": { class: "preset", level: "WARN", description: "no agent or planning files would ship; preset ship.keep exempts named paths" },
  "dev-material": { class: "preset", level: "WARN", description: "no repo-only files (LICENSE, contributor docs, docs/, tools/) would ship" },
  "generated-files": { class: "preset", level: "FAIL", description: "no build output (dist/, .build/) would ship; a stray .DS_Store WARNs" },
  // new core
  "screenshot-count": { class: "core", level: "FAIL", description: "at most 6 screenshots in metadata/" },
  "screenshot-format": { class: "core", level: "FAIL", description: "only .png files under metadata/" },
  "screenshot-size": { class: "core", level: "FAIL", description: "every screenshot is 2000×1250" },
  "icon-size": { class: "core", level: "FAIL", description: "the extension icon (and PNG command icons) are 512×512" },
  "readme-links": { class: "core", level: "FAIL", description: "every relative link in README.md and docs/**/*.md resolves from its own directory to a file that ships" },
  "changelog-placeholder": { class: "core", level: "FAIL", description: "exactly one {PR_MERGE_DATE}, on the top changelog entry" },
  "nested-review-config": { class: "core", level: "FAIL", description: "no nested Greptile config (.greptile/, greptile.json) at any depth would ship" },
  // new preset-class
  "pref-description-length": { class: "preset", level: "FAIL", description: "preference descriptions within the preset's budget" },
  "pref-label-length": { class: "preset", level: "FAIL", description: "preference labels within the preset's budget" },
  logger: { class: "preset", level: "FAIL", description: "the preset's logger package is a dependency, imported, with its checkbox preference declared" },
  "logger-verbose-copy": { class: "preset", level: "FAIL", description: "the verboseLogging preference equals the preset's block, every field" },
  "logger-strict-redaction": { class: "preset", level: "FAIL", description: "the strictRedaction preference equals the preset's block, every field" },
  "agents-md-paths": { class: "preset", level: "FAIL", description: "every backticked repo path in AGENTS.md / CONCEPTS.md exists (repo file extensions only; <!-- rx-ignore agents-md --> exempts a line)" },
  "agents-md-scripts": { class: "preset", level: "FAIL", description: "every `npm run <x>` in AGENTS.md / CONCEPTS.md is a package.json script (<!-- rx-ignore agents-md --> exempts a line)" },
  "agents-md-no-home-paths": { class: "preset", level: "FAIL", description: "no home-directory path (a machine path under the user's home) in AGENTS.md / CONCEPTS.md" },
  "agents-md-symbols": { class: "preset", level: "FAIL", description: "every backticked symbol() in AGENTS.md / CONCEPTS.md exists under src/ (<!-- rx-ignore agents-md --> exempts a line)" },
};

export const CHECK_IDS = Object.keys(CHECKS);
export const PRESET_CHECK_IDS = CHECK_IDS.filter((id) => CHECKS[id].class === "preset");
export const CORE_CHECK_IDS = CHECK_IDS.filter((id) => CHECKS[id].class === "core");

/**
 * `spec.checks` for the preflight command, in the registry's `{ description, levels }` form so
 * `rx preset check` reads each check's capability from `rx commands --json` like any other command's.
 * @returns {Record<string, { description: string, levels: Array<"PASS" | "FAIL" | "WARN" | "N/A" | "ERROR"> }>}
 */
export function specChecks() {
  return Object.fromEntries(CHECK_IDS.map((id) => [id, {
    description: CHECKS[id].description,
    levels: CHECKS[id].level === "FAIL" ? ["PASS", "FAIL", "WARN", "N/A"] : ["PASS", "WARN", "N/A"],
  }]));
}

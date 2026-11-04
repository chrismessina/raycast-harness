// The Greptile rules no program decides (docs/commands.md §4.9: "one entry per … Greptile
// judgment rule"). Greptile reviews every Store PR against the 52 rules in
// `src/rules/greptile/config.json`; `rx preflight` covers the mechanical ones, and these are the
// rest: an agent reads the branch diff for each and records pass / fail / n-a with evidence in
// `rx audit record`. The list is checked against the snapshot at load, so a rule Raycast renames
// or removes is an ERROR here, never a silently skipped entry. A Greptile finding at any of its
// severities (`high` / `medium` / `low`) holds a Store PR, so every judgment rule is blocking.
//
// The entry id in an `--entries` file is `greptile/<rule id>`; the result id is
// `audit-greptile-<rule id>`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RxError } from "../errors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const GREPTILE_CONFIG = join(HERE, "..", "rules", "greptile", "config.json");

/** Greptile rule ids whose level in the plugin's rule map is (or includes) judgment. */
export const GREPTILE_JUDGMENT_RULES = Object.freeze([
  "changelog-entries",
  "supported-platforms",
  "shortcut-platform-keys",
  "launch-command-try-catch",
  "preference-types",
  "action-organization",
  "preference-storage",
  "no-hardcoded-secrets",
  "root-navigation-title",
  "ai-tools-evals",
  "ai-instructions",
  "readme-user-facing",
  "docs-match-behavior",
  "no-native-binaries",
  "failure-toasts",
  "error-empty-state",
  "no-silent-failure",
  "shell-command-injection",
  "no-analytics-or-keychain",
  "store-naming",
  "backward-compatible-updates",
  "loading-navigation-placeholders",
  "third-party-tos-signals",
  "owner-field",
  "contributors-third-party-updates",
  "deprecated-apis",
  "manifest-basics",
  "menu-bar-commands",
  "destructive-actions",
  "list-search-filtering",
  "data-hooks",
  "script-and-sql-utils",
  "ai-api-usage",
  "ai-skills",
  "ai-model-provider",
  "oauth-utils",
]);

export const GREPTILE_PREFIX = "greptile/";

/**
 * The judgment rules, each verified to exist in the core snapshot.
 * @param {string} [configPath] test override
 * @returns {{ id: string, entryId: string, severity: "block", title: string }[]}
 */
export function greptileJudgmentRules(configPath = GREPTILE_CONFIG) {
  /** @type {{ rules?: { id: string, rule?: string }[] }} */
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new RxError(`cannot read the Greptile snapshot ${configPath}: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
  const byId = new Map((config.rules ?? []).map((r) => [r.id, r]));
  const missing = GREPTILE_JUDGMENT_RULES.filter((id) => !byId.has(id));
  if (missing.length) throw new RxError(`Greptile judgment rule(s) absent from the snapshot ${configPath}: ${missing.join(", ")}; run rx greptile drift`, { id: "input" });
  return GREPTILE_JUDGMENT_RULES.map((id) => ({
    id,
    entryId: `${GREPTILE_PREFIX}${id}`,
    severity: "block",
    title: (byId.get(id)?.rule ?? id).split("\n")[0].trim() || id,
  }));
}

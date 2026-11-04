# Legacy preflight behavior (anchors for the compatibility preset)

Each section stands in for the Greptile rule the legacy `scripts/preflight.mjs` check enforced unconditionally. The compatibility preset (`legacy-compat.json`) binds the six preset-class checks here so that `rx preflight --preset legacy-compat.json` reproduces the legacy verdicts for `scripts/compare-preflight.mjs`.

## prettier-config

**ID:** `prettier-config` — `.prettierrc` must exist with `printWidth: 120` and `singleQuote: false`.

## generated-preference-argument-types

**ID:** `generated-preference-argument-types` — a hand-written `Preferences` / `Arguments` type or an inline `getPreferenceValues<{…}>` fails.

## manifest-title-case

**ID:** `manifest-title-case` — lowercase significant words in titles warn.

## no-agent-scaffolding

**ID:** `no-agent-scaffolding` — agent and planning files warn; a nested Greptile config fails.

## no-dev-material

**ID:** `no-dev-material` — LICENSE, contributor docs, top-level `docs/` and `tools/` warn.

## no-generated-files

**ID:** `no-generated-files` — `dist/` and `.build/` fail; a stray `.DS_Store` warns.

# gates / audit / guard fixtures

Inputs the Wave 3 tests (`test/gates*.mjs`, `test/audit*.mjs`, `test/guard*.mjs`, `test/fingerprint*.mjs`) share. The extension itself is built in a temp dir by `test/gates-helpers.mjs` (a compliant `makeExt` extension, `git init`, fake `node_modules/.bin/tsc`, `build`/`lint` scripts that exit 0), because the receipt lives under the repo's `git rev-parse --git-path rx` and a checked-in fixture has no repo.

- `preset.json` — a minimal preset: one build-only rule (never audited), one blocking judgment rule (`copy-error`), one report-only judgment rule (`kit`), one rule that applies only when the extension writes files (`export-actions`), one that applies only to forks (`fork-only`), and the dependency floors `rx api-floor` needs.
- `forbidden.txt` — two fake literals for `rx scan`.
- `expected.json` — the verdicts a clean unpublished run of `rx gates` produces for the helper's extension.

# `rx preflight` check classes

Every check `rx preflight` emits is either **core** (an objective, ecosystem-wide fact: a Raycast Store requirement, a Greptile rule from the vendored snapshot, or what `ray publish` does) or **preset** (a policy whose values, applicability or severity belong to one owner). Core runs with or without `--preset`. A preset-class check runs only when the preset binds it (`rules[].bindings[]` with `kind: "rx"` and `check: <id>`); without a preset, or with a preset that does not bind it, the check reports `N/A (no preset binds <id>)`. Plan §4.16 and plan-review-2 F6 fix the classification of the six preset-class legacy checks; this file records the reason for each.

## How a preset binding changes a check

| Binding field | Effect on the bound check |
|---|---|
| `applies` (on the rule) | Evaluated first (grammar: `docs/applicability.md`). False → `N/A (rule <id> does not apply: <condition>)`. Unknown (a context value `rx` cannot learn here, such as `published` before `rx stale` ran) → `N/A` naming the missing value. |
| `severity` | A **cap**. `report` turns every FAIL the check would produce into WARN; `block` leaves the check's own levels in place (a check may still WARN on its own: `generated-files` FAILs `dist/` and WARNs a stray `.DS_Store`). A preset can never raise a check's level above what the check itself produces. |
| `bindings[].options` | The owner's values the check needs (the exact `.prettierrc`, the verbatim logger preference blocks, the length budgets). Core carries none of them. A check whose required option is missing is `ERROR input` naming the option. When several applicable rules bind the same check with different options, every distinct option set is evaluated under the severity of the rules that bound it, and the strictest effective outcome stands (a failing `report` set is a WARN even beside a passing `block` set; two rules binding the same set take the stricter severity). |
| `ship.keep[]` | Paths an owner ships on purpose for named extensions (`TODO.md` on `brew` and `dev-null`). `agent-scaffolding` and `dev-material` leave those paths out of their candidates when the extension's `package.json` `name` is listed. |

A binding to a **core** check never changes that check's severity: `rx preset check` (`preset-severity`) fails a `report` rule that binds a core check that can FAIL, because that would downgrade a Store failure. Whether a check can FAIL comes from the registry `rx commands --json` exposes: a command declares `checks[id] = { description, levels }` and `levels` lists the verdicts the check can produce (preflight publishes this file's catalog that way; `rx api-floor` declares `api-floor-manifest` and `api-currency` as advisory). A check whose command declares no `levels` is assumed able to FAIL, and the `preset-severity` message names the declaration that would allow the binding.

## The 27 legacy checks

| Legacy id | Class | Reason | Preset field read |
|---|---|---|---|
| `package-json` | core | A manifest that is not JSON, or whose `commands`/`preferences`/`categories`/`platforms` are not arrays, cannot be published. | — |
| `schema` | core | Raycast's docs require `"$schema": "https://www.raycast.com/schemas/extension.json"`. | — |
| `categories` | core | Greptile `extension-categories`: at least one category from Raycast's closed list; `Other` only as a last resort. | — |
| `platforms` | core | Raycast's schema allows only `macOS` and `Windows` (Greptile `supported-platforms`); Greptile `platforms-field` asks for the field to be declared, so a missing one FAILs, or WARNs when the published copy lacks it too (a pre-existing note). | — |
| `preference-type` | core | Raycast's schema defines the preference types; there is no `number`. | — |
| `shortcut-platform-case` | core | Greptile `shortcut-platform-keys`: the keys are spelled `macOS` and `Windows`. | — |
| `changelog-exists` | core | Raycast's CI changelog check requires `CHANGELOG.md`. | — |
| `changelog-order` | core | Greptile `changelog-entries`: dated headings descend, dates are `YYYY-MM-DD`, no `Unreleased` section. (The placeholder predicate moved to `changelog-placeholder`.) | — |
| `changelog-updated` | core | Greptile `changelog-entries`: a PR that changes behavior adds a new top entry. | — |
| `command-renamed` | core | A command `name` is the key Raycast stores rankings, aliases and hotkeys under; renaming it resets them for every user. | — |
| `eslint-config` | core | Greptile `eslint-flat-config`: no legacy `.eslintrc*`; `defineConfig` only from `eslint/config`. | — |
| `lockfile` | core | Raycast's Copilot review instructions: `package-lock.json` is the only lock file. | — |
| `npm-registry` | core | Same source: packages come only from `registry.npmjs.org`. | — |
| `native-fetch` | core | Greptile `native-fetch`: `fetch` is a global on Raycast's Node runtime. | — |
| `unused-dependencies` | core | Greptile `unused-dependencies`: every dependency is imported under `src/` (FAIL); a package `src/` appears to import at runtime (type-only imports and test files excluded) but lists only in `devDependencies` is a WARN, because the text heuristic also matches an `import("x")` type or an import inside a string (write a type-only use as `import type`); the Greptile judgment entry covers the rest. | — |
| `readme-assets` | core | The Store checklist rejects README embeds from `metadata/`; `assets/` ships to every user. | — |
| `screenshots` | core | Greptile `store-screenshots`: an extension with a `view` or `menu-bar` command needs at least one screenshot in `metadata/`; a published extension (`--published`) whose only such commands are `menu-bar` ones is a WARN, since the rule asks screenshots of new extensions. (Dimensions moved to `screenshot-size`.) | — |
| `launch-command` | core | Greptile `launch-command-api` (heuristic, WARN). | — |
| `favicon` | core | Greptile `favicon-utility` (heuristic, WARN). | — |
| `trash` | core | Greptile `raycast-trash` (heuristic, WARN). | — |
| `localization` | core | Greptile `no-custom-localization` (heuristic, WARN). | — |
| `prettierrc` | **preset** | Greptile `prettier-config` flags only a PR that *changes* `.prettierrc` away from Raycast's two keys. The legacy check demanded the file exist with `printWidth: 120` and `singleQuote: false` in every extension, and the house rule adds the two import-sorting keys and the plugin dependency for self-authored extensions only (`house-style.md` `prettierrc`). The values and the applicability are the owner's. | `rules[].bindings[].options` `{ printWidth, singleQuote, sortImports? }`; `applies` |
| `hand-typed-preferences` | **preset** | Greptile `generated-preference-argument-types` is `low` severity and the house rule `no-hand-preferences` is **report**; the legacy check blocked (job-B P2). The severity is the owner's call, so the preset sets it. | `severity` (cap) |
| `title-case` | **preset** | Greptile `manifest-title-case` defers to `ray lint`; the legacy heuristic (AP small words, brand casing) is a house convention that is wrong for CLI names. | `severity` (cap) |
| `agent-scaffolding` | **preset** | Greptile `no-agent-scaffolding` names the files (a nested Greptile config is `nested-review-config`'s, in core); which of them an owner ships on purpose (`TODO.md` on `brew`/`dev-null`; never `AGENTS.md`, `CONCEPTS.md`, `CLAUDE.md` or `HANDOFF.md`, which stay in the mirror, listed in the extension's `.gitignore` and the preset's `holdout.localOnly`, so `rx holdout out` holds them out of the payload, `rx stale` classifies a published one as `REMOVE` for an audit `remove-published` disposition, and `rx pr files --preset` accepts them only as `removed`) and how hard to fail are policy (`greptile-rules.md` rule → handler table, ship step 3). | `ship.keep[]`; `severity` (cap) |
| `dev-material` | **preset** | Greptile `no-dev-material` names the files; a published `LICENSE` stays and contributor `docs/` ships by policy. | `ship.keep[]`; `severity` (cap) |
| `generated-files` | **preset** | Greptile `no-generated-files`; what is build output (`dist/`, `.build/`) versus a stray (`.DS_Store`) and whether a stray blocks is the owner's call. The path list itself stays in core (`src/rules/store.json`). | `severity` (cap) |

Count: 21 core, 6 preset.

## New checks (plan §4.1, docs/commands.md `rx preflight`)

| Id | Class | Reason | Preset field read |
|---|---|---|---|
| `screenshot-count` | core | The Store accepts at most six screenshots. | — |
| `screenshot-format` | core | The Store's `metadata-images` job collects `.png/.jpg/.jpeg/.webp/.gif/.bmp` and rejects all but PNG; anything else under `metadata/` is a FAIL. | — |
| `screenshot-size` | core | Store screenshots are 2000×1250. | — |
| `icon-size` | core | The Store icon is 512×512. | — |
| `readme-links` | core | A relative link that does not resolve is broken on the Store page (Q9). | — |
| `changelog-placeholder` | core | Greptile `changelog-entries`: exactly one `{PR_MERGE_DATE}`, on the top entry (Q10). | — |
| `nested-review-config` | core | Greptile `no-nested-review-config` (high; split out of `no-agent-scaffolding` on `main` `b6bdcb1`): a nested `.greptile/` or `greptile.json`, at any depth of what `ray publish` copies, can switch off Raycast's repo rules, and CI fails on it. No owner may ship one, so no preset exempts or caps it. | — |
| `pref-description-length` | preset | The 80-character budget is a measurement Chris made (`house-style.md` `pref-description-length`). | `options.max` |
| `pref-label-length` | preset | Same rule, the `label` budget (< 50). | `options.max` |
| `logger` | preset | `@chrismessina/raycast-logger` is a personal dependency. | `applies` (self-authored, web requests) |
| `logger-verbose-copy` | preset | The verbatim `verboseLogging` block is house copy (T5, Q12: the whole block is compared). | `options.expected`, `applies` |
| `logger-strict-redaction` | preset | The verbatim `strictRedaction` block; report-only. | `options.expected`, `applies`, `severity` |
| `agents-md-paths`, `agents-md-scripts`, `agents-md-no-home-paths`, `agents-md-symbols` | preset | Plan §11.1: self-authored extensions only. | `applies` |

## Classes in `rx preflight --json`

`data.checks` maps every emitted id to `"core"` or `"preset"`, so a consumer can tell a `N/A (no preset binds …)` apart from a core `N/A`.

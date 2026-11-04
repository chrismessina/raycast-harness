# Applicability expressions

A preset rule's `applies` field says when the rule holds for an extension. The grammar is **closed**: `schema/preset.schema.json` rejects any condition not listed here, and `rx preset check` (`preset-schema`) fails on it. `rx preflight` evaluates `applies` before running a bound check; the agent evaluates it for judgment-bound rules and records the result in the audit (plan §4.9).

## Grammar

```
expr      := true | condition | { "all": [expr, ...] } | { "any": [expr, ...] } | { "not": expr }
condition := an object with exactly one of the keys below
```

Evaluation is three-valued: `true`, `false`, or `unknown` (a context value `rx` cannot learn in this run). `all` is `false` if any operand is `false`, else `unknown` if any is `unknown`, else `true`. `any` is `true` if any operand is `true`, else `unknown` if any is `unknown`, else `false`. `not unknown` is `unknown`. A rule whose expression is `unknown` makes its bound checks `N/A` naming the missing value; `false` makes them `N/A (rule <id> does not apply: <rendered condition>)`.

## Conditions and where each context value comes from

| Condition | Value | Source |
|---|---|---|
| `{ "selfAuthored": true }` | `package.json` `author` (a string, or an object's `name`) equals the preset's `owner`, compared case-insensitively. A missing `author` is `false`. | `package.json` in the root |
| `{ "platform": "macOS" \| "Windows" }` | `package.json` `platforms` contains the value. An absent `platforms` means `["macOS"]`. | `package.json` |
| `{ "published": true }` | `true` when `--published <dir>` was given, or when `repo/stale/baseline.json` (written by `rx stale`) has `published: true`; `false` when that file has `published: false`; otherwise `unknown` (the message says to run `rx stale`). | `--published`, `rx stale` state |
| `{ "webRequests": true }` | Any file under `src/` (comments stripped) matches the house-style `logger` audit pattern: `/\bfetch\s*\(\|axios\|node-fetch\|useFetch\|@chrismessina\/raycast-downloader\|from "(node:)?https?"\|from "(undici\|got\|ky)"/`. | source scan |
| `{ "declaresPreference": "<name>" }` | A preference with that `name` exists at extension level or on any command. | `package.json` |
| `{ "dependency": { "name": "<pkg>", "minVersion": "<semver>" } }` | The lockfile-resolved version of `<pkg>` (`package-lock.json` `packages["node_modules/<pkg>"].version`, or v1 `dependencies[<pkg>].version`) exists and is ≥ `minVersion` (`minVersion` optional: then presence suffices). No lockfile or not resolved → `false`. The manifest range is never consulted: a caret range admits a version without installing it. | `package-lock.json` |
| `{ "hasViewCommand": true }` | Any command has `mode: "view"`. | `package.json` |
| `{ "commandMode": "view" \| "no-view" \| "menu-bar" }` | Any command has that `mode`. | `package.json` |
| `{ "declaresInterval": true }` | Any command has an `interval` field. | `package.json` |
| `{ "writesFiles": true }` | Any file under `src/` (comments stripped) matches `/\b(writeFile\|writeFileSync\|appendFile\|appendFileSync\|createWriteStream\|copyFile\|copyFileSync\|mkdir\|mkdirSync\|rename\|renameSync)\s*\(/`. | source scan |
| `{ "callsAI": true }` | Any file under `src/` (comments stripped) matches `/\bAI\.ask\s*\(\|\buseAI\s*\(\|canAccess\s*\(\s*AI\b\|\bAI\.Model\b/`. | source scan |
| `{ "manual": "<text>" }` | Always `unknown` to `rx`: a condition only the agent can evaluate ("already being changed", "exports CSV"). The text is what the generated matrix prints in its Applies column. | the agent, recorded in the audit |

Nothing is inferred from an unstated convention: a condition not in this table is a schema error, and a context value not in this table does not exist.

## Rendering

`rx preset table` prints an expression in the Applies column as: `true` → `all`; a condition → its phrase (`selfAuthored` → "self-authored", `webRequests` → "makes web requests", `declaresPreference: x` → "declares `x`", `dependency` → "installed `<pkg>` ≥ <minVersion>", `commandMode: no-view` → "a `no-view` command", `manual: t` → `t`); `all` → operands joined with ", "; `any` → joined with " or "; `not` → "not " + operand.

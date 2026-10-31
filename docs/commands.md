# `rx` command contracts

This file is written before the code. Every command here has an **argument schema**, a **root rule**, a **`data` schema**, a **state location** and a **network boundary**; `rx <command> --help` and `rx commands --json` report the same facts from the code. If the code and this file disagree, the code is wrong.

Plan references (`§4.x`) point at `docs/plans/2026-10-30-raycast-harness.md` in the `chrismessina/raycast-extensions-skills` repository.

## 1. Shared protocol

### Verdicts

One line per check: `VERDICT  check-id  message`. `VERDICT` is one of `PASS`, `FAIL`, `WARN`, `N/A`, `ERROR`. A check id is kebab-case. `N/A` always states why there was nothing to inspect. Silence is never a pass: a command that produces no result at all is an `ERROR protocol`.

| Exit | Meaning |
|---|---|
| 0 | only `PASS`, `WARN`, `N/A` |
| 1 | at least one `FAIL` |
| 2 | at least one `ERROR` (outranks `FAIL`) |

`ERROR` is for a check that could not run: unknown or malformed arguments (`ERROR args`), an unresolvable root (`ERROR root`), unreadable or malformed input (`ERROR input` or a command-specific id), a tool missing from PATH (`ERROR tooling`), a network failure inside the command's purpose (`ERROR github`, `ERROR npm`). A check that ran and found a problem is a `FAIL`.

Domain outcomes (`SAME-PIXELS`, `OURS-SAFE`, `MINE`, `CHECK`, …) are **never extra verdicts**: they are values inside `data` or inside a result's `details`, and each command below gives its mapping to `PASS`/`FAIL`/`WARN`/`N/A`.

### `--json`

Every command accepts `--json` and then prints exactly one document:

```json
{
  "command": "preflight",
  "version": "0.1.0",
  "fingerprint": null,
  "data": { },
  "results": [
    { "id": "readme-assets", "verdict": "FAIL", "message": "1 image path does not resolve",
      "details": [ { "file": "README.md", "line": 12, "text": "metadata/missing.png" } ] }
  ],
  "exit": 1
}
```

`fingerprint` is a string only for commands that compute one (`gates`, `guard`, `audit`); otherwise `null`. `details[]` entries have `text` and optionally `file` (repo-relative or extension-relative, as the command documents) and `line` (1-based).

### `--help`

Every command and subcommand accepts `--help` and prints its usage, arguments, flags, root rule, network boundary and state location. Exit 0.

### Arguments

Flags are `--name value` or `--name=value`; booleans take no value. **Any unknown argument, a flag without a value, an empty value, a flag given twice (unless repeatable), a missing required argument, an unknown subcommand → `ERROR args`, exit 2.** Positional arguments are declared per command. There are no short flags.

### Root resolution (every command whose root rule is `required` or `optional`)

1. `--root <dir>` wins. It must be an existing directory; otherwise `ERROR root`.
2. Otherwise walk up from the current directory to the nearest `package.json` whose parsed content has a `commands` array.
3. If none, look one level down: the immediate subdirectories (not `node_modules`, not dot-directories) that satisfy the same test.
4. Exactly one candidate → that is the root. **More than one → `ERROR root` naming them and asking for `--root`.** None → `ERROR root` asking for `--root`, except for `optional`-root commands, which then run with no root and report the dependent checks as `N/A`.

The dispatcher resolves the root before the command runs; a command never sees an ambiguous root.

### State locations

| Kind | Where | Holds |
|---|---|---|
| repo state | `git rev-parse --git-path rx` in the extension's repository (so `.git/rx/` in an ordinary checkout, the worktree's private dir in a worktree) | `receipt.json`, `audit.json`, `stale/` baselines, `greptile/rounds/`, `holdout/`, `publication.json`, `pr-body/` |
| cross-repo cache | `$XDG_CACHE_HOME/raycast-harness`, default `~/.cache/raycast-harness` | the sparse `raycast/extensions` checkout (`upstream/`), the runtime shortcut table (`shortcuts/<fingerprint>.json`) |

Nothing is ever written into the extension's payload (the files `ray publish` copies) or into the npm installation of `rx`.

### Network

Each command states its boundary. Unless the boundary says so, a command opens no connection and starts no child process that does. `git`, `gh`, `npm`, `npx`, `ray`, `plutil` run through `execFile` with argument arrays; `ls`, `grep`, `find`, `sed` are never run. On this machine `gh` may be a 1Password plugin alias; `rx` tries `op plugin run -- gh` first when `op` is present and no token is in the environment, then plain `gh`.

Two documented exceptions to "network failure is `ERROR`": `guard` speaks the host hook's allow/block transport; `api-floor`'s npm-currency advisory reports `N/A (npm unreachable)` while its local floor check still runs.

### Presets

Commands marked **preset-aware** accept `--preset <file>`, a JSON file validated against `schema/preset.schema.json` (§4.16). Core without a preset enforces only ecosystem facts; preset-class checks are then `N/A (no preset)`. A preset binding may set the severity of a core check only for the house-style rule it binds and can never downgrade an unrelated core `FAIL`. The plugin runner always passes `--preset`.

---

## 2. Commands

Legend: **Root** `required` / `optional` / `none`. **Network** as stated. **State** read/written. **Verdict mapping** lists check ids the command emits; `N/A` reasons are literal.

### `rx commands [--json]`

Lists every command's contract. **Root** none. **Network** none. **State** none.
**data** `{ commands: [{ name, summary, root, network, state, positionals[], flags{}, subcommands{}, data{} }] }` — `flags` includes the global `--json` and `--help`; `subcommands` entries have the same shape.
**Verdicts** `PASS commands <n> commands: …`.

### `rx doctor [--root <dir>] [--json]`   (§4.15)

Report only: never `FAIL`. **Root** optional. **Network** `gh auth status` contacts github.com; all else local. **State** none.
**data** `{ node, ray: { found, apiVersion } | null, gh: { authenticated, login, detail }, signing: { gpgsign, format, key }, raycastApp: { version, path } }`.
**Verdicts** `node` (PASS ≥ 22 / WARN), `ray` (PASS present / WARN missing / `N/A no extension root resolved`), `gh-auth` (PASS / WARN), `git-signing` (PASS / WARN), `raycast-app` (PASS / `N/A Raycast.app not found` / `N/A not macOS`).

### `rx preflight [--root <dir>] [--published <dir>] [--preset <file>] [--json]`   (§4.1, §4.16, §11.1)

The Store-readiness checks, formerly `scripts/preflight.mjs`. **Root** required. **Network** none. **State** none (read-only). Preset-aware.
`--published <dir>` is the extension as it exists in `raycast/extensions` (what `rx stale` fetches); it enables the comparison checks. Without it they report `N/A (not published; pass --published)`.
**Check classes** are recorded in `docs/check-classes.md`: every legacy id is `core` or `preset`; preset-class checks take values, applicability and severity from the preset and are `N/A (no preset)` without one.
**Check ids** — legacy (27): `schema`, `categories`, `platforms`, `preference-type`, `hand-typed-preferences`, `title-case`, `shortcut-platform-case`, `changelog-exists`, `changelog-order`, `changelog-updated`, `command-renamed`, `eslint-config`, `prettierrc`, `lockfile`, `npm-registry`, `native-fetch`, `unused-dependencies`, `readme-assets`, `screenshots`, `package-json`, `agent-scaffolding`, `dev-material`, `generated-files`, `launch-command`, `favicon`, `trash`, `localization`. New (§4.1): `screenshot-count` (≤ 6), `screenshot-format` (`.png` only; anything else under `metadata/` is FAIL), `screenshot-size` (2000×1250), `icon-size` (512×512), `readme-links` (every relative link in README and docs resolves from its own directory, any Markdown form), `changelog-placeholder` (zero placeholders FAIL; the top entry must carry `{PR_MERGE_DATE}`), preset-bound: `pref-description-length` (≤ 80, report), `pref-label-length` (< 50, report), `logger`, `logger-verbose-copy`, `logger-strict-redaction` (report-only), `agents-md-paths`, `agents-md-scripts`, `agents-md-no-home-paths`, `agents-md-symbols` (§11.1, self-authored only). Every id is emitted on every run as PASS/FAIL/WARN/N/A; absence of the inspected thing is `N/A` with the reason.
**data** `{ root, published: boolean, publishedDir: string | null, preset: string | null, selfAuthored: boolean | null, checks: { [id]: "core" | "preset" } }`.
**details** `file` is extension-relative; `line` where the finding is in a file.

### `rx stale [--root <dir>] [--json]`   (§4.2)

Is the published copy of this extension older or different from what is here? **Root** required (resolved before any lookup; fixes Q3). **Network** GitHub API (`gh api repos/raycast/extensions/contents/extensions/<name>` to detect publication and the baseline SHA) and `git fetch` of `raycast/extensions` into the cross-repo cache. **State** reads/writes `cache/upstream/` (sparse checkout, persisted for `gates`, `preflight --published`, `png`, `contributions`); writes `repo/stale/baseline.json` `{ name, baseline, publishedDir, at }`.
Any lookup failure other than 404 → `ERROR github`. 404 → `data.published: false`, `publishedDir: null`, `baseline: null`, one result `N/A stale not published`.
**Classifier** per path (symlinks and mode changes included): `MINE` published == local HEAD blob; `CHECK` published == an older commit of this path; `NEW?` local file the published tree lacks; `UPSTREAM` published blob not in this path's history; `ONLY-PUB` published has a file local does not; `UNHANDLED` symlink, mode change, or an undecidable line.
**Verdict mapping** one result per class actually present, id `stale-<class>` (`stale-mine`, `stale-check`, `stale-new`, `stale-upstream`, `stale-only-pub`, `stale-unhandled`), details one per path: `MINE` → PASS; `CHECK`, `NEW?` → WARN **requiring an audit disposition** (`rx audit record`, keyed by path + local content hash + baseline SHA) before `guard` allows publishing; `UPSTREAM`, `ONLY-PUB`, `UNHANDLED` → FAIL. A fully identical tree → `PASS stale-mine identical to published`.
**data** `{ name, published, publishedDir, baseline, files: [{ path, class, localHash, publishedHash | null, note }] }`.

### `rx png [--published <dir>] [--root <dir>] [--json]`   (§4.3)

Read-only screenshot/icon triage: recommends, never modifies. **Root** required. **Network** none. **State** none. Decodes with `pngjs`; reads IHDR bit depth and the `gAMA`, `iCCP`, `sRGB`, `cHRM` chunks with a bounds-checked chunk reader. Compares every `.png` under `metadata/` and the icon(s) named in `package.json` with the same path under `--published`.
**Outcomes → verdicts**, one result per file, id `png`, outcome in `details[0].text` and `data.files[].outcome`: `SAME-PIXELS` (equal size, RGBA and color metadata) → PASS, recommend adopting the published copy; `UNDECIDED` (bit depth > 8 or metadata differs) → FAIL, compare by eye; `LOCAL-ONLY` (no published copy, or no `--published`) → `N/A keep local`; `OLDER-SHOT` (differs; local matches an older commit of this path) → WARN requiring an audit disposition (path + local hash + baseline SHA); `NOT-YOURS` (differs; local content never in this path's history) → FAIL. Decode or chunk failure → `ERROR png`.
**data** `{ published: boolean, files: [{ path, outcome, local: { width, height, bitDepth, colorType, gAMA, iCCP, sRGB, cHRM } , published: {…} | null, provenance: string | null }] }`.

### `rx scan --forbidden <file> [--pr-text <file>]... [--root <dir>] [--json]`   (§4.4)

Gate −2: do any forbidden example values leak? **Root** required. **Network** none (reads git history locally). **State** none.
`--forbidden` is a text file, one literal per line (blank lines and `#` comments ignored). Scans: file **contents and names** of the payload (extension root minus `ray publish`'s fixed skip list, ignored and untracked included), commit messages in the range `ray` publishes (`<publish-tag>..HEAD` when the tag exists, else all history), and every `--pr-text` file.
**Verdicts** `scan-files`, `scan-names`, `scan-commits`, `scan-pr-text` (each PASS / FAIL with one detail per hit `{ file | commit, line, text: "<forbidden line>" }`; `scan-pr-text` is `N/A no --pr-text given` when absent); `scan-binary` WARN listing binary files for a human look (PASS when none). Empty forbidden file → every check `N/A every example approved (forbidden list is empty)`, never PASS.
**data** `{ forbiddenHash: "sha256:…", forbiddenCount, range: string, hits: number, binaries: string[] }`.

### `rx changelog [--root <dir>] [--published <dir>] [--redactions <file>] [--merge] [--json]`   (§4.5)

**Root** required. **Network** none. **State** `--merge` reads `MERGE_HEAD` and writes `CHANGELOG.md` in the root; otherwise read-only.
**Verdicts** `changelog-placeholder` (exactly one `{PR_MERGE_DATE}`, in the top entry; zero or misplaced → FAIL), `changelog-history` (dated entries byte-equal to `--published`'s **except recorded redactions**; `N/A (not published; pass --published)` without it), `changelog-bullets` (each ≤ 280 chars; WARN), `changelog-merge` (only with `--merge`: rebuilt from HEAD and MERGE_HEAD by heading structure → PASS; ambiguous boundary → `ERROR changelog-merge` with the two headings in details, nothing written).
`--redactions <file>` is JSON `[{ heading, originalHash, replacementHash, forbiddenLine }]`; an entry authorizes exactly one changed body whose published text hashes to `originalHash` and local text to `replacementHash`, dates unchanged.
**data** `{ placeholders: number, topHeading, entries: [{ heading, date, bullets, changed, redacted }], merged: boolean }`.

### `rx contributions --published <dir> [--root <dir>] [--json]`   (§4.6)

Run during a `pull-contributions` merge, from the extension root or a monorepo checkout. **Root** required. **Network** none. **State** none.
For each conflicted path under the extension subtree compares the **incoming** blob with the **published** blob for that path. Path sets compared in both directions; a missing object → `ERROR contributions`. CHANGELOG containment decides only `CHANGELOG.md`.
**Verdicts** one result per conflicted path, id `contribution`, details `{ file, text: "OURS-SAFE <ours blob> == <published blob>" | "REAL-CONTRIBUTION <incoming blob> != <published blob>" }`: `OURS-SAFE` → PASS, `REAL-CONTRIBUTION` → FAIL. `contribution-branch` WARN when a merged PR's leftover `ext/<name>` branch exists whose only new commit is raycastbot's date stamp, else PASS. No conflicts → `N/A no conflicted paths under <extension>`.
**data** `{ extension, conflicted: [{ path, outcome, ours, incoming, published }], leftoverBranch: { name, commit } | null }`.

### `rx api-floor --preset <file> [--root <dir>] [--json]`   (§4.7)

Dependency policy comes **only from the preset** (`dependencies.api`). **Root** required. **Network** optional npm registry read for the currency advisory. **State** none.
Selects the policy from the lockfile-resolved `@raycast/api` major (1 → `existing-1x`, 2 → `2x`; an unpublished extension per `repo/stale/baseline.json` or `--new` absent → the preset's `new` policy, which must not resolve to 1.x).
**Verdicts** `api-floor-lockfile` (resolved version ≥ floor → PASS, else FAIL; no lockfile → `ERROR api-floor-lockfile`), `api-floor-manifest` (range lower bound ≥ floor → PASS, else WARN), `api-floor-new` (new extension on 1.x → FAIL; else PASS or `N/A published extension`), `api-currency` (resolved == npm latest → PASS; behind → WARN; npm unreachable → `N/A npm unreachable`). Without a preset: `ERROR args` (the flag is required).
**data** `{ policy, floor, resolved, range, latest: string | null, newExtension: boolean }`.

### `rx gates --preset <file> --forbidden <file> [--root <dir>] [--json]`   (§4.8)

Runs the mechanical gates in order and writes the receipt. **Root** required. **Network** `stale`'s (GitHub, git fetch); `npm run build` and `npm run lint` do what the project's scripts do; never installs packages (missing local tooling → `ERROR tooling`). **State** deletes then writes `repo/receipt.json`; reads `repo/stale/`; uses the cross-repo `upstream/` cache.
Order: `stale` → `scan` → `preflight` (with `--published <stale's dir>` when published, without it otherwise) → `api-floor` → `npm run build` → `npx --no-install tsc --noEmit` → `npm run lint`. Each step's results are merged into the output with their own ids; the three tool steps are `build`, `tsc`, `lint` (PASS / FAIL with the tool's first error lines in details).
**Fingerprint** (`src/fingerprint.mjs`, no git writes): `fingerprints.payload` = SHA-256 over a sorted, length-delimited manifest of every path in the publisher copy set (ignored and untracked included): path, entry type, executable bit, symlink target, bytes. Plus `head`, `publishRange`, `preset`, `forbidden`, `rxVersion`, `baseline` (the published baseline SHA or the literal `unpublished`). `data.fingerprint` and the envelope `fingerprint` carry the combined SHA-256 of all of them.
**Receipt** `repo/receipt.json` `{ fingerprints: {…}, results: Result[], steps: string[], rxVersion, at }`, written **only when no step produced FAIL or ERROR**. An interrupted run leaves no receipt.
**data** `{ receipt: string | null, fingerprints, steps: [{ name, exit }] }`.

### `rx guard [--json]`   (§4.9)

The plugin's `PreToolUse` hook. **Root** resolved from the hook payload's `cwd` (it is not an argument; a failure to resolve blocks). **Network** none. **State** reads `repo/receipt.json`, `repo/audit.json`.
Reads the hook payload (JSON) on stdin. For a Bash command that runs `npm run publish`, `ray publish` or `npx … ray publish`: allow only if the receipt exists, every fingerprint equals a fresh computation, every required step is present with no FAIL/ERROR, and `audit.json` exists, carries the same combined fingerprint and has no blocking failure. Otherwise block with one sentence naming what is missing or stale. `gh pr ready` in any form → always block ("marking ready is Chris's click"). Any other command → allow.
**Transport** (the documented exception): on allow, prints nothing and exits 0; on block, prints the hook's JSON decision document on stdout and exits per Claude Code's hook contract, which the implementer records from the current docs in the hook's source header. `--json` instead prints the envelope with `guard` as PASS (allow) / FAIL (block) / `N/A not a publish or ready command` and exits per the verdict, for tests.
**data** `{ decision: "allow" | "block", reason, command, receipt: { present, fresh, complete }, audit: { present, fresh, blocking } }`.

### `rx audit record --preset <file> --entries <file> [--root <dir>] [--json]`  ·  `rx audit show [--root <dir>] [--json]`   (§4.9)

The judgment evidence the receipt cannot hold. **Root** required. **Network** none. **State** writes `repo/audit.json` (`record`), reads it (`show`); reads `repo/receipt.json` for the fingerprint.
`--entries` is JSON `[{ id, scope, result: "pass" | "fail" | "n-a", evidence }]`. `record` validates: one entry per applicable house-style rule id and Greptile judgment rule from the preset (`severity` is copied from the preset, never supplied); the shortcut entry must come from `rx shortcuts --check` (its result embedded); stale `CHECK`/`NEW?` and png `OLDER-SHOT` dispositions `[{ path, localHash, baseline, disposition: "keep-local" | "adopt-published", reason }]`; destination/runtime verification entries for every external effect named by the preset. A missing applicable entry → FAIL `audit-coverage`; a blocking rule with `fail` → FAIL `audit-<id>`; report-only failures → WARN. No current receipt → `ERROR audit-receipt`.
**data** `{ written: boolean, fingerprint, entries: number, blocking: string[], reportOnly: string[], dispositions: number }`.

### `rx pr verify <N> --author <login> --extension <name> [--json]`  ·  `rx pr files <N> --extension <name> [--json]`  ·  `rx pr body <N> (--initial <file> | --splice <file>) [--apply] [--repo <owner/repo>] [--json]`   (§4.10)

**Root** none. **Network** GitHub API via `gh` (`--repo` default `raycast/extensions`). **State** `body` writes `repo-less`: it keeps a copy of every body it reads under the cross-repo cache `pr-body/<repo>/<N>/<timestamp>.md`.
`verify`: results `pr-author` (login equals `--author`), `pr-head` (head branch is `ext/<name>`), `pr-draft` (is a draft), `pr-open`, `pr-base` (base is `raycast/extensions:main`), each PASS/FAIL.
`files`: `pr-files` PASS when every changed path is under `extensions/<name>/`, else FAIL with one detail per stray path.
`body`: the `pr-body.py` safety contract: `--initial` only onto a body that is still the one the PR was created with, and only if it contains Raycast's PR template checklist (`.github/pull_request_template.md` from `raycast/extensions`) verbatim; `--splice` takes `[{ find, replace }]`, each `find` one or more whole lines occurring exactly once, anchors non-overlapping; re-read immediately before the single PATCH; history check after. Without `--apply` → `pr-body-diff` PASS with the diff in details and nothing written. With `--apply` → `pr-body-write` PASS, or FAIL when the live body moved (nothing written), or `ERROR pr-body-write` when the write's outcome is unknown. Bodies are exact strings; CRLF survives.
**data** verify: `{ number, author, head, base, draft, state }`; files: `{ files: string[], stray: string[] }`; body: `{ applied, before: "sha256:…", after: "sha256:…", edits: number, overwritten: boolean }`.

### `rx holdout out --preset <file> [--root <dir>] [--json]`  ·  `rx holdout in [--root <dir>] [--json]`   (§4.11)

**Root** required. **Network** none. **State** writes `repo/holdout/inventory.json` and moves files to `repo/holdout/files/`.
`out` moves **only untracked** entries that the preset's `holdout.localOnly` classifies local-only (default `.env`, `.claude`, `.superpowers`). Never a tracked file; never anything in `ship.keep`. Inventory entries: `{ source, destination, type: "file" | "dir" | "symlink", hash }`. `in` restores each entry, refusing to overwrite a destination that changed, and verifies the hash afterward.
**Verdicts** `holdout-out` (PASS with one detail per moved path; `N/A nothing untracked matches the preset's localOnly list`), `holdout-tracked` (FAIL if a localOnly path is tracked: it is a committed leak, handle it as a committed deletion), `holdout-in` (PASS all restored and verified / FAIL destination changed, with the path), `holdout-inventory` (`ERROR` when the inventory is empty while a listed local-only path exists, or when it is missing on `in`).
**data** `{ moved: [...], restored: [...], skipped: [{ path, reason }] }`.

### `rx greptile fetch <N> [--json]`  ·  `rx greptile wait <N> [--json]`  ·  `rx greptile can-reply <N> --round <updated_at> --finding <id> --expected-head <sha> --forbidden <file> --reply <file> --evidence <file> [--claims-fix] [--json]`  ·  `rx greptile drift [--update --dest <dir>] [--json]`   (§4.12)

**Root** `fetch`/`wait`/`can-reply`: optional (the round store lives in the extension's repo state when a root resolves, else in the cross-repo cache under `greptile/<repo>/<N>/`); `drift`: none. **Network** GitHub API via `gh` (all four; `drift` also reads `raycast/extensions` contents). **State** `fetch` writes `rounds/<updated_at>.json`; `wait` reads/writes `etag`; `can-reply` appends to `replies.json`; `drift --update` writes **only** into `--dest`.
`fetch`: results `greptile-round` PASS with `{ score, updatedAt, reviewedCommit, findings }` in data; no Greptile summary yet → `N/A no Greptile review on #N yet`.
`wait`: one ETag-conditional GET. `greptile-wait` PASS `new round <updated_at>` / `N/A no change` (304) / `ERROR greptile-wait` on any failure (never "no change").
`can-reply`: the finding must belong to the stored round; the fetched head must equal `--expected-head`; `--evidence` is JSON `{ finding, disposition: "fixed" | "partial" | "declined", artifact, explanation }`; with `--claims-fix`, `repo/publication.json` (written by the runner's publish step) must name this PR and the current remote SHA, which must differ from the round's reviewed commit; a decline permits an unchanged head. The exact reply bytes are scanned with `--forbidden`. Results `reply-round`, `reply-head`, `reply-evidence`, `reply-publication` (`N/A not a fix claim` without `--claims-fix`), `reply-scan`: each PASS or FAIL; missing/mismatched evidence → `ERROR reply-evidence`. Records `{ repo, pr, round, finding, expectedHead, evidenceHash, forbiddenHash, replyHash, at }`.
`drift`: compares `src/rules/greptile/` (the core snapshot, versioned with the package; `SOURCE.json` records repo, source (`main` or a PR), SHA, fetch date) with the live `.greptile/` in `raycast/extensions`. `greptile-drift` PASS no drift / FAIL with one detail per change (`rule added`, `rule removed`, `rule changed <id> <field>`, `files changed`, `rules.md changed`, `source moved`) / `ERROR greptile-drift` when the live copy cannot be read. `--update` requires `--dest <maintainer checkout>` and rewrites that checkout's `src/rules/greptile/` from the live copy; never the installed package.
**data** fetch `{ repo, pr, head, round: { score, updatedAt, reviewedCommit, findings: [{ id, path, line, originalCommitId, body }] } }`; wait `{ etag, changed, updatedAt }`; can-reply `{ authorized: boolean, record }`; drift `{ snapshot: SOURCE.json, live: { source, sha }, changes: string[] }`.

### `rx shortcuts --runtime [--json]`  ·  `rx shortcuts --check [--table <file>] [--root <dir>] [--json]`   (§4.13)

**Root** `--runtime`: none; `--check`: required. **Network** none. **State** `--runtime` writes `cache/shortcuts/<shimFingerprint>.json` `{ appVersion, shimFingerprint, shortcuts: { [name]: { modifiers, key } } }` from the installed Raycast app's API shim; `--check` reads the table matching the running app (or `--table`).
`--check` compares the extension's resolved action panels (every `shortcut` literal, `Keyboard.Shortcut.Common.*` reference and object-literal shortcut such as a toast `primaryAction`) with the table. Results `shortcut-runtime-table` (PASS table found / `ERROR runtime evidence unavailable` when the extension declares any shortcut and no matching table exists / `N/A extension declares no shortcuts`), `shortcut-ambiguous` (FAIL per conflicting pair, details with file:line), `shortcut-reserved` (FAIL per reserved combination). The audit cannot be completed and `guard` blocks on the ERROR.
**data** runtime `{ appVersion, shimFingerprint, path, count }`; check `{ table, declared: number, conflicts: [...] }`.

### `rx preset check <file> [--json]`  ·  `rx preset table <file> --into <reference.md> [--check] [--json]`   (§4.16)

**Root** none. **Network** none. **State** `table` rewrites the region between `<!-- rx:matrix:start -->` and `<!-- rx:matrix:end -->` in `--into` (or only compares with `--check`).
`check`: `preset-schema` (valid against `schema/preset.schema.json`, unknown fields rejected), `preset-ids` (no duplicate ids), `preset-anchors` (every `anchor` resolves to a heading in its reference file, resolved relative to the preset file), `preset-bindings` (a non-build rule has ≥ 1 binding; each `rx` binding names a check in `rx commands --json`, each `eslint` binding a rule in `eslint-plugin/`, each `judgment` binding a decision in `src/judge/decisions/` or the preset's `judgments[]`), `preset-severity` (no binding downgrades an unrelated core check). Each PASS/FAIL.
`table`: rows for non-build rules only, columns Rule · ID · Tag · Applies · Severity · Binding, sorted by the anchors' order in the reference file. `preset-table` PASS written (or, with `--check`, identical) / FAIL region differs (`--check`) / `ERROR preset-table` markers missing.
**data** check `{ rules, bindings: { rx, eslint, judgment }, errors: [...] }`; table `{ rows, changed }`.

### `rx judge <decision-id> --inputs <file> [--provider jev|haiku|agent] [--json]`  ·  `rx judge eval <decision-id> [--provider …] [--json]`   (§4, D6, Phase 7)

Advisory only; never blocks, never acts. **Root** none. **Network** the chosen provider's API (`JEV_API_KEY`, `ANTHROPIC_API_KEY`); `agent` mode: none. **State** none.
Decisions in `src/judge/decisions/<id>.json` `{ id, question, answers[], inputs (JSON Schema), fixtures: [{ inputs, expected }] }`. Provider mode: `judge-<id>` PASS with `data.answer` when top probability ≥ 0.7, WARN `defer-to-agent` below; provider error → WARN and fall back to agent mode. Agent mode: `N/A agent mode: decide and record in the audit` with `data.prompt` `{ question, answers, inputs }`. `eval`: one result per fixture (`judge-eval` PASS/FAIL) and `data.accuracy`.

### `rx api-diff <from> <to> [--json]`   (§4.14, Phase 8, optional)

Deterministic half of the api-changelog skill. **Root** none. **Network** npm registry (`npm pack` of both versions into a temp dir). **State** none. `api-diff` PASS with the typed-declaration diff in details; a pack or extraction failure → `ERROR api-diff` (never a silent empty release); a diff whose only changes are version fields → `N/A only version fields changed`.

---

## 3. Adding or changing a command

1. Write or change its section here first (arguments, root, network, state, data, verdict mapping).
2. Create `src/commands/<name>.mjs` exporting `spec` (the schema above, which `--help` and `rx commands` render) and `run(ctx)`; `ctx` gives `args`, the resolved `root`, `results`, `cwd`, `env`, `stdin()`, `log()`.
3. Add `test/<name>.test.mjs` with a witnessed red for every check, and a fixture under `test/fixtures/extensions/` with its `expected.json` when the command inspects an extension.
4. `npm run check`.

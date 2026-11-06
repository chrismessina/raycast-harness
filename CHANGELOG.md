# Changelog

## Unreleased

- Initial scaffold: verdict protocol, argument parser, root resolution,
  `rx commands --json`, `rx doctor`, commit-message hook.
- `rx preflight`: the skills plugin's `scripts/preflight.mjs` ported with every one of its
  27 checks emitted on every run as PASS/FAIL/WARN/N/A; Markdown-aware README embed
  extraction (reference definitions, angle-bracket destinations, HTML attribute whitespace,
  query strings; fenced and inline code excluded); new checks `screenshot-count`,
  `screenshot-format`, `screenshot-size`, `icon-size`, `readme-links`,
  `changelog-placeholder`; preset-bound `pref-description-length`, `pref-label-length`,
  `logger`, `logger-verbose-copy`, `logger-strict-redaction`, `agents-md-paths`,
  `agents-md-scripts`, `agents-md-no-home-paths`, `agents-md-symbols`.
- Core vs preset: `docs/check-classes.md` classifies every check; preset-class checks take
  values, applicability and severity from `--preset` and are `N/A` without one.
  `schema/preset.schema.json` (`"schema": 1`) and the closed applicability grammar in
  `docs/applicability.md`.
- `rx preset check <file>`: schema, duplicate ids, anchors, bindings against the rx, ESLint
  and judgment registries, severity downgrades. `rx preset table <file> --into <reference.md>
  [--check]`: regenerates the audit matrix between `<!-- rx:matrix:start -->` and
  `<!-- rx:matrix:end -->`.
- `rx api-floor --preset <file>`: `@raycast/api` lockfile and manifest-range floors from the
  preset's `dependencies.api` (existing 1.x, 2.x, new extensions), publication from
  `rx stale`'s baseline, npm currency as an advisory that reports `N/A npm unreachable`.
- `scripts/compare-preflight.mjs` and `test/port-exceptions.json`: legacy-vs-rx equivalence
  over every local `raycast-*` checkout and the fixtures.
- `rx stale`: sparse fetch of `raycast/extensions` into the shared cache, per-path classifier
  (MINE / CHECK / NEW? / UPSTREAM / ONLY-PUB / UNHANDLED) with blob-history provenance,
  symlink and mode checks; writes `stale/baseline.json`; CHECK and NEW? carry the
  audit-disposition key `{ path, localHash, baseline }`.
- `rx contributions`: per-file incoming-vs-published decision during a `pull-contributions`
  merge, monorepo-safe, both-direction tree comparison, CHANGELOG containment limited to
  `CHANGELOG.md`, leftover `ext/<name>` bot-stamp detection.
- `rx changelog`: placeholder count and position, dated history against the published copy
  with recorded privacy redactions (`--redactions`), bullet length, and `--merge` rebuild by
  heading structure that treats a stamped and a placeholder heading as the same entry and
  refuses an ambiguous boundary.
- `src/upstream.mjs`: one partial clone shared by `stale`, `gates`, `preflight --published`,
  `png` and `contributions`. `src/payload.mjs`: the publisher copy set (ray's fixed skip
  list at any depth) as a shared library.
- `rx png`: read-only screenshot and icon triage against the published copy with a
  bounds-checked PNG chunk reader and pngjs RGBA decode; outcomes SAME-PIXELS (PASS),
  UNDECIDED (FAIL: 16-bit or differing gAMA/iCCP/sRGB/cHRM), LOCAL-ONLY (N/A keep local),
  OLDER-SHOT (WARN with path, local hash and baseline SHA), NOT-YOURS (FAIL). No `sips`.
- `rx scan`: gate −2. Literal scan of the payload `ray publish` copies (contents and names,
  ignored and untracked included), the commit messages in ray's
  `HEAD...__raycast_latest_publish_<name>__` range (all history without the tag) and
  `--pr-text` files; binary files WARN; an empty forbidden list is N/A everywhere, never
  PASS; `data.forbiddenHash`.
- `rx holdout out|in`: moves only untracked preset-classified local-only entries to the repo
  state directory, never tracked files or `ship.keep`, with a hashed inventory; `in` refuses a
  changed destination and verifies every restore.
- `rx pr verify|files|body`: port of ship's `pr-body.py` with every safeguard (initial only
  onto an unedited body, whole-line anchors exactly once and non-overlapping, re-read before
  the single PATCH, never retried, edit-history gap check, CRLF preserved); `--initial` also
  refuses a body lacking Raycast's PR template checklist verbatim (fetched at run time);
  every live body read is backed up to the cross-repo cache; `--prospective <file>` writes the
  whole composed body on a dry run for `rx scan --pr-text`, and binds `--apply` to that scanned
  file (a recomposition that differs FAILs and writes nothing).
- `rx greptile fetch|wait|can-reply|drift`: rounds keyed by the summary's `updated_at` with
  `original_commit_id` per finding; single-shot ETag wait where a failed check is ERROR,
  never "no change"; `can-reply` authorizes exact reply bytes per finding, round and head
  with evidence, a forbidden-list scan and a publication record for fix claims (a decline no
  longer needs a new head); the Greptile rule snapshot moves into core at
  `src/rules/greptile/` and `drift --update` writes only into an explicit `--dest` checkout.
- `rx shortcuts runtime`: extract the installed Raycast app's `Keyboard.Shortcut.Common`
  table (17 constants at 2.10.1.0), app version and shim fingerprint into the cross-repo
  cache; `rx shortcuts check`: compare an extension's resolved ActionPanels and toast actions
  with that table (`shortcut-runtime-table`, `shortcut-ambiguous`, `shortcut-reserved`).
  Missing runtime evidence is an ERROR, never an N/A.
- `eslint-plugin-raycast-harness` at `raycast-harness/eslint-plugin`:
  `no-multiline-emptyview-description` (moved from the skills plugin),
  `no-ambiguous-shortcut` (toast `primaryAction` included; explicit `table` option),
  `copy-error-pairing` (helper forms accepted), `no-toast-hide-in-cleanup`, with a
  `recommended` flat config.
- `rx gates`: runs stale → scan → preflight (`--published` only when published) → api-floor →
  `npm run build` → `npx --no-install tsc --noEmit` → `npm run lint`, in-process or through
  execFile, invalidates the previous receipt first and writes `repo/receipt.json` only when no
  step FAILed or ERRORed; missing local tooling is `ERROR tooling`, never an install.
- `src/fingerprint.mjs`: the receipt fingerprint over the publisher copy set (ignored and
  untracked files included, symlink targets read through), HEAD, publish range, preset and
  forbidden bytes, rx version and the published baseline (`unpublished` for a new
  extension); no git writes.
- `rx audit record|show`: the agent audit beside the receipt: one entry per applicable
  preset rule and Greptile judgment rule with severity from the preset, embedded
  `shortcuts check` and `png` evidence, dispositions for stale CHECK/NEW? and png
  OLDER-SHOT keyed on path, content hash and baseline, destination/runtime verifications
  for detected external effects; tied to the receipt's fingerprint.
- `rx guard`: the plugin's PreToolUse hook: allows a publish only as the whole command
  `npm run publish` or `ray publish` (one `cd <dir> &&` and plain output redirections
  admitted; an exact-shape allowlist, no shell parser) and only behind a current receipt
  (matching fingerprints, every step, no FAIL/ERROR) and a current audit with no blocking
  reason; any other command that mentions the word `publish` blocks with the plain-command
  instruction; any mention of marking a PR ready blocks; silent on allow, one JSON deny
  document on block. The dispatcher honors a command's `transport` for this.
- `rx judge ask|eval`: four decisions (`changelog-user-visible`, `review-finding-triage`,
  `needs-code`, `png-provenance`) with fixtures traced to receipts in the skills plugin's
  learnings; inputs validated against each decision's schema; Jev and Claude Haiku adapters
  behind an injectable transport, D6 provider order, 0.7 threshold with `defer-to-agent`,
  provider errors falling back to agent mode, and eval accuracy. Advisory only.
- `rx api-diff <from> <to> [--out <dir>]`: packs both `@raycast/api` versions from npm and
  reports the publish-order window, the added, removed and changed files, the
  `types/index.d.ts` unified diff, `dist/types/` and the `oclif.manifest.json` commands, flags
  and changed leaves (with `kind` added/removed/changed); file modes are inventoried; `N/A`
  only when every change is a version field under the two narrow versionOnly rules (JSON
  top-level `version`, or one whole quoted literal in a text file); a pack, extraction or read
  failure, a symlink or special file in a package, or a publish-time tie on an endpoint is
  `ERROR`; `--out` reserves `<dir>/<version>` atomically before npm, never overwrites, and an
  ERROR removes only what the run reserved; temp dirs are removed on every exit path.

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
- `rx guard` (plan §9 item 3): a `cd` target that exists but is not a directory
  (`cd ./package.json && npm run publish`) now blocks with "the cd target … is not a
  directory" before any root or receipt is looked up, and an extension found one level down
  through a symlinked child is reported and checked at its physical root in `data.roots` and
  in every sentence.
- Receipt and audit provenance (plan §9 item 4): `rx gates` and `rx audit record` attest
  `receipt.json` and `audit.json` with an HMAC-SHA256 under a per-machine key at
  `$XDG_CONFIG_HOME/raycast-harness/attest.key` (created on first need at 0600 in a 0700
  directory, race-safe, never replaced; an unusable key is `ERROR attest-key`). `rx guard`
  verifies both attestations before any other check, so a missing key, a missing
  attestation, a different key and a changed file each block with their own sentence; a
  receipt written before this change blocks until `rx gates` runs again. The guard now also
  handles `Write`, `Edit`, `MultiEdit` and `NotebookEdit`, blocking any target inside a
  repository's rx state directory or on the key, and blocks a Bash command that mentions
  `.git/rx` or the key's path. `rx doctor` reports `attest-key`. The contract's limitation (2)
  now says what the attestation proves and what it does not.
- Replay and path fixes (Codex round W7): a receipt and audit are bound to the checkout and
  the `rx gates` attempt they were made for. Both carry an attested `subject` (the real path
  of the root and of the git common directory), and every `rx gates` attempt, failed or
  stopped on its arguments included, first rotates a per-root generation kept outside the
  repository under `$XDG_CONFIG_HOME/raycast-harness/generations/`; the receipt carries it
  and the audit records the receipt's generation and MAC. The guard blocks a receipt copied
  from another checkout, one restored after a later gates attempt, and an audit recorded
  against a superseded receipt. The Bash state rule collapses `/./` and repeated `/`, and
  checks every path-like word with the same protected-path test the Write rule uses (which
  catches a worktree's state path and the whole rx config directory). Protected paths resolve
  `..` in filesystem order, so a symlink followed by `..` is caught. `rx audit record` checks
  the receipt's attestation, binding and clean results before using it, and `rx audit show`
  reports provenance failures. A key directory that already exists with group or other access
  is `ERROR attest-key` with the `chmod 700` fix. `docs/guide.md` ships in the package.
- Replay fixes (Codex round W7r2): `rx gates` rotates the generation right after the root
  resolves, before any git call, so a gates attempt whose git lookup fails still supersedes a
  saved receipt and audit. A failed rotation unlinks the stored generation, and every reader
  rejects a generation whose directory is open to group or other, naming the `chmod 700` fix.
  The Bash state rule splits words the way a POSIX shell does before removing quotes, so a
  protected path with a quoted or escaped space is caught. The guide no longer claims that
  `publication.json` is bound to a checkout.
- Walkthrough fixes: `agents-md-paths` checks only paths with no extension or one an
  extension repository holds, and `<!-- rx-ignore agents-md -->` on a line (or alone on the
  line above) exempts it from the paths, scripts and symbols checks, never from the home-path
  check. Without `--published`, the comparison checks say "no published copy given" instead of
  "not published". `audit-verification` says "recorded" and counts `n-a` apart from `pass`.
  `rx audit record` says a blocking audit will stop the guard. Judge fixture sources cite
  `raycast-extensions-skills:<path>:<lines>` instead of a path on one machine, and a test keeps
  home-directory paths out of every shipped file. `api-currency` mentions a major-version
  migration only across majors. `rx png` names every difference it found.

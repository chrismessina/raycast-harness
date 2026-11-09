# Changelog

## Unreleased

- Chris's 2026-11-03 file ruling (`AGENTS.md`, `CONCEPTS.md`, `CLAUDE.md` and `HANDOFF.md`
  never ship) works through a guarded publish. The plugin preset holds them out with
  `rx holdout`, and `holdout-tracked` names its fix (`git rm --cached <path>` and list it in the
  extension's `.gitignore`). `rx stale --preset` (and `rx gates`, which now passes its preset to
  stale) classifies a published file the preset's `holdout.localOnly` lists and the local tree
  lacks as `REMOVE` (`stale-remove`, WARN) instead of the `ONLY-PUB` FAIL. `rx audit record`
  accepts the disposition `remove-published` (`{ path, localHash: "absent", baseline }`) for those
  rows only, and `rx guard` recomputes the same rule. `rx pr files` reports each file's GitHub
  status (`data.files: [{ path, status, previous }]`, the path list kept as `data.paths`), and
  with `--preset` its `pr-local-only` check FAILs when a local-only file is added, modified or
  renamed in rather than removed.
- Synced with the live skills plugin: the published-copy comparison has a test for a file changed
  inside an already-published directory with an unchanged file list (ported from the live
  `preflight.test.mjs`), and `docs/check-classes.md` no longer lists `AGENTS.md` as a file an
  owner ships on purpose (Chris's 2026-11-03 ruling: `AGENTS.md` and `CONCEPTS.md` stay in the
  mirror, listed in the extension's `.gitignore`).
- Published-copy access is one scoped operation (`src/published-copy.mjs` `withPublishedCopy`):
  the service owns cache detection, the upstream lock for the whole read and exact-baseline
  validation, and `stale`, `preflight`, `png`, `changelog`, `contributions`, `gates` and
  `audit record` read through it. `repo/stale/baseline.json` is `{ name, published, baseline, at }`
  with no cache path (an older file with one still reads). An external `--published` is neither
  locked nor refreshed, `changelog --published` inside the cache is read under the lock, and
  `gates` reports `ERROR github` when the cache moved between `stale` and `preflight`.
- One completion kernel (`src/command-execution.mjs`) is shared by the dispatcher and by the
  in-process steps of `rx gates` and `rx audit record`: results recorded before a throw, silence
  as `ERROR protocol` and the conversion of thrown errors are defined once. Two existing
  differences stay explicit options (only the dispatcher logs an unexpected error's stack and
  contains a failure to record an ERROR). No output, verdict or exit code changes.
- `rx gates` stamps the receipt with exactly the Greptile rules snapshot its `greptile-rules`
  step reported. A final check, `gates-rules-changed`, runs immediately before the receipt is
  written and FAILs with no receipt when another `rx greptile update` installed a copy while gates
  ran. The step has a 30-second deadline: when it expires gates WARNs, installs nothing, kills the
  pending `gh` child (the 1Password `op plugin run` fallback included) and continues on the copy in
  use. Any request still in flight when the step settles, for any reason, is canceled too. The process runner and GitHub transport accept an optional AbortSignal for this. When the
  receipt's rules are not the rules in use, `rx guard` and `rx audit show` prescribe "run rx gates,
  then rx audit record".
- `rx gates` keeps the Greptile rules current as its first step, `greptile-rules`, with the same
  check-and-update as `rx greptile update`; offline, or when the live rules fail validation, it
  WARNs and continues on the copy in use. The receipt records the rules it ran under
  (`greptileRules`), and a receipt written before this field is not current. `rx audit record`
  refuses a receipt written under other Greptile rules, and `rx guard` and `rx audit show`
  require the receipt, the audit and the rules in use to agree, naming the one that differs.
- `rx audit record` judges against one snapshot of the Greptile rules taken at the start, and
  writes nothing (`ERROR audit-greptile-rules`) if an `rx greptile update` lands mid-recording.
  `update --dest` restores every file it attempted, including one whose write failed after
  truncating it, verifies each restored file byte for byte, and accepts an older checkout whose
  `SOURCE.json` has no `committed`. In preflight, a package that `src/` appears to import at runtime
  but that is listed only in `devDependencies` is a heuristic WARN, and a published menu-bar-only
  extension without screenshots is a WARN unless its published copy had screenshots and this
  change removes them all.
- An audit is bound to the Greptile rules it judged: `rx audit record` stores
  `greptileRules { repo, sha, digest }`, and `rx guard` and `rx audit show` block when the rules
  in use differ, so a rule whose text changed cannot reuse an old judgment. Rule copies are
  ordered by upstream commit date (`SOURCE.json` `committed`), must name `raycast/extensions`
  and pass a full schema check; `rx greptile update` WARNs when its copy is not the one in use,
  and `update --dest` writes all or nothing. Preflight `screenshots` covers menu-bar commands,
  `unused-dependencies` FAILs a runtime import of a package listed only in `devDependencies`, and
  `nested-review-config` checks every depth of the payload. Rules that preflight covers only in part
  are judgment rules too: the audit requires 55 Greptile judgment entries.
- Greptile rules stay current. `rx greptile outdated` (formerly `drift`) says whether the rules
  in use match the last commit on `raycast/extensions` main that touched `.greptile/`, usually in
  one request. `rx greptile update` fetches the live rules, validates them and writes them
  atomically to `~/.cache/raycast-harness/greptile/rules/`; every reader uses the newest valid
  copy that is not older than the one shipped with rx. `update --dest <checkout>` refreshes a
  maintainer checkout's shipped copy. `rx doctor` adds a report-only `greptile-rules` check: PASS
  current, WARN out of date, or WARN could not check.
- The shipped Greptile rules are refreshed to `raycast/extensions` main `b6bdcb1` (58 rules: 6
  new, 19 changed). New core preflight check `nested-review-config` (Greptile
  `no-nested-review-config`, high), split out of the preset-class `agent-scaffolding`, which now
  only WARNs. `platforms` FAILs a missing field (`platforms-field`), or WARNs when the published
  copy lacks it too. Four new audit judgment rules (40 in total). Every shipped rule is bound to a
  preflight check or listed as judgment (a test enforces it), and a rule in the rules in use that
  this release has not classified is a required, blocking audit entry.
- `--format md` escapes block syntax and GitHub-flavored autolinks as well as inline syntax, so
  a detail such as `+ added.d.ts`, `- removed.d.ts`, `# note`, `1. item`, `&copy;`, a bare URL,
  a `www.` address or an email address renders as literal text. `rx publication record` needs no
  extension: it records into the git repository containing `--root` or the working directory,
  including a multi-extension checkout root, and a missing git is reported as such. The plugin
  runner records a publication without loading the registry or reaching the network; when rx's
  bytes are not on the machine it exits 2 and says the record was not written.
- Every command takes `--format text|json|md`. `--json` stays as an exact alias of
  `--format json`, and pairing it with `--format text|md` is `ERROR args`. `md` prints a
  Markdown report of the results (a verdict table, then the details with `file:line` as inline
  code, then the exit code) and does not render `data`. Text and JSON output are byte-identical
  to before. `rx guard` keeps its hook transport when no format is given.
- `rx publication record <repo> <pr> <sha> [--root <dir>]` writes the plain publication record
  `repo/publication.json` (`{repo, pr, remoteSha, at}`; no attestation, no network). Its writer
  and `rx greptile can-reply --claims-fix` share one validator, and a malformed record is now
  `ERROR input` rather than evidence. The plugin runner records a publication through it.
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
  repository under `$XDG_CONFIG_HOME/raycast-harness/generations/`. The receipt carries it
  and the audit records the receipt's generation and MAC. The guard blocks a receipt copied
  from another checkout, one restored after a later gates attempt, and an audit recorded
  against a superseded receipt. The Bash state rule collapses `/./` and repeated `/`, and
  checks every path-like word with the same protected-path test the Write rule uses (which
  catches a worktree's state path and the whole rx config directory). Protected paths resolve
  `..` in filesystem order, so a symlink followed by `..` is caught. `rx audit record` checks
  the receipt's attestation, binding and clean results before using it, and `rx audit show`
  reports provenance failures. A key directory that already exists with group or other access
  is `ERROR attest-key` with the `chmod 700` fix. `docs/guide.md` ships in the package.
- `rx gates` and `rx audit record` say on stderr when they removed a previous receipt or
  audit, including when the arguments did not parse, so a mistyped command no longer
  deletes valid state silently.
- Simplify pass over Wave 7: the guard caches `git rev-parse` per directory within one
  decision and loads its publish-only modules lazily, and a named command loads only its own
  module (about 15–30 ms less per guard call); shared helpers for private temp files, atomic
  JSON writes and XDG base directories. No message or check changed.
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

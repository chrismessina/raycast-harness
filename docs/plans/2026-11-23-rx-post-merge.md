# Plan: `rx post-merge`

The contract is `docs/commands.md` § `rx post-merge` (and the new rows in §1 State locations and the
preflight "Nothing to ship" rule). This file orders the work; it does not restate the contract.
Where the two disagree, the contract wins and this file is wrong.

## Decisions (Chris, 2026-11-23)

- One command, `rx post-merge`. It applies by default; `--dry-run` previews. Chris asked whether a
  dry-run default was over-cautious, and the agent agreed: every write is a reversible local change
  (one commit, the shipped bytes). The fail-closed behavior comes from refusing on any ambiguity
  before the first write, not from making the user run it twice.
- rx pushes the cleanup commit (2a), but only when the push would send exactly that one commit.
- PNGs whose only difference is color metadata get adopted without a by-eye check when raycastbot's
  commit produced them (3a). Pixels must still be equal.
- The signing key is created on first need (4b). Registering it on GitHub is Chris's job; rx prints
  the commands for it.
- `raycast-pr-loop` runs `rx post-merge` when it sees the merge (5b). That lives in the plugin repo.
- A cleaned tree no longer FAILs the changelog checks (6a). The agent defined "cleaned" by content
  (the payload is identical to the published copy) rather than by a record. This is stricter: a
  record would stay true after new work started.

## Agent's calls, flagged for Chris

- No new repo state file. Re-running is idempotent (`ALREADY`), so a "cleaned" marker has no
  reader yet.
- Branch sweeping and the "docs that still call the PR open" report are cut from v1. Squash merges
  leave no ancestor branches for the sweep to find, and the report was fuzzy.
- The commit is built with plumbing (`commit-tree` on a temporary index), not `git commit`. This
  never sweeps in the user's staged or unstaged work, and it is the only way to commit the stamped
  CHANGELOG while leaving a new entry the user has not staged yet unstaged.
- Ground truth that shaped the design: raycastbot does not commit on main. It pushes
  `Update CHANGELOG.md` (plus an image optimization) onto `ext/<name>`, and then the squash
  includes it. (#33802: `31348fe`, 1 text and 4 PNG rows; #33890: `f47dae9`, CHANGELOG only.)

## Tasks (subagent-driven, one reviewer pass each)

1. **`stampProblem(before, after)`** in `src/changelog/parse.mjs`: the pure text form of
   `notAStamp` (`src/commands/contributions.mjs`). Return null, or the reason, plus the changed
   line index and both lines. `notAStamp` calls it, with its messages unchanged, and the existing
   contributions tests stay green. Unit tests: accept the stamp; reject 0 or 2 changed lines, a
   changed line count, a non-heading line, a wrong date shape.
2. **`nothingToShip(root, publishedDir)`** in `src/payload-identity.mjs`, reusing `walkPayload`
   from `src/commands/stale.mjs`. Wire it into `src/preflight/checks.mjs` (`changelog-placeholder`
   and `changelog-updated`) and into `src/commands/changelog.mjs` (`changelog-placeholder`, only
   with `--published`). Remove the `TODO.md` line. Witnessed red: with the call disabled, the
   identical-tree test FAILs. Also test that a single differing byte outside `CHANGELOG.md` brings
   the FAIL back.
3. **`src/signing-key.mjs`**: `signingKeyPaths()`, `inspectSigningKey()` (missing / ok / bad
   with the sentence), `createSigningKey()` (ssh-keygen in a temp dir, then hard links, never
   replacing either file), `registration(transport)` (`user`, then
   `users/<login>/ssh_signing_keys` across every page). Tests use a temp `XDG_CONFIG_HOME`, real
   `ssh-keygen`, and a fake transport.
4. **`src/commands/post-merge.mjs`, read side (steps 1–4) and `--dry-run`**. Register it like every
   other command (the dispatcher discovers `src/commands/*.mjs`; the file name is the command name). Test fixture: a local bare "upstream" through
   `_setUpstreamForTests`, a fake transport serving the PR, its commits, each commit's files, the
   contents listings, the user and the keys, and a local extension repo. Covers every
   `post-merge-pr` outcome, the rewrite-run rules (record mismatch, a bot commit not at the end, an
   out-of-extension file, a removed file, a truncated tree), and every adoption-table row. Rows
   include the mode and symlink FAILs, the filter or autocrlf FAIL, an added file, and the PNG pixel
   FAIL.
5. **Writes (step 5) and push (step 6)**, following the contract's Prepare, Sign, Install and push
   sub-steps exactly. Expose a test-only stop hook, `_setInstallStopForTests(step)`, that throws at
   install step 3, 4, 5 or 6. Tests:
   - The commit verifies with `ssh-keygen` under an allowed-signers file, and it is made even when
     the repo's own config says to sign with something else (`gpg.ssh.program` pointing at a script
     that fails).
   - A signing failure leaves the checkout byte-identical: working tree, index file and ref.
   - A dirty tree is preserved: unrelated staged and unstaged edits are untouched.
   - STAMP with an unstaged new entry.
   - A stop at each install step, then a re-run, converges to the same end state.
   - An existing `index.lock` is FAIL with nothing written.
   - A change between validation and install is FAIL with nothing written. The test edits the file
     from the stop hook placed before step 1.
   - An `update-ref` race is refused.
   - Push: PASS; WARN for other unpushed commits; WARN when the remote moved; WARN for two push URLs;
     N/A with no upstream; a re-run that only pushes. All run against a local bare remote, and the
     PASS case proves no tag was sent.
6. **Docs and release notes**: the `## Unreleased` CHANGELOG items (New: `rx post-merge`; Changed:
   the nothing-to-ship N/A), README command list if it has one, `docs/guide.md` if it lists
   commands. `npm run check` is green.
7. **Plugin repo** (`chrismessina/raycast-extensions-skills`, separate checkout): `pr-and-cleanup.md`
   § Post-merge cleanup → `rx post-merge`; the `ship` skill's merged trigger runs it, and its
   "never bypass signing" text names the rx key as the one sanctioned signer; `raycast-pr-loop`'s
   merged exit runs it (5b); `reference/rx.md`.

Real-world witnessed run, last: a scratch clone of `sf-symbols-search` at `5f8857a`, with no
remotes, running `rx post-merge 33890 --dry-run` against live GitHub. Expected result: `CHANGELOG.md`
is `ADOPT`, and the signing check reports the key as unregistered or not yet created.

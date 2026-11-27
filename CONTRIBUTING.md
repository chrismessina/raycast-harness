# Contributing

Contributions are accepted under the Apache License 2.0 (see `LICENSE`). By
opening a pull request you agree your contribution is licensed that way.

## What a change needs

1. **A contract before code.** Every command's arguments, root resolution,
   `data` schema, state location and network boundary are in
   `docs/commands.md`. Change the contract first; the code follows it.
2. **The verdict protocol.** One line per check, `PASS` / `FAIL` / `WARN` /
   `N/A` / `ERROR`, exit 0 / 1 / 2. Silence is never a pass: nothing to inspect
   is `N/A` with a reason. See `docs/commands.md` §Verdicts and
   `src/verdict.mjs`. A command declares every check id it may emit in `spec.checks`.
3. **Witnessed red.** Every new check ships with a test that fails when the
   check is disabled. In the PR, show it: disable the check, run the test,
   paste the failure, restore it, paste the pass. A green suite alone is not
   evidence that a check checks anything.
4. **Fixtures, not mocks of our own assumptions.** Checked-in fake extensions
   live in `test/fixtures/extensions/<name>/` with an `expected.json` naming the
   verdicts each command must produce. Recorded real inputs, scrubbed of
   anything identifying, go in `test/fixtures/real/`.
5. **No shelling out to `ls`, `grep`, `find` or `sed`.** Use Node. External
   programs (`git`, `gh`, `npm`, `ray`) run through `execFile` with argument
   arrays.
6. **Core versus preset.** Core encodes only objective, ecosystem-wide facts
   (Raycast's Store requirements, its Greptile rules, what `ray publish`
   does). Anything specific to one developer's house style belongs in a preset
   file passed with `--preset`.
7. US English. No absolute home-directory paths in any file.
8. **Parse a format with a maintained parser.** Markdown, HTML, JSON and YAML
   have spec-tested parsers; finding their structure with regular expressions
   over the raw text gets the edge cases wrong one review round at a time (the
   README checks did, until they moved to micromark and parse5). A regex is for
   matching words inside what a parser returns. A new runtime dependency is
   pinned to an exact version at least two weeks old.

## Releasing

Write the release's `## Unreleased` CHANGELOG section (shape below) and push it to
`main`. Then start the release workflow:

```sh
gh workflow run release.yml -f version=<x.y.z>
gh run list --workflow release.yml --limit 2   # the prepare run, then the publish run it starts
gh run watch <run id> --exit-status            # watch the publish run: that is where npm is reached
```

A release takes two runs. The prepare run ends by dispatching the publish run, so
watching only the first one tells you nothing about npm. Start one release at a
time. A release's runs share one concurrency group, and GitHub keeps at most one
run pending in a group, so a second dispatch while a run is pending replaces the
pending run.

`.github/workflows/release.yml` does the rest on a macOS runner. Each run does one
phase, which `scripts/ci-release.mjs plan` chooses from what `main` and npm
hold, and a run stops at its first failure:

1. **Prepare.** This phase runs when `package.json` is older and the CHANGELOG
   has `## Unreleased`. `scripts/bump.mjs` writes the version everywhere it is
   carried: `package.json`, `package-lock.json`, the version in
   `docs/commands.md`, the tarball name in `docs/guide.md`, and the CHANGELOG
   heading. `npm run check` then tests the bumped tree. `scripts/ci-commit.mjs`
   commits it to `main` through the GitHub API, so GitHub signs it, and refuses
   if `main` has moved. Last, the run dispatches a fresh run at that commit.
2. **Publish.** This phase runs at the release commit, when npm does not list the
   version yet. `npm run check` tests that exact commit, then `npm publish` runs
   through npm trusted publishing (OIDC). No token is stored anywhere, and the
   version's provenance names this commit. `prepublishOnly` runs the release
   check below first.
3. **Finish.** This phase runs once npm lists the version from that commit.
   `node scripts/github-release.mjs <version> --ci` creates the tag through the
   API (a lightweight tag on the GitHub-signed commit) and the GitHub release.

**After any failure**, fix the cause and run the same `gh workflow run` again.
The plan sees what the last run left behind (nothing yet, a release commit with
no upload, or an upload with no tag), and continues from there. It never bumps
twice, and it never uploads over a version npm already lists.

**One-time setup per package (on npmjs.com, by the owner).** Go to the package's
Settings → Trusted publishing → GitHub Actions. Organization or user:
`chrismessina`. Repository: `raycast-harness`. Workflow filename: `release.yml`.
Allowed actions: `npm publish`; direct, not staged, because the workflow's tests
are the gate. Then, under Publishing access, choose "Require two-factor
authentication and disallow tokens"; trusted publishing still works with it. The
new configuration expires unless its first upload succeeds within two days.

### Releasing from this machine

`npm run release` is the fallback when CI cannot run. Bump with
`node scripts/bump.mjs <version>`, and commit that on `main`. Then run
`npm run release` from the repository root. Stay at the terminal, because it
asks for 2FA at the approval, and npm may also ask during the upload. Leave the
checkout alone until it finishes.

The maintainer's npm account stages uploads: a staged upload is not listed until
someone approves it with 2FA. A rejected staged version can never be reused, so
nothing is approved before CI passes on the commit npm packed.
`scripts/release.mjs` runs the steps in this order, and stops at the first
failure:

1. **Check.** It refuses a dry run. `node scripts/github-release.mjs --check`
   refuses when origin's `main` has commits you lack, the tree is dirty, HEAD is
   not on `main`, a `v<version>` tag points elsewhere, or the version's
   CHANGELOG section is missing or not in the shape below. `prepublishOnly` runs
   the same check. The script then records HEAD and the `shasum` of HEAD's
   tarball (`npm pack --dry-run --json`), which are the bytes npm uploads.
2. **Upload.** This step runs only when npm has no staged or listed upload of
   this version yet. It runs `npm publish`, whose `postpublish` hook sees
   `RX_RELEASE=1` and leaves the rest to this script. Afterward HEAD must not
   have moved, and the staged entry's shasum must be HEAD's.
3. **Push.** It fast-forwards origin's `main` to HEAD.
4. **CI.** For a staged upload, it waits for the CI workflow on that commit. If
   CI fails, the version stays staged and unapproved: reject it, fix the
   problem, and release the next patch version. A version npm already lists has
   nothing left to approve, so this step and the next are skipped.
5. **Approve.** It runs `npm stage approve <id>` in your terminal for the one
   staged entry whose shasum is HEAD's, through a pinned `npx npm@11.19.1`, so
   the npm on PATH does not matter. That is the 2FA prompt. A version that is
   already listed (one that skipped staging) is not approved again.
6. **Finish.** It waits up to ten minutes for npm to list the version, and it
   refuses when npm recorded a different commit (`gitHead`) than HEAD. It then
   tags that commit as `v<version>` (signed), pushes the tag, and creates the
   GitHub release from that commit's CHANGELOG section.

- **After a failure before the approval**, fix the cause and run
  `npm run release` again. It finds an upload that is already staged with
  HEAD's bytes. It does not upload a second time, and it still approves only
  after CI passes. If CI failed, do not approve. Reject the staged version
  (`npx npm@11.19.1 stage reject <id>`, which the error prints), fix the
  problem, and release the next patch version, because a rejected number
  cannot be reused.
- **After a failure once npm lists the version** (the tag, the push or the
  GitHub release failed), run `node scripts/github-release.mjs <version>`. It
  works from npm's record, not the checkout, so it still finishes after `main`
  has moved on, and it skips what is already done. `npm run release` also
  finishes it while HEAD is still that commit.
- **A bare `npm publish`** uploads, and its `postpublish` hook waits 60 seconds
  for npm to list the version. A staged upload therefore ends with GitHub
  completion reported as pending. Run `npm run release` to finish it: it
  resumes at the push and waits for CI before approving.

A tarball upload (`npm publish <file>.tgz`) runs neither script and may record
no commit, so it is unsupported: release from the directory.

### Writing the CHANGELOG

The release notes are the CHANGELOG section, copied byte for byte, so write
them for someone skimming a release page. `prepublishOnly` enforces the shape
(`changelogProblems()` in `scripts/github-release.mjs`):

- At most one summary paragraph (200 characters) naming what the release is
  about.
- Then items under `### Breaking`, `### New`, `### Changed` and `### Fixed`,
  in that order, leaving out empty groups.
- Each item has a budget that grows with what the reader must do about it:
  Breaking 240 characters (say what to change), New 160, Changed 140, Fixed 120.
- Each paragraph, including an item's text, on one line with no wrapping:
  GitHub shows every line break in a release body. Nested lists, tables, code
  blocks and hard breaks (`\` or trailing spaces) keep their lines. Older
  sections keep their wrapping; only the version being released is checked.
- URLs inline, and no footnotes: a definition outside the section would be
  left behind.
- A plain release version (`1.2.3`); the check refuses a prerelease.

One item per change a user would notice, not per commit. Name the check or
command in code, say what it now does, and stop. Mechanism, library names,
corpus counts and edge-case lists belong in the commit message and the docs.
Merge related changes into one item: three README fixes are one line.

## Running the checks

```sh
npm ci
npm run check      # tsc --checkJs, eslint, node --test
node bin/rx.mjs commands --json
```

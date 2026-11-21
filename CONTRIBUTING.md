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

Bump the version (`package.json`, `package-lock.json`, the version in
`docs/commands.md` and the tarball name in `docs/guide.md`), rename the
CHANGELOG's `## Unreleased` to `## <version>`, and commit that on `main`. Then
run npm's release command from the repository root, and leave the checkout
alone until it finishes.

- **Before the upload**, `prepublishOnly` refuses when origin's `main` has
  commits you lack, the tree is dirty, HEAD is not on `main`, a `v<version>`
  tag points elsewhere, or the version's CHANGELOG section is missing or not in
  the shape below. A dry run runs this check and nothing else.
- **After the upload**, `postpublish` waits for npm to list the version, then
  tags the commit npm recorded for it (`gitHead`) as `v<version>` (signed),
  pushes `main` and the tag, and creates the GitHub release from that commit's
  CHANGELOG section.
- **A staged upload** is not listed until you approve it, and approval runs no
  scripts, so `postpublish` reports GitHub completion as pending. After
  approving, run `node scripts/github-release.mjs <version>`.
- **After any failure**, run `node scripts/github-release.mjs <version>`. It
  works from npm's record, not the checkout, and skips what is already done.

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

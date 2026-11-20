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
run npm's release command. Its `prepublishOnly` script refuses when the
CHANGELOG's section for the version is missing or not in the shape below, the
tree is dirty, or HEAD is not on `main`. Its `postpublish` script pushes `main`, pushes a signed `v<version>`
tag, and creates the GitHub release from that CHANGELOG section. If a step
fails after the npm upload, run `node scripts/github-release.mjs` again; it
skips what is already done.

### Writing the CHANGELOG

The release notes are the CHANGELOG section, so write them for someone
skimming a release page. `prepublishOnly` enforces the shape
(`changelogProblems()` in `scripts/github-release.mjs`):

- At most one summary paragraph (200 characters) naming what the release is
  about.
- Then items under `### Breaking`, `### New`, `### Changed` and `### Fixed`,
  in that order, leaving out empty groups.
- Each item has a budget that grows with what the reader must do about it:
  Breaking 240 characters (say what to change), New 160, Changed 140, Fixed 120.

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

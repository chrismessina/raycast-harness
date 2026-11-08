# rx user guide

This guide explains what `rx` is, how to run it, the ideas it is built on, and the recipes you will use day to day. The exact contract of every command (flags, root rule, network boundary, state, JSON data) is in [`commands.md`](commands.md); `rx commands --json` prints the same contract from the installed version.

## 1. What rx is

`rx` (the npm package `raycast-harness`) is a command-line tool that runs the deterministic part of building and shipping a Raycast extension: is the published copy older than mine, does every README link resolve, does the CHANGELOG carry exactly one `{PR_MERGE_DATE}`, is this screenshot pixel-identical to the published one, may this publish go ahead. Each command prints one verdict line per check and exits by the worst verdict, so an agent or a person branches on the exit code instead of reading prose.

The `raycast-extensions` Claude Code plugin is the other half. Its skills (`develop`, `ship`, `raycast-pr-loop`, `api-changelog`, and others) decide *when* to run a check and what to do with the result; they never re-implement a check in shell. Every skill calls rx through one runner script, `scripts/rx.mjs` in the plugin, and the plugin's `PreToolUse` hook is `rx guard`, which blocks a publish that is not backed by a current receipt and audit.

```text
  Claude Code session
  ├─ skill (ship, develop, raycast-pr-loop …)
  │     └─ node <plugin>/scripts/rx.mjs <command> …     ← the runner
  │            ├─ picks the rx executable (pinned npx, RX_TARBALL, or RX_DEV)
  │            └─ appends --preset <plugin>/presets/chrismessina.json when the command takes one
  └─ PreToolUse hook (Bash | Write | Edit | MultiEdit | NotebookEdit)
        └─ node <plugin>/scripts/rx.mjs guard           ← reads the tool call on stdin, allows or denies

  rx  →  verdict lines / JSON envelope / Markdown report, exit 0 | 1 | 2
     →  repo state in .git/rx/ (receipt, audit, stale baseline, holdout)
     →  cross-repo cache in ~/.cache/raycast-harness/ (published copies, shortcut table)
```

rx itself knows nothing about Chris's house style. The house rules live in a preset file (the plugin ships `presets/chrismessina.json`); rx only enforces what the Raycast Store requires unless you pass one.

## 2. Install and run

rx needs Node 22.12 or newer. The executable is available as both `rx` and `raycast-harness`.

From npm, without installing anything globally:

```sh
npx raycast-harness commands
npx raycast-harness preflight          # from an extension root
```

From a local tarball (a candidate build before it is published), install it into a directory of its own and call its binary:

```sh
npm install --prefix ~/rx-try ./raycast-harness-0.1.0.tgz
~/rx-try/node_modules/.bin/rx --version
```

From a checkout of this repository:

```sh
node bin/rx.mjs doctor
```

### The plugin runner

Skills never type a bare `rx`. They run `node "<plugin>/scripts/rx.mjs" <command> [subcommand] [--flags]`, which resolves the executable in this order:

| Setting | What runs |
|---|---|
| `RX_DEV=<rx checkout>` | `node <checkout>/bin/rx.mjs`, for validating an unreleased checkout |
| `RX_TARBALL=<raycast-harness-*.tgz>` | an isolated `npm install` of that tarball under `~/.cache/raycast-harness/runner/tarball/<hash>/`, keyed by the tarball's bytes; test-only, never set in shipped config |
| neither | `npx -y raycast-harness@<version>`, where the version is pinned in the plugin's `rx-version.json` |

The runner appends `--preset <plugin>/presets/chrismessina.json` whenever the addressed command or subcommand accepts `--preset` (it learns this from `rx commands --json`); a `--preset` you pass yourself wins. It also has two modes of its own: `--runner-version` prints the pinned version, and `--record-publication <owner/name> <pr> <remoteSha>` is a compatibility form that forwards to `rx publication record <owner/name> <pr> <remoteSha>`, which writes `.git/rx/publication.json` after a successful publish so that `rx greptile can-reply --claims-fix` can check it. The record is per git repository, so it works from an extension or from the root of a checkout that holds several. Recording never reaches the network: for `publication` the runner reads no registry and fetches nothing, and runs only an rx whose bytes are already on this machine (`RX_DEV`, an `RX_TARBALL` install already in the cache, or the pinned package already in npm's cache, run with `npx --offline`, which may unpack it from that cache onto local disk). When none is there, it exits 2 saying the record was not written; run any rx command through the runner once, then retry. A runner failure prints one line starting `rx runner:` and exits 2.

## 3. Concepts

### Verdicts and exit codes

| Verdict | Means | Exit |
|---|---|---|
| `PASS` | the check ran and found nothing wrong | 0 |
| `WARN` | worth reading, does not block | 0 |
| `N/A` | nothing to inspect, and the message says why | 0 |
| `FAIL` | the check ran and found a problem | 1 |
| `ERROR` | the check could not run (bad argument, unreadable input, missing tool, network); it outranks FAIL | 2 |

Silence is never a pass, and an unknown argument is an `ERROR args`. Detail lines under a verdict are indented and usually `file:line  text`. `--json` replaces the lines with one envelope, `{ command, version, fingerprint, data, results, exit }`.

### Output formats

Every command takes `--format text|json|md`. `text` is the verdict lines and is the default. `json` is the envelope, and `--json` is the same thing spelled shorter, so a script that already passes `--json` keeps working. `md` is a Markdown report you can paste into a PR or a handoff: a table of verdicts, checks and messages, the details as a list with `file:line` in inline code, and the exit code. The format never changes a verdict or the exit code. The Markdown report leaves out `data`; use `--format json` when you need it. Giving `--json` together with `--format text` or `--format md` is an `ERROR args`.

```sh
rx preflight --format md > preflight.md
```

`rx guard` is the one exception to the default: run as the hook, with no format, it prints nothing on allow and a deny document on block. Give it any `--format` to see its ordinary report instead.

### Root resolution

Every command whose root rule is `required` or `optional` finds the extension like this: `--root <dir>` wins; otherwise rx walks up from the current directory to the nearest `package.json` with a `commands` array; if there is none, it looks one level down. More than one candidate is always an `ERROR root` that asks for `--root`, and so is a `--root` that is not an existing directory. Finding no extension at all is an `ERROR root` only for a `required` command; an `optional` one (`rx doctor`, `rx greptile fetch`, `wait` and `can-reply`) runs without a root and reports the checks that need one as `N/A`, so `rx doctor` works outside any extension. It never guesses.

### State locations

- **Repo state** lives in `git rev-parse --git-path rx` of the extension's repository, which is `.git/rx/` in a normal checkout: `receipt.json` (gates), `audit.json` (audit), `stale/baseline.json` (stale), `holdout/` (holdout), `publication.json` (`rx publication record`) and Greptile round stores. It is never inside the payload and never inside the npm install.
- **rx config** lives in `$XDG_CONFIG_HOME/raycast-harness`, by default `~/.config/raycast-harness`, outside every repository: the attestation key `attest.key` and one generation file per extension root under `generations/` (see "Receipt attestation").
- **Cross-repo cache** lives in `$XDG_CACHE_HOME/raycast-harness`, by default `~/.cache/raycast-harness`: the sparse checkout of `raycast/extensions` under `upstream/`, the runtime shortcut table under `shortcuts/`, the runner's tarball installs and registry cache under `runner/`, PR-body snapshots, and the Greptile rules copies `rx greptile update` writes under `greptile/rules/` (see "Keeping Greptile rules current").

Only rx writes rx state. Never hand-edit `receipt.json`, `audit.json` or `publication.json`, and never copy them between checkouts or restore saved copies. `receipt.json` and `audit.json` are bound to the checkout and the `rx gates` attempt they were made for. `publication.json` is a plain record, `{repo, pr, remoteSha, at}`, written only by `rx publication record`, and it carries no binding or attestation; `rx greptile can-reply` refuses a record that `rx publication record` would not write.

### Presets versus core

Without `--preset`, `rx preflight` runs only the core checks, the ones the Raycast Store itself enforces, and reports every preset-class check as `N/A no preset (core enforces only Store facts)`. With a preset, the house rules bind too (Prettier settings, logger blocks, AGENTS.md claims, title case and so on), with the applicability and severity the preset gives them. `rx gates`, `rx api-floor`, `rx holdout out` and `rx audit record` require `--preset`; `rx preset check <file>` validates one.

### The receipt → audit → guard chain

1. `rx gates` first brings the Greptile rules current (`greptile-rules`, the same routine as `rx greptile update`; offline it WARNs and keeps the copy it has), then runs `stale → scan → preflight → api-floor → build → tsc → lint` in order. Only when no step FAILs or ERRORs does it write `.git/rx/receipt.json`, fingerprinted over the whole payload (ignored and untracked files included, because `ray publish` copies them), HEAD, the publish range, the preset and the forbidden list, and naming the Greptile rules it ran under. The check `gates-tree-changed` makes sure no step wrote into the payload while it ran, and `gates-rules-changed` makes sure the Greptile rules in use are still the ones the first step reported. The first step gives up after 30 seconds and carries on with the copy it has.
2. `rx audit record` takes a JSON entries file (kept outside the extension root) with one entry per applicable preset rule and per Greptile judgment rule, a disposition for every `stale-check` / `stale-new` path and png `OLDER-SHOT`, and a verification per external effect the extension has (`writes-files`, `web-requests`, `calls-ai`). It also runs `rx shortcuts check` and `rx png` in-process, then writes `.git/rx/audit.json` tied to the receipt's fingerprint.
3. `rx guard` runs as the `PreToolUse` hook. A Bash command that is exactly `npm run publish` or `ray publish` (optionally after one `cd <dir> &&`) is allowed only when the receipt exists, was made in this checkout by the latest `rx gates` attempt, every fingerprint still matches a fresh computation, every step is present and clean, and the audit was recorded against that same receipt and matches its fingerprint with no blocking reason (recomputed, not read from the file), and the receipt, the audit and the rules in use all name the same Greptile rules. Any other command that mentions the word `publish` is blocked as `unknown`. Any command that mentions marking a PR ready (`gh pr ready` and its API forms) is always blocked: that is Chris's click.

Any change to the payload after `rx gates` (an edit, a dependency bump, a holdout returning files) stales the receipt; re-run gates, then the audit.

### `judge` is advisory only

`rx judge ask <decision-id> --inputs <file>` answers one named judgment call (`changelog-user-visible`, `needs-code`, `png-provenance`, `review-finding-triage`). With `TYPESAFE_API_KEY` set it asks Jev, else with `ANTHROPIC_API_KEY` it asks Haiku, else it runs in agent mode: it prints the structured question and answers for the agent to decide and record in the audit. It never blocks and never acts. `rx judge eval <decision-id>` runs the decision's fixtures and reports accuracy.

## 4. Recipes

Run these from the extension root, or pass `--root <dir>`. In a Claude Code session the skills run the same commands through the runner, which supplies `--preset`; at a terminal you pass it yourself. `PRESET` below stands for the preset file and `FORBID` for a forbidden-values file, both kept outside the extension root.

### Check an extension before shipping

```sh
rx preflight                       # Store facts only
rx preflight --preset "$PRESET"    # plus the house rules
rx changelog                       # placeholder, bullets
```

A just-merged extension with no pending change FAILs `changelog-placeholder`, because the next entry must carry `{PR_MERGE_DATE}`. That is expected until you start the next change. Without `--published`, `changelog-updated`, `command-renamed` and `changelog-history` report `N/A no published copy given; pass --published <dir> (rx stale prints it)`. That names the missing flag; it says nothing about whether the extension is published.

### See what changed against the published copy

```sh
rx stale --json        # network: GitHub API and a sparse git fetch of raycast/extensions
```

`stale` writes `.git/rx/stale/baseline.json`, which records whether the extension is published and the baseline commit, never a path. Its JSON output's `data.publishedDir` is the published copy in the cache for this run. Feed that directory to the comparison checks:

```sh
PUB="$(rx stale --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.publishedDir))')"
rx preflight --preset "$PRESET" --published "$PUB"
rx changelog --published "$PUB"
```

`stale-only-pub` and `stale-upstream` FAILs mean publishing would delete or revert someone else's work; stop and pull the contributions first.

### Compare screenshots and icons

```sh
rx png --published "$PUB"
```

Each image is `SAME-PIXELS` (adopt the published copy), `UNDECIDED` (compare by eye), `LOCAL-ONLY`, `OLDER-SHOT` (needs an audit disposition) or `NOT-YOURS`. The message names every difference it found, so `UNDECIDED; color metadata differs: iCCP; RGBA pixels differ; compare by eye` means a tool added an ICC profile and the pixels changed too. It is read-only and never rewrites a file.

### Ship with the gate chain

Each step is its own command; the guard denies a compound command that contains a publish.

```sh
rx holdout out --preset "$PRESET"                       # untracked local-only files → .git/rx/holdout/
rx gates --preset "$PRESET" --forbidden "$FORBID"        # writes .git/rx/receipt.json only when clean
rx shortcuts runtime                                     # once per installed Raycast version
rx audit record --preset "$PRESET" --entries "$WORK/entries.json"
rx audit show                                            # does the audit still match the receipt?
npm run publish                                          # the guard checks receipt + audit here
rx publication record raycast/extensions "$PR" "$REMOTE_SHA"   # the record can-reply --claims-fix reads
rx holdout in                                            # restore and verify every held-out entry
```

Hold out first: moving files changes the payload, which the receipt fingerprints. Restore only after the publish, because `holdout in` changes the payload again.

### Review a contributor PR's touched files

```sh
rx pr files <N> --extension <name>                        # FAIL on any file outside extensions/<name>/
rx pr verify <N> --author <login> --extension <name>      # author, head branch, draft, open, base
```

During a pull-contributions merge in your own repo, `rx contributions --published "$PUB"` says which conflicted files carry a real contribution and which are the published copy coming back.

### Drive Greptile rounds

```sh
rx greptile fetch <N> --json          # the current round: score, findings, head
rx greptile wait <N>                  # one ETag-conditional GET: PASS new round, N/A no change
rx greptile can-reply <N> --round <updated_at> --finding <id> --expected-head <sha> \
  --forbidden "$FORBID" --reply reply.md --evidence evidence.json [--claims-fix]
rx greptile outdated                  # the Greptile rules in use versus the live .greptile/ on main
```

`can-reply` authorizes exactly those reply bytes; `--claims-fix` also requires `.git/rx/publication.json` for this PR at a new remote SHA. Scan any text before you send it with `rx scan --forbidden "$FORBID" --pr-text reply.md`.

### Keeping Greptile rules current

Raycast's Greptile reviews every Store PR against the rules in `.greptile/` on `raycast/extensions` main, and Raycast edits them often. rx ships a copy in `src/rules/greptile/`, and `rx preflight`, `rx audit` and `rx doctor` read whichever copy is in use. Keep that copy current the way you keep a package current:

```sh
rx greptile outdated                  # PASS current / FAIL out of date, one line per change
rx greptile update                    # fetch main's .greptile/, validate it, and make it the copy in use
```

`update` writes a new copy to `~/.cache/raycast-harness/greptile/rules/` and never touches the npm install. rx uses the copy taken from the latest upstream commit (`committed` in its `SOURCE.json`), whether a cache copy or the shipped one, so upgrading rx to a release with newer rules takes effect without deleting anything. When a copy from a later commit is already in use, `update` says so with a WARN instead of claiming it updated. A copy that fails validation, names a repository other than `raycast/extensions`, or carries a commit date in the future is skipped with a warning on stderr, and rx falls back to the next valid copy or the shipped one.

You rarely need to run `update` yourself: `rx gates` runs the same check-and-update as its first step, `greptile-rules`, and records the rules it ran under in the receipt. A network failure there is a WARN (the receipt records it), live rules that fail validation are never installed, and gates carries on with the copy it has.

Updating the rules can change what an audit was judged against, so `rx audit record` refuses a receipt written under other rules (`the Greptile rules changed since rx gates ran (<a> → <b>); run rx gates again`), and `rx guard` blocks a publish unless the receipt, the audit and the rules in use all agree, naming which one differs: `the Greptile rules changed since the audit was recorded (<old> → <new>); run rx audit record again` (or `…; run rx gates, then rx audit record` when the receipt names other rules too), `the audit was recorded against other Greptile rules than the receipt (<audit> vs <receipt>); run rx audit record again`, or `the Greptile rules changed since rx gates ran (<receipt> → <now>); run rx gates, then rx audit record`. Read the changed rules, update the entries file, and run gates and the audit again. `rx doctor` checks the same thing on every run and prints `WARN  greptile-rules  out of date: …` when it is time to update; offline it says so and keeps using the copy it has.

A maintainer refreshing the shipped copy runs `rx greptile update --dest <raycast-harness checkout>`, which rewrites that checkout's `src/rules/greptile/` all-or-nothing (a failed write restores every file) and refuses the running package's own directory. Every change it reports may need a matching change in the plugin's rule mapping.

### Derive an `@raycast/api` changelog

```sh
rx api-diff 2.10.1 2.11.0 --out "$WORK" --json
```

Both versions must be exact published versions. The command reports the file inventory, the `types/index.d.ts` diff and the CLI's commands and flags; `--out` leaves both packages extracted under `<dir>/<version>/package/` and refuses to overwrite.

### Ask a judgment question

```sh
printf '{ "change": "…", "context": "…" }\n' > "$WORK/inputs.json"
rx judge ask changelog-user-visible --inputs "$WORK/inputs.json"
rx judge ask changelog-user-visible --inputs "$WORK/inputs.json" --provider agent
rx judge eval changelog-user-visible
```

The inputs file is validated against the decision's schema first (`judge-inputs`).

### Other commands

`rx scan --forbidden "$FORBID" [--pr-text <file>]...` finds forbidden literals in payload contents, file names, the commits ray publishes and PR text. `rx api-floor --preset "$PRESET"` checks `@raycast/api` against the preset's floor. `rx shortcuts check [--table <file>]` compares the extension's shortcuts with the runtime table. `rx pr body <N> --initial <file> | --splice <file> [--apply]` edits a PR body without clobbering hand edits. `rx preset table <file> --into <reference.md> [--check]` regenerates the audit matrix. `rx doctor` reports Node, `ray`, `gh` auth, git signing and the Raycast app version.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR  root  no extension found from <dir> (no package.json with a "commands" array here, above, or one level down); pass --root <dir>` | You ran a root-required command outside an extension. | `cd` into the extension or pass `--root`. |
| `ERROR  args  unknown argument "--bogus"` / `ERROR  args  missing --preset` | A flag is misspelled or a required flag is absent. | Check `rx <command> --help` or `rx commands --json`. |
| `ERROR  input  --entries <file> is inside the extension root <root>; ray publish would copy it, so keep it outside (the payload fingerprint would also change)` | The audit entries file sits in the payload. | Write it to a temp directory outside the root. |
| `ERROR  tooling  build: <root>/node_modules is missing; run npm install there (rx never installs)` | `rx gates` reached the build step without dependencies. | `npm ci` in the extension, then re-run gates. |
| `ERROR  tooling  tsc: node_modules/.bin/tsc is missing; add typescript to devDependencies and npm install (rx never installs)` | No TypeScript in the project. | Add it as a dev dependency. |
| `ERROR  tooling  <step>: package.json has no "<step>" script` | `build` or `lint` script missing. | Add the script. |
| `FAIL  gates-tree-changed  <fingerprints> changed while the steps ran; a step wrote into the payload (generated files, an autofix?), so scan and preflight did not see what would ship` | Build or lint wrote into the payload. | Commit or ignore the generated output so it exists before gates, or stop the autofix. |
| `gates: removed the previous receipt at <path> …` or `audit: removed the previous audit at <path> …` on stderr | A gates run or an audit recording always deletes the previous one before it checks its inputs, so a bad invocation never leaves an old authorization behind. | Nothing is wrong. Fix the command and run it again; a new receipt or audit is written when the run succeeds. |
| `gates: no receipt (a step FAILed or ERRORed)` | Any step FAILed. | Fix the FAIL lines above it; nothing is written until the run is clean. |
| `FAIL  audit-coverage  N applicable rule(s) have no entry` | The entries file misses rules. | Add one entry per listed id (preset rules and `greptile/<id>`). |
| `FAIL  audit-dispositions  N outcome(s) without a disposition; M disposition(s) match nothing in this run` | A `stale-check` / `stale-new` path or png `OLDER-SHOT` has no matching `{ path, localHash, baseline }` entry, or an entry is stale. | Copy the hashes from the current `rx stale` / `rx png` output. |
| `FAIL  audit-verification  N external effect(s) unverified` | The extension writes files, makes web requests or calls AI and the entries carry no verification. | Add a `{ verification, result, evidence }` entry with runtime evidence. |
| `PASS  audit-verification  N external effect(s) recorded: P pass, M n-a` | Every detected effect has an entry. rx checks that an entry exists and is not `fail`; it does not run the effect. | Read the `n-a` count: each one is a claim that the effect does not happen, and the evidence must say why. |
| `audit: written to <path>/audit.json with N blocking reason(s); rx guard will refuse a publish until they are resolved` | The audit was saved, but it records FAILs, missing entries, dispositions or verifications. | Fix the FAIL lines above it and run `rx audit record` again; `rx audit show` lists the reasons. |
| `FAIL  agents-md-paths  N backticked paths in AGENTS.md do not exist; fix them, or mark a reference to another repository with <!-- rx-ignore agents-md -->` (also `agents-md-scripts`, `agents-md-symbols`) | AGENTS.md or CONCEPTS.md names a file, `npm run` script or `symbol()` this extension does not have. A path ending in an extension no extension repository holds (`.php`, `.rb`) is never checked. | Fix the reference, or, when it names another repository (a companion server, an upstream library), put `<!-- rx-ignore agents-md -->` on that line or alone on the line above it. The marker never exempts a home-directory path, which `agents-md-no-home-paths` checks on its own. |
| `N/A  changelog-updated  no published copy given; pass --published <dir> (rx stale prints it)` | The comparison checks ran without `--published`. | Pass `rx stale`'s `publishedDir` (see "See what changed against the published copy"). |
| `ERROR  shortcut-runtime-table  runtime evidence unavailable: … run rx shortcuts runtime` | No shortcut table for the installed Raycast version. | Run `rx shortcuts runtime`. |
| guard: `… blocked: no gates receipt at <path>; run rx gates, then rx audit record` | No receipt for this tree. | Run gates, then the audit. |
| guard: `… blocked: the receipt is stale: payload changed since rx gates ran; run rx gates and rx audit record again` | The payload, HEAD, publish range, preset or forbidden list changed after gates (including `holdout in` before publishing). | Re-run gates and the audit; publish before `holdout in`. |
| guard: `… blocked: no audit at <path>; run rx audit record` / `the audit is tied to a different receipt than the current tree; run rx audit record again` | No audit, or it belongs to an older receipt. | Run `rx audit record` after the latest gates. |
| guard: `cannot determine what this command runs: the guard allows a publish only as the whole command \`npm run publish\` or \`ray publish\`, optionally after \`cd <dir> &&\` and before plain output redirections; write it that way (and keep the word publish out of other commands)` | The command mentions `publish` in any other shape (`FOO=1 npm run publish`, a commit message, an `echo`). | Run the publish as its own plain command; keep the word out of others. |
| guard: `marking a PR ready for review is Chris's click, not the agent's; leave it a draft and hand him the link` | The command mentions `gh pr ready` or an equivalent API call. | Do not retry; hand over the PR link. |
| guard: `… blocked: receipt.json cannot be verified: this machine has no rx attestation key at <path> (rx gates creates it); re-run rx gates, then rx audit record` | No key exists yet, or it was deleted (rotation). | Run `rx gates`, then `rx audit record`. |
| guard: `… blocked: receipt.json cannot be verified: the rx attestation key <path> <problem>` (also `ERROR  attest-key  the rx attestation key <path> <problem>; rx never replaces an existing key, so fix or remove it by hand` from gates, audit record and doctor) | The key is not a regular file, is not 32 bytes, or is readable or writable by group or other. | `chmod 600` it if only the mode is wrong; otherwise delete it and run `rx gates` (see "Receipt attestation"). |
| `ERROR  attest-key  the rx attestation key directory <dir> has mode 0755; it must not be accessible to group or other, and rx does not change a directory it did not create: run chmod 700 <dir>` (from gates, audit record and doctor; the guard blocks with `… cannot be verified: ` and the same sentence) | The key's directory, or `generations/` inside it, already existed with group or other access. | Run the `chmod 700` it names, then run the command again. |
| guard: `… blocked: receipt.json was written for another checkout: <root>; run rx gates here` | The receipt was made in another checkout (a clone, another worktree) and copied here. | Run `rx gates`, then `rx audit record`, in this checkout. |
| guard: `… blocked: receipt.json is from an earlier rx gates attempt; run rx gates again` (also `ERROR  audit-receipt` from `rx audit record`, and `WARN  audit-show`) | A later `rx gates` attempt started after this receipt was written (even one that failed or ERRORed on its arguments), so this receipt was saved and put back; or this checkout's generation file is gone. | Run `rx gates`, then `rx audit record`. |
| guard: `… blocked: audit.json was recorded against an earlier receipt.json; run rx audit record again` | The audit belongs to a receipt that a later `rx gates` replaced, even when the tree is unchanged. | Run `rx audit record` after the latest gates. |
| guard: `… blocked: receipt.json is not attested by this machine's rx key: re-run rx gates, then rx audit record` | The receipt has no attestation: it was written by an rx older than attestation, or by hand. | Run `rx gates`, then `rx audit record`. |
| guard: `… blocked: receipt.json carries a malformed attestation (expected { alg: "hmac-sha256", keyId, mac }): re-run rx gates, then rx audit record` | The attestation field was edited. | Run `rx gates`, then `rx audit record`. |
| guard: `… blocked: receipt.json was attested by rx key <id>, not this machine's key <id>: re-run rx gates, then rx audit record` | The key was rotated, or the receipt came from another machine. | Run `rx gates`, then `rx audit record`. |
| guard: `… blocked: receipt.json's attestation does not verify against this machine's rx key (the file changed after rx wrote it): re-run rx gates, then rx audit record` | Someone edited the receipt after rx wrote it. | Run `rx gates`, then `rx audit record`; never edit rx state. |
| guard: the same five sentences naming `audit.json` and ending `re-run rx audit record` | The audit's attestation fails for the same reasons. | Run `rx audit record`. |
| guard: `rx state is written only by rx: <Tool> of <path> targets the rx state directory <dir>; run the rx command that owns it (rx gates, rx audit record) instead` (or `… targets the rx attestation key or its directory (<dir>) …`) | A `Write`, `Edit`, `MultiEdit` or `NotebookEdit` aimed at `.git/rx/` (or a worktree's rx state) or at the key. | Run the rx command that writes that file; read state with `rx audit show`. |
| guard: `rx state is written only by rx: this command mentions .git/rx or the rx attestation key; use rx gates / rx audit record to write it and rx audit show to read it` | A Bash command spells `.git/rx` (also as `.git/./rx` or `.git//rx`) or `raycast-harness/attest.key`, or one of its path-like words resolves into rx state (a worktree's `.git/worktrees/<name>/rx` included) or into `$XDG_CONFIG_HOME/raycast-harness/`, even to read. | Use `rx audit show` to read state; rx's own commands never name these paths. |
| `ERROR  github  publication lookup for <name> failed: gh api … failed: …; cannot prove freshness` | `rx stale` could not reach GitHub (offline, proxy, `gh` not authenticated). | Fix connectivity or `gh auth login`; rx fails closed rather than assume freshness. |
| `ERROR  npm  npm view @raycast/api time --json: timed out after 60000 ms` | `rx api-diff` could not reach the npm registry. | Check the network or `npm config get registry`. |
| `N/A  api-currency  npm unreachable` | `rx api-floor` could not read npm latest; the floor checks still ran. | Nothing blocks; re-run online for the advisory. |
| `ERROR  args  <dir>/<version> already exists; --out never overwrites` | `rx api-diff --out` points at a used directory. | Pick a new `--out` directory. |
| `rx doctor` shows `WARN  gh-auth  gh not authenticated: …`, `WARN  git-signing  commit.gpgsign is not true; commits will be unsigned`, `WARN  ray  node_modules/.bin/ray missing in <root>; run npm install there` or `WARN  node  <version>; rx needs Node 22.12 or newer` | Doctor only reports; it never FAILs. | Fix whichever tool it names. |
| `FAIL  greptile-outdated  out of date: N change(s) since <date>; run rx greptile update` (or `WARN  greptile-rules  out of date: …` from `rx doctor`) | Raycast changed its Greptile rules since the copy rx uses was fetched. | Run `rx greptile update`, then read the changes it lists: a new or changed rule can mean the extension needs work before the next review. |
| `WARN  greptile-rules  could not check (offline or gh unavailable): using <kind> copy from <date>` | Doctor, or the first `rx gates` step, could not reach GitHub, so it could not compare the rules. | Nothing blocks: gates continues on the copy it has and records the WARN in the receipt. Re-run online, or run `gh auth login`. |
| `WARN  greptile-rules  could not check within 30 s: using <kind> copy from <date>` | The first `rx gates` step did not get an answer from GitHub within its deadline. | Nothing blocks: gates continues on the copy it has, installs nothing, and records the WARN in the receipt. Re-run when GitHub responds. |
| `FAIL  gates-rules-changed  the Greptile rules changed while rx gates ran (<a> → <b>); run rx gates again` | Another `rx greptile update` (or gates run) installed a rules copy while this gates run was working, so the receipt would name rules the first step never reported. No receipt was written. | Run `rx gates` again. |
| `WARN  greptile-rules  the live rules failed validation and were not installed: using <kind> copy from <date>` | Main's `.greptile/` does not parse or fails rx's schema (the detail says why), so `rx gates` kept the copy in use. | Nothing blocks. If it persists, Raycast changed the format: report it against rx. |
| `ERROR  audit-receipt  the Greptile rules changed since rx gates ran (<a> → <b>); run rx gates again` | The rules in use changed after `rx gates` wrote the receipt (an `rx greptile update`, another gates run's update, or an rx upgrade). | Run `rx gates`, then `rx audit record`. |
| `FAIL  guard  … the receipt was written before rx bound receipts to the Greptile rules; run rx gates again` | The receipt predates the `greptileRules` field. | Run `rx gates`, then `rx audit record`. |
| `FAIL  guard  … the Greptile rules changed since rx gates ran (<receipt> → <now>); run rx gates, then rx audit record` / `FAIL  guard  … the audit was recorded against other Greptile rules than the receipt (<audit> vs <receipt>); run rx audit record again` | The receipt, or the audit, names other Greptile rules than the other two. | Run the command the sentence names. |
| `rx: ignoring the invalid Greptile rules copy in <dir>: <problem>` on stderr | A copy in the cache is malformed (an interrupted or hand-edited file). rx skipped it and used the next valid copy. | Delete that directory and run `rx greptile update`. |
| `ERROR  greptile-update  could not read or validate the live rules; nothing written: …` | `update` could not reach GitHub, or main's `.greptile/` failed validation. | Fix connectivity or `gh auth login` and retry; if validation failed, the copy in use is unchanged and still works. |
| `WARN  greptile-update  wrote … but it is not the copy in use: …, sorts later` | A copy from a later upstream commit was already in use, so the one just written changes nothing. | Nothing to do unless that later copy is wrong; `rx greptile outdated` compares it with main. |
| `FAIL  guard  … the Greptile rules changed since the audit was recorded (<old> → <new>); run rx audit record again` / `…; run rx gates, then rx audit record` | The Greptile rules in use changed after `rx audit record` (an `rx greptile update`, another `rx gates` run, or an rx upgrade). An audit written before rx stored the rules says `unrecorded` as the old SHA. The second form appears when the receipt also names other rules than the ones in use, because `rx audit record` refuses that receipt. | Read the changed rules against the branch and update the entries file, then run the command the sentence names. |
| `ERROR  audit-greptile-rules  the Greptile rules changed while the audit was being recorded (<a> → <b>); run rx audit record again` | An `rx greptile update` finished while `rx audit record` was running, so the entries were judged against rules that are no longer in use. Nothing was written. | Read the changed rules against the branch, update the entries file, and run `rx audit record` again. |
| `rx runner: RX_TARBALL=<path> does not exist` / `rx runner: RX_DEV=<dir> is not an rx checkout: <dir>/bin/rx.mjs does not exist` | The runner override points at nothing. | Fix or unset the variable. |
| `rx runner: npm install of RX_TARBALL failed (exit N): …` | The isolated tarball install failed (often no network for its dependencies). | Fix the network, or remove `~/.cache/raycast-harness/runner/tarball/<hash>/` and retry. |
| `rx runner: \`rx commands --json\` via <label> did not print JSON …` / `… reported exit N; cannot learn which commands accept --preset` | The resolved rx could not start or is broken, so the runner cannot inject the preset. | Run the same executable by hand with `commands --json` and read its error. |

### Receipt attestation

`rx gates` and `rx audit record` sign what they write. Each `receipt.json` and `audit.json` carries an `attestation` field: an HMAC-SHA256 over the file's canonical JSON, under a key that exists once per machine at `$XDG_CONFIG_HOME/raycast-harness/attest.key` (by default `~/.config/raycast-harness/attest.key`). The key lives outside every repository and outside the npm installation. The first `rx gates` or `rx audit record` creates it as 32 random bytes, at mode 0600 in a 0700 directory. rx sets that mode only on a directory it creates; if the directory already exists with any group or other access, every command that loads the key stops with `ERROR attest-key` naming the directory and the `chmod 700` fix; `rx guard` and `rx doctor` only read it, and `rx doctor` reports it as `attest-key` with its key id.

Before it looks at anything else, `rx guard` verifies both files against that key. A missing key, a file without an attestation, an attestation in the wrong shape, an attestation made with a different key and a file that changed after rx wrote it each block the publish with their own sentence; the troubleshooting table above quotes every one. A receipt or audit written by an rx older than this version has no attestation, so it blocks with "receipt.json is not attested by this machine's rx key" until `rx gates` and `rx audit record` run again.

An attestation proves who wrote a file, not where or when, so a genuine receipt could otherwise be copied into an identical clone, or saved and put back after a later `rx gates` run had deleted it. Two bindings close that. Every receipt and audit records its `subject`, the real path of the extension root and of the repository's git common directory, and the guard compares it with the checkout it is checking ("receipt.json was written for another checkout"). And every `rx gates` attempt, as its very first step and even when it later fails or stops on a bad argument, writes a new random generation for that root to `$XDG_CONFIG_HOME/raycast-harness/generations/`; the receipt carries the generation it was made under, the guard requires it to be the current one ("receipt.json is from an earlier rx gates attempt"), and the audit records the receipt's generation and MAC so that an audit from a superseded receipt blocks too ("audit.json was recorded against an earlier receipt.json"). `rx audit record` checks all of this, and the receipt's attestation, before it uses the receipt, and `rx audit show` reports any failure as a WARN with the same sentence.

The guard also protects the files themselves. A `Write`, `Edit`, `MultiEdit` or `NotebookEdit` whose target is inside a repository's rx state directory (`.git/rx/`, or `.git/worktrees/<name>/rx` in a worktree) or inside `$XDG_CONFIG_HOME/raycast-harness/` is blocked, with the path resolved the way the filesystem resolves it, so a symlink followed by `..` is caught. So is any Bash command that mentions `.git/rx` or `raycast-harness/attest.key` (also as `.git/./rx` or `.git//rx`), or whose path-like words resolve into either place, even one that only reads. To read state, run `rx audit show`.

What the attestation proves is narrow: the file's contents were produced by a process holding this machine's key, which `rx gates` and `rx audit record` hold and an agent editing files under `.git/rx/` does not. It does not prove the work was done well, and it does not stop a determined process: anything running as the same OS user can read the key, so a deliberate multi-step evasion remains possible. It closes the easy routes, a hand-written receipt, an edited audit and a saved pair put back. The residual is the same deliberate evasion: a process that also restores the generation file, which lives outside the repository and which the guard write-protects, can still replay a saved receipt and audit.

To rotate the key, delete `attest.key`. Until a new one exists, every receipt blocks with "this machine has no rx attestation key". The next `rx gates` creates a new one, and from then on every receipt and audit made with the old key blocks with "was attested by rx key <old>, not this machine's key <new>" until `rx gates` and `rx audit record` run again in that repository. rx never replaces an existing key on its own; a key with the wrong mode, size or type is an `ERROR attest-key` that you fix or remove by hand.

# raycast-harness (`rx`)

Tested, explicit-verdict checks for building and shipping [Raycast](https://www.raycast.com) extensions.

New to rx? Read the [user guide](docs/guide.md) for what it is, how to run it and the common recipes.

Most of the procedure around a Store submission is deterministic: is the published copy older than mine, does every README image resolve, does the CHANGELOG carry exactly one `{PR_MERGE_DATE}`, is this screenshot pixel-identical to the published one, did a contributor actually change code or only the CHANGELOG, may I reply to this review finding yet. Agents and people used to re-type those procedures as shell, and most defects came from the re-typing: a `grep -P` erroring into a false pass, a shell not word-splitting a variable, `ls` hiding a dotfile. `rx` moves each procedure into a Node command with one verdict per check.

## Install and run

```sh
npx raycast-harness commands          # list commands
npx raycast-harness preflight         # from an extension root
npx raycast-harness doctor
```

Requires Node 22.12 or newer. The executable is available as both `rx` and `raycast-harness`.

## Verdict protocol

Every command prints one line per check and exits by the worst verdict:

```
PASS   schema            package.json $schema is the Raycast extension schema
FAIL   readme-links      1 relative link does not resolve
       README.md:12  media/missing.png
N/A    changelog-updated no published copy given; pass --published <dir> (rx stale prints it)
```

| Verdict | Means | Exit |
|---|---|---|
| `PASS` | the check ran and found nothing wrong | 0 |
| `WARN` | report, does not block | 0 |
| `N/A` | nothing to inspect, and the message says why | 0 |
| `FAIL` | the check ran and found a problem | 1 |
| `ERROR` | the check could not run (bad argument, unreadable input, missing tool, network); outranks FAIL | 2 |

Silence is never a pass. Unknown arguments are an `ERROR`. `--json` prints one envelope `{ command, version, fingerprint, data, results, exit }`. The full contract for every command, including its root rule, network boundary and state location, is in [`docs/commands.md`](docs/commands.md).

## Commands

| Command | Does |
|---|---|
| `rx preflight` | Store-readiness checks on package.json, CHANGELOG, README, screenshots, dependencies, shipped files |
| `rx stale` | compares the local tree with the published copy in `raycast/extensions` and classifies every path |
| `rx png` | pixel and color-metadata comparison of screenshots and icons with the published copies (read-only) |
| `rx scan` | finds forbidden example values in files, file names, commit messages and PR text |
| `rx changelog` | placeholder, history and bullet checks; rebuilds the CHANGELOG during a merge |
| `rx contributions` | during a pull-contributions merge: which conflicted files carry a real contribution |
| `rx api-floor` | `@raycast/api` floor and currency, policy from the preset |
| `rx api-diff` | what changed between two published `@raycast/api` versions: files, `types/index.d.ts` diff, CLI commands and flags |
| `rx gates` | runs the gates in order and writes a fingerprinted receipt |
| `rx guard` | the publish hook: allows `ray publish` only on a fresh receipt and a complete audit |
| `rx audit` | records the judgment evidence the receipt cannot hold |
| `rx pr` | verifies a Store PR's author, branch, base and files; edits its body without clobbering hand edits |
| `rx holdout` | moves untracked local-only files out of the payload and verifies their return |
| `rx greptile` | fetches review rounds, waits for the next one, authorizes a reply, detects rule drift |
| `rx shortcuts` | `runtime`: the installed app's `Keyboard.Shortcut.Common` table into the cache; `check`: panels and toast actions against it |
| `rx preset` | validates a preset and regenerates the rule matrix it describes |
| `rx judge` | `ask`: an advisory answer to one named judgment call, or the structured question in agent mode; `eval`: per-fixture output and accuracy (never blocks) |
| `rx doctor` | Node, `ray`, `gh` auth, git signing, Raycast app version |
| `rx commands` | every command's contract as JSON |

**Judge providers.** `rx judge` uses Jev (TypeSafe's decision model, implemented against its public API reference at `https://docs.typesafe.ai/api`, fetched 2026-11-04) when `TYPESAFE_API_KEY` is set, else Claude Haiku (`claude-haiku-5-5`) when `ANTHROPIC_API_KEY` is set, else agent mode, which prints the question, its answers and the inputs for the agent to decide; `--provider` overrides the order. Jev's probabilities are what its API returns; Haiku's are what the model writes into a forced tool call. Neither is calibrated, and `rx judge` never presents them as such. A provider answer counts only at a top probability of 0.7 or more, a provider error falls back to agent mode, and no `judge` result is part of the gates, the audit or the publish guard.

The ESLint rules ship with the package and are importable at `raycast-harness/eslint-plugin` (flat config; `recommended` included).

## Core versus preset

Core encodes only objective, ecosystem-wide facts: Raycast's Store requirements, its Greptile review rules (a versioned snapshot in `src/rules/greptile/`), and what `ray publish` copies. Everything specific to one developer, such as house style, dependency floors or which files they choose to ship, lives in a **preset**: a JSON file validated against `schema/preset.schema.json` and passed with `--preset <file>`. Without a preset, preset-class checks report `N/A (no preset)`; they never silently pass. `docs/check-classes.md` records which class each check belongs to.

## Development

```sh
npm ci
npm run check        # tsc --checkJs, eslint, node --test
node scripts/install-hooks.mjs   # commit-msg hook: refuses Claude Code session URLs
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rules every change follows (contract before code, witnessed red, fixtures, no shelling out to `ls`/`grep`/`find`/`sed`).

## License

Apache License 2.0; see [`LICENSE`](LICENSE). Third-party material and relicensed code are listed in [`NOTICE`](NOTICE).

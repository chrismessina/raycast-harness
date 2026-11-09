# TODO

Work deferred past 0.1.0, and known issues accepted for it. This file is not part of the npm
package.

## Deferred refactors

These come from the structural survey of 2026-11-07, which ranked eight changes by payoff against
cost. Items 1, 2, 3 and 5 shipped before 0.1.0. Chris deferred the four below on 2026-11-08.
Each should land as its own change, with the existing tests as proof and an adversarial review.

- **Survey item 4: preflight check descriptors.** Adding a check today means touching the
  catalog (`src/preflight/catalog.mjs`), the orchestration in `src/preflight/checks.mjs`, an
  enabled-check branch and the option planning. Give each check one descriptor
  (`{ id, class, levels, description, optionKeys, run }`) under `src/preflight/checks/`, derive
  the catalog from them, move binding planning into `src/preset/plan.mjs`, and share the
  `ship.keep` policy between preflight and holdout in `src/preset/shipping.mjs`. Applicability
  feeds the audit and the guard, so the move must not change evaluation. Size: medium.
- **Survey item 6: per-invocation runtime dependencies.** Test seams come in several shapes:
  mutable transport singletons (`src/pr/transport.mjs`, `src/judge/transport.mjs`,
  `src/upstream.mjs`), ambient environment variables, and one-off `_set…ForTests` hooks. Pass a
  `createRuntime({ env, exec, github, judgeHttp, upstream, clock })` into `runCli` and migrate
  one service at a time, with one `test/environment.mjs` builder for isolated config, cache,
  transports and git fixtures. Size: large, incremental.
- **Survey item 7: named file-walking policies.** rx has 13 recursive file walkers and the
  plugin has two more. Share the enumeration mechanics in a small `src/fs/tree.mjs` with explicit
  symlink, error and ordering behavior, and keep each walk's policy visible through named
  projections. Leave the payload walk (it feeds the fingerprint and the guard) and holdout (it
  moves the user's files) out of the first pass. Size: medium.
- **Survey item 8: authorization below the commands.** The receipt and audit validators import
  from the commands that write them, and the trust-check order is spelled out separately in
  gates, audit and guard. Move the contracts into `src/authorization/contracts.mjs`, the
  read-only checks into `src/authorization/inspect.mjs`, and the start of a gates run into
  `src/authorization/attempt.mjs`. This touches code that passed several adversarial rounds, so
  it goes last and only in behavior-preserving stages. Size: large.

## Known issues accepted for 0.1.0

- A `generations/` directory whose owner lost write permission (mode 0500) makes both the
  rotation and the revoking unlink fail, so a restored receipt and audit pass until the
  directory is repaired and `rx gates` runs again. A per-root revocation marker in the parent,
  cleared only by a successful rotation, would close it.
- Someone who also restores the generation file, or copies a whole state directory under a name
  the guard never sees spelled, can replay a receipt. The guard stops an agent that follows the
  ship skill; it does not sandbox a process that sets out to evade it.
- `rx api-diff` waits the full 60 seconds when the npm registry is unreachable.
- `rx audit show` reports a replayed receipt as WARN and exits 0; the guard blocks it.
- A published extension has no clean baseline run: a just-merged extension FAILs
  `changelog-placeholder` until it has a pending entry.
- The `review-pr` skill does not call `rx pr files` for a contributor's PR. (`rx pr verify` checks
  Chris's own PRs and does not fit.)
- When a provider's top answer is below 0.7, `rx judge ask` text output does not name the provider that returned the probabilities; `--json` does. (A PASS and a provider-error fallback already name it.)
- Gates reports the `agents-md-*` checks N/A because `AGENTS.md` is held out before it runs. The
  ship skill requires checking freshness in pre-flight, before `rx holdout out`, and the audit's
  `agents-md-claims` entry must cite that earlier output; nothing enforces the order mechanically.

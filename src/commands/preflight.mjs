// `rx preflight [--root d] [--published d] [--preset f] [--json]`: the Store-readiness checks,
// formerly the plugin's scripts/preflight.mjs. Every catalog id is emitted on every run.
// Contract: docs/commands.md; classes: docs/check-classes.md; applicability: docs/applicability.md.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { RxError } from "../errors.mjs";
import { specChecks } from "../preflight/catalog.mjs";
import { runPreflight } from "../preflight/checks.mjs";
import { loadPreset } from "../preset/load.mjs";
import { insideUpstreamCache, withUpstreamLock } from "../upstream.mjs";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "preflight",
  summary: "Store-readiness checks on an extension (core facts; preset-bound house rules with --preset)",
  root: "required",
  flags: {
    "--root": { type: "string", value: "<dir>", help: "extension root" },
    "--published": { type: "string", value: "<dir>", help: "the extension as published in raycast/extensions (enables the comparison checks)" },
    "--preset": { type: "string", value: "<file>", help: "preset JSON (schema/preset.schema.json); without it preset-class checks are N/A" },
  },
  network: "none",
  state: "none (read-only); reads repo/stale/baseline.json for the `published` applicability value when present",
  data: {
    root: "string",
    published: "boolean — whether --published was given",
    publishedDir: "string | null",
    preset: "string | null — the preset path",
    selfAuthored: "boolean | null — null without a preset",
    checks: "{ [id]: \"core\" | \"preset\" }",
  },
  checks: specChecks(),
  examples: ["rx preflight", "rx preflight --published ~/.cache/raycast-harness/upstream/extensions/brew --preset presets/chrismessina.json --json"],
};

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, root, cwd, results }) {
  if (!root) throw new RxError("preflight needs an extension root", { id: "root" });
  const pubFlag = typeof args.flags["--published"] === "string" ? args.flags["--published"] : null;
  const publishedDir = pubFlag === null ? null : resolve(cwd, pubFlag);
  if (publishedDir !== null && (!existsSync(publishedDir) || !statSync(publishedDir).isDirectory()))
    throw new RxError(`--published ${JSON.stringify(pubFlag)} is not a directory`, { id: "input" });
  const presetFlag = typeof args.flags["--preset"] === "string" ? args.flags["--preset"] : null;
  const preset = presetFlag === null ? null : loadPreset(presetFlag, cwd);
  // A published copy inside the shared upstream cache is read under the cache's reader lock, so a
  // concurrent `rx stale` for another extension cannot swap the tree mid-run. A published
  // directory anywhere else needs no lock.
  const work = () => runPreflight({ root, publishedDir, preset });
  const { outcomes, data } = publishedDir !== null && insideUpstreamCache(publishedDir) ? await withUpstreamLock(work) : await work();
  for (const o of outcomes) results.add(o.verdict, o.id, o.message, o.details);
  return { data };
}

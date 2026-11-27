#!/usr/bin/env node
// `node scripts/bump.mjs <version>`: write a release's version into every file that carries it,
// as CONTRIBUTING's release steps list them, and rename the CHANGELOG's `## Unreleased` to
// `## <version>`. The release workflow (.github/workflows/release.yml) runs it in CI; it can also
// be run by hand before `npm run release`.
//
// Files: package.json `version`; package-lock.json's root `version` and `packages[""].version`;
// docs/commands.md's `--json` example (`"version": "<old>"`, exactly one occurrence); docs/guide.md's
// tarball name (`chrismessina-raycast-harness-<old>.tgz`, exactly one occurrence); CHANGELOG.md's
// `## Unreleased` heading (exactly one). Refuses, changing nothing, unless the new version is a
// plain release version above the current one and every anchor is found exactly once.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, isVersion } from "./github-release.mjs";

export const FILES = Object.freeze(["package.json", "package-lock.json", "docs/commands.md", "docs/guide.md", "CHANGELOG.md"]);

/** Replace exactly one occurrence of `from`, or throw naming the file. @param {string} text @param {string} from @param {string} to @param {string} file */
function once(text, from, to, file) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: expected exactly one ${JSON.stringify(from)}, found ${n}`);
  return text.replace(from, to);
}

/**
 * The bumped contents of every file. Pure: takes and returns `{ [file]: text }`.
 * @param {Record<string, string>} files @param {string} version
 * @returns {Record<string, string>}
 */
export function bump(files, version) {
  if (!isVersion(version)) throw new Error(`not a release version: ${JSON.stringify(version)} (want x.y.z)`);
  const pkg = JSON.parse(files["package.json"]);
  const old = pkg.version;
  if (!isVersion(old)) throw new Error(`package.json has no release version (${JSON.stringify(old)})`);
  if (compareVersions(version, old) <= 0) throw new Error(`${version} is not above the current ${old}`);

  /** @type {Record<string, string>} */
  const out = {};
  out["package.json"] = once(files["package.json"], `"version": "${old}"`, `"version": "${version}"`, "package.json");

  const lock = JSON.parse(files["package-lock.json"]);
  if (lock.version !== old || lock.packages?.[""]?.version !== old) throw new Error(`package-lock.json's root version is not ${old}; run npm install first`);
  lock.version = version;
  lock.packages[""].version = version;
  out["package-lock.json"] = JSON.stringify(lock, null, 2) + "\n";

  out["docs/commands.md"] = once(files["docs/commands.md"], `"version": "${old}",`, `"version": "${version}",`, "docs/commands.md");
  out["docs/guide.md"] = once(files["docs/guide.md"], `chrismessina-raycast-harness-${old}.tgz`, `chrismessina-raycast-harness-${version}.tgz`, "docs/guide.md");
  out["CHANGELOG.md"] = once(files["CHANGELOG.md"], "\n## Unreleased\n", `\n## ${version}\n`, "CHANGELOG.md");
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  try {
    const version = process.argv[2] ?? "";
    /** @type {Record<string, string>} */
    const files = {};
    for (const f of FILES) files[f] = readFileSync(join(root, f), "utf8");
    const out = bump(files, version);
    for (const f of FILES) writeFileSync(join(root, f), out[f]);
    console.log(`bump: ${JSON.parse(files["package.json"]).version} → ${version} in ${FILES.join(", ")}`);
  } catch (e) {
    console.error(`bump: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

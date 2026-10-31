#!/usr/bin/env node
// Copy scripts/commit-msg into this repo's resolved hooks directory (honors core.hooksPath via
// `git rev-parse --git-path hooks`). Idempotent; never overwrites a different existing hook.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const src = join(here, "commit-msg");
const hooksDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: repo, encoding: "utf8" }).trim();
const dest = join(hooksDir, "commit-msg");

if (existsSync(dest)) {
  if (readFileSync(dest).equals(readFileSync(src))) {
    console.log(`ok     ${dest} (already installed)`);
  } else {
    console.error(`SKIP   ${dest} exists and differs; merge by hand`);
    process.exit(1);
  }
} else {
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`added  ${dest}`);
}

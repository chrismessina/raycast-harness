// Nothing the npm package ships names a path on the author's machine (walkthrough finding 7):
// every file under package.json `files` (src/ included) is free of `~/Developer` and `/Users/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO } from "./helpers.mjs";

/** @param {string} p @returns {string[]} */
function walk(p) {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : walk(join(p, e.name))));
}

test("no shipped file contains ~/Developer or /Users/", () => {
  const { files } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const shipped = /** @type {string[]} */ (files).flatMap((f) => walk(join(REPO, f)));
  assert.ok(shipped.some((f) => relative(REPO, f).startsWith("src/judge/decisions/")), "the walk reaches src/");
  /** @type {string[]} */
  const hits = [];
  for (const f of shipped) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (line.includes("~/Developer") || line.includes("/Users/")) hits.push(`${relative(REPO, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("every relative docs/… link in README.md is shipped (listed in package.json files)", () => {
  const { files } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const links = [...readme.matchAll(/\]\((docs\/[^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
  assert.ok(links.includes("docs/guide.md") && links.includes("docs/commands.md"), `the README links the guide and the contracts: ${links.join(", ")}`);
  const shipped = (/** @type {string} */ l) => /** @type {string[]} */ (files).some((f) => l === f || (f.endsWith("/") && l.startsWith(f)));
  assert.deepEqual(links.filter((l) => !shipped(l)), []);
});

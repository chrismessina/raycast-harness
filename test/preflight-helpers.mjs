// Helpers shared by the preflight tests: a minimal PNG writer, a compliant fake extension, and
// shorthands over the in-process CLI.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { REPO, rx } from "./helpers.mjs";

export const LEGACY_PRESET = join(REPO, "test", "fixtures", "presets", "legacy-compat.json");
export const HOUSE_PRESET = join(REPO, "test", "fixtures", "presets", "house.json");
export const CHRIS_PRESET = join(process.env.HOME ?? "", "Developer", "GitHub", "chrismessina", "raycast-extensions-skills-harness", "plugins", "raycast-extensions", "presets", "chrismessina.json");

/** A minimal valid PNG whose IHDR says width×height (grayscale, 8-bit). @param {number} width @param {number} height */
export function png(width, height) {
  const crc = (/** @type {Buffer} */ buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  // One scanline's worth of zeros is enough for a header-only reader; the IDAT need not cover the image.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(width + 1))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const GOOD_PKG = {
  $schema: "https://www.raycast.com/schemas/extension.json",
  name: "good",
  title: "Good Extension",
  author: "testowner",
  icon: "icon.png",
  categories: ["Productivity"],
  platforms: ["macOS"],
  commands: [{ name: "index", title: "Search Items", mode: "view" }],
  preferences: [{ name: "apiKey", title: "API Key", type: "password", required: true }],
  dependencies: { "@raycast/api": "^2.1.0" },
};

export const LOCK = (apiVersion = "2.1.0", extra = {}) =>
  JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@raycast/api": { version: apiVersion, resolved: `https://registry.npmjs.org/@raycast/api/-/api-${apiVersion}.tgz` }, ...extra } });

/**
 * Write a compliant extension into dir, then apply overrides. A file value of null removes the
 * default; a Buffer is written as bytes.
 * @param {string} dir
 * @param {{ pkg?: Record<string, unknown>, files?: Record<string, string | Buffer | null> }} [overrides]
 */
export function makeExt(dir, overrides = {}) {
  /** @type {Record<string, string | Buffer | null>} */
  const files = {
    "package.json": JSON.stringify({ ...GOOD_PKG, ...(overrides.pkg || {}) }, null, 2),
    "package-lock.json": LOCK(),
    ".prettierrc": JSON.stringify({ printWidth: 120, singleQuote: false }),
    "eslint.config.js": 'const { defineConfig } = require("eslint/config");\nmodule.exports = defineConfig([]);\n',
    "CHANGELOG.md": "# Changelog\n\n## [Update] - {PR_MERGE_DATE}\n\n- New\n\n## [Initial Version] - 2026-01-02\n",
    "README.md": "# Good\n\n![Shot](media/shot.png)\n",
    "media/shot.png": png(10, 10),
    "assets/icon.png": png(512, 512),
    "metadata/good-1.png": png(2000, 1250),
    "src/index.tsx": 'import { List, getPreferenceValues } from "@raycast/api";\nconst p = getPreferenceValues<Preferences>();\n',
    ...(overrides.files || {}),
  };
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/**
 * Run preflight and index results by id.
 * @param {string} root @param {{ preset?: string | null, published?: string }} [opts]
 */
export async function preflight(root, opts = {}) {
  const argv = ["preflight", "--root", root, "--json"];
  const preset = opts.preset === undefined ? LEGACY_PRESET : opts.preset;
  if (preset) argv.push("--preset", preset);
  if (opts.published) argv.push("--published", opts.published);
  const r = await rx(argv);
  if (!r.json) throw new Error(`preflight printed no JSON:\n${r.stdout}\n${r.stderr}`);
  /** @type {Record<string, { id: string, verdict: string, message: string, details: { file?: string, line?: number, text: string }[] }>} */
  const by = Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));
  return { ...r, by, verdict: (/** @type {string} */ id) => by[id]?.verdict, fails: r.json.results.filter((/** @type {any} */ x) => x.verdict === "FAIL").map((/** @type {any} */ x) => x.id), warns: r.json.results.filter((/** @type {any} */ x) => x.verdict === "WARN").map((/** @type {any} */ x) => x.id) };
}

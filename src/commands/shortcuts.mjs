// `rx shortcuts runtime` and `rx shortcuts check` (docs/commands.md §4.13).
//
//   runtime  reads the installed Raycast app's API shim, extracts the full Keyboard.Shortcut.Common
//            table and writes it to the cross-repo cache keyed by the shim's fingerprint.
//   check    scans an extension's source (src/shortcuts/scan.mjs) and compares every declared
//            shortcut with that table: two actions in one panel (or one toast) resolving to the same
//            binding → FAIL shortcut-ambiguous; a binding the panel assigns itself → FAIL
//            shortcut-reserved. No matching table while the extension declares any shortcut →
//            ERROR shortcut-runtime-table ("runtime evidence unavailable"): the audit cannot be
//            completed. N/A only when the extension declares no shortcuts (plan-review-2 F4).
//
// Nothing here claims a bundled table matches the installed runtime; there is no bundled table.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { run as exec } from "../exec.mjs";
import { RxError } from "../errors.mjs";
import { cachePath } from "../state.mjs";
import { declaredPlatforms, exclusive, scanExtension } from "../shortcuts/scan.mjs";
import { loadTypeScript } from "../typescript.mjs";
import {
  APP_CANDIDATES,
  discoverApp,
  extractCommonTable,
  fingerprintShim,
  formatBinding,
  loadTable,
  normalizeBinding,
  plistPathFor,
  reservedMatch,
  shimPathFor,
} from "../shortcuts/table.mjs";

const CHECK_IDS = {
  "shortcut-runtime-table": "a Keyboard.Shortcut.Common table from the running Raycast app is available (ERROR runtime evidence unavailable when shortcuts are declared and none matches; N/A only when none are declared)",
  "shortcut-ambiguous": "no two actions in one resolved ActionPanel (or one toast) share a binding on a declared platform; one FAIL per conflicting pair",
  "shortcut-reserved": "no ActionPanel shortcut spells out a binding the panel assigns itself (↵, ⌘↵, ⌘⇧↵); one FAIL per site; toast actions are not panels and are not checked",
};

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "shortcuts",
  summary: "runtime Keyboard.Shortcut.Common table from the installed Raycast app, and an extension's shortcuts checked against it",
  network: "none",
  subcommands: {
    runtime: {
      name: "runtime",
      summary: "extract the Common table, app version and shim fingerprint from the installed Raycast app into the cache",
      root: "none",
      network: "none (reads Raycast.app from /Applications or ~/Applications, or --app; `plutil` runs through execFile)",
      state: "writes $XDG_CACHE_HOME/raycast-harness/shortcuts/<shimFingerprint>.json",
      flags: {
        "--app": { type: "string", value: "<Raycast.app>", help: "the Raycast.app bundle to read instead of the one found in /Applications or ~/Applications" },
      },
      checks: { "shortcut-runtime-table": CHECK_IDS["shortcut-runtime-table"] },
      data: {
        appVersion: "string | null — CFBundleShortVersionString of the installed app",
        shimFingerprint: "string — SHA-256 of the shim file the app loads",
        path: "string — the table file written",
        count: "number — Common constants in the table",
      },
      examples: ["rx shortcuts runtime", "rx shortcuts runtime --app ~/Applications/Raycast.app --json"],
    },
    check: {
      name: "check",
      summary: "compare the extension's resolved panels and toast actions with the runtime table",
      root: "required",
      network: "none",
      state: "reads shortcuts/<shimFingerprint>.json from the cache (the fingerprint of the installed app's shim) unless --table is given; writes nothing; runs no code from the extension unless --extension-typescript is given",
      flags: {
        "--table": { type: "string", value: "<file>", help: "a table written by `rx shortcuts runtime` (or a recorded fixture) instead of the one matching the installed app" },
        "--root": { type: "string", value: "<dir>", help: "extension root" },
        "--extension-typescript": { type: "boolean", help: "read source with the extension's installed typescript, which loads and runs that package's code (as a build would); without it the source is only read, by the text scan" },
      },
      checks: CHECK_IDS,
      data: {
        table: "{ path, appVersion, shimFingerprint } | null",
        declared: "number — shortcuts found (resolved or not)",
        conflicts: "[{ platforms, binding, sites: [{ file, line, title, source }] }]",
        reserved: "[{ platforms, binding, why, site }]",
        platforms: "the platforms package.json declares (absent → [\"macOS\"])",
        unresolved: "[{ file, line, title, source }] — declared shortcuts whose binding could not be read statically (a variable, a spread, a composed component; see src/shortcuts/scan.mjs)",
        groups: "{ panels, toasts, loose }",
        files: "number of source files scanned",
        parser: "string | null — the extension's TypeScript the scan read source with (\"typescript <version>\"); null without --extension-typescript or when none could be loaded",
        textScanned: "string[] — files read by the fallback text scan instead (every file without a parser, else those that did not parse cleanly)",
      },
      examples: ["rx shortcuts check", "rx shortcuts check --root ../raycast-brew --table test/fixtures/shortcuts/table-2.10.1.0.json"],
    },
  },
};

/** @type {{ shim?: string, plist?: string }} */
let OVERRIDE = {};
/** Test hook: point the runtime extraction at a recorded shim and plist instead of an app bundle. @param {{ shim?: string, plist?: string }} p */
export function _setRuntimePaths({ shim, plist } = {}) {
  OVERRIDE = { shim, plist };
}

/**
 * The shim and plist to read: the test override, else `--app`, else the first discovered app.
 * `shim` is null when nothing was found; `searched` names what was looked at for the message.
 * @param {string | null} app
 */
function locate(app) {
  if (OVERRIDE.shim) return { shim: OVERRIDE.shim, plist: OVERRIDE.plist ?? null, searched: [OVERRIDE.shim] };
  if (app) return { shim: shimPathFor(app), plist: plistPathFor(app), searched: [app] };
  const found = discoverApp();
  return { shim: found ? shimPathFor(found) : null, plist: found ? plistPathFor(found) : null, searched: APP_CANDIDATES() };
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  if (ctx.args.subcommand === "runtime") return runtime(ctx);
  return check(ctx);
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function runtime({ args, results, log }) {
  const app = typeof args.flags["--app"] === "string" ? args.flags["--app"] : null;
  const { shim, plist, searched } = locate(app);
  if (!shim || !existsSync(shim)) {
    throw new RxError(`Raycast app shim not found (looked in ${searched.join(", ")}); install Raycast, pass --app <Raycast.app>, or pass --table to \`rx shortcuts check\``, { id: "shortcut-runtime-table" });
  }
  const shimFingerprint = fingerprintShim(shim);
  const shortcuts = extractCommonTable(readFileSync(shim, "utf8"));
  const appVersion = await readAppVersion(plist, log);
  const path = cachePath("shortcuts", `${shimFingerprint}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ appVersion, shimFingerprint, shortcuts }, null, 2) + "\n");
  const count = Object.keys(shortcuts).length;
  results.pass("shortcut-runtime-table", `Raycast ${appVersion ?? "(version unreadable)"}: ${count} Common constants written to ${path}`);
  return { data: { appVersion, shimFingerprint, path, count }, fingerprint: null };
}

/** @param {string | null} plist @param {(s: string) => void} log */
async function readAppVersion(plist, log) {
  if (!plist || !existsSync(plist)) return null;
  try {
    const r = await exec("plutil", ["-convert", "json", "-o", "-", plist]);
    if (r.code !== 0) { log(`plutil exit ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}\n`); return null; }
    const v = JSON.parse(r.stdout).CFBundleShortVersionString;
    return typeof v === "string" ? v : null;
  } catch (e) {
    log(`${/** @type {Error} */ (e).message}\n`);
    return null;
  }
}

/** @param {import("../cli.mjs").CommandContext} ctx */
async function check({ args, root, results }) {
  const ext = /** @type {string} */ (root);
  const useTs = args.flags["--extension-typescript"] === true;
  const scan = scanExtension(ext, useTs ? loadTypeScript(ext) : null);
  const platforms = declaredPlatforms(ext);
  const groupsSummary = {
    panels: scan.groups.filter((g) => g.kind === "panel").length,
    toasts: scan.groups.filter((g) => g.kind === "toast").length,
    loose: scan.groups.filter((g) => g.kind === "loose").length,
  };
  // Unresolved sites are known before any table lookup, so an early ERROR return still lists them.
  const unresolved = scan.shortcuts.filter((sc) => sc.kind === "unresolved").map(site);
  /** @type {Record<string, unknown>} */
  const data = { table: null, declared: scan.shortcuts.length, conflicts: [], reserved: [], platforms, unresolved, groups: groupsSummary, files: scan.files, parser: scan.parser, textScanned: scan.textScanned };
  const reader = scan.parser === null ? `; text scan: ${useTs ? "the extension's typescript could not be loaded" : "--extension-typescript was not given, so no extension code was run"}` : scan.textScanned.length ? `; ${scan.parser}, text scan for ${scan.textScanned.length} file${scan.textScanned.length === 1 ? "" : "s"} that did not parse` : `; ${scan.parser}`;

  if (scan.shortcuts.length === 0) {
    const why = `extension declares no shortcuts (${scan.files} source files scanned${reader})`;
    results.na("shortcut-runtime-table", why);
    results.na("shortcut-ambiguous", why);
    results.na("shortcut-reserved", why);
    return { data };
  }

  // The table: --table wins; otherwise the cache entry for the installed app's shim.
  /** @type {import("../shortcuts/table.mjs").ShortcutTable} */
  let table;
  /** @type {string} */
  let tablePath;
  const explicit = typeof args.flags["--table"] === "string" ? args.flags["--table"] : null;
  if (explicit) {
    tablePath = explicit;
    table = loadTable(explicit);
  } else {
    const { shim, searched } = locate(null);
    if (!shim || !existsSync(shim)) {
      results.error("shortcut-runtime-table", `runtime evidence unavailable: ${scan.shortcuts.length} shortcuts declared and no Raycast app shim (looked in ${searched.join(", ")}); run \`rx shortcuts runtime\` on a machine with Raycast, then pass its table with --table`);
      return { data };
    }
    const fp = fingerprintShim(shim);
    tablePath = cachePath("shortcuts", `${fp}.json`);
    if (!existsSync(tablePath)) {
      results.error("shortcut-runtime-table", `runtime evidence unavailable: ${scan.shortcuts.length} shortcuts declared and no table for the installed app (shim ${fp.slice(0, 12)}); run \`rx shortcuts runtime\``);
      return { data };
    }
    table = loadTable(tablePath);
    if (table.shimFingerprint !== fp) {
      results.error("shortcut-runtime-table", `runtime evidence unavailable: ${tablePath} records shim ${table.shimFingerprint.slice(0, 12)} but the installed app's shim is ${fp.slice(0, 12)}; run \`rx shortcuts runtime\``);
      return { data };
    }
  }
  data.table = { path: tablePath, appVersion: table.appVersion, shimFingerprint: table.shimFingerprint };
  results.pass("shortcut-runtime-table", `${tablePath} (Raycast ${table.appVersion ?? "version unrecorded"}, ${Object.keys(table.shortcuts).length} Common constants, shim ${table.shimFingerprint.slice(0, 12)})`);

  // Resolve every shortcut to a binding per declared platform.
  /** @type {{ sc: import("../shortcuts/scan.mjs").Shortcut, bindings: Partial<Record<"macOS" | "Windows", import("../shortcuts/table.mjs").Binding>> }[]} */
  const resolved = [];
  for (const sc of scan.shortcuts) {
    if (sc.kind === "common") {
      const entry = sc.name ? table.shortcuts[sc.name] : undefined;
      if (!entry) { unresolved.push(site(sc)); continue; } // a Common name the runtime lacks (tsc rejects it too)
      resolved.push({ sc, bindings: { macOS: entry.macOS, Windows: entry.Windows } });
    } else if (sc.kind !== "unresolved") resolved.push({ sc, bindings: sc.bindings });
  }
  unresolved.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // Collisions: same group, same platform, same normalized binding.
  /** @type {Map<string, { platforms: Set<string>, binding: string, a: typeof resolved[number], b: typeof resolved[number] }>} */
  const pairs = new Map();
  for (const platform of platforms) {
    /** @type {Map<string, typeof resolved>} */
    const buckets = new Map();
    for (const r of resolved) {
      const group = scan.groups[r.sc.group];
      if (group.kind === "loose") continue;
      const b = r.bindings[platform];
      if (!b) continue;
      const key = `${group.id}\u0000${normalizeBinding(b)}`;
      const list = buckets.get(key) ?? [];
      list.push(r);
      buckets.set(key, list);
    }
    for (const list of buckets.values()) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (exclusive(a.sc, b.sc)) continue;
        const key = `${a.sc.file}:${a.sc.line}|${b.sc.file}:${b.sc.line}`;
        const entry = pairs.get(key) ?? { platforms: new Set(), binding: formatBinding(/** @type {any} */ (a.bindings[platform]), platform), a, b };
        entry.platforms.add(platform);
        pairs.set(key, entry);
      }
    }
  }
  /** @type {unknown[]} */
  const conflicts = [];
  for (const p of pairs.values()) {
    const plats = [...p.platforms];
    const label = (/** @type {typeof p.a} */ r) => `${r.sc.file}:${r.sc.line} ${r.sc.title ? JSON.stringify(r.sc.title) : r.sc.source}`;
    results.fail("shortcut-ambiguous", `${label(p.a)} and ${label(p.b)} both resolve to ${p.binding} on ${plats.join(" and ")}`, [
      { file: p.a.sc.file, line: p.a.sc.line, text: `${p.a.sc.title ?? "(untitled)"}: ${p.a.sc.source}` },
      { file: p.b.sc.file, line: p.b.sc.line, text: `${p.b.sc.title ?? "(untitled)"}: ${p.b.sc.source}` },
    ]);
    conflicts.push({ platforms: plats, binding: p.binding, sites: [site(p.a.sc), site(p.b.sc)] });
  }
  data.conflicts = conflicts;
  if (conflicts.length === 0) {
    results.pass("shortcut-ambiguous", `${resolved.length} of ${scan.shortcuts.length} shortcuts resolved across ${groupsSummary.panels} panels and ${groupsSummary.toasts} toasts; no two in one group share a binding on ${platforms.join(" or ")}${unresolved.length ? ` (${unresolved.length} unresolved, listed in data)` : ""}${reader}`);
  }

  // Reserved: a binding the panel assigns itself. Panels and loose actions (rendered into a panel
  // from another component) only: a toast's actions have no primary/secondary default to collide with.
  /** @type {unknown[]} */
  const reserved = [];
  for (const r of resolved) {
    if (scan.groups[r.sc.group].kind === "toast") continue;
    /** @type {{ platforms: string[], binding: string, why: string } | null} */
    let hit = null;
    for (const platform of platforms) {
      const b = r.bindings[platform];
      const m = b ? reservedMatch(b) : null;
      if (!m) continue;
      if (!hit) hit = { platforms: [], binding: formatBinding(/** @type {any} */ (b), platform), why: m.why };
      hit.platforms.push(platform);
    }
    if (!hit) continue;
    results.fail("shortcut-reserved", `${r.sc.file}:${r.sc.line} ${r.sc.title ? JSON.stringify(r.sc.title) : r.sc.source} spells out ${hit.binding}, ${hit.why}; the panel assigns that itself, so this action either is that default (drop the prop) or collides with it`, [
      { file: r.sc.file, line: r.sc.line, text: r.sc.source },
    ]);
    reserved.push({ ...hit, site: site(r.sc) });
  }
  data.reserved = reserved;
  if (reserved.length === 0) results.pass("shortcut-reserved", `no ActionPanel shortcut spells out a panel default (↵, ⌘↵, ⌘⇧↵)`);

  return { data, fingerprint: null };
}

/** @param {import("../shortcuts/scan.mjs").Shortcut} sc */
function site(sc) {
  return { file: sc.file, line: sc.line, title: sc.title, source: sc.source };
}

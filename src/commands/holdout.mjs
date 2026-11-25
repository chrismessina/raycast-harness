// `rx holdout out --preset <file> [--root <dir>]` · `rx holdout in [--root <dir>]`
// (docs/commands.md §4.11). Keeps local-only files safe while `ray publish` and
// `pull-contributions` run: `ray publish` copies everything under the root (ignored and untracked
// included), and a tracked-and-ignored file cannot be held back by `.gitignore` at all.
//
//   out   moves ONLY untracked entries the preset's `holdout.localOnly` names (default `.env`,
//         `.claude`, `.superpowers`) to the repo state dir, writing an inventory first. A
//         localOnly path tracked in this checkout's index (the mirror's, never the published
//         copy's) is never moved: FAIL holdout-tracked, whose detail says the fix, `git rm
//         --cached` it (the file stays on disk) and list it in the extension's `.gitignore`. Anything in the preset's `ship.keep` is never touched. An empty
//         inventory while a listed path still exists in the root is an ERROR (plan-review-1 #8,
//         #32975: a filtered `ls` hid `.claude`, nothing moved, the inventory came back empty).
//   in    restores every inventory entry, refusing to overwrite a destination that reappeared
//         with different content, and verifies each hash after the move.
//
// The preset is validated whole against the preset schema (as loadPreset() does), then read for
// exactly two fields:
//   holdout.localOnly: string[]           ship.keep: [{ path, extensions: string[], reason }]
// A keep entry applies only when its `extensions` names this extension's package.json `name`.
// Keep protection is ancestor/descendant aware: a kept file inside a local-only directory stays
// while the rest of that directory moves entry by entry; a local-only descendant of a kept
// directory still moves. The inventory records the extension root (realpath); `in` refuses to
// restore into a different root (one repo can hold several extensions sharing .git/rx).

import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RxError } from "../errors.mjs";
import { git, isWorkTree } from "../git.mjs";
import { loadPreset } from "../preset/load.mjs";
import { repoStatePath } from "../state.mjs";

export const DEFAULT_LOCAL_ONLY = Object.freeze([".env", ".claude", ".superpowers"]);

const rootFlag = /** @type {import("../args.mjs").Flag} */ ({ type: "string", value: "<dir>", help: "extension root" });

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "holdout",
  summary: "move untracked local-only files out of the root before a publish (out) and restore them, verified, afterward (in)",
  root: "required",
  network: "none",
  state: "writes repo/holdout/inventory.json and moves files to repo/holdout/files/ (`git rev-parse --git-path rx`)",
  subcommands: {
    out: {
      name: "out",
      summary: "move the preset's untracked local-only entries out of the root, recording an inventory",
      flags: {
        "--root": rootFlag,
        "--preset": { type: "string", value: "<file>", required: true, help: "preset JSON, validated against the preset schema; reads holdout.localOnly and ship.keep" },
      },
      checks: {
        "holdout-out": { description: "untracked local-only entries moved (PASS with one detail per path; N/A when nothing matches)", levels: ["PASS", "N/A"] },
        "holdout-tracked": "no local-only path is tracked in this checkout's index (FAIL names each one with its fix: git rm --cached <path>, the file stays on disk, and list it in the extension's .gitignore, or, if the preset's owner decides it ships, list it in ship.keep; ERROR, before anything moves or an inventory is written, when git cannot read the index)",
        "holdout-inventory": { description: "inventory written and non-empty whenever a movable local-only path exists (ERROR otherwise, or when a holdout is already in progress)", levels: ["PASS", "ERROR"] },
      },
      data: { moved: "[{ source, destination, type, hash }]", restored: "[] (always empty for out)", skipped: "[{ path, reason }]" },
      examples: ["rx holdout out --preset ~/plugin/presets/chrismessina.json"],
    },
    in: {
      name: "in",
      summary: "restore every inventory entry without overwriting a changed destination, and verify each hash",
      flags: { "--root": rootFlag },
      checks: {
        "holdout-in": "every entry restored to its source and verified by hash (FAIL names the path that changed or failed)",
        "holdout-inventory": { description: "inventory present and recorded for this root (ERROR when missing or for another root)", levels: ["PASS", "ERROR"] },
      },
      data: { moved: "[] (always empty for in)", restored: "[{ source, destination, type, hash }]", skipped: "[{ path, reason }]" },
      examples: ["rx holdout in"],
    },
  },
};

/**
 * @typedef {{ source: string, destination: string, type: "file" | "dir" | "symlink", hash: string }} InventoryEntry
 * @typedef {{ version: 1, root: string, createdAt: string, entries: InventoryEntry[] }} Inventory
 *   `root` is the extension root's realpath; `in` refuses a different root.
 * @typedef {{ path: string, extensions: string[] }} KeepEntry
 */

/**
 * Read the two preset fields this command uses, after validating the WHOLE preset against the
 * schema loadPreset() uses: a typo such as `holdout.localonly` or `ship.keeps` is ERROR input
 * before anything is planned, never a silent fallback to the default list or to no keeps. Paths
 * are normalized after validation. `keep` carries every entry with its `extensions`; use
 * keepPathsFor() to select the ones that apply to one extension.
 * @param {string} file absolute
 * @returns {{ localOnly: string[], keep: KeepEntry[] }}
 */
export function readPresetFields(file) {
  const { preset } = loadPreset(file);
  const localOnly = preset.holdout?.localOnly ?? DEFAULT_LOCAL_ONLY;
  const keep = (preset.ship?.keep ?? []).map((k) => ({ path: normalizeRel(k.path, file, "ship.keep[].path"), extensions: [...k.extensions] }));
  return { localOnly: localOnly.map((p) => normalizeRel(p, file, "holdout.localOnly")), keep };
}

/** The kept paths that apply to one extension. @param {KeepEntry[]} keep @param {string | null} name */
export function keepPathsFor(keep, name) {
  return name === null ? [] : keep.filter((k) => k.extensions.includes(name)).map((k) => k.path);
}

/**
 * Expand one local-only path into the entries to move, given the kept paths. A path equal to a
 * kept path yields nothing; a directory containing a kept path yields its non-kept children
 * (recursively); any other path yields itself. Paths are root-relative with `/`.
 * @param {string} root @param {string} p @param {string[]} kept
 * @returns {{ move: string[], kept: string[] }}
 */
export function expandForKeep(root, p, kept) {
  /** @type {string[]} */
  const move = [];
  /** @type {string[]} */
  const keptHit = [];
  const visit = (/** @type {string} */ rel) => {
    if (kept.includes(rel)) {
      keptHit.push(rel);
      return;
    }
    const containsKept = kept.some((k) => k.startsWith(rel + "/"));
    if (containsKept && lstatSync(join(root, rel)).isDirectory()) {
      for (const name of readdirSync(join(root, rel)).sort()) visit(`${rel}/${name}`);
      return;
    }
    move.push(rel);
  };
  visit(p);
  return { move, kept: keptHit };
}

/** A root-relative path with no `..`, no leading `/`, no trailing `/`. @param {string} p @param {string} file @param {string} field */
function normalizeRel(p, file, field) {
  const clean = p.replace(/\/+$/, "").replace(/^\.\//, "");
  if (!clean || clean.startsWith("/") || clean.split("/").some((s) => s === ".." || s === "")) throw new RxError(`--preset ${file}: ${field} entry ${JSON.stringify(p)} must be a relative path inside the root`, { id: "input" });
  return clean;
}

/**
 * Content fingerprint: a file hashes its bytes, a symlink its target, a directory the sorted
 * list of (relative path, entry hash) beneath it. Same entry, same hash, wherever it sits.
 * @param {string} abs
 * @returns {{ type: "file" | "dir" | "symlink", hash: string }}
 */
export function fingerprint(abs) {
  const st = lstatSync(abs);
  const h = createHash("sha256");
  if (st.isSymbolicLink()) return { type: "symlink", hash: `sha256:${h.update(`link:${readlinkSync(abs)}`).digest("hex")}` };
  if (st.isDirectory()) {
    const walk = (/** @type {string} */ rel) => {
      for (const name of readdirSync(join(abs, rel)).sort()) {
        const r = rel ? `${rel}/${name}` : name;
        const fp = fingerprint(join(abs, r));
        h.update(`${fp.type}:${r}:${fp.hash}\n`);
        if (fp.type === "dir") walk(r);
      }
    };
    h.update("dir\n");
    walk("");
    return { type: "dir", hash: `sha256:${h.digest("hex")}` };
  }
  return { type: "file", hash: `sha256:${h.update(readFileSync(abs)).digest("hex")}` };
}

/**
 * @param {string} from @param {string} to
 * @param {{ renameSync: Function, cpSync: Function, rmSync: Function }} [ops]
 */
export function move(from, to, ops = { renameSync, cpSync, rmSync }) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    ops.renameSync(from, to);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EXDEV") throw e;
    try {
      ops.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    } catch (copyError) {
      ops.rmSync(to, { recursive: true, force: true });
      throw copyError;
    }
    try {
      ops.rmSync(from, { recursive: true, force: true });
    } catch (removeError) {
      throw Object.assign(/** @type {Error} */ (removeError), { held: true });
    }
  }
}

/**
 * @param {InventoryEntry[]} planned @param {string} root
 * @param {(from: string, to: string) => void} mover @param {(s: string) => void} log
 */
export function performMoves(planned, root, mover, log) {
  /** @type {InventoryEntry[]} */
  const moved = [];
  /** @type {InventoryEntry[]} */
  const held = [];
  /** @type {import("../verdict.mjs").Detail[]} */
  const failures = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  for (const e of planned) {
    log(`holdout: ${e.source} -> ${e.destination}\n`);
    try {
      mover(join(root, e.source), e.destination);
      moved.push(e);
    } catch (err) {
      const isHeld = /** @type {{ held?: boolean }} */ (err).held === true;
      if (isHeld) held.push(e);
      const text = isHeld ? `copied, but the source could not be removed: ${/** @type {Error} */ (err).message}` : `move failed: ${/** @type {Error} */ (err).message}`;
      failures.push({ file: e.source, text });
      skipped.push({ path: e.source, reason: text });
    }
  }
  return { moved, held, failures, skipped };
}

/** @param {string} word */
function shellWord(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** @param {string} path */
function readInventory(path) {
  if (!existsSync(path)) return null;
  try {
    const inv = /** @type {Inventory} */ (JSON.parse(readFileSync(path, "utf8")));
    if (!inv || !Array.isArray(inv.entries)) throw new Error("no entries array");
    return inv;
  } catch (e) {
    throw new RxError(`inventory ${path} is unreadable: ${/** @type {Error} */ (e).message}`, { id: "input" });
  }
}

/** @param {string} path @param {Inventory} inv */
function writeInventory(path, inv) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(inv, null, 2) + "\n");
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run(ctx) {
  const root = /** @type {string} */ (ctx.root);
  if (!(await isWorkTree(root))) throw new RxError(`${root} is not a git work tree; holdout needs git to tell tracked from untracked`, { id: "git" });
  const inventoryPath = await repoStatePath(root, "holdout", "inventory.json");
  const filesDir = await repoStatePath(root, "holdout", "files");
  if (ctx.args.subcommand === "out") return out(ctx, root, inventoryPath, filesDir);
  return restore(ctx, root, inventoryPath, filesDir);
}

/**
 * @param {import("../cli.mjs").CommandContext} ctx
 * @param {string} root @param {string} inventoryPath @param {string} filesDir
 */
async function out({ args, cwd, results, log }, root, inventoryPath, filesDir) {
  const { localOnly, keep: keepAll } = readPresetFields(resolve(cwd, /** @type {string} */ (args.flags["--preset"])));
  /** @type {string | null} */
  let name;
  try {
    const n = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
    name = typeof n === "string" && n ? n : null;
  } catch {
    name = null;
  }
  const keep = keepPathsFor(keepAll, name);
  const realRoot = realpathSync(root);
  /** @type {InventoryEntry[]} */
  const moved = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  const data = { moved, restored: [], skipped };

  const existing = readInventory(inventoryPath);
  if (existing && existing.entries.length) {
    results.error("holdout-inventory", `a holdout is already in progress (${existing.entries.length} entries in ${inventoryPath}); run \`rx holdout in\` first`);
    return { data };
  }

  /** @type {string[]} */
  const present = localOnly.filter((p) => existsSync(join(root, p)) || isSymlink(join(root, p)));
  /** @type {import("../verdict.mjs").Detail[]} */
  const tracked = [];
  /** @type {import("../verdict.mjs").Detail[]} paths git could not classify */
  const unreadable = [];
  /** @type {InventoryEntry[]} what may move: untracked, not kept */
  const planned = [];
  for (const p of present) {
    const { move: candidates, kept } = expandForKeep(root, p, keep);
    for (const k of kept) skipped.push({ path: k, reason: `ship.keep: the preset ships it for ${name}` });
    for (const c of candidates) {
      const ls = await git(["ls-files", "--error-unmatch", "--", c], { cwd: root, allowFail: true });
      // Only exit 1 means "not in the index". Any other failure (128: a corrupt or unreadable
      // index) says nothing about tracking, so the path must not be treated as untracked.
      if (ls.code !== 0 && ls.code !== 1) {
        unreadable.push({ file: c, text: `git ls-files exit ${ls.code}: ${(ls.stderr ?? "").trim() || "no output"}` });
        continue;
      }
      if (ls.code === 0) {
        const dir = lstatSync(join(root, c)).isDirectory();
        tracked.push({ file: c, text: `tracked in this checkout's index, so it cannot be held out: run \`git -C ${shellWord(root)} rm ${dir ? "-r " : ""}--cached -- ${shellWord(c)}\` (the file stays on disk), list ${c}${dir ? "/" : ""} in that checkout's .gitignore, then run \`rx holdout in --root ${shellWord(root)}\` to restore anything this run moved, and run \`rx holdout out\` again with the same arguments` });
        skipped.push({ path: c, reason: "tracked" });
        continue;
      }
      const fp = fingerprint(join(root, c));
      const destination = join(filesDir, c);
      if (existsSync(destination) || isSymlink(destination)) {
        results.error("holdout-inventory", `${destination} already exists without an inventory entry; inspect it before holding out again`);
        return { data };
      }
      planned.push({ source: c, destination, type: fp.type, hash: fp.hash });
    }
  }

  if (unreadable.length) {
    skipped.push(...unreadable.map((d) => ({ path: /** @type {string} */ (d.file), reason: "index unreadable" })));
    results.error("holdout-tracked", `could not read this checkout's index, so tracked paths cannot be told from untracked ones; nothing was moved and no inventory was written. Repair the index (for example, \`git -C ${shellWord(root)} status\` shows the error), then run \`rx holdout out\` again`, unreadable);
    return { data };
  }

  // Inventory first, then the moves: a crash between the two leaves a record of what was meant to
  // move, and `in` verifies by hash so an entry that never moved is reported, not invented.
  /** @type {Inventory} */
  const inv = { version: 1, root: realRoot, createdAt: new Date().toISOString(), entries: planned };
  writeInventory(inventoryPath, inv);
  const { moved: done, held, failures: moveFailures, skipped: failedMoves } = performMoves(planned, root, move, log);
  moved.push(...done);
  skipped.push(...failedMoves);
  const recorded = [...moved, ...held];
  if (recorded.length !== planned.length) writeInventory(inventoryPath, { ...inv, entries: recorded });

  if (tracked.length) results.fail("holdout-tracked", `${tracked.length} local-only path(s) are tracked in this checkout's index; untrack each with git rm --cached and list it in the extension's .gitignore, or, if the preset's owner decides it ships, list it in the preset's ship.keep for this extension`, tracked);
  else results.pass("holdout-tracked", "no local-only path is tracked");

  if (moved.length) results.pass("holdout-out", `${moved.length} untracked local-only entr${moved.length === 1 ? "y" : "ies"} moved to ${filesDir}`, moved.map((e) => ({ file: e.source, text: `${e.type} ${e.hash}` })));
  else if (planned.length) results.na("holdout-out", "nothing moved; see holdout-inventory");
  else results.na("holdout-out", "nothing untracked matches the preset's localOnly list");

  // The #32975 shape: something movable exists, yet nothing moved. Kept and tracked paths are
  // not movable and never trigger this; a failed move does.
  if (!recorded.length && planned.length) {
    results.error("holdout-inventory", `inventory is empty while movable local-only path(s) exist in the root: ${planned.map((e) => e.source).join(", ")}`, moveFailures);
  } else if (moveFailures.length) {
    results.error("holdout-inventory", `${moveFailures.length} planned move(s) failed; ${recorded.length} recorded in ${inventoryPath}`, moveFailures);
  } else {
    results.pass("holdout-inventory", `${recorded.length} entr${recorded.length === 1 ? "y" : "ies"} recorded in ${inventoryPath}`);
  }
  return { data };
}

/**
 * @param {import("../cli.mjs").CommandContext} ctx
 * @param {string} root @param {string} inventoryPath @param {string} filesDir
 */
async function restore({ results, log }, root, inventoryPath, filesDir) {
  /** @type {InventoryEntry[]} */
  const restored = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  const data = { moved: [], restored, skipped };
  const inv = readInventory(inventoryPath);
  if (!inv) {
    results.error("holdout-inventory", `no inventory at ${inventoryPath}; nothing is known to be held out`);
    return { data };
  }
  const realRoot = realpathSync(root);
  if (inv.root !== realRoot) {
    results.error("holdout-inventory", `inventory belongs to ${inv.root}, not ${realRoot}; run \`rx holdout in --root ${inv.root}\``);
    return { data };
  }
  results.pass("holdout-inventory", `${inv.entries.length} entr${inv.entries.length === 1 ? "y" : "ies"} in ${inventoryPath} for ${realRoot}`);

  /** @type {import("../verdict.mjs").Detail[]} */
  const failures = [];
  /** @type {InventoryEntry[]} */
  const remaining = [];
  for (const e of inv.entries) {
    const source = join(root, e.source);
    const held = existsSync(e.destination) || isSymlink(e.destination);
    const occupied = existsSync(source) || isSymlink(source);
    if (!held) {
      if (occupied && fingerprint(source).hash === e.hash) {
        restored.push(e); // already back, byte-identical: nothing to move
        continue;
      }
      failures.push({ file: e.source, text: `held-out copy missing at ${e.destination}` });
      remaining.push(e);
      continue;
    }
    // The held copy is verified against its recorded hash before it is deleted as redundant or
    // moved back: an edit made at the state path is still Chris's work and is never destroyed.
    const heldNow = fingerprint(e.destination);
    if (heldNow.hash !== e.hash) {
      failures.push({ file: e.source, text: `held-out copy changed since the holdout (${e.destination} now ${heldNow.type} ${heldNow.hash}, inventory ${e.hash})${occupied ? `; destination ${source} also present (${fingerprint(source).hash})` : ""}; both kept, reconcile by hand` });
      remaining.push(e);
      continue;
    }
    if (occupied) {
      const now = fingerprint(source);
      if (now.hash !== e.hash) {
        failures.push({ file: e.source, text: `destination changed since the holdout (${source} now ${now.type} ${now.hash}, inventory ${e.hash}); not overwritten, held-out copy kept at ${e.destination}; reconcile by hand` });
        remaining.push(e);
        continue;
      }
      // Identical content on both sides; drop the held copy rather than move over it.
      rmSync(e.destination, { recursive: true, force: true });
      restored.push(e);
      continue;
    }
    log(`holdout: ${e.destination} -> ${e.source}\n`);
    move(e.destination, source);
    const after = fingerprint(source);
    if (after.hash !== e.hash) {
      failures.push({ file: e.source, text: `restored but hash differs (${after.hash} vs inventory ${e.hash})` });
      continue;
    }
    restored.push(e);
  }

  if (remaining.length) writeInventory(inventoryPath, { ...inv, entries: remaining });
  else {
    rmSync(inventoryPath, { force: true });
    pruneEmpty(filesDir);
  }
  if (failures.length) results.fail("holdout-in", `${failures.length} entr${failures.length === 1 ? "y" : "ies"} not restored; ${remaining.length} left in the inventory`, failures);
  else results.pass("holdout-in", `${restored.length} entr${restored.length === 1 ? "y" : "ies"} restored and verified`, restored.map((e) => ({ file: e.source, text: `${e.type} ${e.hash}` })));
  return { data };
}

/** @param {string} p */
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove an empty files dir tree (never anything with content). @param {string} dir */
function pruneEmpty(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) pruneEmpty(p);
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

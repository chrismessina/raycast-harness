// Pure comparisons for `rx api-diff` (docs/commands.md, plan 4.14): publish-order windows, the
// file inventory with the versionOnly rule (Q17), unified-diff line counts and the oclif
// manifest surface. Nothing here touches the network or spawns a process.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Exact published version: `2.10.1` or a prerelease such as `2.11.0-beta.1`. No ranges, tags or `v`. */
export const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Versions from npm's `time` map in publish order (oldest first). `created` and `modified` are
 * not versions and are skipped; an entry whose date does not parse is skipped too.
 * @param {Record<string, unknown>} time
 * @returns {{ version: string, at: string }[]}
 */
export function publishOrder(time) {
  return Object.entries(time)
    .filter(([k, v]) => k !== "created" && k !== "modified" && typeof v === "string" && !Number.isNaN(Date.parse(v)))
    .map(([version, at]) => ({ version, at: /** @type {string} */ (at) }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

/**
 * Versions other than `version` whose `time` value equals its own: a tie makes the publish order
 * ambiguous, and a lexical tie-break would invent one.
 * @param {{ version: string, at: string }[]} order @param {string} version
 */
export function tiedWith(order, version) {
  const at = order.find((e) => e.version === version)?.at;
  if (at === undefined) return [];
  return order.filter((e) => e.version !== version && Date.parse(e.at) === Date.parse(at)).map((e) => e.version);
}

/**
 * @typedef {{ data: Buffer, mode: string }} Entry  `mode`: permission bits as a 4-digit octal string
 */

/**
 * Every regular file under `dir`, as sorted `/`-separated paths relative to it, with its bytes and
 * permission bits. npm packs neither symlinks nor special files, and a link could pull a host file
 * into the diff, so any entry that is not a regular file or a directory throws, naming its path.
 * @param {string} dir
 * @returns {Map<string, Entry>}
 */
export function readTree(dir) {
  /** @type {Map<string, Entry>} */
  const out = new Map();
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(a);
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile()) out.set(r, { data: readFileSync(a), mode: (st.mode & 0o7777).toString(8).padStart(4, "0") });
      else throw new Error(`${r} is ${st.isSymbolicLink() ? "a symlink" : "not a regular file"}`);
    }
  };
  walk(dir, "");
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * JSON with object keys sorted at every level, so key order never counts as a difference. Array
 * order does.
 * @param {unknown} v
 * @returns {string}
 */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The contract's two narrow versionOnly rules. Anything else is a real change, including a
 * dependency range or a URL that moved with the version; equal sizes and digit-only differences
 * prove nothing (Q17).
 * - `.json`: both sides parse, and setting the baseline's top-level `version` to `toVersion`
 *   gives a deep-equal value (key order ignored).
 * - anything else: text (no NUL byte) holding `fromVersion` exactly once, as a whole quoted
 *   literal (`"<from>"` or `'<from>'`, the same quote on both sides); replacing it with the same
 *   literal for `toVersion` gives the new bytes. A substring (`2.1.1` inside `2.1.10`, `^2.1.1`,
 *   `2.1.1/model`) never qualifies. Compared through latin1, which round-trips every byte.
 * @param {string} path @param {Buffer} a @param {Buffer} b @param {string} fromVersion @param {string} toVersion
 */
export function isVersionOnly(path, a, b, fromVersion, toVersion) {
  if (path.endsWith(".json")) {
    let ja, jb;
    try {
      ja = JSON.parse(a.toString("utf8"));
      jb = JSON.parse(b.toString("utf8"));
    } catch {
      return false;
    }
    if (!ja || typeof ja !== "object" || Array.isArray(ja) || !("version" in ja)) return false;
    return canonical({ ...ja, version: toVersion }) === canonical(jb);
  }
  if (a.includes(0) || b.includes(0)) return false;
  const text = a.toString("latin1");
  const parts = text.split(fromVersion);
  if (parts.length !== 2) return false;
  const q = parts[0].slice(-1);
  if ((q !== '"' && q !== "'") || parts[1][0] !== q) return false;
  return Buffer.from(parts.join(toVersion), "latin1").equals(b);
}

/**
 * @typedef {{ path: string, fromBytes: number, toBytes: number, fromMode: string, toMode: string, versionOnly: boolean }} Changed
 * @typedef {{ added: string[], removed: string[], changed: Changed[] }} Inventory
 */

/**
 * A file is changed when its bytes or its mode differ; a mode change is never versionOnly.
 * @param {Map<string, Entry>} from @param {Map<string, Entry>} to
 * @param {string} fromVersion @param {string} toVersion
 * @returns {Inventory}
 */
export function inventory(from, to, fromVersion, toVersion) {
  /** @type {Inventory} */
  const inv = { added: [], removed: [], changed: [] };
  for (const [p, a] of from) {
    const b = to.get(p);
    if (b === undefined) { inv.removed.push(p); continue; }
    const sameBytes = a.data.equals(b.data);
    const sameMode = a.mode === b.mode;
    if (sameBytes && sameMode) continue;
    inv.changed.push({
      path: p,
      fromBytes: a.data.length,
      toBytes: b.data.length,
      fromMode: a.mode,
      toMode: b.mode,
      versionOnly: sameMode && !sameBytes && isVersionOnly(p, a.data, b.data, fromVersion, toVersion),
    });
  }
  for (const p of to.keys()) if (!from.has(p)) inv.added.push(p);
  const cmp = (/** @type {string} */ x, /** @type {string} */ y) => (x < y ? -1 : x > y ? 1 : 0);
  inv.added.sort(cmp);
  inv.removed.sort(cmp);
  inv.changed.sort((x, y) => cmp(x.path, y.path));
  return inv;
}

/** No file added or removed and every changed file versionOnly. @param {Inventory} inv */
export function onlyVersionFields(inv) {
  return inv.added.length === 0 && inv.removed.length === 0 && inv.changed.every((c) => c.versionOnly);
}

/**
 * `+`/`-` lines of a unified diff, excluding the `---`/`+++` file headers. Headers are recognized
 * by position (they open the diff, before the first `@@`), never by prefix: a removed line that
 * reads `-- x` prints as `--- x` and is content.
 * @param {string} diff
 */
export function countDiff(diff) {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * @typedef {{ path: string, kind: "added" | "removed" | "changed", from?: unknown, to?: unknown }} LeafChange
 * @typedef {{ commandsAdded: string[], commandsRemoved: string[], flagsAdded: { command: string, flag: string }[], flagsRemoved: { command: string, flag: string }[], changed: LeafChange[] }} CliDiff
 */

/**
 * The commands and their flag names in a parsed `oclif.manifest.json`.
 * @param {unknown} manifest
 * @returns {Map<string, string[]>}
 */
export function cliSurface(manifest) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  const commands = /** @type {any} */ (manifest)?.commands;
  if (!commands || typeof commands !== "object") throw new Error("oclif.manifest.json has no commands object");
  for (const [name, cmd] of Object.entries(commands)) {
    const flags = cmd && typeof cmd === "object" && cmd.flags && typeof cmd.flags === "object" ? Object.keys(cmd.flags) : [];
    out.set(name, flags.sort());
  }
  return out;
}

/**
 * Leaves of a JSON value as dotted path → value. Arrays and scalars are leaves; objects recurse.
 * @param {unknown} v @param {string} path @param {Map<string, unknown>} out
 */
function leaves(v, path, out) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out);
  } else out.set(path, v);
  return out;
}

/**
 * Commands added and removed; flags added and removed on commands present on both sides (a new
 * command's flags arrive with it; a removed command's leave with it); and `changed`: every other
 * leaf under `commands` whose value differs, as a dotted path with both JSON values, sorted by
 * path. A leaf present on one side only (a new `options` on an existing flag) has `kind` `added`
 * or `removed` and omits the missing side, so an explicit JSON `null` stays distinct from absence.
 * Leaves of an added or removed command or flag are not repeated.
 * @param {unknown} ma parsed manifest, baseline @param {unknown} mb parsed manifest, new
 * @returns {CliDiff}
 */
export function cliDiff(ma, mb) {
  const a = cliSurface(ma);
  const b = cliSurface(mb);
  /** @type {CliDiff} */
  const out = { commandsAdded: [], commandsRemoved: [], flagsAdded: [], flagsRemoved: [], changed: [] };
  /** @type {Set<string>} */
  const covered = new Set();
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const name of names) {
    const fa = a.get(name);
    const fb = b.get(name);
    if (!fa && fb) { out.commandsAdded.push(name); covered.add(`commands.${name}`); }
    else if (fa && !fb) { out.commandsRemoved.push(name); covered.add(`commands.${name}`); }
    else if (fa && fb) {
      for (const f of fb) if (!fa.includes(f)) { out.flagsAdded.push({ command: name, flag: f }); covered.add(`commands.${name}.flags.${f}`); }
      for (const f of fa) if (!fb.includes(f)) { out.flagsRemoved.push({ command: name, flag: f }); covered.add(`commands.${name}.flags.${f}`); }
    }
  }
  const la = leaves(/** @type {any} */ (ma).commands, "commands", new Map());
  const lb = leaves(/** @type {any} */ (mb).commands, "commands", new Map());
  const isCovered = (/** @type {string} */ p) => [...covered].some((c) => p === c || p.startsWith(`${c}.`));
  const paths = [...new Set([...la.keys(), ...lb.keys()])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  for (const p of paths) {
    if (isCovered(p)) continue;
    const inA = la.has(p);
    const inB = lb.has(p);
    if (inA && !inB) out.changed.push({ path: p, kind: "removed", from: la.get(p) });
    else if (!inA && inB) out.changed.push({ path: p, kind: "added", to: lb.get(p) });
    else if (canonical(la.get(p)) !== canonical(lb.get(p))) out.changed.push({ path: p, kind: "changed", from: la.get(p), to: lb.get(p) });
  }
  return out;
}

// `rx api-diff <from> <to> [--out <dir>] [--json]`: what moved between two published versions of
// @raycast/api, read from the npm tarballs (docs/commands.md, plan 4.14). The deterministic half
// of the api-changelog skill; fixes Q15–Q17 and Q22 by construction. It describes a release and
// never judges one, so nothing here can FAIL.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RxError } from "../errors.mjs";
import { run as exec } from "../exec.mjs";
import { EXACT, cliDiff, cliSurface, countDiff, inventory, onlyVersionFields, publishOrder, readTree, tiedWith } from "../api-diff/compare.mjs";

const PKG = "@raycast/api";
const DECL = "types/index.d.ts";
const MANIFEST = "oclif.manifest.json";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "api-diff",
  summary: "what changed between two published @raycast/api versions: file inventory, types/index.d.ts diff, CLI surface",
  root: "none",
  positionals: [
    { name: "from", required: true, help: "an exact published version, e.g. 2.10.1 (not a range, tag or latest)" },
    { name: "to", required: true, help: "an exact published version; either order, the earlier-published one is the baseline" },
  ],
  flags: {
    "--out": { type: "string", value: "<dir>", help: "extract both packages to <dir>/<version>/package/ and leave them; never overwrites" },
  },
  network: "required: `npm view @raycast/api time --json`, then `npm pack @raycast/api@<v> --pack-destination <tmp>` for both versions",
  state: "none; without --out the packages go to a temp dir removed on every exit path",
  data: {
    package: "\"@raycast/api\"",
    from: "string — the earlier-published version (the baseline)",
    to: "string",
    published: "{ from: string, to: string } — npm time entries",
    window: "string[] — versions published strictly between, publish order",
    dirs: "{ from: string, to: string } | null — the extracted package/ dirs, only with --out",
    files: "{ added: string[], removed: string[], changed: [{ path, fromBytes, toBytes, versionOnly }] } — paths relative to package/, sorted",
    versionOnly: "boolean — nothing added or removed and every changed file versionOnly",
    declarations: "{ path: \"types/index.d.ts\", changed: boolean, added: number, removed: number, diff: string }",
    distTypes: "{ added: string[], removed: string[], changed: string[] } — paths under dist/types/",
    cli: "{ commandsAdded: string[], commandsRemoved: string[], flagsAdded: [{ command, flag }], flagsRemoved: [{ command, flag }], changed: [{ path, from, to }] } — oclif.manifest.json; changed holds every other differing leaf under commands, dotted paths, sorted",
  },
  checks: {
    "api-diff-window": { description: "<from> and <to> are adjacent in publish order (WARN with the intermediate versions)", levels: ["PASS", "WARN"] },
    "api-diff": { description: "the release inventory and declarations diff (N/A when only version fields changed; ERROR on any pack, extraction or read failure)", levels: ["PASS", "N/A", "ERROR"] },
  },
  examples: ["rx api-diff 2.10.1 2.11.0", "rx api-diff 2.10.1 2.11.0 --out ~/tmp/api --json"],
};

/**
 * The npm side, replaceable in tests so no test touches the network.
 * @typedef {{
 *   time: () => Promise<Record<string, unknown>>,
 *   pack: (version: string, dest: string) => Promise<string>,
 * }} Packer
 *   `pack` writes the tarball into the empty directory `dest` and returns its path.
 */

/** @type {Packer} */
const npmPacker = {
  async time() {
    const r = await exec("npm", ["view", PKG, "time", "--json"], { timeoutMs: 60_000, id: "npm" });
    if (r.code !== 0) {
      const first = (r.stderr || r.stdout).split("\n").find((l) => l.trim()) ?? `exit ${r.code}`;
      throw new RxError(`npm view ${PKG} time failed: ${first.trim()}`, { id: "npm" });
    }
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new RxError(`npm view ${PKG} time --json printed something that is not JSON`, { id: "npm" });
    }
  },
  async pack(version, dest) {
    const r = await exec("npm", ["pack", `${PKG}@${version}`, "--pack-destination", dest], { timeoutMs: 180_000, id: "api-diff" });
    if (r.code !== 0) {
      const first = (r.stderr || r.stdout).split("\n").find((l) => l.trim()) ?? `exit ${r.code}`;
      throw new Error(`npm pack failed: ${first.trim()}`);
    }
    // npm prints the tarball name as its last stdout line; fall back to the one .tgz in `dest`.
    const named = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (named && existsSync(join(dest, named))) return join(dest, named);
    const tgz = readdirSync(dest).filter((f) => f.endsWith(".tgz"));
    if (tgz.length === 1) return join(dest, tgz[0]);
    throw new Error(`npm pack left ${tgz.length} tarballs in ${dest}; expected one`);
  },
};

let packer = npmPacker;
/** Test hook: replace both the `time` lookup and the pack. `null` restores npm. @param {Packer | null} p */
export function _setPacker(p) { packer = p ?? npmPacker; }

/**
 * Pack, extract and read one version. Every failure is `ERROR api-diff` naming the version (Q16):
 * never an empty diff.
 * @param {string} version @param {string} packDir empty dir for the tarball
 * @param {string} extractDir `<base>/<version>`, already created by the caller (reserved, under --out)
 */
async function fetchVersion(version, packDir, extractDir) {
  const fail = (/** @type {string} */ what, /** @type {unknown} */ e) =>
    new RxError(`${version}: ${what}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, { id: "api-diff" });
  /** @type {string} */
  let tgz;
  try {
    mkdirSync(packDir, { recursive: true });
    tgz = await packer.pack(version, packDir);
    if (!existsSync(tgz)) throw new Error(`no tarball at ${tgz}`);
  } catch (e) {
    throw fail("pack failed", e);
  }
  try {
    const r = await exec("tar", ["-xzf", tgz, "-C", extractDir], { id: "api-diff" });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).split("\n").find((l) => l.trim())?.trim() ?? `tar exit ${r.code}`);
  } catch (e) {
    throw fail("extraction failed", e);
  }
  const pkgDir = join(extractDir, "package");
  try {
    let st;
    try { st = lstatSync(pkgDir); } catch { throw new Error("the tarball has no package/ directory"); }
    if (!st.isDirectory()) throw new Error("package/ is not a directory");
    // readTree throws on any symlink or non-regular entry, so the diff below reads only regular files.
    const tree = readTree(pkgDir);
    if (!tree.has(DECL)) throw new Error(`package/${DECL} is missing`);
    return { pkgDir, tree };
  } catch (e) {
    throw fail("read failed", e);
  }
}

/**
 * The parsed manifest of one side, or null when its manifest is missing. A manifest that exists but
 * does not parse is a read failure.
 * @param {string} version @param {Map<string, import("../api-diff/compare.mjs").Entry>} tree
 */
function manifestOf(version, tree) {
  const entry = tree.get(MANIFEST);
  if (!entry) return null;
  try {
    const m = JSON.parse(entry.data.toString("utf8"));
    cliSurface(m); // throws when there is no commands object
    return m;
  } catch (e) {
    throw new RxError(`${version}: read failed: ${MANIFEST}: ${/** @type {Error} */ (e).message.split("\n")[0]}`, { id: "api-diff" });
  }
}

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ args, cwd, results }) {
  const a = args.positionals.from;
  const b = args.positionals.to;
  for (const v of [a, b]) {
    if (!EXACT.test(v)) throw new RxError(`${JSON.stringify(v)} is not an exact version (want e.g. 2.10.1; no range, tag or latest)`, { id: "args" });
  }
  if (a === b) throw new RxError(`<from> and <to> are the same version (${a}); give two different published versions`, { id: "args" });

  const outFlag = typeof args.flags["--out"] === "string" ? /** @type {string} */ (args.flags["--out"]) : null;
  const out = outFlag !== null ? resolve(cwd, outFlag) : null;

  /** Directories this run reserved under --out: the only ones an ERROR may remove. @type {string[]} */
  const owned = [];
  let ok = false;
  /** @type {string | null} */
  let tmp = null;
  try {
    if (out !== null) {
      // Reserve each <out>/<version> with a non-recursive mkdir before any npm call: atomic, so a
      // concurrent run, a file or a dangling symlink already there is refused, never adopted.
      mkdirSync(out, { recursive: true });
      for (const v of [a, b]) {
        const dir = join(out, v);
        try {
          mkdirSync(dir);
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") throw new RxError(`${dir} already exists; --out never overwrites`, { id: "args" });
          throw e;
        }
        owned.push(dir);
      }
    }

    const order = publishOrder(await packer.time());
    const index = new Map(order.map((e, i) => [e.version, i]));
    for (const v of [a, b]) {
      if (!index.has(v)) throw new RxError(`${v} is not a published ${PKG} version (not in npm's time map)`, { id: "args" });
    }
    for (const v of [a, b]) {
      const tied = tiedWith(order, v);
      if (tied.length) throw new RxError(`${v} has the same npm time as ${tied.join(", ")}; the publish order is ambiguous`, { id: "api-diff" });
    }
    const [from, to] = /** @type {number} */ (index.get(a)) < /** @type {number} */ (index.get(b)) ? [a, b] : [b, a];
    const iFrom = /** @type {number} */ (index.get(from));
    const iTo = /** @type {number} */ (index.get(to));
    const window = order.slice(iFrom + 1, iTo).map((e) => e.version);
    const published = { from: order[iFrom].at, to: order[iTo].at };

    if (window.length === 0) results.pass("api-diff-window", `${from} → ${to} are adjacent in publish order`);
    else results.warn("api-diff-window", `${window.length} intermediate version(s): ${window.join(", ")}`);

    tmp = mkdtempSync(join(tmpdir(), "rx-api-diff-"));
    /** @type {Record<string, { pkgDir: string, tree: Map<string, import("../api-diff/compare.mjs").Entry> }>} */
    const sides = {};
    for (const v of [from, to]) {
      let extractDir;
      if (out !== null) extractDir = join(out, v); // reserved above
      else mkdirSync((extractDir = join(tmp, "x", v)), { recursive: true });
      sides[v] = await fetchVersion(v, join(tmp, "pack", v), extractDir);
    }
    const A = sides[from];
    const B = sides[to];

    const files = inventory(A.tree, B.tree, from, to);
    const versionOnly = onlyVersionFields(files);

    const d = await exec("diff", ["-u", "--label", `a/${DECL}`, "--label", `b/${DECL}`, join(A.pkgDir, DECL), join(B.pkgDir, DECL)], { id: "api-diff" });
    if (d.code !== 0 && d.code !== 1) throw new RxError(`diff ${DECL} failed (exit ${d.code}): ${d.stderr.split("\n")[0]}`, { id: "api-diff" });
    const diff = d.code === 1 ? d.stdout : "";
    const counts = countDiff(diff);
    const declarations = { path: DECL, changed: d.code === 1, added: counts.added, removed: counts.removed, diff };

    const DT = "dist/types/";
    const distTypes = {
      added: files.added.filter((p) => p.startsWith(DT)),
      removed: files.removed.filter((p) => p.startsWith(DT)),
      changed: files.changed.filter((c) => c.path.startsWith(DT)).map((c) => c.path),
    };

    /** @type {{ text: string }[]} */
    const details = [];
    for (const p of files.added) details.push({ text: `+ ${p}` });
    for (const p of files.removed) details.push({ text: `- ${p}` });
    for (const c of files.changed) details.push({ text: `~ ${c.path} ${c.fromBytes}→${c.toBytes}` });

    const ma = manifestOf(from, A.tree);
    const mb = manifestOf(to, B.tree);
    const cli = ma && mb ? cliDiff(ma, mb) : { commandsAdded: [], commandsRemoved: [], flagsAdded: [], flagsRemoved: [], changed: [] };
    const missing = [ma ? null : from, mb ? null : to].filter(Boolean);
    if (missing.length) details.push({ text: `${MANIFEST} missing in ${missing.join(" and ")}; cli lists are empty` });

    for (const line of diff.replace(/\n$/, "").split("\n")) if (diff) details.push({ text: line });

    const summary = `${files.added.length} added, ${files.removed.length} removed, ${files.changed.length} changed; ${DECL} +${counts.added} −${counts.removed}`;
    if (versionOnly) results.na("api-diff", "only version fields changed", details);
    else results.pass("api-diff", summary, details);

    ok = true;
    return {
      data: {
        package: PKG,
        from,
        to,
        published,
        window,
        dirs: out !== null ? { from: A.pkgDir, to: B.pkgDir } : null,
        files,
        versionOnly,
        declarations,
        distTypes,
        cli,
      },
    };
  } finally {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    // On an ERROR, remove only the directories this run reserved, so a retry is not refused.
    if (!ok) for (const dir of owned) rmSync(dir, { recursive: true, force: true });
  }
}

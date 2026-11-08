// Shared scaffolding for the gates / audit / guard / fingerprint tests: a compliant extension in
// a git repo with fake local tooling, the cross-repo cache pointed at the temp dir, the upstream
// fetch pointed at a local bare repo, the attestation key's XDG_CONFIG_HOME pointed at the temp
// dir, the npm registry lookup stubbed, and the GitHub transport (which gates' greptile-rules step
// reads raycast/extensions through) replaced by an offline fake unless a test installs another
// (greptileFake). Nothing here reaches the network or touches ~/.cache or ~/.config.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _setRegistry } from "../src/commands/api-floor.mjs";
import { attest, inspectKey } from "../src/attest.mjs";
import { _setUpstreamForTests } from "../src/upstream.mjs";
import { setTransport } from "../src/pr/transport.mjs";
import { SHIPPED_DIR } from "../src/greptile/rules.mjs";
import { GREPTILE_JUDGMENT_RULES, GREPTILE_PREFIX } from "../src/audit/greptile.mjs";
import { REPO, rx, withTempDir } from "./helpers.mjs";
import { makeExt } from "./preflight-helpers.mjs";
import { commit, fakeUpstream, g, initRepo } from "./upstream-fixtures.mjs";

import { PNG } from "pngjs";

export const FIX = join(REPO, "test", "fixtures", "gates");

/**
 * A fully decodable RGBA PNG (rx png inflates the IDAT and checks it, so the header-only PNG the
 * preflight helpers write is not enough here). `seed` varies the pixels.
 * @param {number} w @param {number} h @param {number} [seed]
 */
export function validPng(w, h, seed = 0) {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    p.data[i * 4] = (seed * 37 + 40) & 0xff;
    p.data[i * 4 + 1] = 90;
    p.data[i * 4 + 2] = (i + seed) & 0xff;
    p.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(p, { colorType: 6, bitDepth: 8 });
}
export const PRESET = join(FIX, "preset.json");
export const FORBIDDEN = join(FIX, "forbidden.txt");

_setRegistry(async () => null);

/**
 * A fake GitHub transport for the greptile-rules step (src/greptile/update.mjs). Without `sha` it
 * is offline: every request throws. With `sha`, the last commit touching .greptile/ on main is
 * `sha` (committed `committed`) and its three files are the shipped copy's, with `files`
 * replacing any of them. `calls` records every request path.
 * @param {{ sha?: string, committed?: string, files?: Record<string, string> }} [o]
 */
export function greptileFake(o = {}) {
  /** @type {string[]} */
  const calls = [];
  const offline = (/** @type {string} */ path) => {
    calls.push(path);
    throw new Error(`offline (test transport): ${path}`);
  };
  const never = async () => { throw new Error("gates never sends this request"); };
  const t = {
    async getJson(/** @type {string} */ path) {
      if (!o.sha) return offline(path);
      calls.push(path);
      if (/\/commits\?path=\.greptile&sha=main&per_page=1$/.test(path)) return [{ sha: o.sha, commit: { committer: { date: o.committed ?? "2026-11-05T00:00:00Z" } } }];
      throw new Error(`unexpected GET ${path}`);
    },
    async getRaw(/** @type {string} */ path) {
      if (!o.sha) return offline(path);
      calls.push(path);
      const m = path.match(/\.greptile\/([^?]+)\?ref=/);
      if (!m) throw new Error(`unexpected RAW ${path}`);
      return o.files?.[m[1]] ?? readFileSync(join(SHIPPED_DIR, m[1]), "utf8");
    },
    getJsonPages: never,
    getConditional: never,
    graphql: never,
    patch: never,
  };
  return { t: /** @type {import("../src/pr/transport.mjs").Transport} */ (/** @type {unknown} */ (t)), calls };
}

/**
 * Run `fn` with XDG_CACHE_HOME and XDG_CONFIG_HOME pointed at a fresh temp dir, the GitHub
 * transport offline (greptileFake), and the upstream and transport test hooks reset after.
 * @template T
 * @param {(dir: string) => Promise<T>} fn
 */
export async function withGatedEnv(fn) {
  return withTempDir(async (dir) => {
    const saved = process.env.XDG_CACHE_HOME;
    const savedConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    const prevTransport = setTransport(greptileFake().t);
    try {
      return await fn(dir);
    } finally {
      setTransport(prevTransport);
      _setUpstreamForTests({ url: null, probe: null });
      if (saved === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = saved;
      if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedConfig;
    }
  });
}

/**
 * Write a state document re-attested with the (temp) machine key, as rx itself would: for tests
 * of the checks that run AFTER provenance (a correctly attested receipt that still lies).
 * @param {string} path @param {Record<string, unknown>} doc
 */
export function writeAttested(path, doc) {
  const k = inspectKey();
  if (k.status !== "ok") throw new Error(`writeAttested: no usable test key (${k.status})`);
  const { attestation: _drop, ...rest } = /** @type {any} */ (doc);
  writeFileSync(path, JSON.stringify(attest(rest, k)));
}

/** Read a JSON state document. @param {string} path */
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * Fake local tooling: `node_modules/.bin/tsc` (a shell script) and `build` / `lint` scripts in
 * package.json. `tscExit`, `buildExit`, `lintExit` set what each exits with.
 * @param {string} root
 * @param {{ tscExit?: number, buildExit?: number, lintExit?: number, tsc?: boolean, buildScript?: string }} [o]
 *   `buildScript` replaces the build script entirely (for a build that writes files).
 */
export function fakeTooling(root, o = {}) {
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  if (o.tsc !== false) {
    const tsc = join(root, "node_modules", ".bin", "tsc");
    writeFileSync(tsc, `#!/bin/sh\n${o.tscExit ? `echo "src/index.tsx(1,1): error TS0000: fixture error" >&2; ` : ""}exit ${o.tscExit ?? 0}\n`);
    chmodSync(tsc, 0o755);
  }
  return {
    build: o.buildScript ?? `node -e "${o.buildExit ? `console.error('fixture build error'); process.exit(${o.buildExit})` : "0"}"`,
    lint: `node -e "${o.lintExit ? `console.error('fixture lint error'); process.exit(${o.lintExit})` : "0"}"`,
  };
}

/**
 * A compliant extension named `ext` at dir/ext, committed, with fake tooling. With `published`,
 * a fake raycast/extensions holds the FIRST commit's files and a second commit adds a changelog
 * entry (so `rx stale` classifies CHANGELOG.md as CHECK); otherwise the publication probe says 404.
 * @param {string} dir
 * @param {{ published?: boolean, src?: string, pkg?: Record<string, unknown>, tooling?: Parameters<typeof fakeTooling>[1], files?: Record<string, string | Buffer | null> }} [o]
 */
export async function buildGated(dir, o = {}) {
  const root = join(dir, "ext");
  const scripts = fakeTooling(root, o.tooling);
  /** @type {Record<string, string | Buffer | null>} */
  const files = {
    ".gitignore": "node_modules/\n*.local\n",
    "metadata/good-1.png": validPng(2000, 1250, 1),
    "assets/icon.png": validPng(512, 512, 2),
    "media/shot.png": validPng(10, 10, 3),
    ...(o.files ?? {}),
  };
  if (o.src) files["src/index.tsx"] = o.src;
  makeExt(root, { pkg: { name: "ext", scripts, ...(o.pkg ?? {}) }, files });
  await initRepo(root);
  const first = await commit(root, {}, "v1");
  /** @type {Awaited<ReturnType<typeof fakeUpstream>> | null} */
  let up = null;
  if (o.published) {
    // Published = the first commit's payload (what `ray publish` would have copied).
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    /** @type {Record<string, Buffer>} */
    const tree = {};
    const walk = (/** @type {string} */ rel) => {
      for (const n of readdirSync(join(root, rel))) {
        if (n === ".git" || n === "node_modules") continue;
        const p = rel ? `${rel}/${n}` : n;
        if (statSync(join(root, p)).isDirectory()) walk(p);
        else tree[p] = readFileSync(join(root, p));
      }
    };
    walk("");
    up = await fakeUpstream(dir, { ext: tree });
    _setUpstreamForTests({ url: up.url, probe: async (n) => n === "ext" });
    await commit(root, { "CHANGELOG.md": "# Changelog\n\n## [Update] - {PR_MERGE_DATE}\n\n- Newer\n\n## [Initial Version] - 2026-01-02\n" }, "v2");
  } else {
    _setUpstreamForTests({ url: `file://${dir}/unused.git`, probe: async () => false });
  }
  return { root, first, up };
}

/** `rx gates` over the helper's extension. @param {string} root */
export function gates(root) {
  return rx(["gates", "--root", root, "--preset", PRESET, "--forbidden", FORBIDDEN, "--json"]);
}

/** The state dir (`git rev-parse --git-path rx`) of an extension. @param {string} root */
export async function stateDir(root) {
  return (await g(root, ["rev-parse", "--path-format=absolute", "--git-path", "rx"])).stdout;
}

/** Index results by id (the last result wins for repeated ids). @param {any} r */
export const byId = (r) => Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.id, x]));

/**
 * A complete entries file for the fixture preset: the three applicable rules and every Greptile
 * judgment rule as pass, plus any overrides / extra items.
 * @param {{ overrides?: Record<string, Partial<{ result: string, evidence: string }>>, omit?: string[], extra?: unknown[] }} [o]
 */
export function fullEntries(o = {}) {
  const ids = ["copy-error", "kit", ...GREPTILE_JUDGMENT_RULES.map((id) => `${GREPTILE_PREFIX}${id}`)];
  const entries = ids
    .filter((id) => !(o.omit ?? []).includes(id))
    .map((id) => ({ id, scope: "src/**", result: "pass", evidence: `read the branch diff for ${id}: nothing to report`, ...(o.overrides?.[id] ?? {}) }));
  return [...entries, ...(o.extra ?? [])];
}

/** Write an entries file beside the extension (outside the payload). @param {string} dir @param {unknown} entries */
export function writeEntries(dir, entries) {
  const file = join(dir, "entries.json");
  writeFileSync(file, JSON.stringify(entries, null, 2));
  return file;
}

/** `rx audit record`. @param {string} root @param {string} entriesFile */
export function auditRecord(root, entriesFile) {
  return rx(["audit", "record", "--root", root, "--preset", PRESET, "--entries", entriesFile, "--json"]);
}

/** A PreToolUse payload for a Bash command. @param {string} command @param {string} cwd */
export function bashPayload(command, cwd) {
  return JSON.stringify({ session_id: "fixture", transcript_path: "/dev/null", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "fixture" }, tool_use_id: "toolu_fixture" });
}

/** `rx guard --json` with a payload on stdin. @param {string} payload */
export function guard(payload) {
  return rx(["guard", "--json"], { stdin: payload });
}

// The shared sparse checkout of `raycast/extensions` (docs/commands.md §1, state table:
// `cache/upstream/`). One partial clone for every extension; `extensions/<name>` is added to the
// cone on demand. `rx stale` fills it and `gates`, `audit record`, `preflight --published`,
// `png`, `changelog` and `contributions` read from it, all through src/published-copy.mjs.
//
// Fail closed: a fetch that errors, or a checkout that leaves the extension directory missing or
// empty, is an RxError (`github`), never "no differences". Publication is decided by the GitHub
// contents API: 404 → not published; any other failure → `github`.
//
// Locking: `cache/upstream/.rx-lock` (a directory, created atomically) is held by the fetch AND by
// every reader for the whole of its comparison (`withUpstreamLock`), because a second rx process
// fetching another extension moves the shared tree to a new FETCH_HEAD and would swap the files
// under a running `stale` or `contributions`. The lock is reentrant within one process. Waiting
// gives up after `lockWaitMs` (default 120 s) with `ERROR github`; a lock older than `lockStaleMs`
// (default 10 min) is treated as abandoned and removed.
//
// Commands do not call this module to read a published copy: they go through
// `withPublishedCopy` (src/published-copy.mjs), the one consumer of `ensureUpstream`,
// `cachedUpstream` and `withUpstreamLock`, which holds the lock for the whole read. Nesting is safe
// (reentrant in-process); the callback's return value and exceptions pass through; the lock is
// released in `finally`. A wait longer than `lockWaitMs` throws `RxError` id `github`
// (`ERROR github` at the dispatcher); do not catch it into a pass. `lockHeld()` reports whether
// this process currently holds it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { RxError, firstLine } from "./errors.mjs";
import { PUBLISH_SKIPS } from "./payload.mjs";
import { ghApi } from "./gh.mjs";
import { git } from "./git.mjs";
import { cachePath, cachePathReadOnly } from "./state.mjs";

export const UPSTREAM_BRANCH = "main";
let UPSTREAM_URL = "https://github.com/raycast/extensions.git";
/** @type {((name: string) => Promise<boolean>) | null} */
let publicationProbe = null;
let lockWaitMs = 120_000;
let lockStaleMs = 600_000;

/**
 * Test hooks: point the fetch at a local bare repository, replace the GitHub publication lookup,
 * shorten the lock timings. Pass `null` to restore a default.
 * @param {{ url?: string | null, probe?: ((name: string) => Promise<boolean>) | null, lockWaitMs?: number | null, lockStaleMs?: number | null }} o
 */
export function _setUpstreamForTests({ url, probe, lockWaitMs: wait, lockStaleMs: stale }) {
  if (url !== undefined) UPSTREAM_URL = url ?? "https://github.com/raycast/extensions.git";
  if (probe !== undefined) publicationProbe = probe;
  if (wait !== undefined) lockWaitMs = wait ?? 120_000;
  if (stale !== undefined) lockStaleMs = stale ?? 600_000;
}

/**
 * @typedef {{
 *   name: string,
 *   published: boolean,
 *   publishedDir: string | null,
 *   baseline: string | null,
 *   at: string,
 * }} UpstreamInfo
 *   `baseline` is the commit of `raycast/extensions` `main` the checkout holds; `publishedDir` is
 *   the absolute path of `extensions/<name>` inside the cache. Both null when unpublished.
 */

/**
 * The git blob id of raw bytes (`git hash-object` with no filters): sha1 over `blob <len>\0<bytes>`.
 * Used to compare an on-disk published file with a committed blob.
 * @param {Buffer} bytes
 */
export function blobId(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * The only paths left out of a comparison: what `ray publish` never copies (`src/payload.mjs`,
 * one source of truth). Nothing else is filtered: a published `.prettierrc`, `dist/` or
 * `.DS_Store` that differs locally is a real difference (Q18 retired the legacy `grep -v`).
 * Matched against every path segment on both sides.
 */
export const PUBLISH_SKIP = new Set(PUBLISH_SKIPS);

/** @param {string} segment one path segment */
export function skipSegment(segment) {
  return PUBLISH_SKIP.has(segment);
}

/** Where the sparse checkout lives (created on demand). */
export function upstreamDir() {
  return cachePath("upstream");
}

/**
 * Is `dir` at or under the upstream cache? Compares real paths so a symlinked `--published`
 * resolves correctly; creates nothing, and a cache that does not exist contains nothing.
 * @param {string} dir an existing directory
 */
export function insideUpstreamCache(dir) {
  const cache = cachePathReadOnly("upstream");
  if (!existsSync(cache)) return false;
  const real = realpathSync(dir);
  const base = realpathSync(cache);
  return real === base || real.startsWith(base + sep);
}

/** @param {string} name */
function metaPath(name) {
  const base = cachePath("upstream-meta");
  mkdirSync(base, { recursive: true });
  return join(base, `${encodeURIComponent(name)}.json`);
}

/** @param {string} name extension name as in package.json */
function validName(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes(".."))
    throw new RxError(`extension name ${JSON.stringify(name)} is not a valid raycast/extensions directory name`, { id: "input" });
  return name;
}

/**
 * What the cache already knows about `name`, with no network. Null when nothing was recorded, or
 * when the checkout no longer holds the recorded baseline.
 * @param {string} name
 * @returns {Promise<UpstreamInfo | null>}
 */
export async function cachedUpstream(name) {
  validName(name);
  const file = metaPath(name);
  if (!existsSync(file)) return null;
  /** @type {UpstreamInfo} */
  let meta;
  try {
    meta = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (meta.name !== name) return null;
  if (!meta.published) return meta;
  const dir = upstreamDir();
  const head = await git(["rev-parse", "--verify", "HEAD"], { cwd: dir, allowFail: true });
  if (head.code !== 0 || head.stdout.trim() !== meta.baseline) return null;
  if (!meta.publishedDir || !nonEmptyDir(meta.publishedDir)) return null;
  return meta;
}

/** @param {string} dir */
function nonEmptyDir(dir) {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Is `extensions/<name>` on upstream `main`? Network: `gh api repos/raycast/extensions/contents/…`.
 * 404 → false. Any other failure → RxError `github`.
 * @param {string} name
 */
export async function isPublished(name) {
  validName(name);
  if (publicationProbe) return publicationProbe(name);
  try {
    const r = await ghApi(`repos/raycast/extensions/contents/extensions/${name}`);
    if (!Array.isArray(r)) throw new RxError(`extensions/${name} on raycast/extensions is not a directory`, { id: "github" });
    return true;
  } catch (e) {
    if (/** @type {any} */ (e)?.status === 404) return false;
    if (e instanceof RxError) throw new RxError(`publication lookup for ${name} failed: ${e.message}; cannot prove freshness`, { id: "github" });
    throw e;
  }
}

/**
 * Make sure the cache holds the current published copy of `name` and return where it is. One
 * network round trip (publication lookup) plus a `git fetch` when published. With
 * `maxAgeMs > 0`, a record younger than that whose checkout is intact is returned without any
 * network call (for `gates`, which runs `stale` and then re-reads the same baseline).
 * @param {string} name
 * @param {{ maxAgeMs?: number, log?: (s: string) => void }} [opts]
 * @returns {Promise<UpstreamInfo>}
 */
export async function ensureUpstream(name, { maxAgeMs = 0, log = () => {} } = {}) {
  validName(name);
  if (maxAgeMs > 0) {
    const cached = await cachedUpstream(name);
    if (cached && Date.now() - Date.parse(cached.at) <= maxAgeMs) return cached;
  }

  const published = await isPublished(name);
  const at = new Date().toISOString();
  if (!published) {
    /** @type {UpstreamInfo} */
    const info = { name, published: false, publishedDir: null, baseline: null, at };
    writeFileSync(metaPath(name), JSON.stringify(info, null, 2) + "\n");
    return info;
  }

  const dir = upstreamDir();
  await withUpstreamLock(async () => {
    await initSparse(dir);
    log(`fetching raycast/extensions:${UPSTREAM_BRANCH} (sparse: extensions/${name})\n`);
    const add = await git(["sparse-checkout", "add", `extensions/${name}`], { cwd: dir, allowFail: true });
    if (add.code !== 0) throw new RxError(`sparse-checkout add extensions/${name} failed: ${firstLine(add.stderr)}`, { id: "github" });
    const fetch = await git(["fetch", "-q", "--depth", "1", "--filter=tree:0", "origin", UPSTREAM_BRANCH], { cwd: dir, allowFail: true });
    if (fetch.code !== 0) throw new RxError(`git fetch of raycast/extensions failed: ${firstLine(fetch.stderr)}; cannot prove freshness`, { id: "github" });
    // The cache is rx's own working tree, never a user checkout; moving it to FETCH_HEAD is the
    // one place rx runs `checkout`.
    const co = await git(["checkout", "-q", "--force", "--detach", "FETCH_HEAD"], { cwd: dir, allowFail: true });
    if (co.code !== 0) throw new RxError(`checkout of raycast/extensions FETCH_HEAD failed: ${firstLine(co.stderr)}`, { id: "github" });
  });

  const baseline = (await git(["rev-parse", "--verify", "HEAD"], { cwd: dir })).stdout.trim();
  const publishedDir = join(dir, "extensions", name);
  if (!nonEmptyDir(publishedDir))
    throw new RxError(`baseline fetch left ${publishedDir} missing or empty; cannot prove freshness`, { id: "github" });
  /** @type {UpstreamInfo} */
  const info = { name, published: true, publishedDir, baseline, at };
  writeFileSync(metaPath(name), JSON.stringify(info, null, 2) + "\n");
  return info;
}

/** Create the partial clone skeleton once. @param {string} dir */
async function initSparse(dir) {
  mkdirSync(dir, { recursive: true });
  const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: dir, allowFail: true });
  if (inside.code === 0 && inside.stdout.trim() === "true") {
    // An existing clone must be ours (origin = raycast/extensions); never fetch into anything else.
    const url = await git(["remote", "get-url", "origin"], { cwd: dir, allowFail: true });
    if (url.code !== 0 || url.stdout.trim() !== UPSTREAM_URL)
      throw new RxError(`${dir} is a git repository whose origin is not ${UPSTREAM_URL}; remove it or set XDG_CACHE_HOME`, { id: "github" });
    return;
  }
  if (readdirSync(dir).some((n) => n !== ".rx-lock"))
    throw new RxError(`${dir} exists but is not the rx upstream clone; remove it or set XDG_CACHE_HOME`, { id: "github" });
  await git(["init", "-q"], { cwd: dir });
  await git(["remote", "add", "origin", UPSTREAM_URL], { cwd: dir });
  await git(["config", "core.sparseCheckout", "true"], { cwd: dir });
  await git(["sparse-checkout", "init", "--cone"], { cwd: dir });
}

let lockDepth = 0;

/** True while this process holds the upstream cache lock (for tests and assertions). */
export function lockHeld() {
  return lockDepth > 0;
}

/**
 * Run `fn` holding `cache/upstream/.rx-lock`: writers (the fetch) and readers (`stale`,
 * `contributions`) alike, so the shared tree cannot move under a comparison. Reentrant within the
 * process; across processes it waits up to `lockWaitMs`, then `ERROR github`.
 * @template T
 * @param {() => Promise<T>} fn
 */
export async function withUpstreamLock(fn) {
  if (lockDepth > 0) {
    lockDepth++;
    try { return await fn(); } finally { lockDepth--; }
  }
  const dir = upstreamDir();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".rx-lock");
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* vanished between attempts */ }
      if (age > lockStaleMs) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new RxError(`another rx holds the upstream cache lock ${lock} (fetching or comparing); try again`, { id: "github" });
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(20, lockWaitMs / 10))));
    }
  }
  lockDepth = 1;
  try {
    return await fn();
  } finally {
    lockDepth = 0;
    rmSync(lock, { recursive: true, force: true });
  }
}

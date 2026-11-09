// Access to the published copy of an extension as one scoped operation (docs/commands.md §1).
// Commands never coordinate the upstream cache themselves: they call
//
//   withPublishedCopy({ name, directory?, expectedBaseline?, refresh, log? }, async (copy) => …)
//
// and do every read of the published copy inside the callback. The service owns cache detection,
// the upstream lock (held for the callback's whole lifetime), expected-baseline validation and the
// directory's lifetime: `copy.directory` is valid only until the callback returns. Underneath is
// the shared sparse checkout of src/upstream.mjs.
//
// Three ways in, chosen by the options:
//   directory        a caller-supplied `--published <dir>`. Inside the upstream cache it is read
//                    under the lock; anywhere else it is neither locked nor refreshed. Combining it
//                    with `refresh` or `expectedBaseline` is an ERROR input.
//   name, refresh    `rx stale`: the publication lookup and the fetch run under the lock, then the
//                    callback, still under it. A refresh failure is ERROR github; only a 404 on the
//                    publication lookup means unpublished.
//   name             what the cache already holds for `name`, with no network. With
//                    `expectedBaseline`, a cache that no longer holds that exact baseline throws
//                    PublishedCopyChanged (ERROR github) before the callback runs.
//
// The stale baseline (`repo/stale/baseline.json`) is `{ name, published, baseline, at }`: the
// publication status and baseline identity, never a cache path. Readers go through
// readStaleBaseline, which also accepts the older shape that carried `publishedDir` and ignores it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RxError } from "./errors.mjs";
import { repoStatePath, repoStatePathReadOnly, writeJsonAtomic } from "./state.mjs";
import { cachedUpstream, ensureUpstream, insideUpstreamCache, withUpstreamLock } from "./upstream.mjs";
import { isDirectory } from "./util.mjs";

/**
 * @typedef {{
 *   name: string | null,
 *   published: boolean,
 *   baseline: string | null,
 *   at: string | null,
 *   cached: boolean,
 *   directory: string | null,
 *   path: (rel: string) => string,
 *   exists: (rel: string) => boolean,
 *   read: (rel: string) => Buffer,
 * }} PublishedCopy
 *   `published` is false only when the publication lookup said 404 (then `directory` is null and
 *   `path`/`read` throw). `baseline` is the raycast/extensions commit the copy holds, null for a
 *   caller-supplied directory (its identity is the caller's to know) and when unpublished.
 *   `cached` is true when the copy lives in the shared upstream cache (and so is read under the
 *   lock). `directory`, `path`, `exists` and `read` are valid only inside the callback.
 */

/**
 * The cache no longer holds the baseline the caller expected (another rx moved the shared tree, or
 * the cache was cleared). ERROR github when uncaught; `rx audit record` reports it under `png`.
 */
export class PublishedCopyChanged extends RxError {
  /** @param {unknown} name @param {unknown} expected */
  constructor(name, expected) {
    super(`the upstream cache no longer holds baseline ${String(expected).slice(0, 12)} for ${name}; run rx gates again`, { id: "github" });
    this.name = "PublishedCopyChanged";
  }
}

/**
 * @param {{ name: string | null, published: boolean, baseline: string | null, at: string | null, cached: boolean, directory: string | null }} p
 * @returns {PublishedCopy}
 */
function makeCopy({ name, published, baseline, at, cached, directory }) {
  const path = (/** @type {string} */ rel) => {
    if (directory === null) throw new RxError(`extensions/${name} is not published; there is no published copy to read`, { id: "input" });
    return join(directory, rel);
  };
  return {
    name,
    published,
    baseline,
    at,
    cached,
    directory,
    path,
    exists: (rel) => directory !== null && existsSync(join(directory, rel)),
    read: (rel) => readFileSync(path(rel)),
  };
}

/**
 * Run `fn` with the published copy of an extension. Every read of the copy belongs inside `fn`;
 * its return value and exceptions pass through, and the lock (when one is held) is released when
 * it settles.
 * @template T
 * @param {{ name?: string | null, directory?: string | null, expectedBaseline?: string, refresh?: boolean, log?: (s: string) => void }} opts
 * @param {(copy: PublishedCopy) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPublishedCopy({ name = null, directory = null, expectedBaseline, refresh = false, log = () => {} }, fn) {
  if (directory !== null) {
    if (refresh || expectedBaseline !== undefined)
      throw new RxError("a caller-supplied published directory is read as given: it cannot be refreshed or checked against a baseline", { id: "input" });
    // A directory that does not exist is outside the cache by definition (it holds nothing).
    const cached = isDirectory(directory) && insideUpstreamCache(directory);
    const copy = makeCopy({ name, published: true, baseline: null, at: null, cached, directory });
    return cached ? withUpstreamLock(() => fn(copy)) : fn(copy);
  }
  if (typeof name !== "string") throw new RxError("the published copy needs an extension name or a directory", { id: "input" });
  return withUpstreamLock(async () => {
    const info = refresh ? await ensureUpstream(name, { log }) : await cachedUpstream(name);
    if (expectedBaseline !== undefined && (!info || info.baseline !== expectedBaseline)) throw new PublishedCopyChanged(name, expectedBaseline);
    if (!info) throw new RxError(`the upstream cache holds no copy of ${name}; run rx stale first`, { id: "github" });
    return fn(makeCopy({ name, published: info.published, baseline: info.baseline, at: info.at, cached: true, directory: info.publishedDir }));
  });
}

/**
 * @typedef {{ name: unknown, published: unknown, baseline: unknown, at: unknown }} StaleBaseline
 *   As recorded; each reader validates the fields it uses.
 */

/**
 * Write `repo/stale/baseline.json`: `{ name, published, baseline, at }`, no cache path.
 * @param {string} root
 * @param {{ name: string, published: boolean, baseline: string | null, at: string }} b
 */
export async function writeStaleBaseline(root, { name, published, baseline, at }) {
  writeJsonAtomic(await repoStatePath(root, "stale", "baseline.json"), { name, published, baseline, at });
}

/**
 * Read `repo/stale/baseline.json`. Null when the file is absent or holds no JSON object. A file
 * written by the older shape (with `publishedDir`) reads the same: the path is dropped. Creates
 * nothing. Throws when the state path cannot be resolved or the file is not JSON: each reader
 * keeps its own policy for that.
 * @param {string} root
 * @returns {Promise<StaleBaseline | null>}
 */
export async function readStaleBaseline(root) {
  const file = await repoStatePathReadOnly(root, "stale", "baseline.json");
  if (!existsSync(file)) return null;
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (j === null || typeof j !== "object" || Array.isArray(j)) return null;
  return { name: j.name, published: j.published, baseline: j.baseline, at: j.at };
}

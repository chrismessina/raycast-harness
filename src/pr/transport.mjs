// The one GitHub transport `rx pr` and `rx greptile` speak through. Every method here is a network
// boundary; the default implementation runs `gh` via src/gh.mjs (argument arrays, no shell).
// Tests install a fake with `setTransport()` so nothing reaches github.com.
//
// Why a layer above gh.mjs: these commands need three things `ghApi` does not expose — the HTTP
// status and ETag of a conditional GET (`rx greptile wait`), typed GraphQL variables
// (`-F p=<int>` for the PR number), and a PATCH that is sent exactly once and whose failure is
// reported, never retried (`rx pr body --apply`).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RxError } from "../errors.mjs";
import { gh, ghApi } from "../gh.mjs";

/**
 * @typedef {{
 *   getJson: (path: string, o?: { signal?: AbortSignal }) => Promise<any>,
 *   getJsonPages: (path: string) => Promise<any[]>,
 *   getRaw: (path: string, o?: { signal?: AbortSignal }) => Promise<string>,
 *   getConditional: (path: string, etag: string | null) => Promise<{ status: number, etag: string | null, body: any }>,
 *   graphql: (query: string, variables: Record<string, string | number>) => Promise<any>,
 *   patch: (path: string, body: Record<string, unknown>) => Promise<{ ok: boolean, error: string | null }>,
 * }} Transport
 *   `getJson`/`getRaw`/`graphql` reject with RxError(id "github") on any non-2xx. `getJsonPages`
 *   follows the `Link` header to the last page and returns every page's items as one array, so a
 *   list is never silently its first page (a stray file on page 2, a finding past 100 comments).
 *   `getConditional` resolves with status 200 (parsed body, new etag) or 304 (body null); any
 *   other outcome rejects. `patch` never throws for an HTTP failure: it reports it, because the
 *   caller must then re-read to learn whether GitHub applied the write anyway.
 */

/** @type {Transport} */
export const ghTransport = {
  // `signal` (the greptile-rules step's deadline) kills the gh child on abort; omitted, as before.
  getJson: (path, o) => ghApi(path, { signal: o?.signal }),
  async getJsonPages(path) {
    // `--paginate --slurp` yields one JSON array of pages; each page is itself an array here.
    const pages = await ghApi(path, { paginate: true });
    if (!Array.isArray(pages)) throw new RxError(`gh api ${path} --paginate did not return pages`, { id: "github" });
    /** @type {any[]} */
    const items = [];
    for (const page of pages) {
      if (!Array.isArray(page)) throw new RxError(`gh api ${path} --paginate returned a non-list page`, { id: "github" });
      items.push(...page);
    }
    return items;
  },
  getRaw: (path, o) => ghApi(path, { raw: true, headers: ["Accept: application/vnd.github.raw"], signal: o?.signal }),
  async getConditional(path, etag) {
    const args = ["api", "--include", path];
    if (etag) args.push("-H", `If-None-Match: ${etag}`);
    const r = await gh(args);
    const text = r.stdout;
    const m = text.match(/^HTTP\/[\d.]+ (\d{3})/m);
    if (r.code !== 0 && !m) throw new RxError(`gh api ${path} failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`, { id: "github" });
    const status = m ? Number(m[1]) : NaN;
    const sep = text.search(/\r?\n\r?\n/);
    const headers = sep === -1 ? text : text.slice(0, sep);
    const payload = sep === -1 ? "" : text.slice(sep).replace(/^\r?\n\r?\n/, "");
    const newEtag = headers.match(/^etag:\s*(.+?)\s*$/im)?.[1] ?? null;
    if (status === 304) return { status, etag: newEtag ?? etag, body: null };
    if (status !== 200) throw new RxError(`gh api ${path}: HTTP ${status}`, { id: "github" });
    try {
      return { status, etag: newEtag, body: JSON.parse(payload) };
    } catch {
      throw new RxError(`gh api ${path} returned non-JSON output`, { id: "github" });
    }
  },
  async graphql(query, variables) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(variables)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
    const r = await gh(args);
    if (r.code !== 0) throw new RxError(`gh api graphql failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}`, { id: "github" });
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new RxError("gh api graphql returned non-JSON output", { id: "github" });
    }
    if (parsed?.errors?.length) throw new RxError(`graphql: ${parsed.errors[0].message}`, { id: "github" });
    return parsed;
  },
  async patch(path, body) {
    // The body goes through a file, never argv: a PR body can exceed the argument length limit
    // and `-f body=` would alter nothing but is one more place for a shell to touch it.
    const dir = mkdtempSync(join(tmpdir(), "rx-patch-"));
    const file = join(dir, "body.json");
    try {
      writeFileSync(file, JSON.stringify(body));
      // Sent once. gh.mjs retries through `op plugin run -- gh` only when plain gh was rejected as
      // unauthenticated, which is a request GitHub did not accept, so the write still lands at
      // most once.
      const r = await gh(["api", "-X", "PATCH", path, "--input", file, "--silent"]);
      return r.code === 0 ? { ok: true, error: null } : { ok: false, error: r.stderr.trim().split("\n")[0] || `exit ${r.code}` };
    } catch (e) {
      return { ok: false, error: /** @type {Error} */ (e).message };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/** @type {Transport} */
let current = ghTransport;

/** Test hook: replace the GitHub transport. Returns the previous one. @param {Transport} t */
export function setTransport(t) {
  const prev = current;
  current = t;
  return prev;
}

export function transport() {
  return current;
}

/**
 * Validate an `owner/name` repository slug.
 * @param {string} repo
 */
export function parseRepo(repo) {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!m) throw new RxError(`--repo must be owner/name, got ${JSON.stringify(repo)}`, { id: "args" });
  return { owner: m[1], name: m[2], slug: repo };
}

/**
 * A PR number from a positional: digits only.
 * @param {string} raw
 */
export function parsePrNumber(raw) {
  if (!/^\d+$/.test(raw)) throw new RxError(`<N> must be a pull request number, got ${JSON.stringify(raw)}`, { id: "args" });
  return Number(raw);
}

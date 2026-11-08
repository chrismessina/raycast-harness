// GitHub CLI access. Plain `gh` first. If it reports that it is not authenticated and `op`
// (1Password CLI) is on PATH, retry through `op plugin run -- gh`: on some machines `gh` is a
// shell alias for that wrapper, and an alias does not exist inside execFile. The wrapper is
// never tried first because it can block on a 1Password authorization prompt.
// Every function here is a network boundary; callers document that in their command contract.

import { run } from "./exec.mjs";
import { RxError } from "./errors.mjs";

const NOT_AUTHED = /not logged in|You are not logged into any GitHub hosts|To get started with GitHub CLI|gh auth login/i;

/**
 * Run `gh <args>`; resolves on any exit code (read `code`), rejects with RxError when gh cannot
 * be started. `signal` reaches every child (plain gh, the `op --version` probe and the `op plugin
 * run` fallback): aborting it kills the running one and rejects with RxError `…: aborted`.
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string, signal?: AbortSignal }} [opts]
 */
export async function gh(args, opts = {}) {
  const signal = opts.signal;
  const plain = await run("gh", args, { cwd: opts.cwd, input: opts.input, signal });
  if (plain.code === 0 || !NOT_AUTHED.test(plain.stderr + plain.stdout)) return plain;
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return plain;
  const op = await run("op", ["--version"], { timeoutMs: 5_000, signal }).catch(() => null);
  if (signal?.aborted) throw new RxError("op --version: aborted", { id: "tooling" });
  if (!op || op.code !== 0) return plain;
  // An abort is rethrown, never mistaken for "the wrapper failed, use plain gh's answer".
  const wrapped = await run("op", ["plugin", "run", "--", "gh", ...args], { cwd: opts.cwd, input: opts.input, timeoutMs: 30_000, signal }).catch((e) => {
    if (signal?.aborted) throw e;
    return null;
  });
  return wrapped ?? plain;
}

/**
 * `gh api <path>` parsed as JSON. Non-2xx → RxError with the HTTP status when gh reports one.
 * @param {string} path e.g. "repos/raycast/extensions/pulls/123"
 * @param {{ method?: string, fields?: Record<string, string>, headers?: string[], paginate?: boolean, cwd?: string, raw?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<any>}
 */
export async function ghApi(path, opts = {}) {
  const args = ["api", path];
  if (opts.method) args.push("-X", opts.method);
  for (const [k, v] of Object.entries(opts.fields ?? {})) args.push("-f", `${k}=${v}`);
  for (const h of opts.headers ?? []) args.push("-H", h);
  if (opts.paginate) args.push("--paginate", "--slurp");
  const r = await gh(args, { cwd: opts.cwd, signal: opts.signal });
  if (r.code !== 0) {
    const m = r.stderr.match(/HTTP (\d{3})/);
    const err = new RxError(`gh api ${path} failed${m ? ` (HTTP ${m[1]})` : ""}: ${r.stderr.trim().split("\n")[0]}`, { id: "github" });
    /** @type {any} */ (err).status = m ? Number(m[1]) : null;
    throw err;
  }
  if (opts.raw) return r.stdout;
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new RxError(`gh api ${path} returned non-JSON output`, { id: "github" });
  }
}

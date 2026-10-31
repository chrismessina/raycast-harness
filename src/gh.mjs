// GitHub CLI access. On Chris's machine `gh` is a shell alias for `op plugin run -- gh`, and an
// alias does not exist inside execFile: a bare `gh` runs unauthenticated. So when `op` is on PATH
// and no token is in the environment, go through 1Password first, then plain `gh`.
// Every function here is a network boundary; callers document that in their command contract.

import { run } from "./exec.mjs";
import { RxError } from "./errors.mjs";

/** @type {string[][] | null} */
let candidates = null;

/** @returns {Promise<string[][]>} */
async function ghCommands() {
  if (candidates) return candidates;
  const list = [];
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    const op = await run("op", ["--version"]).catch(() => null);
    if (op && op.code === 0) list.push(["op", "plugin", "run", "--", "gh"]);
  }
  list.push(["gh"]);
  candidates = list;
  return list;
}

/**
 * Run `gh <args>`; resolves on any exit code (read `code`), rejects with RxError when gh cannot
 * be started. Tries the 1Password wrapper first when applicable.
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string }} [opts]
 */
export async function gh(args, opts = {}) {
  let last = null;
  for (const prefix of await ghCommands()) {
    try {
      const r = await run(prefix[0], [...prefix.slice(1), ...args], { cwd: opts.cwd, input: opts.input });
      // The op wrapper exits non-zero with its own message when the plugin is not configured; fall through.
      if (prefix[0] === "op" && r.code !== 0 && /op plugin|1Password|not configured|no credential/i.test(r.stderr)) { last = r; continue; }
      return r;
    } catch (e) {
      last = e;
    }
  }
  if (last instanceof Error) throw last;
  throw new RxError("gh is not installed or not on PATH", { id: "tooling" });
}

/**
 * `gh api <path>` parsed as JSON. Non-2xx → RxError with the HTTP status when gh reports one.
 * @param {string} path e.g. "repos/raycast/extensions/pulls/123"
 * @param {{ method?: string, fields?: Record<string, string>, headers?: string[], paginate?: boolean, cwd?: string, raw?: boolean }} [opts]
 * @returns {Promise<any>}
 */
export async function ghApi(path, opts = {}) {
  const args = ["api", path];
  if (opts.method) args.push("-X", opts.method);
  for (const [k, v] of Object.entries(opts.fields ?? {})) args.push("-f", `${k}=${v}`);
  for (const h of opts.headers ?? []) args.push("-H", h);
  if (opts.paginate) args.push("--paginate", "--slurp");
  const r = await gh(args, { cwd: opts.cwd });
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

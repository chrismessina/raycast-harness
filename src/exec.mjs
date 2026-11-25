// Child processes run through execFile with argument arrays: no shell, no word splitting, no
// aliases. `ls`, `grep`, `find` and `sed` are never run; use Node.

import { execFile } from "node:child_process";
import { RxError } from "./errors.mjs";

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 */

/**
 * Run a program. Resolves only when the child exited by itself (read `code`, which may be
 * non-zero). Rejects with RxError when the program could not be started (ENOENT), timed out, was
 * killed by a signal, or exceeded `maxBuffer`: an incomplete check must never look like a
 * completed negative result. `signal`, when aborted, kills the child (SIGTERM) and rejects with
 * RxError `<cmd args>: aborted`; without one nothing changes.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string | Buffer, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number, id?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<ExecResult>}
 */
export function run(cmd, args, opts = {}) {
  return /** @type {Promise<ExecResult>} */ (spawnChild(cmd, args, opts, "utf8"));
}

/**
 * `run` with stdout kept as the exact bytes the child wrote (no decoding, no trimming): for
 * `git cat-file blob`, whose output is a file's content and may be binary. Same rejections as `run`.
 * @param {string} cmd
 * @param {string[]} args
 * @param {Parameters<typeof run>[2]} [opts]
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: string }>}
 */
export function runBuffer(cmd, args, opts = {}) {
  return /** @type {Promise<{ code: number, stdout: Buffer, stderr: string }>} */ (spawnChild(cmd, args, opts, "buffer"));
}

/**
 * @param {string} cmd @param {string[]} args @param {Parameters<typeof run>[2]} opts
 * @param {"utf8" | "buffer"} encoding
 * @returns {Promise<{ code: number, stdout: string | Buffer, stderr: string }>}
 */
function spawnChild(cmd, args, opts = {}, encoding) {
  const id = opts.id ?? "tooling";
  const what = `${cmd} ${args.join(" ")}`.trim();
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const done = (/** @type {() => void} */ f) => { if (!settled) { settled = true; f(); } };
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding,
        windowsHide: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        const e = /** @type {(NodeJS.ErrnoException & { killed?: boolean, signal?: string | null }) | null} */ (err);
        // Aborted by the caller (a deadline): checked first, because the abort also kills the child.
        if (e && (e.name === "AbortError" || opts.signal?.aborted)) return done(() => reject(new RxError(`${what}: aborted`, { id })));
        if (e && e.code === "ENOENT") return done(() => reject(new RxError(`${cmd} is not installed or not on PATH`, { id })));
        if (e && e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return done(() => reject(new RxError(`${what}: output exceeded ${opts.maxBuffer ?? 64 * 1024 * 1024} bytes`, { id })));
        if (e && (e.killed || e.signal)) {
          const why = e.killed && opts.timeoutMs !== 0 && e.signal === "SIGTERM" ? `timed out after ${opts.timeoutMs ?? 120_000} ms` : `killed by ${e.signal}`;
          return done(() => reject(new RxError(`${what}: ${why}`, { id })));
        }
        if (e && typeof e.code !== "number")
          return done(() => reject(new RxError(`${what}: ${e.message}`, { id })));
        const code = e ? Number(e.code) : 0;
        const out = encoding === "buffer" ? (Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "")) : String(stdout ?? "");
        done(() => resolvePromise({ code, stdout: out, stderr: String(stderr ?? "") }));
      },
    );
    if (child.stdin) {
      // A child that exits before reading its input makes stdin emit EPIPE; that is the child's
      // outcome to report through the exit callback, not a crash of this process.
      child.stdin.on("error", () => {});
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    }
  });
}

/**
 * Run and require exit 0; otherwise throw RxError carrying the first stderr line.
 * @param {string} cmd @param {string[]} args @param {Parameters<typeof run>[2]} [opts]
 */
export async function runOk(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const first = (r.stderr || r.stdout).split("\n").find((l) => l.trim()) ?? `exit ${r.code}`;
    throw new RxError(`${cmd} ${args.join(" ")} failed: ${first.trim()}`, { id: opts.id ?? "tooling" });
  }
  return r;
}

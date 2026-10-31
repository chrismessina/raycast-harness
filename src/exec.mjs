// Child processes run through execFile with argument arrays: no shell, no word splitting, no
// aliases. `ls`, `grep`, `find` and `sed` are never run; use Node.

import { execFile } from "node:child_process";
import { RxError } from "./errors.mjs";

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 */

/**
 * Run a program. Resolves even on a non-zero exit (read `code`); rejects with RxError only when
 * the program cannot be started at all (ENOENT → "<cmd> is not installed or not on PATH").
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string | Buffer, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number }} [opts]
 * @returns {Promise<ExecResult>}
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT")
          return reject(new RxError(`${cmd} is not installed or not on PATH`, { id: "tooling" }));
        if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ETIMEDOUT")
          return reject(new RxError(`${cmd} ${args.join(" ")} timed out`, { id: "tooling" }));
        const code = err && typeof (/** @type {any} */ (err).code) === "number" ? /** @type {any} */ (err).code : err ? 1 : 0;
        resolvePromise({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (opts.input !== undefined && child.stdin) child.stdin.end(opts.input);
  });
}

/**
 * Run and require exit 0; otherwise throw RxError carrying the first stderr line.
 * @param {string} cmd @param {string[]} args @param {Parameters<typeof run>[2] & { id?: string }} [opts]
 */
export async function runOk(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const first = (r.stderr || r.stdout).split("\n").find((l) => l.trim()) ?? `exit ${r.code}`;
    throw new RxError(`${cmd} ${args.join(" ")} failed: ${first.trim()}`, { id: opts.id ?? "tooling" });
  }
  return r;
}

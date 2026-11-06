// Shared test helpers: temp dirs, fake extensions, running the CLI in-process or as a child.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";
import { _setGhForTests } from "../src/commands/doctor.mjs";

export const REPO = join(fileURLToPath(import.meta.url), "..", "..");
export const BIN = join(REPO, "bin", "rx.mjs");

/**
 * @template T
 * @param {(dir: string) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rx-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * withTempDir with XDG_CONFIG_HOME at <dir>/config and the doctor's gh probe stubbed (not logged
 * in; no network), both restored after.
 * @template T
 * @param {(dir: string) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withConfig(fn) {
  return withTempDir(async (dir) => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    _setGhForTests(async () => ({ code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login" }));
    try {
      return await fn(dir);
    } finally {
      _setGhForTests(null);
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
}

/**
 * Write a minimal Raycast extension (package.json with a commands array) at dir/name.
 * @param {string} dir @param {string} name @param {Record<string, unknown>} [extra]
 */
export function fakeExtension(dir, name, extra = {}) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, title: name, commands: [{ name: "index", title: "Index", mode: "view" }], ...extra }, null, 2),
  );
  return root;
}

/**
 * Run the CLI in-process, capturing stdout. Returns { code, stdout, stderr, json }.
 * @param {string[]} argv @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdin?: string }} [opts]
 */
export async function rx(argv, opts = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    stdin: opts.stdin !== undefined ? async () => /** @type {string} */ (opts.stdin) : undefined,
  });
  let json = null;
  if (argv.includes("--json")) {
    try { json = JSON.parse(stdout); } catch { json = null; }
  }
  return { code, stdout, stderr, json };
}

/**
 * Run bin/rx.mjs as a real child process (for exit-code receipts).
 * @param {string[]} argv @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function rxProcess(argv, opts = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...argv], { cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err && typeof (/** @type {any} */ (err).code) === "number" ? /** @type {any} */ (err).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

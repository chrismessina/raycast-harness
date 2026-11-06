// `rx doctor [--root d] [--json]`: is this machine set up? Report only: it never FAILs, it says
// what it found as PASS / WARN / N/A so an agent can decide. The one ERROR it can emit is
// `attest-key` for an attestation key that exists but is unusable (or whose directory is open to
// group or other), since every rx gates and rx audit record run would then ERROR too. The
// `gh auth status` probe is an explicit network operation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectKey } from "../attest.mjs";
import { run as exec } from "../exec.mjs";
import { gh } from "../gh.mjs";
import { git } from "../git.mjs";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "doctor",
  summary: "report Node, ray, gh auth, git signing, the Raycast app version and the rx attestation key (report only)",
  root: "optional",
  flags: { "--root": { type: "string", value: "<dir>", help: "extension root (for the ray check)" } },
  network: "`gh auth status` contacts github.com; everything else is local",
  state: "reads the attestation key $XDG_CONFIG_HOME/raycast-harness/attest.key; creates nothing",
  checks: {
    node: "Node version is 22.12 or newer",
    ray: "node_modules/.bin/ray present in the extension root",
    "gh-auth": "gh is authenticated (network probe)",
    "git-signing": "commit.gpgsign is on and a signing key is configured",
    "raycast-app": "Raycast.app version readable from its Info.plist",
    "attest-key": { description: "PASS the attestation key is a regular file of 32 bytes with no group or other access (prints its mode and keyId) / WARN not created yet / ERROR present but unusable, or its directory is accessible to group or other", levels: ["PASS", "WARN", "ERROR"] },
  },
  data: {
    node: "string — process.version",
    ray: "{ found: boolean, apiVersion: string | null } | null when no root",
    gh: "{ authenticated: boolean, login: string | null, detail: string }",
    signing: "{ gpgsign: boolean, format: string | null, key: string | null }",
    raycastApp: "{ version: string | null, path: string, installed: boolean, error: string | null }",
    attestKey: "{ path: string, present: boolean, keyId: string | null, error: string | null }",
  },
};

let RAYCAST_PLIST = "/Applications/Raycast.app/Contents/Info.plist";
/** Test hook: point the Raycast.app check at another plist. @param {string} path */
export function _setRaycastPlist(path) { RAYCAST_PLIST = path; }

/** @type {typeof gh} */
let ghProbe = gh;
/**
 * Test hook: replace the `gh auth status` probe (tests must not reach the network, and with a
 * temporary XDG_CONFIG_HOME gh's 1Password fallback waits out its 30 s timeout). null restores it.
 * @param {typeof gh | null} fn
 */
export function _setGhForTests(fn) { ghProbe = fn ?? gh; }

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ results, root }) {
  /** @type {Record<string, unknown>} */
  const data = {};

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  data.node = process.version;
  const minor = Number(process.versions.node.split(".")[1]);
  if (major > 22 || (major === 22 && minor >= 12)) results.pass("node", `${process.version}`);
  else results.warn("node", `${process.version}; rx needs Node 22.12 or newer`);

  // ray, resolved from the extension root (never installed by rx)
  if (!root) {
    data.ray = null;
    results.na("ray", "no extension root resolved; pass --root to check ray");
  } else {
    const bin = join(root, "node_modules", ".bin", "ray");
    const apiPkg = join(root, "node_modules", "@raycast", "api", "package.json");
    let apiVersion = null;
    if (existsSync(apiPkg)) {
      try { apiVersion = JSON.parse(readFileSync(apiPkg, "utf8")).version ?? null; } catch { apiVersion = null; }
    }
    data.ray = { found: existsSync(bin), apiVersion };
    if (existsSync(bin)) results.pass("ray", `node_modules/.bin/ray present (@raycast/api ${apiVersion ?? "version unreadable"})`);
    else results.warn("ray", `node_modules/.bin/ray missing in ${root}; run npm install there`);
  }

  // gh auth (network)
  try {
    const r = await ghProbe(["auth", "status"]);
    const text = `${r.stdout}\n${r.stderr}`;
    const login = text.match(/Logged in to github\.com account (\S+)/)?.[1] ?? text.match(/account (\S+) \(/)?.[1] ?? null;
    const ok = r.code === 0 && /Logged in to github\.com/.test(text);
    data.gh = { authenticated: ok, login, detail: text.trim().split("\n")[0] ?? "" };
    if (ok) results.pass("gh-auth", `gh authenticated${login ? ` as ${login}` : ""}`);
    else results.warn("gh-auth", `gh not authenticated: ${(text.trim().split("\n").find((l) => l.trim()) ?? "no output").trim()}`);
  } catch (e) {
    data.gh = { authenticated: false, login: null, detail: /** @type {Error} */ (e).message };
    results.warn("gh-auth", /** @type {Error} */ (e).message);
  }

  // git signing (report)
  const cwd = root ?? process.cwd();
  const cfg = async (/** @type {string} */ k, /** @type {string[]} */ extra = []) =>
    (await git(["config", ...extra, "--get", k], { cwd, allowFail: true })).stdout.trim() || null;
  const gpgsign = (await cfg("commit.gpgsign", ["--bool"])) === "true"; // yes/on/1 all read as true
  const format = await cfg("gpg.format");
  const key = await cfg("user.signingkey");
  data.signing = { gpgsign, format, key: key ? key.slice(0, 24) + (key.length > 24 ? "…" : "") : null };
  if (gpgsign && key) results.pass("git-signing", `commits signed (${format ?? "openpgp"})`);
  else results.warn("git-signing", gpgsign ? "commit.gpgsign is true but user.signingkey is unset" : "commit.gpgsign is not true; commits will be unsigned");

  // Raycast app version: absence is N/A; an installed app whose version cannot be read is a WARN.
  let appVersion = null;
  let readError = null;
  const installed = existsSync(RAYCAST_PLIST);
  if (installed) {
    try {
      const r = await exec("plutil", ["-convert", "json", "-o", "-", RAYCAST_PLIST]);
      if (r.code !== 0) readError = `plutil exit ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`;
      else appVersion = JSON.parse(r.stdout).CFBundleShortVersionString ?? null;
      if (!appVersion && !readError) readError = "CFBundleShortVersionString missing from Info.plist";
    } catch (e) {
      readError = /** @type {Error} */ (e).message;
    }
  }
  data.raycastApp = { version: appVersion, path: RAYCAST_PLIST, installed, error: readError };
  if (appVersion) results.pass("raycast-app", `Raycast ${appVersion}`);
  else if (installed) results.warn("raycast-app", `Raycast.app is installed but its version could not be read: ${readError}`);
  else if (process.platform === "darwin") results.na("raycast-app", `Raycast.app not found at ${RAYCAST_PLIST}`);
  else results.na("raycast-app", `not macOS (${process.platform}); Raycast.app is not expected`);

  // The attestation key (src/attest.mjs): read only, never created here.
  const k = inspectKey();
  data.attestKey = { path: k.path, present: k.status !== "missing", keyId: k.status === "ok" ? k.keyId : null, error: k.status === "bad" ? k.problem : null };
  if (k.status === "ok") results.pass("attest-key", `${k.path} (mode ${k.mode.toString(8).padStart(4, "0")}, 32 bytes, keyId ${k.keyId})`);
  else if (k.status === "missing") results.warn("attest-key", `${k.path} not created yet; rx gates creates it`);
  else results.error("attest-key", k.message);

  return { data };
}

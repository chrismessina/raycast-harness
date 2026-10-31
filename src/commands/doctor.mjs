// `rx doctor [--root d] [--json]`: is this machine set up? Report only: it never FAILs, it says
// what it found as PASS / WARN / N/A so an agent can decide. The `gh auth status` probe is an
// explicit network operation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run as exec } from "../exec.mjs";
import { gh } from "../gh.mjs";
import { git } from "../git.mjs";

/** @type {import("../cli.mjs").CommandSpec} */
export const spec = {
  name: "doctor",
  summary: "report Node, ray, gh auth, git signing and the Raycast app version (report only)",
  root: "optional",
  flags: { "--root": { type: "string", value: "<dir>", help: "extension root (for the ray check)" } },
  network: "`gh auth status` contacts github.com; everything else is local",
  state: "none",
  data: {
    node: "string — process.version",
    ray: "{ found: boolean, apiVersion: string | null } | null when no root",
    gh: "{ authenticated: boolean, login: string | null, detail: string }",
    signing: "{ gpgsign: boolean, format: string | null, key: string | null }",
    raycastApp: "{ version: string | null, path: string }",
  },
};

const RAYCAST_PLIST = "/Applications/Raycast.app/Contents/Info.plist";

/** @type {import("../cli.mjs").CommandModule["run"]} */
export async function run({ results, root }) {
  /** @type {Record<string, unknown>} */
  const data = {};

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  data.node = process.version;
  if (major >= 22) results.pass("node", `${process.version}`);
  else results.warn("node", `${process.version}; rx needs Node 22 or newer`);

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
    const r = await gh(["auth", "status"]);
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
  const cfg = async (/** @type {string} */ k) => (await git(["config", "--get", k], { cwd, allowFail: true })).stdout.trim() || null;
  const gpgsign = (await cfg("commit.gpgsign")) === "true";
  const format = await cfg("gpg.format");
  const key = await cfg("user.signingkey");
  data.signing = { gpgsign, format, key: key ? key.slice(0, 24) + (key.length > 24 ? "…" : "") : null };
  if (gpgsign && key) results.pass("git-signing", `commits signed (${format ?? "openpgp"})`);
  else results.warn("git-signing", gpgsign ? "commit.gpgsign is true but user.signingkey is unset" : "commit.gpgsign is not true; commits will be unsigned");

  // Raycast app version
  let appVersion = null;
  if (existsSync(RAYCAST_PLIST)) {
    const r = await exec("plutil", ["-convert", "json", "-o", "-", RAYCAST_PLIST]).catch(() => null);
    if (r && r.code === 0) {
      try { appVersion = JSON.parse(r.stdout).CFBundleShortVersionString ?? null; } catch { appVersion = null; }
    }
  }
  data.raycastApp = { version: appVersion, path: RAYCAST_PLIST };
  if (appVersion) results.pass("raycast-app", `Raycast ${appVersion}`);
  else if (process.platform === "darwin") results.na("raycast-app", `Raycast.app not found at ${RAYCAST_PLIST}`);
  else results.na("raycast-app", `not macOS (${process.platform}); Raycast.app is not expected`);

  return { data };
}

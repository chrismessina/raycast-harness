// The rx commit-signing key (docs/commands.md §1 State locations "signing key"; `rx post-merge`
// step 4). An ed25519 SSH key pair at $XDG_CONFIG_HOME/raycast-harness/signing/rx-signing and
// rx-signing.pub, used only to sign the one commit `rx post-merge` makes. rx creates it when
// neither file exists (a temp directory inside signing/, then hard links: private file first, so
// of two racing first runs one pair wins) and never replaces either file afterward.

import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, privateDirProblem } from "./attest.mjs";
import { RxError } from "./errors.mjs";
import { run } from "./exec.mjs";
import { transport } from "./pr/transport.mjs";
import { xdgBase } from "./state.mjs";

/**
 * @typedef {{ dir: string, privateKey: string, publicKey: string }} SigningKeyPaths
 * @typedef {{ status: "missing", paths: SigningKeyPaths }
 *   | { status: "ok", paths: SigningKeyPaths, publicKey: string }
 *   | { status: "bad", paths: SigningKeyPaths, message: string }} SigningKeyState
 *   `publicKey` is the `.pub` file's first two fields, "<type> <base64>".
 */

/** The key pair's directory and files, from XDG_CONFIG_HOME at call time. @returns {SigningKeyPaths} */
export function signingKeyPaths() {
  const dir = join(xdgBase("XDG_CONFIG_HOME", ".config"), "raycast-harness", "signing");
  return { dir, privateKey: join(dir, "rx-signing"), publicKey: join(dir, "rx-signing.pub") };
}

const DIR_LABEL = "signing key directory";
const ADVICE = "; fix or remove it by hand (rx never replaces the signing key)";

/** First two whitespace-separated fields. @param {string} s */
const keyFields = (s) => s.trim().split(/\s+/).slice(0, 2).join(" ");

/**
 * Inspect the key pair. Never creates anything.
 * @returns {Promise<SigningKeyState>}
 */
export async function inspectSigningKey() {
  const first = await inspectOnce();
  if (!first.pubMissing) return first.state;
  // A first-run pair race: another process links the private file, then the public one. Give it
  // one short moment before calling the pair bad.
  await new Promise((r) => setTimeout(r, RACE_RETRY_MS));
  return (await inspectOnce()).state;
}

const RACE_RETRY_MS = 100;

/**
 * One inspection. `pubMissing` is true when the private file exists and the public one does not
 * (the window between the two links of a concurrent first run).
 * @returns {Promise<{ state: SigningKeyState, pubMissing: boolean }>}
 */
async function inspectOnce() {
  const state = await inspectState();
  const paths = state.paths;
  const pubMissing = state.status === "bad" && exists(paths.privateKey) && !exists(paths.publicKey);
  return { state, pubMissing };
}

/** @param {string} path */
function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<SigningKeyState>} */
async function inspectState() {
  const paths = signingKeyPaths();
  /** @param {string} message @returns {SigningKeyState} */
  const bad = (message) => ({ status: "bad", paths, message });
  /** @param {string} path @param {string} problem */
  const badPath = (path, problem) => bad(`the rx signing key file ${path} ${problem}${ADVICE}`);

  const parent = join(paths.dir, "..");
  const dirProblem = privateDirProblem(parent, DIR_LABEL) ?? privateDirProblem(paths.dir, DIR_LABEL);
  if (dirProblem) return bad(dirProblem);

  /** @param {string} path @returns {import("node:fs").Stats | null | "error"} */
  const stat = (path) => {
    try {
      return lstatSync(path);
    } catch (e) {
      return /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? null : "error";
    }
  };
  const priv = stat(paths.privateKey);
  const pub = stat(paths.publicKey);
  if (priv === "error") return badPath(paths.privateKey, "cannot be read");
  if (pub === "error") return badPath(paths.publicKey, "cannot be read");
  if (!priv && !pub) return { status: "missing", paths };
  if (!priv) return badPath(paths.privateKey, `is missing while ${paths.publicKey} exists`);
  if (!pub) return badPath(paths.publicKey, `is missing while ${paths.privateKey} exists`);
  if (!priv.isFile()) return badPath(paths.privateKey, "is not a regular file");
  if (!pub.isFile()) return badPath(paths.publicKey, "is not a regular file");
  const mode = priv.mode & 0o777;
  if (mode & 0o077) return badPath(paths.privateKey, `has mode ${mode.toString(8).padStart(4, "0")}; it must not be accessible to group or other`);

  /** @type {string} */
  let pubText;
  try {
    pubText = readFileSync(paths.publicKey, "utf8");
  } catch (e) {
    return badPath(paths.publicKey, `cannot be read (${/** @type {Error} */ (e).message})`);
  }
  const r = await run("ssh-keygen", ["-y", "-P", "", "-f", paths.privateKey]);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).split("\n").find((l) => l.trim())?.trim() ?? `exit ${r.code}`;
    return badPath(paths.privateKey, `is not a usable private key (ssh-keygen -y: ${why})`);
  }
  const derived = keyFields(r.stdout);
  const recorded = keyFields(pubText);
  if (derived !== recorded) return badPath(paths.publicKey, `does not match ${paths.privateKey}`);
  return { status: "ok", paths, publicKey: recorded };
}

/** @param {SigningKeyState} s @returns {Extract<SigningKeyState, { status: "ok" }>} */
function requireOk(s) {
  if (s.status === "bad") throw new RxError(s.message, { id: "signing-key" });
  if (s.status === "missing") throw new RxError(`the rx signing key ${s.paths.privateKey} is missing`, { id: "signing-key" });
  return s;
}

/**
 * Create the pair when neither file exists; never replace either. Throws RxError id "signing-key"
 * for a bad state ("tooling" when ssh-keygen cannot run).
 * @returns {Promise<Extract<SigningKeyState, { status: "ok" }> & { created: boolean }>}
 */
export async function ensureSigningKey() {
  const first = await inspectSigningKey();
  if (first.status === "bad") throw new RxError(first.message, { id: "signing-key" });
  if (first.status === "ok") return { ...first, created: false };

  const { dir, privateKey, publicKey } = first.paths;
  ensurePrivateDirFor(join(dir, ".."));
  ensurePrivateDirFor(dir);
  /** @type {string} */
  let tmp;
  try {
    tmp = mkdtempSync(join(dir, "tmp-"));
  } catch (e) {
    throw new RxError(`cannot create a temp directory in ${dir} for the rx signing key: ${/** @type {Error} */ (e).message}`, { id: "signing-key" });
  }
  /** @type {boolean} */
  let created;
  try {
    const k = join(tmp, "k");
    const r = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "rx post-merge signing", "-f", k]);
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).split("\n").find((l) => l.trim())?.trim() ?? `exit ${r.code}`;
      throw new RxError(`ssh-keygen could not create the rx signing key: ${why}`, { id: "signing-key" });
    }
    chmodSync(k, 0o600);
    // A link refuses to replace an existing file: EEXIST means another process got there first.
    created = linkOnce(k, privateKey);
    if (created) linkOnce(`${k}.pub`, publicKey);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { ...requireOk(await inspectSigningKey()), created };
}

/** @param {string} dir */
function ensurePrivateDirFor(dir) {
  try {
    ensurePrivateDir(dir, DIR_LABEL);
  } catch (e) {
    throw new RxError(/** @type {Error} */ (e).message, { id: "signing-key" });
  }
}

/**
 * Hard-link `from` to `to`. @returns {boolean} false when `to` already exists (never replaced).
 * @param {string} from @param {string} to
 */
function linkOnce(from, to) {
  try {
    linkSync(from, to);
    return true;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") return false;
    throw new RxError(`cannot link the rx signing key into place at ${to}: ${/** @type {Error} */ (e).message}`, { id: "signing-key" });
  }
}

/**
 * Is `publicKey` ("<type> <base64>") registered on GitHub as an SSH signing key of the
 * authenticated user?
 * @param {string} publicKey
 * @returns {Promise<{ login: string, registered: boolean }>}
 */
export async function signingKeyRegistration(publicKey) {
  const t = transport();
  const user = await t.getJson("user");
  const login = String(user?.login ?? "");
  if (!login) throw new RxError("GET user returned no login", { id: "github" });
  const rows = await t.getJsonPages(`users/${login}/ssh_signing_keys?per_page=100`);
  const want = keyFields(publicKey);
  return { login, registered: rows.some((row) => typeof row?.key === "string" && keyFields(row.key) === want) };
}

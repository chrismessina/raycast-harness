// Receipt and audit provenance (docs/commands.md `rx guard`, "Threat model", limitation 2).
//
// Key       one per machine: 32 random bytes at $XDG_CONFIG_HOME/raycast-harness/attest.key
//           (default ~/.config/raycast-harness/attest.key), outside every repository and outside
//           the npm installation. `rx gates` and `rx audit record` create it on first need: the
//           directory at 0700, the file at 0600, written to a temp file in that directory with
//           `wx` and then hard-linked into place. A link, unlike a rename, refuses to replace an
//           existing file, so of two racing first runs exactly one key wins and the loser reads
//           the winner's. A key that exists but is not a regular file (a symlink counts as not
//           regular), is not exactly 32 bytes, or is readable or writable by group or other is an
//           ERROR naming the path; an existing key is never regenerated. `rx guard` and
//           `rx doctor` never create it.
// Directory every load or create checks the key's directory first: when it exists and its mode
//           has any group or other bit, that is ERROR attest-key naming the directory and the
//           `chmod 700` fix (rx never changes the mode of a directory it did not create). A
//           directory rx creates itself is set to exactly 0700. The same rule covers the
//           `generations/` directory beside the key (src/binding.mjs).
// keyId     the first 16 hex characters of SHA-256(key), so a rotated or foreign key is named.
// MAC       attestation = { alg: "hmac-sha256", keyId, mac }, where mac is the lowercase hex
//           HMAC-SHA256(key, canonical JSON of the document without its `attestation` field).
// Canonical JSON: the document as it reads back from its JSON file (so the writer canonicalizes
//           JSON.parse(JSON.stringify(doc)), never the in-memory object), serialized with every
//           object's keys sorted by UTF-16 code unit order (Array.prototype.sort's default),
//           recursively; arrays keep their order; no whitespace anywhere; strings, numbers,
//           booleans and null exactly as JSON.stringify writes them. Two documents that differ
//           only in key order or formatting therefore carry the same MAC.
//
// What this proves: the document's bytes (up to formatting) were produced by a process holding
// this machine's key, which rx gates / rx audit record hold and an agent editing files under
// .git/rx/ does not. It does not prove more than that: anything running as the same OS user can
// read the key, so a deliberate multi-step evasion remains possible. The guard also blocks the
// direct routes (a Write/Edit into .git/rx/ or onto the key, a Bash command that mentions either).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RxError } from "./errors.mjs";
import { xdgBase } from "./state.mjs";

const KEY_BYTES = 32;
const ALG = "hmac-sha256";

/** The key's directory and file, from XDG_CONFIG_HOME at call time. */
export function keyPaths() {
  const dir = join(xdgBase("XDG_CONFIG_HOME", ".config"), "raycast-harness");
  return { dir, file: join(dir, "attest.key") };
}

/** @param {Buffer} key */
export function keyIdOf(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * @typedef {{ status: "ok", path: string, key: Buffer, keyId: string, mode: number }
 *   | { status: "missing", path: string }
 *   | { status: "bad", path: string, problem: string, detail: string, message: string }} KeyState
 *   `message` is the whole sentence (the key file's path and problem, or the directory's); `problem`
 *   is the part after the key's path, for the key-file cases, or the directory sentence itself;
 *   `detail` is `message` without the key-file cases' "rx never replaces an existing key" advice.
 */

/**
 * The sentence for a private rx directory (the key's, or `generations/`) whose mode lets group or
 * other in, or null when it is fine or does not exist yet.
 * @param {string} dir
 * @param {string} [label] what the directory is, in the message (default "attestation key directory")
 * @returns {string | null}
 */
export function privateDirProblem(dir, label = "attestation key directory") {
  /** @type {import("node:fs").Stats} */
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    return `the rx ${label} ${dir} cannot be read (${/** @type {Error} */ (e).message})`;
  }
  if (!st.isDirectory()) return `the rx ${label} ${dir} is not a directory; remove it by hand`;
  const mode = st.mode & 0o777;
  if (mode & 0o077) return `the rx ${label} ${dir} has mode ${mode.toString(8).padStart(4, "0")}; it must not be accessible to group or other, and rx does not change a directory it did not create: run chmod 700 ${dir}`;
  return null;
}

/**
 * Create a private rx directory (0700, exact) or accept an existing one that is private. An
 * existing directory with any group or other bit is ERROR attest-key; it is never chmodded.
 * @param {string} dir
 * @param {string} [label] passed to privateDirProblem for its messages
 * @returns {boolean} whether rx created it now
 */
export function ensurePrivateDir(dir, label) {
  const before = privateDirProblem(dir, label);
  if (before) throw new RxError(before, { id: "attest-key" });
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
  let created = false;
  if (made !== undefined) {
    // Exact 0700 whatever the umask, on every level rx created (never above `made`).
    for (let d = dir; d.startsWith(made); d = dirname(d)) {
      chmodSync(d, 0o700);
      if (d === made || dirname(d) === d) break;
    }
    created = true;
  }
  const after = privateDirProblem(dir, label);
  if (after) throw new RxError(after, { id: "attest-key" });
  return created;
}

/**
 * Read the key without ever creating it.
 * @returns {KeyState}
 */
export function inspectKey() {
  const { dir, file } = keyPaths();
  const dirProblem = privateDirProblem(dir);
  if (dirProblem) return { status: "bad", path: file, problem: dirProblem, detail: dirProblem, message: dirProblem };
  /** @param {string} problem @returns {KeyState} */
  const bad = (problem) => {
    const detail = `the rx attestation key ${file} ${problem}`;
    return { status: "bad", path: file, problem, detail, message: `${detail}; rx never replaces an existing key, so fix or remove it by hand` };
  };
  /** @type {import("node:fs").Stats} */
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return { status: "missing", path: file };
    return bad(`cannot be read (${/** @type {Error} */ (e).message})`);
  }
  if (!st.isFile()) return bad("is not a regular file");
  const mode = st.mode & 0o777;
  if (mode & 0o077) return bad(`has mode ${mode.toString(8).padStart(4, "0")}; it must not be accessible to group or other (chmod 600 it)`);
  if (st.size !== KEY_BYTES) return bad(`is ${st.size} bytes, not ${KEY_BYTES}`);
  /** @type {Buffer} */
  let key;
  try {
    key = readFileSync(file);
  } catch (e) {
    return bad(`cannot be read (${/** @type {Error} */ (e).message})`);
  }
  if (key.length !== KEY_BYTES) return bad(`is ${key.length} bytes, not ${KEY_BYTES}`);
  return { status: "ok", path: file, key, keyId: keyIdOf(key), mode };
}

/** @param {{ message: string }} s */
function badKeyError(s) {
  return new RxError(s.message, { id: "attest-key" });
}

/**
 * Write `data` to a new private temp file (`wx`, 0600 whatever the umask). The caller publishes it
 * (link or rename) and removes it.
 * @param {string} tmp
 * @param {string | Buffer} data
 */
export function writePrivateTemp(tmp, data) {
  writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
  chmodSync(tmp, 0o600);
}

/**
 * The key, created on first need (rx gates, rx audit record only). Throws RxError id `attest-key`
 * for a bad key or a key directory open to group or other.
 * @returns {Extract<KeyState, { status: "ok" }> & { created: boolean }}
 */
export function loadOrCreateKey() {
  const first = inspectKey();
  if (first.status === "ok") return { ...first, created: false };
  if (first.status === "bad") throw badKeyError(first);

  const { dir, file } = keyPaths();
  ensurePrivateDir(dir);
  const tmp = join(dir, `.attest.key.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let created = false;
  try {
    writePrivateTemp(tmp, randomBytes(KEY_BYTES));
    try {
      linkSync(tmp, file);
      created = true;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  const after = inspectKey();
  if (after.status === "ok") return { ...after, created };
  if (after.status === "bad") throw badKeyError(after);
  throw new RxError(`the rx attestation key ${file} could not be created`, { id: "attest-key" });
}

/**
 * Canonical JSON (see the header): keys sorted recursively, no whitespace.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const obj = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** The document without its attestation, as it reads back from JSON. @param {any} doc */
function body(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  if (copy && typeof copy === "object" && !Array.isArray(copy)) delete copy.attestation;
  return copy;
}

/** @param {Buffer} key @param {any} doc */
export function macOf(key, doc) {
  return createHmac("sha256", key).update(canonicalJson(body(doc))).digest("hex");
}

/**
 * The document with its attestation added (a new object; `doc` is not changed).
 * @template {Record<string, unknown>} T
 * @param {T} doc
 * @param {{ key: Buffer, keyId: string }} k
 * @returns {T & { attestation: { alg: string, keyId: string, mac: string } }}
 */
export function attest(doc, k) {
  return { ...doc, attestation: { alg: ALG, keyId: k.keyId, mac: macOf(k.key, doc) } };
}

/**
 * Verify a document's attestation against this machine's key. Returns null when it verifies,
 * else one sentence. `name` is the file name (`receipt.json`), `rerun` the command that rewrites it.
 * @param {any} doc
 * @param {KeyState} keyState
 * @param {{ name: string, rerun: string }} p
 * @returns {string | null}
 */
export function verifyAttestation(doc, keyState, { name, rerun }) {
  if (keyState.status === "missing") return `${name} cannot be verified: this machine has no rx attestation key at ${keyState.path} (rx gates creates it); re-run ${rerun}`;
  if (keyState.status === "bad") return `${name} cannot be verified: ${keyState.detail}`;
  const a = doc && typeof doc === "object" && !Array.isArray(doc) ? doc.attestation : undefined;
  if (a === undefined || a === null || typeof a !== "object" || Array.isArray(a)) return `${name} is not attested by this machine's rx key: re-run ${rerun}`;
  if (a.alg !== ALG || typeof a.keyId !== "string" || typeof a.mac !== "string") return `${name} carries a malformed attestation (expected { alg: "${ALG}", keyId, mac }): re-run ${rerun}`;
  if (a.keyId !== keyState.keyId) return `${name} was attested by rx key ${a.keyId}, not this machine's key ${keyState.keyId}: re-run ${rerun}`;
  const want = Buffer.from(macOf(keyState.key, doc), "hex");
  const got = /^[0-9a-f]{64}$/.test(a.mac) ? Buffer.from(a.mac, "hex") : Buffer.alloc(0);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return `${name}'s attestation does not verify against this machine's rx key (the file changed after rx wrote it): re-run ${rerun}`;
  return null;
}

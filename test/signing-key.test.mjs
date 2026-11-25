// src/signing-key.mjs: the rx commit-signing key. Every test points XDG_CONFIG_HOME at a temp dir
// (withConfig) and uses the real ssh-keygen; none touches the real ~/.config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RxError } from "../src/errors.mjs";
import { setTransport } from "../src/pr/transport.mjs";
import { ensureSigningKey, inspectSigningKey, signingKeyPaths, signingKeyRegistration } from "../src/signing-key.mjs";
import { withConfig } from "./helpers.mjs";

const mode = (/** @type {string} */ p) => statSync(p).mode & 0o777;
// ssh-keygen -Y sign treats a private key with a sibling .pub as an agent key; the 1Password agent would prompt.
const noAgent = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "SSH_AUTH_SOCK"));
const keygen = (/** @type {string} */ f) => execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", f]);

/** @param {() => Promise<unknown>} fn */
async function signingKeyError(fn) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof RxError);
    assert.equal(e.id, "signing-key");
    return e.message;
  }
  assert.fail("expected an RxError");
}

test("signing key: missing is reported without creating anything", () =>
  withConfig(async () => {
    const r = await inspectSigningKey();
    assert.equal(r.status, "missing");
    assert.throws(() => statSync(signingKeyPaths().dir), { code: "ENOENT" });
  }));

test("signing key: ensure creates a 0600/0700 pair once and never replaces it", () =>
  withConfig(async () => {
    const first = await ensureSigningKey();
    const { dir, privateKey, publicKey } = signingKeyPaths();
    assert.equal(first.status, "ok");
    assert.equal(first.created, true);
    assert.equal(mode(privateKey), 0o600);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, "..")), 0o700);
    assert.deepEqual(readdirSync(dir).sort(), ["rx-signing", "rx-signing.pub"], "the temp directory is removed");
    assert.match(first.publicKey, /^ssh-ed25519 \S+$/);
    const before = [readFileSync(privateKey), readFileSync(publicKey)];

    const second = await ensureSigningKey();
    assert.equal(second.created, false);
    assert.equal(second.publicKey, first.publicKey);
    assert.deepEqual([readFileSync(privateKey), readFileSync(publicKey)], before);
  }));

test("signing key: a signature made with the key verifies", () =>
  withConfig(async (dir) => {
    const k = await ensureSigningKey();
    const msg = join(dir, "msg.txt");
    writeFileSync(msg, "adopt raycastbot's rewrites\n");
    execFileSync("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", k.paths.privateKey, msg], { env: noAgent, stdio: "ignore" });
    const allowed = join(dir, "allowed_signers");
    writeFileSync(allowed, `rx@example.invalid ${k.publicKey}\n`);
    const out = execFileSync("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "rx@example.invalid", "-n", "git", "-s", `${msg}.sig`], { input: readFileSync(msg) });
    assert.match(out.toString(), /Good "git" signature/);
  }));

test("signing key: exactly one file present is bad, and ensure leaves it alone", () =>
  withConfig(async () => {
    const { privateKey, publicKey } = (await ensureSigningKey()).paths;
    rmSync(publicKey);
    const r = await inspectSigningKey();
    assert.equal(r.status, "bad");
    assert.ok(r.status === "bad" && r.message.includes(publicKey) && r.message.endsWith("; fix or remove it by hand (rx never replaces the signing key)"), JSON.stringify(r));
    const msg = await signingKeyError(ensureSigningKey);
    assert.ok(msg.includes(publicKey));
    assert.throws(() => statSync(publicKey), { code: "ENOENT" });
    assert.ok(statSync(privateKey).isFile());
  }));

test("signing key: a public file linked a moment after the private one (a first-run pair race) is ok, not bad", () =>
  withConfig(async () => {
    const { publicKey } = (await ensureSigningKey()).paths;
    const pub = readFileSync(publicKey);
    rmSync(publicKey);
    // Another process's second link lands while rx inspects.
    const later = setTimeout(() => writeFileSync(publicKey, pub), 30);
    try {
      const r = await inspectSigningKey();
      assert.equal(r.status, "ok", JSON.stringify(r));
    } finally {
      clearTimeout(later);
    }
  }));

test("signing key: a passphrase-protected private key is bad, without a prompt", () =>
  withConfig(async () => {
    const { privateKey } = (await ensureSigningKey()).paths;
    execFileSync("ssh-keygen", ["-q", "-p", "-P", "", "-N", "secret", "-f", privateKey]);
    const r = await inspectSigningKey();
    assert.equal(r.status, "bad");
    assert.ok(r.status === "bad" && r.message.includes("is not a usable private key"), JSON.stringify(r));
  }));

test("signing key: a group-readable signing directory names it as the signing key directory", () =>
  withConfig(async () => {
    const { dir } = (await ensureSigningKey()).paths;
    chmodSync(dir, 0o750);
    try {
      const r = await inspectSigningKey();
      assert.ok(r.status === "bad" && r.message.startsWith(`the rx signing key directory ${dir} has mode 0750`), JSON.stringify(r));
    } finally {
      chmodSync(dir, 0o700);
    }
  }));

test("signing key: a symlink is not a regular file", () =>
  withConfig(async (dir) => {
    const { privateKey, publicKey } = (await ensureSigningKey()).paths;
    const real = join(dir, "elsewhere.pub");
    copyFileSync(publicKey, real);
    rmSync(publicKey);
    symlinkSync(real, publicKey);
    const r = await inspectSigningKey();
    assert.equal(r.status, "bad");
    assert.ok(r.status === "bad" && r.message.includes(publicKey) && r.message.includes("not a regular file"), JSON.stringify(r));
    await signingKeyError(ensureSigningKey);
    assert.ok(statSync(privateKey).isFile());
  }));

test("signing key: a private file with a group or other bit is bad and is not chmodded", () =>
  withConfig(async () => {
    const { privateKey } = (await ensureSigningKey()).paths;
    chmodSync(privateKey, 0o644);
    const r = await inspectSigningKey();
    assert.equal(r.status, "bad");
    assert.ok(r.status === "bad" && r.message.includes(privateKey) && r.message.includes("0644"), JSON.stringify(r));
    await signingKeyError(ensureSigningKey);
    assert.equal(mode(privateKey), 0o644);
  }));

test("signing key: a .pub that is not the private key's public form is bad", () =>
  withConfig(async (dir) => {
    const { publicKey } = (await ensureSigningKey()).paths;
    const other = join(dir, "other");
    keygen(other);
    copyFileSync(`${other}.pub`, publicKey);
    const r = await inspectSigningKey();
    assert.equal(r.status, "bad");
    assert.ok(r.status === "bad" && r.message.includes(publicKey) && r.message.includes("does not match"), JSON.stringify(r));
    await signingKeyError(ensureSigningKey);
    assert.equal(readFileSync(publicKey, "utf8"), readFileSync(`${other}.pub`, "utf8"));
  }));

test("signing key: a private file ssh-keygen cannot read is bad", () =>
  withConfig(async () => {
    const { privateKey } = (await ensureSigningKey()).paths;
    writeFileSync(privateKey, "not a key\n");
    chmodSync(privateKey, 0o600);
    const r = await inspectSigningKey();
    assert.equal(r.status, "bad");
    assert.ok(r.status === "bad" && r.message.includes(privateKey) && r.message.endsWith("(rx never replaces the signing key)"), JSON.stringify(r));
  }));

test("signing key: a group-readable raycast-harness directory is bad", () =>
  withConfig(async (dir) => {
    const parent = join(dir, "config", "raycast-harness");
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o755);
    const r = await inspectSigningKey();
    assert.equal(r.status, "bad");
    assert.ok(r.status === "bad" && r.message.includes(parent), JSON.stringify(r));
    const msg = await signingKeyError(ensureSigningKey);
    assert.ok(msg.includes(parent));
    assert.equal(mode(parent), 0o755);
    assert.throws(() => statSync(signingKeyPaths().dir), { code: "ENOENT" });
  }));

/** A fake GitHub serving the authenticated user and their signing keys, in pages. @param {string[][]} pages */
function fakeKeys(pages) {
  return {
    getJson: async (/** @type {string} */ p) => {
      if (p === "user") return { login: "octo-author" };
      throw new Error(`unexpected getJson ${p}`);
    },
    getJsonPages: async (/** @type {string} */ p) => {
      if (p !== "users/octo-author/ssh_signing_keys?per_page=100") throw new Error(`unexpected getJsonPages ${p}`);
      return pages.flat().map((key) => ({ key }));
    },
    getRaw: async () => { throw new Error("unexpected getRaw"); },
    getConditional: async () => { throw new Error("unexpected getConditional"); },
    graphql: async () => { throw new Error("unexpected graphql"); },
    patch: async () => { throw new Error("unexpected patch"); },
  };
}

/** @param {string[][]} pages @param {string} pub */
async function registration(pages, pub) {
  const prev = setTransport(fakeKeys(pages));
  try {
    return await signingKeyRegistration(pub);
  } finally {
    setTransport(prev);
  }
}

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMine";

test("signing key registration: a matching row after a non-matching one is found", async () => {
  const r = await registration([["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther"], [KEY]], KEY);
  assert.deepEqual(r, { login: "octo-author", registered: true });
});

test("signing key registration: absent is not registered", async () => {
  const r = await registration([["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther"], ["ssh-rsa AAAAB3Mine"]], KEY);
  assert.deepEqual(r, { login: "octo-author", registered: false });
});

test("signing key registration: a trailing comment on GitHub's row still matches", async () => {
  const r = await registration([[`${KEY} octo@laptop`]], KEY);
  assert.equal(r.registered, true);
});

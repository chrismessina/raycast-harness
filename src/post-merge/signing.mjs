// `rx post-merge` step 4 (docs/commands.md § rx post-merge, `post-merge-signing`): the rx signing
// key exists (created on first need, never under --dry-run) and is registered on GitHub as the
// authenticated user's signing key. The key itself lives in src/signing-key.mjs.

import { RxError } from "../errors.mjs";
import { git } from "../git.mjs";
import { ensureSigningKey, inspectSigningKey, signingKeyRegistration } from "../signing-key.mjs";

/**
 * @typedef {{ verdict: "PASS" | "FAIL" | "WARN", message: string, details: import("../verdict.mjs").Detail[], goOn: boolean,
 *   data: { path: string, created: boolean, registered: boolean | null }, privateKey: string | null }} SigningOutcome
 *   `goOn` is whether step 5 runs: PASS, or the --dry-run WARN for a key it would create.
 */

/**
 * @param {{ top: string, dryRun: boolean }} o
 * @returns {Promise<SigningOutcome>}
 */
export async function checkSigning({ top, dryRun }) {
  const state = await inspectSigningKey();
  if (state.status === "bad") throw new RxError(state.message, { id: "signing-key" });
  const { privateKey, publicKey: publicKeyPath } = state.paths;
  if (state.status === "missing" && dryRun)
    return { verdict: "WARN", message: `would create the rx signing key at ${privateKey}`, details: [], goOn: true, data: { path: privateKey, created: false, registered: null }, privateKey: null };

  const key = state.status === "ok" ? { ...state, created: false } : await ensureSigningKey();
  const { login, registered } = await signingKeyRegistration(key.publicKey);
  const data = { path: privateKey, created: key.created, registered };
  if (!registered) {
    const email = (await git(["config", "user.email"], { cwd: top, allowFail: true })).stdout.trim() || "<your git user.email>";
    return {
      verdict: "FAIL",
      message: "the rx signing key is not registered on GitHub as a signing key; run these yourself in a terminal (an agent cannot: the first is interactive, and rx guard blocks commands that name the key's path)",
      details: [
        { text: "gh auth refresh -h github.com -s admin:ssh_signing_key" },
        { text: `gh ssh-key add ${publicKeyPath} --type signing --title "rx post-merge signing"` },
        { text: `optional, so git log --show-signature verifies it locally: add "${email} ${key.publicKey}" to the file gpg.ssh.allowedSignersFile names` },
      ],
      goOn: false,
      data,
      privateKey,
    };
  }
  return { verdict: "PASS", message: `signing with ${publicKeyPath} (registered on GitHub as ${login}'s signing key)`, details: [], goOn: true, data, privateKey };
}

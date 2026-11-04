// The tag `ray publish` leaves on the last published commit, shared by `rx scan` (the commit range
// it scans) and `src/fingerprint.mjs` (the `publishRange` field).
//
// The publisher builds its tags from the fork branch name, `ext/<name>`, so the tag is
// `__raycast_latest_publish_ext/<name>__` (verified against real repositories, e.g.
// `__raycast_latest_publish_ext/otty__`; @raycast/api 2.9.0 `dist/commands/publish/index.js`
// builds `"__raycast_latest_publish_" + branch + "__"`). The publisher reads ONLY that tag and logs
// all history when it is absent, so rx does the same: a bare `__raycast_latest_publish__` left by an
// older publisher is never a boundary (it would narrow the scan below what the publisher sends;
// Codex W4 r2 A1). `publishTagCandidates` stays a list so a future publisher form can be added.

import { git } from "./git.mjs";

/** The publisher's current tag for an extension. @param {string} name the package name */
export const publishTag = (name) => `__raycast_latest_publish_ext/${name}__`;

/** The tags that bound the publisher's own log, in order of preference. @param {string} name */
export const publishTagCandidates = (name) => [publishTag(name)];

/**
 * The first candidate tag that resolves to a commit in `root`, with that commit's SHA.
 * @param {string} root
 * @param {string} name
 * @returns {Promise<{ tag: string, sha: string } | null>}
 */
export async function resolvePublishTag(root, name) {
  for (const tag of publishTagCandidates(name)) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], { cwd: root, allowFail: true });
    if (r.code === 0) return { tag, sha: r.stdout.trim() };
  }
  return null;
}

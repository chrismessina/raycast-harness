// `nothingToShip(root, publishedDir)`: is the extension byte-identical to its published copy, over
// what `ray publish` copies (walkPayload applies its skip list)? True right after a merge, when
// there is no change for a CHANGELOG entry to describe. The one rule: any difference at all (a
// path on one side only, a byte, git's executable bit (the owner's, S_IXUSR), a symlink or other non-file entry on either
// side, or an empty payload) → false. A file that cannot be read is false too: identity is never
// assumed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkPayload } from "./commands/stale.mjs";
import { ownerExecutable } from "./util.mjs";

export const NOTHING_TO_SHIP = "nothing to ship: the payload is identical to the published copy";

/**
 * @param {string} root
 * @param {string} publishedDir
 * @returns {boolean}
 */
export function nothingToShip(root, publishedDir) {
  const local = walkPayload(root);
  const published = walkPayload(publishedDir);
  if (local.size === 0 || published.size === 0 || local.size !== published.size) return false;
  for (const [path, l] of local) {
    const p = published.get(path);
    if (!p || l.kind !== "file" || p.kind !== "file" || ownerExecutable(l.mode) !== ownerExecutable(p.mode)) return false;
    if (!sameBytes(join(root, path), join(publishedDir, path))) return false;
  }
  return true;
}

/**
 * Are the two files byte-equal? A file that cannot be read is no proof of identity: false (fail
 * closed), never a throw.
 * @param {string} a @param {string} b
 */
function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

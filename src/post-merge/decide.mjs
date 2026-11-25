// `rx post-merge` step 3, one path at a time (docs/commands.md § rx post-merge, the outcome table):
// read the four local and published sides, check that no filter or conversion applies, and decide
// ALREADY, ADOPT, STAMP or FAIL by the first row that matches. Read only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RxError } from "../errors.mjs";
import { stampProblem } from "../changelog/parse.mjs";
import { PngError, comparePng, decodeRgba, readPngInfo } from "../png.mjs";
import { blobId } from "../upstream.mjs";
import { blobBytes, filteredHash, fsStep, indexSide, repoPathOf, sameSide, sideText, treeSide, workSide } from "./sides.mjs";

/** @typedef {import("./github.mjs").Side} Side */

/**
 * @typedef {{
 *   path: string,
 *   repoPath: string,
 *   outcome: "ADOPT" | "STAMP" | "ALREADY" | "FAIL",
 *   pre: Side | null,
 *   post: Side,
 *   pub: Side | null,
 *   head: Side | null,
 *   index: Side | null,
 *   work: Side | null,
 *   reason: string | null,
 *   hint: string | null,
 *   bytes: Buffer | null,
 *   stamp: { unstamped: string, stamped: string } | null,
 * }} PathPlan
 *   `hint` is a second line of advice for a FAIL (the next step to take), or null.
 *   `bytes` are the canonical `post` bytes from the cache (null when the path FAILed before they
 *   were read). `stamp` is set for a STAMP path: the one heading line to replace on disk.
 */

/**
 * Decide one adoption path.
 * @param {{ top: string, prefix: string, cacheRoot: string | null, name: string }} where
 *   `cacheRoot` is the upstream cache repository, or null when extensions/<name> is not published.
 * @param {import("./github.mjs").RewritePath} p
 * @returns {Promise<PathPlan>}
 */
export async function decidePath({ top, prefix, cacheRoot, name }, { path, pre, post }) {
  const repoPath = repoPathOf(prefix, path);
  const pub = cacheRoot ? await treeSide(cacheRoot, "HEAD", `extensions/${name}/${path}`) : null;
  const head = await treeSide(top, "HEAD", repoPath);
  const { side: index, unmerged } = await indexSide(top, repoPath);
  const { side: work, parentProblem } = workSide(top, repoPath);

  /** @type {PathPlan} */
  const plan = { path, repoPath, outcome: "FAIL", pre, post, pub, head, index, work, reason: null, hint: null, bytes: null, stamp: null };
  /** @param {string} reason @param {string | null} [hint] */
  const fail = (reason, hint = null) => ({ ...plan, outcome: /** @type {const} */ ("FAIL"), reason, hint });

  for (const s of [pre, post, pub, head, index, work]) if (s && s.type !== "file") return fail(`${path} is a ${s.type}; rx adopts only regular files`);
  if (parentProblem) return fail(`${path} cannot be adopted: ${parentProblem}; rx adopts only regular files`);
  if (unmerged) return fail(`${path} has an unmerged index entry; finish the merge first`);
  if (!sameSide(pub, post)) return fail("changed upstream after the merge", "run rx stale, then pull-contributions");

  // The canonical post bytes, from the cache, raw; their hash must be post.
  const bytes = await blobBytes(/** @type {string} */ (cacheRoot), post.blob, "github");
  if (blobId(bytes) !== post.blob) throw new RxError(`the upstream cache's bytes for ${post.blob} do not hash to it`, { id: "github" });
  plan.bytes = bytes;

  // Conversion: no filter or line-ending conversion may apply to this path, on either side.
  const conversion = `${path} has a git filter or line-ending conversion (gitattributes or core.autocrlf); adopt it by hand`;
  if ((await filteredHash(top, repoPath, bytes)) !== post.blob) return fail(conversion);
  /** @type {Buffer | null} */
  const disk = work ? fsStep(`reading ${repoPath}`, () => readFileSync(join(top, repoPath))) : null;
  if (work && disk && (await filteredHash(top, repoPath, disk)) !== work.blob) return fail(conversion);

  if (sameSide(head, post)) return { ...plan, outcome: "ALREADY" };

  const headIsPre = sameSide(head, pre);
  if (headIsPre && ((sameSide(index, pre) && (sameSide(work, pre) || sameSide(work, post))) || (sameSide(index, post) && sameSide(work, post)))) {
    if (/\.png$/i.test(path)) {
      const problem = await pngProblem(top, path, pre, bytes);
      if (problem) return fail(problem);
    }
    return { ...plan, outcome: "ADOPT" };
  }

  if (path === "CHANGELOG.md" && headIsPre && pre && work && disk && work.mode === pre.mode && pre.mode === post.mode) {
    const stamp = await stampOf(top, pre, bytes, disk, path);
    if (stamp) {
      const lines = disk.toString("utf8").split("\n");
      const count = (/** @type {string} */ line) => lines.filter((l) => l === line).length;
      const unstamped = count(stamp.unstamped);
      const stamped = count(stamp.stamped);
      const reRun = stamped === 1 && unstamped === 0;
      if ((sameSide(index, pre) && (unstamped === 1 || reRun)) || (sameSide(index, post) && reRun)) return { ...plan, outcome: "STAMP", stamp };
    }
  }

  return fail(`changed here since the merge: head ${sideText(head)}, index ${sideText(index)}, work ${sideText(work)}; adopt the published file by hand`);
}

/**
 * Is pre → post exactly the {PR_MERGE_DATE} stamp, with all three texts valid UTF-8 (the install
 * rewrites one line of the disk text, so it must round-trip)? The stamp lines, or null.
 * @param {string} top @param {Side} pre @param {Buffer} post @param {Buffer} disk @param {string} path
 */
async function stampOf(top, pre, post, disk, path) {
  const before = await blobBytes(top, pre.blob, "git");
  const texts = [before, post, disk].map((b) => b.toString("utf8"));
  if (![before, post, disk].every((b, i) => Buffer.from(texts[i], "utf8").equals(b))) return null;
  const r = stampProblem(texts[0], texts[1], path);
  if (r.problem !== null || r.unstamped === undefined || r.stamped === undefined) return null;
  return { unstamped: r.unstamped, stamped: r.stamped };
}

/**
 * An ADOPT .png must decode, stay at most 8-bit, and keep pre's size and RGBA pixels. Differing
 * color metadata is expected. The FAIL reason, or null.
 * @param {string} top @param {string} path @param {Side | null} pre @param {Buffer} post
 */
async function pngProblem(top, path, pre, post) {
  const changed = `raycastbot changed the pixels of ${path}`;
  try {
    if (readPngInfo(post).bitDepth > 8) return changed;
    if (!pre) {
      decodeRgba(post);
      return null;
    }
    const before = await blobBytes(top, pre.blob, "git");
    if (readPngInfo(before).bitDepth > 8) return changed;
    return comparePng(before, post).pixelsEqual ? null : changed;
  } catch (e) {
    if (e instanceof PngError) return `${path}: ${e.message}`;
    throw e;
  }
}

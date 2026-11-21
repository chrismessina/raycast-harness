// PNG inspection for `rx png` (docs/commands.md §4.3).
//
//   readPngInfo(buf)   bounds-checked chunk walk: IHDR (width, height, bitDepth, colorType) and the
//                      four color-metadata chunks gAMA, iCCP, sRGB, cHRM as hex strings (null when
//                      absent). Every chunk's length, type and CRC are checked; anything malformed
//                      throws PngError (an RxError with id "png").
//   decodeRgba(buf)    pngjs decode to 8-bit RGBA (`{ width, height, data }`); throws PngError. pngjs's
//                      sync reader does NOT fail on a damaged IDAT (it yields zeroed pixels), so the
//                      IDAT stream is inflated here first and its length checked against IHDR.
//   comparePng(a, b)   "SAME-PIXELS" | "DIFFERENT" | "UNDECIDED" with a reason naming every
//                      difference found (bit depth, metadata chunks, size, pixels), after fully decoding
//                      both files (any decode failure throws before an outcome): UNDECIDED when
//                      either file is 16-bit (decoding to 8 bits merges distinct values) or the
//                      color metadata differs (the same bytes render differently); SAME-PIXELS
//                      needs equal size, equal metadata and byte-equal RGBA. An opaque RGB file
//                      and its RGBA twin with a 255 alpha plane compare SAME-PIXELS: that is the
//                      lossless re-encode Raycast CI performs.
//   crc32, buildChunk, insertChunk   chunk builders, exported for tests that plant metadata.

import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { RxError } from "./errors.mjs";

export class PngError extends RxError {
  /** @param {string} message */
  constructor(message) {
    super(message, { id: "png" });
    this.name = "PngError";
  }
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const META_CHUNKS = /** @type {const} */ (["gAMA", "iCCP", "sRGB", "cHRM"]);

/**
 * @typedef {{
 *   width: number, height: number, bitDepth: number, colorType: number,
 *   gAMA: string | null, iCCP: string | null, sRGB: string | null, cHRM: string | null,
 * }} PngInfo
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 as PNG uses it (over type + data). @param {Buffer} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Walk every chunk with bounds checks. Returns [{ type, data, offset }].
 * @param {Buffer} buf
 */
export function readChunks(buf) {
  if (!Buffer.isBuffer(buf)) throw new PngError("not a buffer");
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new PngError("not a PNG: bad signature");
  /** @type {{ type: string, data: Buffer, offset: number }[]} */
  const chunks = [];
  let off = 8;
  let sawEnd = false;
  while (off < buf.length) {
    if (off + 8 > buf.length) throw new PngError(`truncated chunk header at byte ${off}`);
    const length = buf.readUInt32BE(off);
    if (length > 0x7fffffff) throw new PngError(`chunk at byte ${off} declares an invalid length ${length}`);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError(`chunk at byte ${off} has an invalid type ${JSON.stringify(type)}`);
    const dataStart = off + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new PngError(`chunk ${type} at byte ${off} runs past the end of the file`);
    const expected = buf.readUInt32BE(dataEnd);
    const actual = crc32(buf.subarray(off + 4, dataEnd));
    if (expected !== actual) throw new PngError(`chunk ${type} at byte ${off} has a bad CRC`);
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd), offset: off });
    off = dataEnd + 4;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!chunks.length || chunks[0].type !== "IHDR") throw new PngError("first chunk is not IHDR");
  if (chunks[0].data.length !== 13) throw new PngError(`IHDR has ${chunks[0].data.length} bytes, expected 13`);
  if (!sawEnd) throw new PngError("no IEND chunk: file is truncated");
  return chunks;
}

/**
 * IHDR fields and the color-metadata chunks.
 * @param {Buffer} buf
 * @returns {PngInfo}
 */
export function readPngInfo(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks[0].data;
  /** @type {PngInfo} */
  const info = {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    gAMA: null,
    iCCP: null,
    sRGB: null,
    cHRM: null,
  };
  if (![1, 2, 4, 8, 16].includes(info.bitDepth)) throw new PngError(`IHDR bit depth ${info.bitDepth} is not valid`);
  if (![0, 2, 3, 4, 6].includes(info.colorType)) throw new PngError(`IHDR color type ${info.colorType} is not valid`);
  for (const name of META_CHUNKS) {
    const found = chunks.filter((c) => c.type === name);
    if (found.length > 1) throw new PngError(`${name} appears ${found.length} times`);
    if (found.length) info[name] = found[0].data.toString("hex");
  }
  return info;
}

/**
 * Decode to 8-bit RGBA with pngjs.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, data: Buffer }}
 */
export function decodeRgba(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const expected = expectedRawLength(width, height, ihdr[8], ihdr[9], ihdr[12]);
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  if (!idat.length) throw new PngError("decode failed: no IDAT chunk");
  /** @type {Buffer} */
  let raw;
  try {
    raw = inflateSync(idat);
  } catch (e) {
    throw new PngError(`decode failed: IDAT does not inflate (${/** @type {Error} */ (e).message})`);
  }
  if (raw.length !== expected) throw new PngError(`decode failed: IDAT inflates to ${raw.length} bytes, IHDR implies ${expected}`);
  try {
    const png = PNG.sync.read(buf);
    if (png.width !== width || png.height !== height || png.data.length !== width * height * 4) throw new Error("decoded size does not match IHDR");
    return { width: png.width, height: png.height, data: png.data };
  } catch (e) {
    throw new PngError(`decode failed: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Bytes a PNG's filtered scanlines occupy once inflated: per row one filter byte plus the packed
 * samples; Adam7 interlacing is the sum over its seven passes.
 * @param {number} w @param {number} h @param {number} bitDepth @param {number} colorType @param {number} interlace
 */
export function expectedRawLength(w, h, bitDepth, colorType, interlace) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new PngError(`IHDR color type ${colorType} is not valid`);
  const rowBytes = (/** @type {number} */ pw) => Math.ceil((pw * channels * bitDepth) / 8);
  if (interlace === 0) return h * (1 + rowBytes(w));
  if (interlace !== 1) throw new PngError(`IHDR interlace method ${interlace} is not valid`);
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let total = 0;
  for (const [xs, ys, xstep, ystep] of passes) {
    const pw = Math.ceil(Math.max(0, w - xs) / xstep);
    const ph = Math.ceil(Math.max(0, h - ys) / ystep);
    if (pw > 0 && ph > 0) total += ph * (1 + rowBytes(pw));
  }
  return total;
}

/**
 * `pixelsEqual`: equal size and equal 8-bit RGBA. On UNDECIDED it separates a metadata-only
 * difference (the same image, re-tagged) from a different image that also carries other metadata.
 * @typedef {{ outcome: "SAME-PIXELS" | "DIFFERENT" | "UNDECIDED", reason: string, pixelsEqual: boolean, a: PngInfo, b: PngInfo }} Comparison
 */

/**
 * Compare two PNG files. Throws PngError when either cannot be read or decoded.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Comparison}
 */
export function comparePng(a, b) {
  const ia = readPngInfo(a);
  const ib = readPngInfo(b);
  // Both files are fully decoded before any outcome: a damaged IDAT must surface as an error
  // even when the headers alone would already decide UNDECIDED or DIFFERENT.
  const da = decodeRgba(a);
  const db = decodeRgba(b);
  const sixteen = ia.bitDepth > 8 || ib.bitDepth > 8;
  const differing = META_CHUNKS.filter((k) => ia[k] !== ib[k]);
  const sameSize = ia.width === ib.width && ia.height === ib.height;
  /** @type {string[]} */
  const diffs = [];
  if (sixteen) diffs.push(`16-bit PNG (bit depth ${ia.bitDepth} vs ${ib.bitDepth})`);
  if (differing.length) diffs.push(`color metadata differs: ${differing.join(", ")}`);
  const pixelsEqual = sameSize && da.data.equals(db.data);
  if (!sameSize) diffs.push(`size ${ia.width}x${ia.height} vs ${ib.width}x${ib.height}`);
  else if (!pixelsEqual) diffs.push("RGBA pixels differ");
  if (sixteen || differing.length) return { outcome: "UNDECIDED", reason: `${diffs.join("; ")}; compare by eye`, pixelsEqual, a: ia, b: ib };
  if (diffs.length) return { outcome: "DIFFERENT", reason: diffs.join("; "), pixelsEqual, a: ia, b: ib };
  return { outcome: "SAME-PIXELS", reason: "equal size, RGBA pixels and color metadata", pixelsEqual, a: ia, b: ib };
}

/**
 * Build one chunk (length + type + data + CRC).
 * @param {string} type four ASCII letters
 * @param {Buffer} data
 */
export function buildChunk(type, data) {
  if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError(`invalid chunk type ${JSON.stringify(type)}`);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Return a copy of `buf` with `chunk` inserted right after IHDR (where the color chunks belong).
 * @param {Buffer} buf a valid PNG
 * @param {Buffer} chunk from buildChunk
 */
export function insertChunk(buf, chunk) {
  const chunks = readChunks(buf);
  const ihdrEnd = chunks[0].offset + 8 + chunks[0].data.length + 4;
  return Buffer.concat([buf.subarray(0, ihdrEnd), chunk, buf.subarray(ihdrEnd)]);
}

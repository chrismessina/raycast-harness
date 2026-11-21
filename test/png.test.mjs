import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import * as zlib from "node:zlib";
import * as pngLib from "../src/png.mjs";
import { PngError, buildChunk, comparePng, crc32, decodeRgba, expectedRawLength, insertChunk, readPngInfo } from "../src/png.mjs";
import { extractFirstFile, pngTargets } from "../src/commands/png.mjs";
import { REPO, fakeExtension, rx, withTempDir } from "./helpers.mjs";

const FIXTURE = join(REPO, "test", "fixtures", "png", "triage");

/**
 * A pngjs-encoded image. `pixel` is [r, g, b, a]; `colorType` 6 (RGBA, default) or 2 (RGB);
 * `bitDepth` 8 (default) or 16; `gamma` adds a gAMA chunk.
 * @param {{ w?: number, h?: number, pixel?: number[], colorType?: 2 | 6, bitDepth?: 8 | 16, gamma?: number, vary?: boolean }} [o]
 */
function png(o = {}) {
  const w = o.w ?? 4;
  const h = o.h ?? 3;
  const p = new PNG({ width: w, height: h });
  const [r, g, b, a] = o.pixel ?? [200, 100, 50, 255];
  for (let i = 0; i < w * h; i++) {
    p.data[i * 4] = o.vary ? (r + i) & 0xff : r;
    p.data[i * 4 + 1] = g;
    p.data[i * 4 + 2] = b;
    p.data[i * 4 + 3] = a;
  }
  if (o.gamma) p.gamma = o.gamma;
  return PNG.sync.write(p, { colorType: o.colorType ?? 6, bitDepth: o.bitDepth ?? 8 });
}

/** @param {string} dir */
function gitInit(dir) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}
/** @param {string} dir @param {string} msg */
function gitCommit(dir, msg) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

// ---- src/png.mjs -------------------------------------------------------------------------

test("readPngInfo reads IHDR and reports every metadata chunk as absent on a bare file", () => {
  const info = readPngInfo(png());
  assert.deepEqual(info, { width: 4, height: 3, bitDepth: 8, colorType: 6, gAMA: null, iCCP: null, sRGB: null, cHRM: null });
  assert.equal(readPngInfo(png({ colorType: 2 })).colorType, 2);
  assert.equal(readPngInfo(png({ bitDepth: 16 })).bitDepth, 16);
});

test("each metadata chunk independently: present vs missing flips the comparison to UNDECIDED", () => {
  const base = png();
  const chunks = {
    gAMA: buildChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
    iCCP: buildChunk("iCCP", Buffer.concat([Buffer.from("test\0\0", "latin1"), Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])])),
    sRGB: buildChunk("sRGB", Buffer.from([0])),
    cHRM: buildChunk("cHRM", Buffer.alloc(32, 1)),
  };
  for (const [name, chunk] of Object.entries(chunks)) {
    const withChunk = insertChunk(base, chunk);
    const info = readPngInfo(withChunk);
    for (const other of ["gAMA", "iCCP", "sRGB", "cHRM"]) {
      if (other === name) assert.equal(info[other], chunk.subarray(8, chunk.length - 4).toString("hex"), `${name} bytes`);
      else assert.equal(info[other], null, `${other} absent when only ${name} planted`);
    }
    const cmp = comparePng(base, withChunk);
    assert.equal(cmp.outcome, "UNDECIDED", name);
    assert.match(cmp.reason, new RegExp(`metadata differs: ${name}`));
    // Both carrying the same chunk compares SAME-PIXELS again.
    assert.equal(comparePng(withChunk, Buffer.from(withChunk)).outcome, "SAME-PIXELS", `${name} on both`);
    // Same chunk, different bytes: still UNDECIDED.
    const altered = Buffer.from(chunk);
    altered[8] ^= 0x55;
    altered.writeUInt32BE(crc32(altered.subarray(4, altered.length - 4)), altered.length - 4);
    assert.equal(comparePng(withChunk, insertChunk(base, altered)).outcome, "UNDECIDED", `${name} differing bytes`);
  }
  // pngjs's own gAMA writer agrees with the hand-built chunk reader.
  assert.equal(readPngInfo(png({ gamma: 0.45455 })).gAMA, "0000b18f");
});

test("corrupt input is a PngError, never a verdict", () => {
  const good = png();
  assert.throws(() => readPngInfo(Buffer.from("not a png at all")), PngError);
  assert.throws(() => readPngInfo(good.subarray(0, good.length - 6)), (e) => e instanceof PngError && /truncated|IEND|runs past/.test(e.message));
  const badCrc = Buffer.from(good);
  badCrc[badCrc.length - 1] ^= 0xff; // IEND CRC
  assert.throws(() => readPngInfo(badCrc), (e) => e instanceof PngError && /bad CRC/.test(e.message));
  const hugeLength = Buffer.from(good);
  hugeLength.writeUInt32BE(0x7fffffff, 8);
  assert.throws(() => readPngInfo(hugeLength), (e) => e instanceof PngError && /runs past/.test(e.message));
  const notIhdr = Buffer.concat([good.subarray(0, 8), buildChunk("sRGB", Buffer.from([0])), good.subarray(8)]);
  assert.throws(() => readPngInfo(notIhdr), (e) => e instanceof PngError && /first chunk is not IHDR/.test(e.message));
  assert.throws(() => comparePng(good, badCrc), PngError);
  assert.throws(() => decodeRgba(Buffer.from("x")), PngError);
  assert.equal(/** @type {PngError} */ (new PngError("x")).id, "png");
});

test("changed transparency is DIFFERENT; RGB and its opaque RGBA twin are SAME-PIXELS; 16-bit is UNDECIDED", () => {
  const rgba = png({ pixel: [10, 20, 30, 255] });
  const rgb = png({ pixel: [10, 20, 30, 255], colorType: 2 });
  assert.equal(readPngInfo(rgb).colorType, 2);
  assert.equal(comparePng(rgba, rgb).outcome, "SAME-PIXELS", "CI's lossless RGBA->RGB re-encode");
  const translucent = png({ pixel: [10, 20, 30, 128] });
  const t = comparePng(rgba, translucent);
  assert.equal(t.outcome, "DIFFERENT");
  assert.match(t.reason, /RGBA pixels differ/);
  assert.equal(comparePng(rgba, png({ pixel: [10, 20, 31, 255] })).outcome, "DIFFERENT");
  assert.equal(comparePng(rgba, png({ pixel: [10, 20, 30, 255], w: 5 })).outcome, "DIFFERENT");
  const sixteen = png({ bitDepth: 16 });
  const u = comparePng(rgba, sixteen);
  assert.equal(u.outcome, "UNDECIDED");
  assert.match(u.reason, /16-bit/);
  assert.equal(comparePng(sixteen, Buffer.from(sixteen)).outcome, "UNDECIDED", "two 16-bit files are never auto-decided");
});

/** A PNG whose chunk structure is intact (CRCs valid) but whose IDAT does not inflate. @param {Buffer} good */
function damageIdat(good) {
  const { readChunks } = /** @type {typeof import("../src/png.mjs")} */ (pngLib);
  const chunks = readChunks(good);
  const parts = [good.subarray(0, 8)];
  for (const c of chunks) parts.push(c.type === "IDAT" ? buildChunk("IDAT", Buffer.from([0xff, 0xff, 0x00, 0x01, 0x02, 0x03])) : buildChunk(c.type, Buffer.from(c.data)));
  return Buffer.concat(parts);
}

test("a damaged IDAT with intact chunks passes the chunk reader but fails the decode, and comparePng fails before any outcome", () => {
  const bad = damageIdat(png());
  assert.doesNotThrow(() => readPngInfo(bad));
  assert.throws(() => decodeRgba(bad), PngError);
  assert.throws(() => comparePng(png({ w: 9 }), bad), PngError, "different dimensions do not short-circuit to DIFFERENT");
  assert.throws(() => comparePng(png({ bitDepth: 16 }), bad), PngError, "16-bit does not short-circuit to UNDECIDED");
  assert.throws(() => comparePng(bad, png()), PngError);
  // Valid zlib, wrong length: pngjs would pad with zeros and say nothing.
  const { deflateSync } = /** @type {typeof import("node:zlib")} */ (zlib);
  const short = Buffer.concat([png().subarray(0, 8), ...pngLib.readChunks(png()).map((c) => (c.type === "IDAT" ? buildChunk("IDAT", deflateSync(Buffer.alloc(7))) : buildChunk(c.type, Buffer.from(c.data))))]);
  assert.throws(() => decodeRgba(short), (e) => e instanceof PngError && /inflates to 7 bytes, IHDR implies 51/.test(e.message));
  assert.equal(expectedRawLength(4, 3, 8, 6, 0), 3 * (1 + 16));
  assert.equal(expectedRawLength(8, 8, 8, 6, 1), 271, "Adam7: 5+5+9+18+34+68+132");
  assert.equal(expectedRawLength(5, 1, 1, 0, 0), 2, "1-bit grayscale packs 5 pixels into one byte");
  assert.throws(() => expectedRawLength(1, 1, 8, 5, 0), PngError);
});

test("extractFirstFile reads the regular file out of a pax/ustar archive and ignores headers and directories", () => {
  const header = (/** @type {string} */ name, /** @type {number} */ size, /** @type {string} */ type) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, "latin1");
    h.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
    h[156] = type.charCodeAt(0);
    return h;
  };
  const pad = (/** @type {Buffer} */ b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const payload = Buffer.from("hello blob");
  const tar = Buffer.concat([header("pax_global_header", 3, "g"), pad(Buffer.from("abc")), header("metadata/", 0, "5"), header("metadata/x.png", payload.length, "0"), pad(payload), Buffer.alloc(1024)]);
  assert.equal(extractFirstFile(tar)?.toString(), "hello blob");
  assert.equal(extractFirstFile(Buffer.alloc(1024)), null);
});

// ---- rx png ---------------------------------------------------------------------------------

test("pngTargets: every PNG under metadata/ plus the icons package.json names, sorted", async () => {
  await withTempDir((dir) => {
    const ext = fakeExtension(dir, "ext", { icon: "icon.png", commands: [{ name: "a", title: "A", mode: "view", icon: "cmd.png" }], tools: [{ name: "t", icon: "tool.svg" }] });
    mkdirSync(join(ext, "metadata", "nested"), { recursive: true });
    mkdirSync(join(ext, "assets"));
    writeFileSync(join(ext, "metadata", "b-2.png"), png());
    writeFileSync(join(ext, "metadata", "a-1.PNG"), png());
    writeFileSync(join(ext, "metadata", "nested", "c.png"), png());
    writeFileSync(join(ext, "metadata", "notes.txt"), "x");
    writeFileSync(join(ext, "assets", "icon.png"), png());
    writeFileSync(join(ext, "assets", "cmd.png"), png());
    assert.deepEqual(pngTargets(ext), ["assets/cmd.png", "assets/icon.png", "metadata/a-1.PNG", "metadata/b-2.png", "metadata/nested/c.png"]);
  });
});

test("rx png without --published: every file LOCAL-ONLY as N/A keep local; nothing on disk changes", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "metadata"));
    const bytes = png();
    writeFileSync(join(ext, "metadata", "shot-1.png"), bytes);
    const r = await rx(["png", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.results.length, 1);
    assert.equal(r.json.results[0].verdict, "N/A");
    assert.match(r.json.results[0].message, /LOCAL-ONLY, keep local/);
    assert.equal(r.json.results[0].details[0].text, "LOCAL-ONLY keep local");
    assert.equal(r.json.data.published, false);
    assert.equal(r.json.data.files[0].outcome, "LOCAL-ONLY");
    assert.equal(r.json.data.files[0].local.width, 4);
    assert.ok(readFileSync(join(ext, "metadata", "shot-1.png")).equals(bytes), "read-only");
  });
});

test("rx png: no PNG at all is N/A with a reason; a bad --published is ERROR; a corrupt file is ERROR png", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    let r = await rx(["png", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(r.json.results[0].verdict, "N/A");
    assert.match(r.json.results[0].message, /no PNG/);

    r = await rx(["png", "--root", ext, "--published", join(dir, "nope"), "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].id, "png");
    assert.equal(r.json.results[0].verdict, "ERROR");

    mkdirSync(join(ext, "metadata"));
    writeFileSync(join(ext, "metadata", "bad-1.png"), Buffer.from("\x89PNG\r\n\x1a\nnot really"));
    r = await rx(["png", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.equal(r.json.results[0].verdict, "ERROR");
    assert.equal(r.json.results[0].id, "png");
    assert.equal(r.json.data.files[0].outcome, "ERROR");
    assert.deepEqual(Object.keys(r.json.data.files[0]).sort(), ["baseline", "local", "localHash", "outcome", "path", "provenance", "published"]);
    assert.match(r.json.data.files[0].localHash, /^sha256:[0-9a-f]{64}$/, "hash of the bytes even when they do not parse");

    // A damaged IDAT is ERROR with no published twin (never LOCAL-ONLY) and with a published twin
    // of other dimensions (never DIFFERENT / NOT-YOURS).
    writeFileSync(join(ext, "metadata", "bad-1.png"), damageIdat(png()));
    r = await rx(["png", "--root", ext, "--json"], { cwd: dir });
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.data.files[0].outcome, "ERROR");
    assert.match(r.json.results[0].message, /decode failed/);
    mkdirSync(join(dir, "pub", "metadata"), { recursive: true });
    writeFileSync(join(dir, "pub", "metadata", "bad-1.png"), png({ w: 9 }));
    r = await rx(["png", "--root", ext, "--published", join(dir, "pub"), "--json"], { cwd: dir });
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.data.files[0].outcome, "ERROR");
    // and a damaged PUBLISHED twin is ERROR too, not NOT-YOURS
    writeFileSync(join(ext, "metadata", "bad-1.png"), png());
    writeFileSync(join(dir, "pub", "metadata", "bad-1.png"), damageIdat(png({ w: 9 })));
    r = await rx(["png", "--root", ext, "--published", join(dir, "pub"), "--json"], { cwd: dir });
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.data.files[0].outcome, "ERROR");
    assert.match(r.json.results[0].message, /published copy decode failed/);
  });
});

test("rx png with a published twin: the fixture's eight outcomes map to the contract's verdicts", async () => {
  await withTempDir(async (dir) => {
    const expected = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8"));
    const ext = join(dir, "ext");
    cpSync(FIXTURE, ext, { recursive: true });
    const pub = join(dir, "published", "metadata");
    mkdirSync(pub, { recursive: true });
    mkdirSync(join(dir, "published", "assets"));
    gitInit(ext);

    const shot = png({ pixel: [1, 2, 3, 255], vary: true });
    // SAME-PIXELS: published is the CI re-encode (RGB) of the local RGBA shot.
    writeFileSync(join(ext, "metadata", "same-1.png"), shot);
    writeFileSync(join(pub, "same-1.png"), png({ pixel: [1, 2, 3, 255], vary: true, colorType: 2 }));
    // UNDECIDED: same pixels, differing color metadata (gAMA).
    writeFileSync(join(ext, "metadata", "undecided-2.png"), png({ gamma: 0.45455 }));
    writeFileSync(join(pub, "undecided-2.png"), png());
    // OLDER-SHOT: commit the old shot first, publish it, then replace locally.
    const old = png({ pixel: [9, 9, 9, 255] });
    writeFileSync(join(ext, "metadata", "older-3.png"), old);
    writeFileSync(join(pub, "older-3.png"), png({ pixel: [9, 9, 9, 255], colorType: 2 }));
    // NOT-YOURS: published never existed in this history.
    writeFileSync(join(ext, "metadata", "notyours-4.png"), png({ pixel: [5, 5, 5, 255] }));
    writeFileSync(join(pub, "notyours-4.png"), png({ pixel: [6, 6, 6, 255] }));
    // LOCAL-ONLY: no published copy.
    writeFileSync(join(ext, "metadata", "local-5.png"), png());
    // 16-BIT: a 16-bit local shot with no published copy still fails (it never reaches a comparison).
    writeFileSync(join(ext, "metadata", "deep-6.png"), png({ bitDepth: 16 }));
    // icons: top-level icon SAME-PIXELS, command icon LOCAL-ONLY
    writeFileSync(join(ext, "assets", "icon.png"), png({ pixel: [7, 7, 7, 255] }));
    writeFileSync(join(dir, "published", "assets", "icon.png"), png({ pixel: [7, 7, 7, 255] }));
    writeFileSync(join(ext, "assets", "command.png"), png());
    const baseline = gitCommit(ext, "initial shots");
    writeFileSync(join(ext, "metadata", "older-3.png"), png({ pixel: [8, 8, 8, 255] }));
    gitCommit(ext, "replace shot 3");

    const r = await rx(["png", "--root", ext, "--published", join(dir, "published"), "--json"], { cwd: dir });
    assert.equal(r.code, expected.exit, r.stdout);
    assert.ok(!r.json.results.some((/** @type {any} */ x) => x.id === "protocol"), "no undeclared ids");
    assert.ok(r.json.results.every((/** @type {any} */ x) => x.id === "png"));
    const byPath = Object.fromEntries(r.json.data.files.map((/** @type {any} */ f) => [f.path, f]));
    const resultByPath = Object.fromEntries(r.json.results.map((/** @type {any} */ x) => [x.details[0].file, x]));
    for (const [path, exp] of Object.entries(expected.outcomes)) {
      assert.equal(byPath[path]?.outcome, /** @type {any} */ (exp).outcome, path);
      assert.equal(resultByPath[path]?.verdict, /** @type {any} */ (exp).verdict, `${path}: ${JSON.stringify(resultByPath[path])}`);
      assert.ok(resultByPath[path].details[0].text.startsWith(/** @type {any} */ (exp).outcome), `details[0].text leads with the outcome for ${path}`);
    }
    assert.equal(byPath["metadata/older-3.png"].provenance, baseline);
    assert.equal(byPath["metadata/older-3.png"].baseline, baseline, "structured baseline on the row");
    for (const f of r.json.data.files) {
      assert.deepEqual(Object.keys(f).sort(), ["baseline", "local", "localHash", "outcome", "path", "provenance", "published"], f.path);
      assert.match(f.localHash, /^sha256:[0-9a-f]{64}$/, f.path);
      if (f.outcome !== "OLDER-SHOT" && f.outcome !== "UNDECIDED") assert.equal(f.baseline, null, f.path);
    }
    assert.equal(byPath["metadata/notyours-4.png"].baseline, null);
    // UNDECIDED: the baseline pins the exact published bytes that were compared by eye; no provenance.
    const undecided = byPath["metadata/undecided-2.png"];
    const pubHash = `sha256:${createHash("sha256").update(readFileSync(join(pub, "undecided-2.png"))).digest("hex")}`;
    assert.equal(undecided.baseline, pubHash, "UNDECIDED baseline is the sha256 of the published bytes");
    assert.equal(undecided.provenance, null);
    const undecidedResult = resultByPath["metadata/undecided-2.png"];
    assert.match(undecidedResult.message, /^metadata\/undecided-2\.png: UNDECIDED; .*; compare by eye, then record an audit disposition$/);
    assert.equal(undecidedResult.details[1].text, `disposition needs: path=metadata/undecided-2.png localHash=${undecided.localHash} baseline=${pubHash}`);
    assert.match(resultByPath["metadata/older-3.png"].details[1].text, new RegExp(`path=metadata/older-3.png localHash=sha256:[0-9a-f]{64} baseline=${baseline}`));
    assert.ok(resultByPath["metadata/older-3.png"].details[1].text.includes(byPath["metadata/older-3.png"].localHash), "prose and structured hash agree");
    assert.equal(byPath["metadata/notyours-4.png"].provenance, null);
    assert.equal(byPath["metadata/same-1.png"].published.colorType, 2);
    assert.equal(byPath["metadata/same-1.png"].local.colorType, 6);
    assert.equal(byPath["metadata/local-5.png"].published, null);
    assert.equal(r.json.data.published, true);
    // read-only: the local shot that differs is untouched
    assert.ok(readFileSync(join(ext, "metadata", "older-3.png")).equals(png({ pixel: [8, 8, 8, 255] })));
  });
});

test("rx png: a 16-bit local shot FAILs with the conversion command, with or without a published copy", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "metadata"));
    mkdirSync(join(dir, "pub", "metadata"), { recursive: true });
    writeFileSync(join(ext, "metadata", "paired-1.png"), png({ bitDepth: 16 }));
    writeFileSync(join(dir, "pub", "metadata", "paired-1.png"), png());
    writeFileSync(join(ext, "metadata", "alone-2.png"), png({ bitDepth: 16 }));
    const r = await rx(["png", "--root", ext, "--published", join(dir, "pub"), "--json"], { cwd: dir });
    assert.equal(r.code, 1, r.stdout);
    for (const path of ["metadata/paired-1.png", "metadata/alone-2.png"]) {
      const f = r.json.data.files.find((/** @type {any} */ x) => x.path === path);
      const res = r.json.results.find((/** @type {any} */ x) => x.details[0].file === path);
      assert.equal(f.outcome, "16-BIT", path);
      assert.equal(res.verdict, "FAIL", path);
      assert.equal(res.details[0].text, "16-BIT convert to 8-bit", path);
      const abs = `'${join(ext, path)}'`;
      assert.ok(res.message.includes(`magick ${abs} -depth 8 ${abs}`), res.message);
    }
    // read-only: the 16-bit file is untouched
    assert.ok(readFileSync(join(ext, "metadata", "alone-2.png")).equals(png({ bitDepth: 16 })));
  });
});

test("rx png: differing metadata alone is UNDECIDED even with identical pixels", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "metadata"));
    mkdirSync(join(dir, "pub", "metadata"), { recursive: true });
    writeFileSync(join(ext, "metadata", "s-1.png"), png({ gamma: 0.45455 }));
    writeFileSync(join(dir, "pub", "metadata", "s-1.png"), png());
    const r = await rx(["png", "--root", ext, "--published", join(dir, "pub"), "--json"], { cwd: dir });
    assert.equal(r.code, 0, "UNDECIDED is a WARN: a human compares by eye and records a disposition");
    assert.equal(r.json.data.files[0].outcome, "UNDECIDED");
    assert.equal(r.json.results[0].verdict, "WARN");
    assert.match(r.json.results[0].message, /metadata differs: gAMA/);
  });
});

test("rx png: a --published dir inside the upstream cache is read under the cache lock; a foreign holder → ERROR github; a dir elsewhere needs no lock", async () => {
  const { _setUpstreamForTests, upstreamDir } = await import("../src/upstream.mjs");
  await withTempDir(async (dir) => {
    const savedXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    _setUpstreamForTests({ lockWaitMs: 150, lockStaleMs: 60_000 });
    try {
      const ext = fakeExtension(dir, "ext");
      mkdirSync(join(ext, "metadata"));
      writeFileSync(join(ext, "metadata", "s-1.png"), png());
      const inCache = join(upstreamDir(), "extensions", "ext");
      mkdirSync(join(inCache, "metadata"), { recursive: true });
      writeFileSync(join(inCache, "metadata", "s-1.png"), png());
      const elsewhere = join(dir, "pub");
      mkdirSync(join(elsewhere, "metadata"), { recursive: true });
      writeFileSync(join(elsewhere, "metadata", "s-1.png"), png());

      let r = await rx(["png", "--root", ext, "--published", inCache, "--json"], { cwd: dir });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.json.data.files[0].outcome, "SAME-PIXELS");
      assert.ok(!existsSync(join(upstreamDir(), ".rx-lock")), "lock released");

      mkdirSync(join(upstreamDir(), ".rx-lock")); // a foreign rx holds the lock
      r = await rx(["png", "--root", ext, "--published", inCache, "--json"], { cwd: dir });
      assert.equal(r.code, 2, r.stdout);
      assert.equal(r.json.results[0].id, "github");
      assert.equal(r.json.results[0].verdict, "ERROR");
      assert.match(r.json.results[0].message, /upstream cache lock/);
      assert.ok(existsSync(join(upstreamDir(), ".rx-lock")), "the foreign lock is left alone");

      r = await rx(["png", "--root", ext, "--published", elsewhere, "--json"], { cwd: dir });
      assert.equal(r.code, 0, "a published dir outside the cache does not take the lock: " + r.stdout);
      assert.equal(r.json.data.files[0].outcome, "SAME-PIXELS");
    } finally {
      _setUpstreamForTests({ lockWaitMs: null, lockStaleMs: null });
      if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedXdg;
    }
  });
});

test("rx png: pixels differ outside a git work tree is ERROR (provenance cannot run), never a guess", async () => {
  await withTempDir(async (dir) => {
    const ext = fakeExtension(dir, "ext");
    mkdirSync(join(ext, "metadata"));
    mkdirSync(join(dir, "pub", "metadata"), { recursive: true });
    writeFileSync(join(ext, "metadata", "s-1.png"), png({ pixel: [1, 1, 1, 255] }));
    writeFileSync(join(dir, "pub", "metadata", "s-1.png"), png({ pixel: [2, 2, 2, 255] }));
    const r = await rx(["png", "--root", ext, "--published", join(dir, "pub"), "--json"], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } });
    assert.equal(r.code, 2, r.stdout);
    assert.equal(r.json.results[0].verdict, "ERROR");
    assert.match(r.json.results[0].message, /not a git work tree/);
  });
});

test("N1/N3 (gate): rx png with an external --published dir on a machine with no upstream cache compares cleanly and creates no cache directory", async () => {
  await withTempDir(async (dir) => {
    const savedXdg = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    try {
      const ext = fakeExtension(dir, "ext");
      mkdirSync(join(ext, "metadata"));
      writeFileSync(join(ext, "metadata", "s-1.png"), png());
      const elsewhere = join(dir, "pub");
      mkdirSync(join(elsewhere, "metadata"), { recursive: true });
      writeFileSync(join(elsewhere, "metadata", "s-1.png"), png());
      const r = await rx(["png", "--root", ext, "--published", elsewhere, "--json"], { cwd: dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.json.data.files[0].outcome, "SAME-PIXELS");
      assert.ok(!existsSync(join(dir, "cache")), "a read-only command must not create the cache directory");
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedXdg;
    }
  });
});

test("comparePng lists every difference it found (metadata chunks, size, pixels); the outcome is unchanged", () => {
  const iccp = buildChunk("iCCP", Buffer.concat([Buffer.from("test\0\0", "latin1"), Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])]));
  const gama = buildChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
  const base = png({ vary: true });
  // A flipped shot that also gained an ICC profile (what sips does): both differences are named.
  const flipped = insertChunk(png({ vary: true, pixel: [201, 100, 50, 255] }), iccp);
  const a = comparePng(base, flipped);
  assert.equal(a.outcome, "UNDECIDED");
  assert.equal(a.reason, "color metadata differs: iCCP; RGBA pixels differ; compare by eye");
  // Two chunks and a size change.
  const b = comparePng(base, insertChunk(insertChunk(png({ w: 5 }), iccp), gama));
  assert.equal(b.outcome, "UNDECIDED");
  assert.equal(b.reason, "color metadata differs: gAMA, iCCP; size 4x3 vs 5x3; compare by eye");
  // Without metadata differences the outcome is DIFFERENT and the reason as before.
  assert.deepEqual([comparePng(base, png({ w: 5 })).outcome, comparePng(base, png({ w: 5 })).reason], ["DIFFERENT", "size 4x3 vs 5x3"]);
  assert.deepEqual([comparePng(base, png({ vary: true, pixel: [9, 9, 9, 255] })).outcome, comparePng(base, png({ vary: true, pixel: [9, 9, 9, 255] })).reason], ["DIFFERENT", "RGBA pixels differ"]);
  // 16-bit with different pixels names both.
  const c = comparePng(png({ bitDepth: 16 }), png({ bitDepth: 16, pixel: [9, 9, 9, 255] }));
  assert.equal(c.outcome, "UNDECIDED");
  assert.equal(c.reason, "16-bit PNG (bit depth 16 vs 16); RGBA pixels differ; compare by eye");
});

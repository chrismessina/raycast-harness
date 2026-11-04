#!/usr/bin/env node
// Phase 2 equivalence: run the legacy plugin preflight and `rx preflight --preset legacy-compat`
// over every extension checkout matching ~/Developer/GitHub/chrismessina/raycast-* and over the
// checked-in fixtures, normalize both to (id, severity, file, line), and report every legacy
// finding rx does not reproduce. Exit 1 when any finding is lost that test/port-exceptions.json
// does not name exactly, or when any root could not be fully inspected (either side failed to run,
// printed something other than JSON, or rx reported an ERROR).
//
//   node scripts/compare-preflight.mjs [--legacy <preflight.mjs>] [--roots <dir>] [--only <name>]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/exec.mjs";
import { isExtensionDir } from "../src/root.mjs";

const RX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, /** @type {string} */ dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; };
const legacy = resolve(flag("--legacy", join(homedir(), "Developer", "GitHub", "chrismessina", "raycast-extensions-skills-harness", "plugins", "raycast-extensions", "scripts", "preflight.mjs")));
const rootsDir = resolve(flag("--roots", join(homedir(), "Developer", "GitHub", "chrismessina")));
const only = flag("--only", "");
const preset = join(RX, "test", "fixtures", "presets", "legacy-compat.json");
/** @type {{ split: Record<string, { when: string, id: string }[]>, knownLost: { root: string, id: string, message: string, file: string | null }[] }} */
const exceptions = JSON.parse(readFileSync(join(RX, "test", "port-exceptions.json"), "utf8"));

if (!existsSync(legacy)) { console.error(`legacy preflight not found at ${legacy}`); process.exit(2); }

/** @type {string[]} */
const roots = [];
for (const name of readdirSync(rootsDir).sort()) {
  if (!name.startsWith("raycast-")) continue;
  const dir = join(rootsDir, name);
  if (isExtensionDir(dir)) roots.push(dir);
}
for (const base of ["extensions", "real"]) {
  const d = join(RX, "test", "fixtures", base);
  if (!existsSync(d)) continue;
  for (const name of readdirSync(d).sort()) if (isExtensionDir(join(d, name))) roots.push(join(d, name));
}

const RANK = { WARN: 1, FAIL: 2 };
/** The rx id one legacy sub-finding maps to. @param {string} legacyId @param {string} sub */
const targetId = (legacyId, sub) => exceptions.split[legacyId]?.find((s) => new RegExp(s.when).test(sub))?.id ?? legacyId;

let lostTotal = 0;
let legacyTotal = 0;
let newExtraTotal = 0;
let failures = 0;
let inspected = 0;
for (const root of roots) {
  if (only && !root.endsWith(only)) continue;
  const name = root.startsWith(RX) ? `fixture ${root.slice(RX.length + 1)}` : root.replace(homedir(), "~");
  let l, n;
  try {
    l = await run(process.execPath, [legacy, "--json"], { cwd: root, timeoutMs: 120_000 });
    n = await run(process.execPath, [join(RX, "bin", "rx.mjs"), "preflight", "--root", root, "--preset", preset, "--json"], { cwd: RX, timeoutMs: 120_000 });
  } catch (e) {
    failures++;
    console.log(`FAILED ${name}: could not run a side: ${/** @type {Error} */ (e).message}`);
    continue;
  }
  /** @type {{ id: string, level: string, message: string, where: string[] }[]} */
  let legacyFindings;
  /** @type {any} */
  let envelope;
  try { legacyFindings = JSON.parse(l.stdout); if (!Array.isArray(legacyFindings)) throw new Error("not an array"); } catch {
    failures++;
    console.log(`FAILED ${name}: legacy produced no JSON (exit ${l.code}): ${l.stderr.trim().split("\n")[0] ?? ""}`);
    continue;
  }
  try { envelope = JSON.parse(n.stdout); if (!Array.isArray(envelope?.results)) throw new Error("no results"); } catch {
    failures++;
    console.log(`FAILED ${name}: rx produced no JSON envelope (exit ${n.code}): ${n.stderr.trim().split("\n")[0] ?? ""}`);
    continue;
  }
  if (envelope.exit === 2) {
    failures++;
    console.log(`FAILED ${name}: rx reported ERROR: ${envelope.results.filter((/** @type {any} */ r) => r.verdict === "ERROR").map((/** @type {any} */ r) => `${r.id} ${r.message}`).join("; ")}`);
    continue;
  }
  // Shapes and exit statuses must agree with the findings on both sides; any inconsistency means
  // the root was not fully inspected.
  /** @type {string[]} */
  const inconsistent = [];
  const legacyShapeOk = legacyFindings.every((f) => f && typeof f.id === "string" && (f.level === "fail" || f.level === "warn") && typeof f.message === "string" && Array.isArray(f.where ?? []));
  if (!legacyShapeOk) inconsistent.push("legacy findings have an unexpected shape");
  const legacyExpectedExit = legacyFindings.some((f) => f.level === "fail") ? 1 : 0;
  if (l.code !== legacyExpectedExit) inconsistent.push(`legacy exited ${l.code} but its findings imply ${legacyExpectedExit}`);
  if (envelope.command !== "preflight") inconsistent.push(`rx envelope is for ${JSON.stringify(envelope.command)}, not preflight`);
  if (!envelope.results.length) inconsistent.push("rx envelope has no results");
  const rxShapeOk = envelope.results.every((/** @type {any} */ r) => r && typeof r.id === "string" && ["PASS", "FAIL", "WARN", "N/A", "ERROR"].includes(r.verdict) && typeof r.message === "string" && Array.isArray(r.details));
  if (!rxShapeOk) inconsistent.push("rx results have an unexpected shape");
  const rxImpliedExit = envelope.results.some((/** @type {any} */ r) => r.verdict === "ERROR") ? 2 : envelope.results.some((/** @type {any} */ r) => r.verdict === "FAIL") ? 1 : 0;
  if (envelope.exit !== rxImpliedExit) inconsistent.push(`rx envelope exit ${envelope.exit} but its results imply ${rxImpliedExit}`);
  if (n.code !== envelope.exit) inconsistent.push(`rx process exited ${n.code} but its envelope says ${envelope.exit}`);
  if (inconsistent.length) {
    failures++;
    console.log(`FAILED ${name}: ${inconsistent.join("; ")}`);
    continue;
  }
  inspected++;
  /** @type {Map<string, { verdict: string, locations: Set<string> }>} */
  const byId = new Map();
  for (const r of envelope.results) {
    if (r.verdict !== "FAIL" && r.verdict !== "WARN") continue;
    byId.set(r.id, { verdict: r.verdict, locations: new Set(r.details.filter((/** @type {any} */ d) => d.file).map((/** @type {any} */ d) => `${d.file}${d.line !== undefined ? `:${d.line}` : ""}`)) });
  }
  /** @type {string[]} */
  const lost = [];
  /** @type {string[]} */
  const known = [];
  /** @type {Set<string>} */
  const mappedIds = new Set();
  for (const f of legacyFindings) {
    const sev = f.level === "fail" ? "FAIL" : "WARN";
    for (const sub of f.message.split("; ")) {
      legacyTotal++;
      const id = targetId(f.id, sub);
      mappedIds.add(id);
      const c = byId.get(id);
      const kept = c !== undefined && RANK[/** @type {"FAIL"|"WARN"} */ (c.verdict)] >= RANK[sev] && (f.where ?? []).every((w) => c.locations.has(w));
      if (kept) continue;
      const line = `${sev} ${f.id}→${id} ${sub}${f.where?.length ? ` @ ${f.where.join(", ")}` : ""}`;
      const reviewed = exceptions.knownLost.find((k) => root.endsWith(k.root) && k.id === f.id && new RegExp(k.message).test(sub) && (k.file === null ? !(f.where ?? []).length : (f.where ?? []).some((w) => w.split(":")[0] === k.file)));
      if (reviewed) known.push(line); else lost.push(line);
    }
  }
  const extra = [...byId.keys()].filter((id) => !mappedIds.has(id));
  newExtraTotal += extra.length;
  lostTotal += lost.length;
  console.log(`${lost.length ? "LOST " : "ok   "} ${name}: legacy ${legacyFindings.length} finding(s), rx ${byId.size} FAIL/WARN, ${extra.length} new (${extra.join(", ") || "none"})`);
  for (const x of lost) console.log(`        lost: ${x}`);
  for (const x of known) console.log(`        dropped on purpose (test/port-exceptions.json knownLost): ${x}`);
}
console.log(`\n${roots.length} roots, ${inspected} fully inspected, ${failures} not inspected; ${legacyTotal} legacy sub-findings; ${lostTotal} lost; ${newExtraTotal} rx-only findings (expected differences: test/port-exceptions.json)`);
process.exitCode = lostTotal || failures || inspected === 0 ? 1 : 0;

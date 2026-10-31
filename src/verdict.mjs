// The verdict protocol every rx command speaks (docs/commands.md §1).
//
//   VERDICT  check-id  message            one line per check, VERDICT in PASS FAIL WARN N/A ERROR
//   exit 0 = only PASS/WARN/N/A, 1 = any FAIL, 2 = any ERROR (outranks FAIL)
//
// --json prints one envelope: { command, version, fingerprint, data, results, exit }.
// Domain outcomes (SAME-PIXELS, OURS-SAFE, MINE …) live in `data` or a result's `details`;
// they are never extra verdicts.

/** @typedef {"PASS" | "FAIL" | "WARN" | "N/A" | "ERROR"} Verdict */
/** @typedef {{ file?: string, line?: number, text: string }} Detail */
/** @typedef {{ id: string, verdict: Verdict, message: string, details: Detail[] }} Result */

export const VERDICTS = /** @type {const} */ (["PASS", "FAIL", "WARN", "N/A", "ERROR"]);

const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class Results {
  constructor() {
    /** @type {Result[]} */
    this.items = [];
  }

  /**
   * @param {Verdict} verdict
   * @param {string} id   kebab-case check id, e.g. `readme-assets`
   * @param {string} message one line; `N/A` must say why
   * @param {Detail[]} [details]
   */
  add(verdict, id, message, details = []) {
    if (!VERDICTS.includes(verdict)) throw new TypeError(`not a verdict: ${verdict}`);
    if (!ID_RE.test(id)) throw new TypeError(`not a check id: ${JSON.stringify(id)}`);
    if (typeof message !== "string" || !message.trim()) throw new TypeError(`result ${id} needs a message`);
    if (/\r|\n/.test(message)) throw new TypeError(`result ${id}: message must be one line`);
    const clean = details.map((d) => {
      if (!d || typeof d.text !== "string") throw new TypeError(`result ${id}: detail needs text`);
      /** @type {Detail} */
      const out = { text: d.text };
      if (d.file !== undefined) out.file = String(d.file);
      if (d.line !== undefined) out.line = Number(d.line);
      return out;
    });
    this.items.push({ id, verdict, message, details: clean });
    return this;
  }

  /** @param {string} id @param {string} message @param {Detail[]} [details] */
  pass(id, message, details) { return this.add("PASS", id, message, details); }
  /** @param {string} id @param {string} message @param {Detail[]} [details] */
  fail(id, message, details) { return this.add("FAIL", id, message, details); }
  /** @param {string} id @param {string} message @param {Detail[]} [details] */
  warn(id, message, details) { return this.add("WARN", id, message, details); }
  /** `N/A`: nothing to inspect. The message states why. @param {string} id @param {string} message @param {Detail[]} [details] */
  na(id, message, details) { return this.add("N/A", id, message, details); }
  /** @param {string} id @param {string} message @param {Detail[]} [details] */
  error(id, message, details) { return this.add("ERROR", id, message, details); }

  /** @param {Verdict} verdict */
  has(verdict) { return this.items.some((r) => r.verdict === verdict); }

  /** Append another command's results (used by `rx gates`). @param {Results} other */
  merge(other) { this.items.push(...other.items); return this; }

  /** 0, 1 or 2 per the protocol. */
  get exit() { return exitCodeFor(this.items); }
}

/** @param {Result[]} items */
export function exitCodeFor(items) {
  if (items.some((r) => r.verdict === "ERROR")) return 2;
  if (items.some((r) => r.verdict === "FAIL")) return 1;
  return 0;
}

/**
 * The `--json` document.
 * @param {{ command: string, version: string, fingerprint?: string | null, data?: object, results: Results }} p
 */
export function envelope({ command, version, fingerprint = null, data = {}, results }) {
  return { command, version, fingerprint, data, results: results.items, exit: results.exit };
}

/**
 * Text form: one line per result, details indented beneath it.
 * @param {Results} results
 */
export function renderText(results) {
  const width = Math.min(28, results.items.reduce((w, r) => Math.max(w, r.id.length), 0));
  const lines = [];
  for (const r of results.items) {
    lines.push(`${r.verdict.padEnd(5)}  ${r.id.padEnd(width)}  ${r.message}`);
    for (const d of r.details) {
      const where = d.file ? `${d.file}${d.line !== undefined ? `:${d.line}` : ""}  ` : "";
      lines.push(`       ${where}${d.text}`);
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

/**
 * Print the results in text or JSON and return the exit code. Commands never call process.exit.
 * @param {{ command: string, version: string, fingerprint?: string | null, data?: object, results: Results, json: boolean, write: (s: string) => void }} p
 */
export function emit({ command, version, fingerprint = null, data = {}, results, json, write }) {
  if (json) write(JSON.stringify(envelope({ command, version, fingerprint, data, results }), null, 2) + "\n");
  else write(renderText(results));
  return results.exit;
}

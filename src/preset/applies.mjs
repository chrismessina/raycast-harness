// Applicability expressions (docs/applicability.md): three-valued evaluation over a context the
// caller builds, plus the phrase renderer `rx preset table` uses for the Applies column.

/**
 * @typedef {true | false | "unknown"} Tri
 * @typedef {{
 *   selfAuthored: boolean,
 *   platforms: string[],
 *   published: boolean | null,
 *   webRequests: boolean,
 *   preferences: string[],
 *   resolved: (name: string) => string | null,
 *   commandModes: string[],
 *   declaresInterval: boolean,
 *   writesFiles: boolean,
 *   callsAI: boolean,
 * }} ApplyContext
 *   `published: null` means unknown (rx stale has not run). `resolved` returns the
 *   lockfile-resolved version of a package or null.
 * @typedef {{ value: Tri, reason: string }} Applied `reason` names the deciding condition.
 */

/**
 * Semver comparison with prerelease ordering: a prerelease sorts below its release; prerelease
 * identifiers compare numerically when both are numeric, otherwise lexically; fewer identifiers
 * sort first. Build metadata is ignored.
 * @param {string} a @param {string} b @returns {number}
 */
export function compareSemver(a, b) {
  const split = (/** @type {string} */ v) => {
    const noBuild = v.split("+")[0];
    const dash = noBuild.indexOf("-");
    const core = (dash === -1 ? noBuild : noBuild.slice(0, dash)).split(".").map(Number);
    const pre = dash === -1 ? [] : noBuild.slice(dash + 1).split(".");
    return { core, pre };
  };
  const pa = split(a), pb = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * @param {any} expr
 * @param {ApplyContext} ctx
 * @returns {Applied}
 */
export function evaluate(expr, ctx) {
  if (expr === true) return { value: true, reason: "all" };
  if (expr === null || typeof expr !== "object") return { value: "unknown", reason: "malformed expression" };
  if ("all" in expr) {
    /** @type {Applied | null} */
    let unknown = null;
    for (const e of expr.all) {
      const r = evaluate(e, ctx);
      if (r.value === false) return r;
      if (r.value === "unknown" && !unknown) unknown = r;
    }
    return unknown ?? { value: true, reason: render(expr) };
  }
  if ("any" in expr) {
    /** @type {Applied | null} */
    let unknown = null;
    for (const e of expr.any) {
      const r = evaluate(e, ctx);
      if (r.value === true) return r;
      if (r.value === "unknown" && !unknown) unknown = r;
    }
    return unknown ?? { value: false, reason: render(expr) };
  }
  if ("not" in expr) {
    const r = evaluate(expr.not, ctx);
    return { value: r.value === "unknown" ? "unknown" : !r.value, reason: `not ${r.reason}` };
  }
  const phrase = render(expr);
  if ("selfAuthored" in expr) return { value: ctx.selfAuthored, reason: phrase };
  if ("platform" in expr) return { value: ctx.platforms.includes(expr.platform), reason: phrase };
  if ("published" in expr) return ctx.published === null ? { value: "unknown", reason: "published is unknown; run rx stale first" } : { value: ctx.published, reason: phrase };
  if ("webRequests" in expr) return { value: ctx.webRequests, reason: phrase };
  if ("declaresPreference" in expr) return { value: ctx.preferences.includes(expr.declaresPreference), reason: phrase };
  if ("dependency" in expr) {
    const v = ctx.resolved(expr.dependency.name);
    if (v === null) return { value: false, reason: `${expr.dependency.name} is not resolved in the lockfile` };
    if (expr.dependency.minVersion && compareSemver(v, expr.dependency.minVersion) < 0) return { value: false, reason: `installed ${expr.dependency.name} ${v} is below ${expr.dependency.minVersion}` };
    return { value: true, reason: phrase };
  }
  if ("hasViewCommand" in expr) return { value: ctx.commandModes.includes("view"), reason: phrase };
  if ("commandMode" in expr) return { value: ctx.commandModes.includes(expr.commandMode), reason: phrase };
  if ("declaresInterval" in expr) return { value: ctx.declaresInterval, reason: phrase };
  if ("writesFiles" in expr) return { value: ctx.writesFiles, reason: phrase };
  if ("callsAI" in expr) return { value: ctx.callsAI, reason: phrase };
  if ("manual" in expr) return { value: "unknown", reason: `"${expr.manual}" is a judgment call` };
  return { value: "unknown", reason: `unknown condition ${Object.keys(expr).join(",")}` };
}

/** The Applies-column phrase for an expression. @param {any} expr @returns {string} */
export function render(expr) {
  if (expr === true) return "all";
  if (expr === null || typeof expr !== "object") return String(expr);
  if ("all" in expr) return expr.all.map(render).join(", ");
  if ("any" in expr) return expr.any.map(render).join(" or ");
  if ("not" in expr) return `not ${render(expr.not)}`;
  if ("selfAuthored" in expr) return "self-authored";
  if ("platform" in expr) return `declares ${expr.platform}`;
  if ("published" in expr) return "published";
  if ("webRequests" in expr) return "makes web requests";
  if ("declaresPreference" in expr) return `declares \`${expr.declaresPreference}\``;
  if ("dependency" in expr) return `installed \`${expr.dependency.name}\`${expr.dependency.minVersion ? ` ≥ ${expr.dependency.minVersion}` : ""}`;
  if ("hasViewCommand" in expr) return "has a `view` command";
  if ("commandMode" in expr) return `a \`${expr.commandMode}\` command`;
  if ("declaresInterval" in expr) return "a command declares `interval`";
  if ("writesFiles" in expr) return "writes files";
  if ("callsAI" in expr) return "calls Raycast AI";
  if ("manual" in expr) return expr.manual;
  return JSON.stringify(expr);
}

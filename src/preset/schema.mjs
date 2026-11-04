// A small JSON Schema (draft 2020-12 subset) validator, enough for schema/preset.schema.json and
// nothing more: type, const, enum, properties, required, additionalProperties, items, minItems,
// uniqueItems, pattern, minLength, minimum, anyOf, allOf, not, if/then/else, and local $ref into
// $defs. rx has one runtime dependency (pngjs) and a schema library is not worth a second one.

/**
 * @typedef {{ path: string, message: string }} SchemaError
 */

/**
 * Validate `value` against `schema`. Returns every error found (empty = valid).
 * @param {unknown} value
 * @param {any} schema the root schema (holds `$defs`)
 * @returns {SchemaError[]}
 */
export function validate(value, schema) {
  /** @type {SchemaError[]} */
  const errors = [];
  check(value, schema, schema, "$", errors);
  return errors;
}

/** @param {unknown} v */
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** @param {any} ref @param {any} root */
function deref(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) throw new Error(`unresolvable $ref ${ref}`);
  }
  return node;
}

/**
 * @param {unknown} v @param {any} s @param {any} root @param {string} path @param {SchemaError[]} errors
 * @returns {boolean} valid
 */
function check(v, s, root, path, errors) {
  if (s === true) return true;
  if (s === false) { errors.push({ path, message: "not allowed" }); return false; }
  if (s.$ref) return check(v, deref(s.$ref, root), root, path, errors);
  const before = errors.length;
  const t = typeOf(v);

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const ok = types.some((x) => x === t || (x === "number" && t === "integer"));
    if (!ok) errors.push({ path, message: `expected ${types.join(" or ")}, got ${t}` });
  }
  if ("const" in s && JSON.stringify(v) !== JSON.stringify(s.const)) errors.push({ path, message: `must equal ${JSON.stringify(s.const)}` });
  if (s.enum && !s.enum.some((/** @type {unknown} */ e) => JSON.stringify(e) === JSON.stringify(v)))
    errors.push({ path, message: `must be one of ${s.enum.map((/** @type {unknown} */ e) => JSON.stringify(e)).join(", ")}` });
  if (t === "string") {
    const str = /** @type {string} */ (v);
    if (s.minLength !== undefined && str.length < s.minLength) errors.push({ path, message: `shorter than ${s.minLength}` });
    if (s.pattern && !new RegExp(s.pattern).test(str)) errors.push({ path, message: `does not match ${s.pattern}` });
  }
  if (t === "integer" || t === "number") {
    if (s.minimum !== undefined && /** @type {number} */ (v) < s.minimum) errors.push({ path, message: `less than ${s.minimum}` });
  }
  if (t === "array") {
    const arr = /** @type {unknown[]} */ (v);
    if (s.minItems !== undefined && arr.length < s.minItems) errors.push({ path, message: `fewer than ${s.minItems} items` });
    if (s.uniqueItems) {
      const seen = new Set();
      arr.forEach((x, i) => { const k = JSON.stringify(x); if (seen.has(k)) errors.push({ path: `${path}[${i}]`, message: "duplicate item" }); seen.add(k); });
    }
    if (s.items !== undefined) arr.forEach((x, i) => check(x, s.items, root, `${path}[${i}]`, errors));
  }
  if (t === "object") {
    const obj = /** @type {Record<string, unknown>} */ (v);
    for (const r of s.required ?? []) if (!(r in obj)) errors.push({ path, message: `missing required property ${JSON.stringify(r)}` });
    const props = s.properties ?? {};
    for (const [k, x] of Object.entries(obj)) {
      if (k in props) check(x, props[k], root, `${path}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push({ path: `${path}.${k}`, message: "unknown property" });
      else if (s.additionalProperties && typeof s.additionalProperties === "object") check(x, s.additionalProperties, root, `${path}.${k}`, errors);
    }
  }
  if (s.allOf) for (const sub of s.allOf) check(v, sub, root, path, errors);
  if (s.anyOf) {
    // Report the branch that got furthest (fewest errors) so the message points at the real problem.
    /** @type {SchemaError[] | null} */
    let best = null;
    let matched = false;
    for (const sub of s.anyOf) {
      /** @type {SchemaError[]} */
      const e = [];
      if (check(v, sub, root, path, e)) { matched = true; break; }
      if (!best || e.length < best.length) best = e;
    }
    if (!matched) errors.push(...(best ?? [{ path, message: "matches no allowed form" }]));
  }
  if (s.not !== undefined) {
    /** @type {SchemaError[]} */
    const e = [];
    if (check(v, s.not, root, path, e)) errors.push({ path, message: "matches a forbidden form" });
  }
  if (s.if !== undefined) {
    /** @type {SchemaError[]} */
    const e = [];
    const cond = check(v, s.if, root, path, e);
    if (cond && s.then !== undefined) check(v, s.then, root, path, errors);
    if (!cond && s.else !== undefined) check(v, s.else, root, path, errors);
  }
  return errors.length === before;
}

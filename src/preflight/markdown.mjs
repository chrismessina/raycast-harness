// What a Markdown document renders, for `readme-assets`, `readme-links` and `readme-dev-sections`.
// The document is parsed as CommonMark + GFM (micromark), turned into an HTML tree with its raw HTML
// kept, and that raw HTML is parsed by parse5, the HTML spec parser, with GFM's tagfilter (an
// `<iframe>`, `<textarea>`, `<script>` and the like is escaped to text, so what it wraps renders).
// So a heading, image or link is reported exactly when the rendered page has that element: nothing
// inside code, an HTML comment or an HTML block's literal text counts, and an `<img>` or `<h2>`
// written as HTML counts like its Markdown form. Every element keeps the source line it came from.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toHast } from "mdast-util-to-hast";
import { raw } from "hast-util-raw";
import { toText } from "hast-util-to-text";
import parseSrcset from "parse-srcset";
import { VFile } from "vfile";

/**
 * @typedef {import("hast").Root} Root
 * @typedef {import("hast").RootContent | Root} Node
 * @typedef {import("hast").Element} Element
 * @typedef {{ kind: "image" | "link", target: string, line: number }} Embed
 * @typedef {{ line: number, level: number, text: string, words: string }} Heading
 */

/** The rendered HTML tree of a Markdown document. @param {string} markdown @returns {Root} */
function rendered(markdown) {
  const mdast = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return /** @type {Root} */ (raw(toHast(mdast, { allowDangerousHtml: true }), { file: new VFile(markdown), tagfilter: true }));
}

/** Every element in document order. @param {Node} node @param {(e: Element) => void} visit */
function eachElement(node, visit) {
  if (node.type === "element") visit(node);
  if ("children" in node) for (const child of node.children) eachElement(child, visit);
}

const MEDIA = new Set(["img", "source", "video", "audio"]);

/**
 * A `srcset`'s image candidates by the HTML spec's parsing algorithm (parse-srcset: a URL may hold a
 * comma, any whitespace separates a descriptor, a candidate with an invalid descriptor is dropped as
 * a browser drops it). The parser reports that drop with console.log, which would corrupt rx's
 * stdout, so the call runs with it silenced; the parser is synchronous.
 * @param {string} srcset @returns {{ url: string }[]}
 */
function candidates(srcset) {
  const log = console.log;
  console.log = () => {};
  try { return parseSrcset(srcset); } finally { console.log = log; }
}

/**
 * Every rendered image and link destination with its 1-based source line: `img`, `source`, `video`
 * and `audio` (`src` and every `srcset` candidate) are images, `a` (`href`) is a link. Elements GFM
 * generates (the footnote section and its back-links) have no source line and are skipped.
 * @param {string} markdown @returns {Embed[]}
 */
export function extractEmbeds(markdown) {
  /** @type {Embed[]} */
  const out = [];
  eachElement(rendered(markdown), (e) => {
    const line = e.position?.start.line;
    if (line === undefined) return;
    const p = e.properties;
    if (MEDIA.has(e.tagName)) {
      if (typeof p.src === "string") out.push({ kind: "image", target: p.src, line });
      const srcset = Array.isArray(p.srcSet) ? p.srcSet.join(", ") : typeof p.srcSet === "string" ? p.srcSet : "";
      if (srcset) for (const c of candidates(srcset)) out.push({ kind: "image", target: c.url, line });
    } else if (e.tagName === "a" && typeof p.href === "string") out.push({ kind: "link", target: p.href, line });
  });
  return out;
}

/**
 * Every rendered heading, `h1`–`h6`, Markdown or HTML, in document order. `text` is what it displays
 * by the HTML innerText algorithm (hast-util-to-text: a `<br>` or block boundary separates words,
 * inline formatting joins them, an image's alt is not text), whitespace collapsed; `words` is that
 * text lowercased with every run of punctuation, emoji and whitespace collapsed to one space (`&`
 * kept). A heading the innerText algorithm hides is left out. `section()` is the text a reader sees after the
 * heading up to the next heading of the same or a higher rank: code included, comments not.
 * @param {string} markdown @returns {(Heading & { section: () => string })[]}
 */
export function headings(markdown) {
  const tree = rendered(markdown);
  /** Document order of every node. @type {Map<Node, number>} */
  const order = new Map();
  /** Each heading, its order index, and the index just past its own subtree. @type {{ element: Element, index: number, after: number, level: number }[]} */
  const found = [];
  /** @param {Node} n @param {Node[]} ancestors */
  const number = (n, ancestors) => {
    const index = order.size;
    order.set(n, index);
    const heading = n.type === "element" && /^h[1-6]$/.test(n.tagName) && displayed(n, ancestors)
      ? { element: n, index, after: index + 1, level: Number(n.tagName[1]) } : null;
    if (heading) found.push(heading);
    if ("children" in n) for (const c of n.children) number(c, [...ancestors, n]);
    if (heading) heading.after = order.size;
  };
  number(tree, []);
  /** The subtree of nodes whose order is in [from, to), ancestors kept as their containers. @param {Node} n @param {number} from @param {number} to @returns {Node | null} */
  const within = (n, from, to) => {
    const i = /** @type {number} */ (order.get(n));
    if (!("children" in n)) return i >= from && i < to ? n : null;
    const children = n.children.map((c) => within(c, from, to)).filter((c) => c !== null);
    return children.length || (i >= from && i < to) ? /** @type {Node} */ ({ ...n, children }) : null;
  };
  /** @type {(Heading & { section: () => string })[]} */
  const out = [];
  found.forEach((h, k) => {
    const line = h.element.position?.start.line;
    const text = toText(h.element).replace(/\s+/g, " ").trim();
    const words = text.toLowerCase().replace(/[^\p{L}\p{N}&]+/gu, " ").trim();
    if (line === undefined || !words) return;
    const end = found.slice(k + 1).find((n) => n.level <= h.level)?.index ?? order.size;
    out.push({ line, level: h.level, text, words, section: () => {
      const part = within(tree, h.after, end);
      return part ? toText(/** @type {Root} */ (part)) : "";
    } });
  });
  return out;

}

/**
 * Whether a heading renders, decided by hast-util-to-text's own visibility rules (the `hidden`
 * attribute, a closed `<dialog>`, `<noscript>`, `<datalist>` and the rest): the heading, holding one
 * placeholder word, is placed under copies of its real ancestors, and it renders when that copy
 * has text. A hidden heading is neither reported nor a section boundary.
 * @param {Element} heading @param {Node[]} ancestors
 */
function displayed(heading, ancestors) {
  /** @type {Node} */
  let copy = { ...heading, children: [{ type: "text", value: "x" }] };
  for (const a of [...ancestors].reverse()) copy = /** @type {Node} */ ({ ...a, children: [copy] });
  return toText(/** @type {Root} */ (copy)).trim() !== "";
}

/** A destination as a filesystem path: decoded, query and fragment removed. @param {string} target */
export function targetPath(target) {
  let t = target.split(/[?#]/)[0];
  try { t = decodeURIComponent(t); } catch { /* keep as is */ }
  return t;
}

/** True for `https://…`, `mailto:`, `raycast://` and the like. @param {string} target */
export function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

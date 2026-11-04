// The one HTTP transport `rx judge` providers speak through. The default posts JSON with the
// global `fetch` and a timeout; tests install a fake with `setTransport()` so nothing reaches the
// network and no real key is ever read.

/**
 * @typedef {{ status: number, body: unknown, text: string }} HttpResponse
 *   `body` is the parsed JSON, or null when the response was not JSON (then read `text`).
 * @typedef {{ postJson: (url: string, headers: Record<string, string>, payload: unknown, timeoutMs: number) => Promise<HttpResponse> }} Transport
 *   `postJson` rejects only when no HTTP response arrived (network failure, timeout); any HTTP
 *   status resolves, and the provider decides what a non-2xx means.
 */

/** @type {Transport} */
export const fetchTransport = {
  async postJson(url, headers, payload, timeoutMs) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    /** @type {unknown} */
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: res.status, body, text };
  },
};

let current = fetchTransport;

/** Test hook: replace the transport. Returns the previous one. @param {Transport} t */
export function setTransport(t) {
  const prev = current;
  current = t;
  return prev;
}

export function transport() {
  return current;
}

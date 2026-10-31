// Errors the dispatcher turns into one ERROR result (exit 2). Commands throw these for anything
// that stops a check from running at all: bad arguments, an unresolvable root, unreadable input.
// A check that ran and found a problem is a FAIL result, not an error.

export class RxError extends Error {
  /**
   * @param {string} message
   * @param {{ id?: string, exit?: 1 | 2 }} [opts] `id` is the check id the ERROR line carries.
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "RxError";
    this.id = opts.id ?? "input";
    this.exit = opts.exit ?? 2;
  }
}

/** Unknown, malformed or missing command-line arguments. Always exit 2. */
export class ArgError extends RxError {
  /** @param {string} message */
  constructor(message) {
    super(message, { id: "args", exit: 2 });
    this.name = "ArgError";
  }
}

/** The extension root could not be resolved (none found, or more than one candidate). Exit 2. */
export class RootError extends RxError {
  /** @param {string} message */
  constructor(message) {
    super(message, { id: "root", exit: 2 });
    this.name = "RootError";
  }
}

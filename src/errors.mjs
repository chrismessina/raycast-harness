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
    /**
     * What the parser had established when it threw: the selected subcommand (null when none was
     * selected or the token was unknown) and every flag parsed before the error. Set by parseArgs;
     * read by the dispatcher's invalidation (src/cli.mjs), never by commands.
     * @type {import("./args.mjs").ParsedArgs | null}
     */
    this.partial = null;
  }
}

/**
 * The extension root could not be resolved. `kind` says why: `none` (nothing found; an
 * optional-root command tolerates this), `ambiguous` (more than one candidate), `bad-root`
 * (an explicit --root that is not a directory). Exit 2.
 */
export class RootError extends RxError {
  /** @param {string} message @param {"none" | "ambiguous" | "bad-root"} kind */
  constructor(message, kind) {
    super(message, { id: "root", exit: 2 });
    this.name = "RootError";
    this.kind = kind;
  }
}

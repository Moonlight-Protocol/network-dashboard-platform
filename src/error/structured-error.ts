/**
 * StructuredError — the local error-bubbling primitive for
 * network-dashboard-platform.
 *
 * Mirrors the error-bubbling standard already live on provider-platform /
 * pay-platform: internal errors are wrapped WITH CONTEXT preserving the
 * cause chain (so logs get the full `A <- B <- C` story), and a small,
 * client-safe `{ code, source, message }` shape is what leaves the edge
 * (here: the network WebSocket). The SDK does not export a `StructuredError`
 * type, so the shape is defined locally.
 *
 * The cause is carried on the native `Error.cause` field so the logger's
 * `flattenCauses` walk (see utils/logger) can reconstruct the chain, and so
 * `console`/stack traces show it too.
 */

/**
 * The client-safe wire shape. This is what rides the WebSocket error frame
 * and what any HTTP error body should collapse to — never the internal
 * cause chain or stack.
 */
export type StructuredErrorShape = {
  code: string;
  source: string;
  message: string;
};

export class StructuredError extends Error {
  readonly code: string;
  readonly source: string;

  constructor(opts: {
    code: string;
    source: string;
    message: string;
    cause?: unknown;
  }) {
    // Only pass the `cause` option when defined so we don't set an explicit
    // `cause: undefined` (which would still register as an own property).
    super(
      opts.message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "StructuredError";
    this.code = opts.code;
    this.source = opts.source;
  }

  /** The client-safe projection — no cause chain, no stack. */
  toWire(): StructuredErrorShape {
    return { code: this.code, source: this.source, message: this.message };
  }

  /**
   * Wrap an arbitrary caught value with context, preserving it as the cause.
   * Idempotent: a value that is already a `StructuredError` is returned
   * untouched so re-wrapping up the stack never buries the original code.
   */
  static from(
    err: unknown,
    ctx: { code: string; source: string; message?: string },
  ): StructuredError {
    if (err instanceof StructuredError) return err;
    const message = ctx.message ??
      (err instanceof Error ? err.message : String(err));
    return new StructuredError({
      code: ctx.code,
      source: ctx.source,
      message,
      cause: err,
    });
  }
}

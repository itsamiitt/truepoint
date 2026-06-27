// mailboxThrottle.ts — the per-mailbox send-rate throttle seam (M12 P1, WARM-001, D2/D3). The send-gate
// (dispatchOutreachSend) consumes one token per send through an injected MailboxThrottlePort; a denied send is
// DEFERRED (re-enqueued with the retry delay), never dropped — so a burst can't outrun the mailbox's ramped
// rate and torch its reputation. The default is allow-all (so core tests + non-worker callers are unaffected);
// apps/workers injects the Redis token-bucket adapter. The warmup ramp (P5) makes the per-mailbox rate dynamic.

export interface ThrottleResult {
  allowed: boolean;
  /** ms to wait before retrying when denied; 0 when allowed. */
  retryAfterMs: number;
}

export interface MailboxThrottlePort {
  tryConsume(mailboxId: string): Promise<ThrottleResult>;
}

/** The default: never throttles. Keeps the send path working without Redis (dev / api / unit tests). */
export const allowAllThrottle: MailboxThrottlePort = {
  async tryConsume() {
    return { allowed: true, retryAfterMs: 0 };
  },
};

/** Thrown by the send-gate when a mailbox is over its rate — the worker catches it and re-enqueues with delay. */
export class MailboxThrottledError extends Error {
  constructor(
    readonly mailboxId: string,
    readonly retryAfterMs: number,
  ) {
    super(`mailbox ${mailboxId} is rate-limited; retry in ${retryAfterMs}ms`);
    this.name = "MailboxThrottledError";
  }
}

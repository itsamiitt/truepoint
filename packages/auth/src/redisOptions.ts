// redisOptions.ts — the two ioredis configurations the auth package uses, and the reason there are two.
//
// THE BUG THIS FIXES. Seven Redis clients live under packages/auth. Two (rateLimit, webauthnChallenge) were
// constructed with explicit fail-fast options; the other five — code.ts, loginTransaction.ts, revocation.ts,
// signupTransaction.ts, ssoTransaction.ts — were bare `new Redis(env.REDIS_URL)`, i.e. ioredis DEFAULTS:
// `maxRetriesPerRequest: 20` with a backoff that climbs to 2s per attempt. Three of those five sit directly on
// the login critical path (`createLoginTransaction`, `issueCode`, `markRevoked`), so a degraded — not even
// down, just slow — Redis turned a sign-in into a stall of tens of seconds instead of a clean failure. The
// difference was never a decision; it is what happens when a default is inherited five times.
//
// WHY NOT ONE SHARED CONFIG. `enableOfflineQueue: false` is correct for a guard and WRONG for state, and the
// distinction is easy to get backwards:
//
//   • A GUARD (rate limit, deny-list, WebAuthn challenge lookup) fails OPEN. Rejecting a command instantly
//     while the socket is still connecting costs nothing — the caller admits the request and logs a DEGRADED
//     marker. Disabling the offline queue is exactly right: no waiting, no queue to drain.
//
//   • STATE (the login transaction, the cross-domain code, the signup/SSO transactions) has no fail-open. If
//     the write does not land, the flow cannot continue. ioredis connects LAZILY on first command, so with the
//     offline queue disabled the FIRST command after process start rejects with "Stream isn't writeable" —
//     which would break the first login after every deploy. These keep the queue (so a command may wait for the
//     connection) and instead BOUND how long that wait can be.
//
// Both are exported so a future client picks a posture deliberately instead of inheriting a default again.

import type { RedisOptions } from "ioredis";

/**
 * For clients whose caller FAILS OPEN when Redis is unreachable — rate limiters, the revocation deny-list's
 * read path, the WebAuthn challenge store. Reject instantly rather than queue: the caller has a safe answer
 * ready and a wait only converts an availability event into a latency event on every request.
 */
export const FAIL_OPEN_REDIS_OPTIONS: RedisOptions = {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
};

/**
 * For clients holding state a flow CANNOT proceed without — the login/signup/SSO transactions and the
 * single-use cross-domain code.
 *
 * The offline queue stays ON so the first command after process start waits for the lazy connect instead of
 * rejecting. Everything else exists to bound that wait: at most 3 reconnect attempts behind a queued command,
 * a linear retry capped at 2s, and a 5s connect timeout. Worst case is a few seconds and then a clean
 * AuthInfraError → 503 `auth_unavailable`, which the clients already understand ("temporarily unavailable"),
 * rather than the ~30s of silent stalling the ioredis default produced.
 */
export const CRITICAL_PATH_REDIS_OPTIONS: RedisOptions = {
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3,
  connectTimeout: 5_000,
  retryStrategy: (times: number): number => Math.min(times * 200, 2_000),
};

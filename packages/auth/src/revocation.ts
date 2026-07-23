// revocation.ts — the access-token revocation deny-list (17 §5, ADR-0016). A verified access JWT is otherwise
// trusted until its ~15-min expiry, so logout / forced-logout / a workspace switch would leave the OLD token
// usable for up to that long. We mirror every durable-session revocation into a short-lived Redis key keyed by
// the session id (the JWT's `sid`); apps/api's authn middleware rejects any token whose `sid` is on the list.
// The key TTL is exactly the access-token lifetime — the only window in which a revoked session's still-valid
// token could be presented. After that the token is expired and the key is gone (self-cleaning).
//
// Fails OPEN by design (see isRevoked): a Redis blip must never 401 every authenticated request. The durable
// session row is the source of truth — refresh/rotation already fail for a revoked session — so the deny-list
// only shortens the access-token window from "≤15 min" to "immediate"; losing it briefly is safe-available.

import { env } from "@leadwolf/config";
import Redis from "ioredis";
import { recordAuthMetric } from "./authMetrics.ts";
import { denyListDegradedLog } from "./revocationLog.ts";

// Lazy: constructing ioredis opens a socket + retry loop. Defer it so importing this module is side-effect-free
// (it is reachable from the auth Next app's module graph, and `next build` must not try to reach Redis).
let _redis: Redis | undefined;
// biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
const redis = (): Redis => (_redis ??= new Redis(env.REDIS_URL));
const key = (sid: string): string => `revoked-sid:${sid}`;

// AUTH-066: the deny-list fails OPEN on a Redis error (never 401 every request). That is correct but was
// SILENT, so a Redis outage widened the revocation window to the full access-token TTL with no signal. We now
// emit a DEGRADED marker. The per-request `check` path can fire on every request during an outage, so throttle
// it to one line per interval; the rare `mark` path (logout / rotate / revoke) always logs.
let _lastCheckDegradedLogMs = 0;
const DEGRADED_LOG_INTERVAL_MS = 10_000;

/** Add a session id to the deny-list for the access-token lifetime (beyond that, any such token is expired). */
export async function markRevoked(sessionId: string): Promise<void> {
  try {
    await redis().set(key(sessionId), "1", "EX", env.ACCESS_TOKEN_TTL_SECONDS);
  } catch (err) {
    // Best-effort: the durable session is already revoked (refresh/rotation fail); a Redis blip here only
    // means the still-live access token keeps working until its normal expiry. Never throw into the caller —
    // but surface it (AUTH-066), because a failed record means a revocation did not take effect promptly.
    console.error(denyListDegradedLog("mark", err));
  }
}

/** Deny-list many session ids at once — the password-change "log out everywhere" path. */
export async function markManyRevoked(sessionIds: readonly string[]): Promise<void> {
  await Promise.all(sessionIds.map((id) => markRevoked(id)));
}

/**
 * Is this session id on the revocation deny-list? Fails OPEN (returns false) on any Redis error: the access
 * token was already cryptographically verified and is bounded to ≤15 min, so treating an unreachable deny-list
 * as "not revoked" is the safe-availability choice (mirrors the rate-limiter's fail-open posture).
 */
export async function isRevoked(sessionId: string): Promise<boolean> {
  try {
    const revoked = (await redis().exists(key(sessionId))) === 1;
    recordAuthMetric("auth_revocation_check_total", { result: revoked ? "revoked" : "allowed" });
    return revoked;
  } catch (err) {
    // Fail OPEN (see the doc comment). Surface a throttled DEGRADED marker (AUTH-066) so a silent deny-list
    // outage — during which logged-out/deprovisioned tokens keep working to expiry — is visible to on-call.
    const now = Date.now();
    if (now - _lastCheckDegradedLogMs >= DEGRADED_LOG_INTERVAL_MS) {
      _lastCheckDegradedLogMs = now;
      console.error(denyListDegradedLog("check", err));
    }
    recordAuthMetric("auth_revocation_check_total", { result: "degraded" });
    return false;
  }
}

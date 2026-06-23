import { env } from "@leadwolf/config";
import { RateLimitedError } from "@leadwolf/types";
// rateLimit.ts — per-IP + per-identifier throttling for the identifier/credential steps (ADR-0020), backed
// by Redis (rate-limiter-flexible). Throws RateLimitedError when a key is exhausted; fails OPEN on a Redis
// outage so a cache blip can't brick authentication.
import Redis from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";

// Lazy: constructing ioredis (and the limiters that capture it) opens a socket + retry loop. Defer it so
// importing this module is side-effect-free — it is reachable from the auth Next app's module graph, and
// `next build` must not try to reach Redis at build time.
let _redis: Redis | undefined;
const redis = (): Redis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_redis ??= new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }));

let _ipLimiter: RateLimiterRedis | undefined;
let _idLimiter: RateLimiterRedis | undefined;
let _apiLimiter: RateLimiterRedis | undefined;
const ipLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_ipLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:ip",
    points: 30,
    duration: 60,
  }));
const idLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_idLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:id",
    points: 10,
    duration: 60,
  }));
// Coarse per-caller cap for the resource API (keyed by subject when authenticated, else IP). 120/min.
const apiLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_apiLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:api",
    points: 120,
    duration: 60,
  }));

// Throw RateLimitedError if `limiter` is exhausted for `key`; fail OPEN on a Redis outage (shared helper).
async function consume(limiter: RateLimiterRedis, key: string): Promise<void> {
  try {
    await limiter.consume(key);
  } catch (e) {
    if (e && typeof e === "object" && "msBeforeNext" in e) {
      throw new RateLimitedError(Math.ceil((e as { msBeforeNext: number }).msBeforeNext / 1000));
    }
    // Infra error (e.g. Redis unavailable) — fail open so an outage can't brick the platform.
  }
}

export async function checkIdentifierRate(args: { ip: string; identifier: string }): Promise<void> {
  await consume(ipLimiter(), args.ip);
  await consume(idLimiter(), args.identifier.toLowerCase());
}

/** Coarse per-request throttle for the resource API. `key` is the subject (authenticated) or client IP. */
export async function checkRequestRate(key: string): Promise<void> {
  await consume(apiLimiter(), key);
}

// ── Credential-step brute-force lockout (W7) ───────────────────────────────────────────────────────────
// The identifier step (checkIdentifierRate) throttles the EXISTENCE probe; this guards the actual SECRET check
// (password / MFA / reset code). We consume one point PER FAILED attempt — keyed by identifier AND by IP — and
// lock further attempts once exhausted; a SUCCESS clears the identifier counter, so a user who eventually signs
// in is never penalised for a few typos. Stricter + far longer window than the identifier step.
const CRED_ID_POINTS = 5; // failed attempts per identifier before lockout
const CRED_IP_POINTS = 50; // failed attempts per IP (covers identifier-spraying from one source)
const CRED_WINDOW = 900; // 15-minute rolling window AND lockout duration (seconds)

let _credIdLimiter: RateLimiterRedis | undefined;
let _credIpLimiter: RateLimiterRedis | undefined;
const credIdLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: lazy-singleton memoization (defer the socket).
  (_credIdLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:cred:id",
    points: CRED_ID_POINTS,
    duration: CRED_WINDOW,
    blockDuration: CRED_WINDOW,
  }));
const credIpLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: lazy-singleton memoization (defer the socket).
  (_credIpLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:cred:ip",
    points: CRED_IP_POINTS,
    duration: CRED_WINDOW,
    blockDuration: CRED_WINDOW,
  }));

// Throw RateLimitedError if `key` is already locked out (NO point consumed). Fails OPEN on a Redis outage.
async function assertNotBlocked(limiter: RateLimiterRedis, key: string): Promise<void> {
  let res: Awaited<ReturnType<RateLimiterRedis["get"]>>;
  try {
    res = await limiter.get(key);
  } catch {
    return; // fail open — a Redis blip must not lock everyone out
  }
  if (res && res.remainingPoints <= 0) {
    throw new RateLimitedError(Math.ceil(res.msBeforeNext / 1000));
  }
}

/** Before checking a credential: refuse if the identifier OR the IP is currently locked out (W7). */
export async function assertCredentialNotLocked(args: {
  ip: string;
  identifier: string;
}): Promise<void> {
  await assertNotBlocked(credIdLimiter(), args.identifier.toLowerCase());
  await assertNotBlocked(credIpLimiter(), args.ip);
}

/** Record a FAILED credential attempt — consume a point for the identifier + the IP. Fails open on Redis. */
export async function recordCredentialFailure(args: {
  ip: string;
  identifier: string;
}): Promise<void> {
  // Swallow BOTH the limiter-exhausted rejection (the lockout is enforced by assertCredentialNotLocked on the
  // next attempt, not here) and any infra error (fail open). We only need the counter to advance.
  await Promise.all([
    credIdLimiter()
      .consume(args.identifier.toLowerCase())
      .catch(() => {}),
    credIpLimiter()
      .consume(args.ip)
      .catch(() => {}),
  ]);
}

/** Clear the identifier's failure counter after a SUCCESSFUL auth (the user proved their identity). */
export async function recordCredentialSuccess(identifier: string): Promise<void> {
  try {
    await credIdLimiter().delete(identifier.toLowerCase());
  } catch {
    // Best-effort: a stuck counter only means a few stale failures count toward the window; it self-expires.
  }
}

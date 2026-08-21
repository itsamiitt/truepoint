import { env } from "@leadwolf/config";
import { RateLimitedError } from "@leadwolf/types";
// rateLimit.ts — per-IP + per-identifier throttling for the identifier/credential steps (ADR-0020), backed
// by Redis (rate-limiter-flexible). Throws RateLimitedError when a key is exhausted; fails OPEN on a Redis
// outage so a cache blip can't brick authentication.
import Redis from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { type OpenGuard, guardDegradedLog, makeDegradedThrottle } from "./guardDegradedLog.ts";

// One throttle for this module's fail-open markers (audit 32 · C11). Module-scoped on purpose: during a Redis
// outage EVERY limiter in here opens at once, and the operator needs to know that, not to be told once per key.
const allowDegradedLog = makeDegradedThrottle();

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
let _captureLimiter: RateLimiterRedis | undefined;
let _revealLimiter: RateLimiterRedis | undefined;
let _profileLimiter: RateLimiterRedis | undefined;
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
// Coarse per-IP backstop for the resource API's UNAUTHENTICATED surface (tokenless requests, plus requests
// whose token fails verification — authn bills those back here). Authenticated traffic is charged per-subject
// via checkAuthedRequestRate below, never this bucket: keying verified users by IP put a whole office/VPN
// egress in ONE 120/min bucket and normal team browsing produced fleet-wide 429s (perf-audit RC2). 120/min.
const apiLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_apiLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:api",
    points: 120,
    duration: 60,
  }));
// Per-SUBJECT cap for authenticated resource-API traffic, consumed by authn AFTER the token verifies — only a
// proven subject can spend its own budget, so a forged token can neither dodge the throttle (it's billed to
// the IP backstop above) nor drain another user's bucket. Higher than the backstop on purpose: one legitimate
// user's burst peaks well above it (a filter edit fans out to search + facets + count, job pollers tick
// underneath), and the expensive paths keep their own tighter guards on top (rl:reveal, rl:capture,
// entitlements, credit balance). Separate keyspace so neither limit weakens the other. 300/min.
let _authedApiLimiter: RateLimiterRedis | undefined;
const authedApiLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_authedApiLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:api:sub",
    points: 300,
    duration: 60,
  }));
// Per-caller cap for the SCRAPING capture path (chrome_extension ingestion, prospect-database-platform I6). Metered
// by RECORD VOLUME — one point per captured record — so a records-packing bot is throttled by how much it captures,
// not just how often it calls. 2,000 records/min per caller: generous for a rep clicking pages, tight for a scraper.
const captureLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_captureLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:capture",
    points: 2000,
    duration: 60,
  }));
// Reveal-specific per-caller burst cap (the MONEY endpoint). A dedicated guard on TOP of the coarse rl:api
// throttle so a runaway script / compromised token is bounded by request velocity, not only the credit-balance
// CHECK. Keyed by the verified subject; config-driven (REVEAL_RATE_PER_MIN, default 60/min). Separate keyspace,
// so it never weakens the coarse limit.
const revealLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_revealLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:reveal",
    points: env.REVEAL_RATE_PER_MIN,
    duration: 60,
  }));

// Per-caller cap for the GLOBAL PROFILE reads (search-consolidation stage 3). These endpoints take a public
// slug or a registrable domain, so they are an ENUMERATION surface in a way the rest of search is not: a
// determined caller could walk the database one profile at a time. What they would get is the browsable half
// — name, title, employer, history — never an email or a phone, so a full walk yields no contactable record
// and the monetized asset is untouched. This bounds the velocity anyway. Keyed by the verified subject;
// separate keyspace so it never weakens the coarse rl:api limit.
const profileLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
  (_profileLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:dbprofile",
    points: env.DATABASE_PROFILE_RATE_PER_MIN,
    duration: 60,
  }));

// Throw RateLimitedError if `limiter` is exhausted for `key` (consuming `points`, default 1); fail OPEN on a Redis
// outage (shared helper).
async function consume(
  limiter: RateLimiterRedis,
  key: string,
  points = 1,
  guard: OpenGuard = "rate-limit",
): Promise<void> {
  try {
    await limiter.consume(key, points);
  } catch (e) {
    if (e && typeof e === "object" && "msBeforeNext" in e) {
      throw new RateLimitedError(Math.ceil((e as { msBeforeNext: number }).msBeforeNext / 1000));
    }
    // Infra error (e.g. Redis unavailable) — fail open so an outage can't brick the platform. Behavior
    // unchanged; it is no longer SILENT (audit 32 · C11). Throttled: during an outage this runs per request,
    // and a log line per request buries the very signal it exists to raise. `key` is never logged — it is an
    // IP, an email, or a subject id.
    if (allowDegradedLog(Date.now())) console.error(guardDegradedLog(guard, e));
  }
}

export async function checkIdentifierRate(args: { ip: string; identifier: string }): Promise<void> {
  await consume(ipLimiter(), args.ip);
  await consume(idLimiter(), args.identifier.toLowerCase());
}

/** Coarse per-request backstop for the resource API's unauthenticated surface. `key` is the client IP. */
export async function checkRequestRate(key: string): Promise<void> {
  await consume(apiLimiter(), key);
}

/** Per-request throttle for AUTHENTICATED resource-API traffic. `key` is the VERIFIED token subject — call
 *  only after the JWT has passed verification (apps/api authn), so the spender provably owns the bucket. */
export async function checkAuthedRequestRate(key: string): Promise<void> {
  await consume(authedApiLimiter(), key);
}

/**
 * Throttle a SCRAPING capture (chrome_extension ingestion, I6) by RECORD VOLUME — consumes `recordCount` points
 * against the caller's per-minute record budget, so a bot packing many records into one envelope is throttled by
 * total volume, not just call count. `key` is the caller subject. Throws RateLimitedError on exhaustion; fails OPEN
 * on a Redis outage (a cache blip must not brick a legitimate capture). Additive — separate keyspace from the API
 * throttle, so it never weakens or duplicates the coarse per-request limit.
 */
export async function checkCaptureRate(key: string, recordCount: number): Promise<void> {
  await consume(captureLimiter(), key, Math.max(1, Math.trunc(recordCount)));
}

/**
 * Per-caller burst throttle for the reveal MONEY endpoint (`key` = the verified subject). Consumes one point
 * per reveal request against REVEAL_RATE_PER_MIN/min. Throws RateLimitedError (→ 429) on exhaustion; fails OPEN
 * on a Redis outage (a cache blip must not brick legitimate reveals — the credit-balance CHECK is the hard cap).
 * Additive: a separate keyspace from the coarse rl:api throttle, so it never weakens it.
 */
export async function checkRevealRate(key: string): Promise<void> {
  // Named distinctly in the DEGRADED marker: this is the guard whose opening matters most (C11). When it and
  // the entitlement gate open together, credit balance is the only remaining control on reveal spend.
  await consume(revealLimiter(), key, 1, "reveal-rate-limit");
}

/**
 * Per-caller cap for a GLOBAL PROFILE read (`key` = the verified subject). See profileLimiter above for the
 * enumeration reasoning. Throws RateLimitedError (→ 429 + Retry-After) on exhaustion; fails OPEN on a Redis
 * outage, which is the right trade here — the thing being protected is browsable, non-monetized data, so a
 * cache blip must not break the Search surface.
 */
export async function checkDatabaseProfileRate(key: string): Promise<void> {
  await consume(profileLimiter(), key, 1, "rate-limit");
}

// ── Email-OTP send throttle (AUTH-025) ─────────────────────────────────────────────────────────────────
// Cap how often a user can request an emailed MFA code so the factor can't be abused to spam a mailbox or burn
// send quota. A dedicated keyspace (does not touch the failed-attempt lockout, which counts WRONG codes — this
// counts SENDS). 3 codes per 15-minute window per user. Throws RateLimitedError on exhaustion; fails OPEN on a
// Redis outage (a cache blip must not block a legitimate code).
const OTP_SEND_POINTS = 3;
const OTP_SEND_WINDOW = 900;
let _otpSendLimiter: RateLimiterRedis | undefined;
const otpSendLimiter = (): RateLimiterRedis =>
  // biome-ignore lint/suspicious/noAssignInExpressions: lazy-singleton memoization (defer the socket).
  (_otpSendLimiter ??= new RateLimiterRedis({
    storeClient: redis(),
    keyPrefix: "rl:otp:send",
    points: OTP_SEND_POINTS,
    duration: OTP_SEND_WINDOW,
  }));

/** Throttle email-OTP code SENDS per user (anti-mailbomb / send-quota guard). Throws RateLimitedError when the
 *  user has requested too many codes recently; fails OPEN on a Redis outage. Consume BEFORE minting/sending. */
export async function checkEmailOtpSendRate(userId: string): Promise<void> {
  await consume(otpSendLimiter(), userId);
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
  } catch (e) {
    // Fail open — a Redis blip must not lock everyone out. Now marked (audit 32 · C11): this path admits a
    // caller who may ALREADY be locked out for credential stuffing, which is the fail-open that matters most.
    if (allowDegradedLog(Date.now())) console.error(guardDegradedLog("rate-limit", e));
    return;
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

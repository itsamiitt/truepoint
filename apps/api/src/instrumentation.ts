// instrumentation.ts — one-shot boot warmup for apps/api. The postgres.js pool connects LAZILY on first
// query and the auth JWKS set is fetched LAZILY on first verify, so without this the FIRST real user after
// every container start/restart pays the full DB TCP+TLS handshake AND the JWKS fetch (perf root cause #8).
// We pay both up front, at boot, off the request path.
//
// Deliberately NON-FATAL (mirrors apps/auth/src/bootSelfTest.ts): each step is wrapped so a warmup failure
// (e.g. DB briefly unreachable at boot) logs a warning and NEVER throws — server.ts must keep listening. The
// caller fires this without awaiting it, so it also never delays the listen. Idempotent: lazy singletons in
// @leadwolf/db and @leadwolf/auth mean a second call is cheap. Redis is skipped (local container, negligible).
import { log, verifyAccessToken } from "@leadwolf/auth";
import { db } from "@leadwolf/db";

// A STRUCTURALLY-VALID but unsigned throwaway JWT (header.payload.signature, all base64url). It must parse as
// a JWS for jose to reach the JWKS lookup at all — a non-JWT string fails at JWS parsing FIRST and never
// fetches the set, so it wouldn't warm anything. With this, verifyAccessToken triggers the lazy
// createRemoteJWKSet + its network fetch, then fails (no matching key / bad signature) — exactly the cache-fill
// we want. Header {"alg":"EdDSA","kid":"warmup","typ":"JWT"}, payload {"warmup":true}. Carries no real claims.
const WARMUP_JWT =
  "eyJhbGciOiJFZERTQSIsImtpZCI6Indhcm11cCIsInR5cCI6IkpXVCJ9.eyJ3YXJtdXAiOnRydWV9.AA";

/** Fill the postgres.js pool with a scope-free `SELECT 1` — no RLS/tenant context needed (03 §9): we go
 * through the base client (`db.$client`, the public Drizzle accessor) so no GUC/role is set. */
async function warmDbPool(): Promise<void> {
  try {
    // db.$client is the underlying postgres.js tagged-template client; this opens + caches a pooled socket.
    await db.$client`SELECT 1`;
    log.info("api.boot.warmup.db_ok");
  } catch (err) {
    log.warn("api.boot.warmup.db_failed", {
      err: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message : "unknown",
    });
  }
}

// jose verification errors raised AFTER the JWKS set was successfully fetched — i.e. the set IS now cached, the
// token was simply (and expectedly) rejected. Seeing one of these means the warm SUCCEEDED. A network/config
// failure (set never fetched) throws a generic error with no such code → that we surface as a warning.
const WARMED_JOSE_CODES = new Set([
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
]);

/** Pre-warm JWKS verification: running a throwaway verify through the PUBLIC verifyAccessToken API initializes
 * jose's lazy createRemoteJWKSet and fetches + caches the auth origin's published set, so the first REAL token
 * verify (the path the post-deploy user pays) is already warm. The verify is EXPECTED to throw AFTER the set is
 * fetched (the throwaway token matches no key) — that specific throw is the success signal. A throw with no
 * post-fetch jose code means the FETCH itself failed (origin unreachable) — that is the only real warning. */
async function warmJwks(): Promise<void> {
  try {
    await verifyAccessToken(WARMUP_JWT, "boot-warmup");
    log.info("api.boot.warmup.jwks_ok"); // unreachable (the unsigned token can't verify) — benign if it ever is.
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (typeof code === "string" && WARMED_JOSE_CODES.has(code)) {
      // The set was fetched + cached; the throwaway token was just rejected. JWKS is now primed.
      log.info("api.boot.warmup.jwks_ok");
      return;
    }
    log.warn("api.boot.warmup.jwks_failed", {
      err: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message : "unknown",
    });
  }
}

let started = false;

/**
 * Run the boot warmup once. Safe to call from server.ts WITHOUT awaiting — every step is self-contained and
 * non-fatal, so listening is never blocked and a warmup failure never crashes the process. The first call runs
 * + awaits both warmups; any later call returns immediately (no-op) and does NOT re-await the in-flight first.
 */
export async function runBootWarmup(): Promise<void> {
  if (started) return;
  started = true;
  await Promise.allSettled([warmDbPool(), warmJwks()]);
  log.info("api.boot.warmup.done");
}

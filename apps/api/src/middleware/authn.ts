// authn.ts — verify the access JWT (minted by the auth.* IdP) via JWKS and attach its claims. Stateless:
// the api never issues tokens (ADR-0016). Missing/invalid token → 401 invalid_token, with no detail leak.

import {
  checkAuthedRequestRate,
  checkRequestRate,
  isRevoked,
  verifyAccessToken,
} from "@leadwolf/auth";
import { appOrigins, env } from "@leadwolf/config";
import { type AccessTokenClaims, ForbiddenError, InvalidTokenError } from "@leadwolf/types";
import type { Context, Next } from "hono";
import {
  extensionRouteAllowed,
  extensionScopeViolationLog,
  isExtensionToken,
} from "./extensionScope.ts";
import { ipKey } from "./rateLimit.ts";

export type ApiVariables = { claims: AccessTokenClaims };

// Bill a request that PRESENTED a token but failed authentication to the per-IP backstop — the app-root
// rateLimit skipped it on seeing the bearer header, so without this a garbage-token flood would dodge the
// throttle entirely. Billing, not gating: the caller must still receive the 401 (the clients' silent-refresh
// recovery keys on it), so an exhausted bucket is swallowed rather than turned into a masking 429.
// checkRequestRate already fails open on Redis errors internally.
const billFailedAuthToIp = (c: Context): Promise<void> =>
  checkRequestRate(ipKey(c)).catch(() => {});

export async function authn(c: Context<{ Variables: ApiVariables }>, next: Next): Promise<void> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new InvalidTokenError();
  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(token, [...appOrigins()]);
  } catch {
    await billFailedAuthToIp(c);
    throw new InvalidTokenError();
  }
  // Revocation deny-list (17 §5, ADR-0016): a cryptographically valid token is STILL rejected if its session
  // was logged out / rotated / force-revoked within the access-token lifetime. isRevoked fails OPEN, so a Redis
  // blip narrows the window back to the token's natural ≤15-min expiry — it never 401s an otherwise-valid caller.
  // Billed to the IP, not the subject: the sub inside a REVOKED token is the victim's — charging it would let a
  // replayed stolen token drain the legitimate user's budget.
  if (await isRevoked(claims.sid)) {
    await billFailedAuthToIp(c);
    throw new InvalidTokenError();
  }
  // Per-subject request budget (perf-audit RC2). Charged HERE, after verification, because this is the first
  // point the subject is PROVEN: the app-root rateLimit runs pre-authn and can only see the IP, and keying
  // verified traffic by IP shared one bucket across a whole office egress. Throws RateLimitedError → 429.
  await checkAuthedRequestRate(claims.sub);
  // Extension-scope confinement (AUTH-065): an extension-minted token (scope:["extension"]) may only reach the
  // narrow prospecting/ingestion allow-list; every other route is off-limits. Web/admin tokens (scope:[]) skip
  // this entirely. Lockout-safe rollout: OBSERVE by default (log the out-of-scope call, still allow it), and
  // only deny when EXTENSION_SCOPE_ENFORCE="true" — so a wrong allow-list can't silently 403 the live extension.
  if (isExtensionToken(claims) && !extensionRouteAllowed(c.req.method, c.req.path)) {
    const enforce = env.EXTENSION_SCOPE_ENFORCE === "true";
    console.warn(
      extensionScopeViolationLog(c.req.method, c.req.path, enforce ? "denied" : "observed"),
    );
    if (enforce) throw new ForbiddenError("insufficient_scope");
  }
  c.set("claims", claims);
  await next();
}

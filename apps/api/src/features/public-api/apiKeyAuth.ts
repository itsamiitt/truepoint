// apiKeyAuth.ts — the bearer gate for the public data API (ADR-0049). This is the machine-caller counterpart
// to middleware/authn.ts + middleware/tenancy.ts, and is directly modelled on features/scim/scimAuth.ts,
// which solved the identical problem for an org's IdP. Read that file first if this one looks surprising.
//
// It does NOT verify a user access JWT. A public-API caller is a customer's SERVER presenting a long-lived
// `api_keys` bearer credential — there is no session, no `sub`, no `sid` to check against the revocation
// deny-list, and verifyAccessToken would reject the value outright.
//
// SECURITY:
//  • Only the SHA-256 HASH of the presented key is ever compared; the plaintext is never stored and cannot be
//    recovered. A missing, malformed, unknown or revoked key all produce the SAME 401 — never reveal which,
//    or the endpoint becomes a credential oracle.
//  • tenantId AND workspaceId come from the matched row, NEVER from the request. That is the whole isolation
//    story: a key cannot be coerced into acting on another tenant or another workspace, because there is no
//    input through which to try. It sets the same context variables `tenancy` sets, so every downstream
//    repository and RLS policy works unchanged and unaware that the caller is a machine.
//  • Rate limiting is keyed by the resolved key id and runs AFTER the 401 gate, so an unknown key spends no
//    limiter budget and cannot be used to exhaust a real key's bucket. This bucket has to exist: the app-root
//    /api/* limiter SKIPS any request carrying an Authorization header (it assumes authn will charge it per
//    subject), and an API-key request carries that header and never reaches authn — so without this it would
//    be throttled by neither.
//  • last_used_at is bumped best-effort so the management surface shows last-use and an idle-then-active
//    (possibly stolen) key is detectable. A failed bump must never 401 a valid caller: it is a monitoring
//    signal, not an auth gate.

import { checkApiKeyRate } from "@leadwolf/auth";
import { apiKeyRepository } from "@leadwolf/db";
import { ForbiddenError, InvalidTokenError, RateLimitedError } from "@leadwolf/types";
import type { Context, Next } from "hono";
import { sha256Hex } from "../../lib/apiKeySecret.ts";

/** What the public-API routes read. Deliberately the same `tenantId`/`workspaceId` names `tenancy` sets. */
export type PublicApiVariables = {
  tenantId: string;
  workspaceId: string;
  apiKeyId: string;
  apiKeyScopes: string[];
};

const rateKey = (apiKeyId: string): string => `apikey:${apiKeyId}`;

export async function apiKeyAuth(
  c: Context<{ Variables: PublicApiVariables }>,
  next: Next,
): Promise<void> {
  const header = c.req.header("authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  // Uniform 401 for missing / malformed / unknown / revoked — never say which.
  if (!presented) throw new InvalidTokenError();

  const auth = await apiKeyRepository.findActiveByHash(sha256Hex(presented));
  if (!auth) throw new InvalidTokenError();

  c.set("tenantId", auth.tenantId);
  c.set("workspaceId", auth.workspaceId);
  c.set("apiKeyId", auth.id);
  c.set("apiKeyScopes", auth.scopes);

  // Throttle per resolved key, after the 401 gate. checkApiKeyRate throws only RateLimitedError and fails
  // open on a Redis outage, so a cache blip degrades velocity control rather than bricking a paying caller.
  // Re-thrown as-is: RateLimitedError already renders as a 429 problem+json through the shared onError.
  await checkApiKeyRate(rateKey(auth.id));

  try {
    await apiKeyRepository.touchLastUsed(auth.tenantId, auth.id);
  } catch {
    // swallow — last_used_at is observability, not authorization.
  }

  await next();
}

/**
 * Require a scope on the resolved key. Scopes are a SPEND control as much as an access one: the billable
 * endpoints debit the tenant's credit balance, so a key minted read-only must not be replayable against them.
 *
 * 403 rather than 404: unlike a resource id, the endpoint's existence is public (it is documented), so hiding
 * it buys nothing, and an integrator whose key lacks a scope needs to be told exactly that.
 */
export function requireScope(scope: string) {
  return async (c: Context<{ Variables: PublicApiVariables }>, next: Next): Promise<void> => {
    if (!c.get("apiKeyScopes").includes(scope)) {
      throw new ForbiddenError(
        "insufficient_scope",
        `This API key does not carry the "${scope}" scope.`,
      );
    }
    await next();
  };
}

/** Re-exported so routes can branch on it without importing from @leadwolf/types twice. */
export { RateLimitedError };

// scimAuth.ts — the bearer-token gate for the /scim/v2 service (enterprise IAM, 17 / ADR-0018; 09 "SCIM
// deprovisioning race & token abuse"). This is the SCIM analogue of authn.ts, but it does NOT verify a user
// access JWT — a SCIM caller is an org's IdP presenting a long-lived `scim_tokens` bearer token, not a logged-in
// user. The token resolves to EXACTLY ONE tenant (token_hash is globally unique), and that tenant scopes every
// downstream SCIM operation — the load-bearing isolation: a token can only ever touch ITS tenant's members.
//
// SECURITY:
//  • Only the SHA-256 HASH of the presented token is ever compared (the plaintext is never stored — mirrors
//    the refresh-token / invitation-token posture). A non-matching or revoked token finds no row → 401.
//  • The tenantId comes from the matched token row, NEVER from the request (path/body/header) — so a token can
//    never be coerced to act on another tenant.
//  • last_used_at is bumped on every authenticated call (wires the WIRE-deferred column) so the management
//    surface shows last-use and an idle-then-active (possibly stolen) token is detectable. The bump is
//    best-effort: a failed bump must NOT 401 a valid caller (it is a monitoring signal, not an auth gate).

import { createHash } from "node:crypto";
import { scimTokenRepository } from "@leadwolf/db";
import type { Context, Next } from "hono";
import { scimUnauthorized } from "./scimError.ts";

/** Context variables the SCIM routes read: the resolved tenant + the authenticating token id (for audit/log). */
export type ScimVariables = { tenantId: string; scimTokenId: string };

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function scimAuth(c: Context<{ Variables: ScimVariables }>, next: Next): Promise<void> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  // Uniform 401 for missing / malformed / unknown / revoked — never reveal which (no token enumeration).
  if (!token) throw scimUnauthorized("Missing bearer token.");

  const auth = await scimTokenRepository.findActiveByHash(sha256Hex(token));
  if (!auth) throw scimUnauthorized();

  c.set("tenantId", auth.tenantId);
  c.set("scimTokenId", auth.id);

  // Best-effort last-use bump (monitoring, 09). Never let a bump failure reject an otherwise-valid call; the
  // bump runs before next() so a successful request reflects the use, but its error is swallowed.
  try {
    await scimTokenRepository.touchLastUsed(auth.tenantId, auth.id);
  } catch {
    // swallow — last_used_at is observability, not authorization.
  }

  await next();
}

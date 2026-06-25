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
//  • Per-token rate-limit: the /scim/* surface is outside the /api/* limiter, so it is throttled HERE, keyed by
//    the resolved token id (`scim:<tokenId>`) — one IdP's bursts can't starve another tenant's provisioning, and
//    a leaked token can't be used to hammer the surface. On trip → SCIM 429 (scimType `tooMany`). The limiter
//    FAILS OPEN on a Redis outage (rateLimit.ts), so a cache blip can never brick provisioning.

import { createHash } from "node:crypto";
import { checkRequestRate } from "@leadwolf/auth";
import { scimTokenRepository } from "@leadwolf/db";
import { RateLimitedError } from "@leadwolf/types";
import type { Context, Next } from "hono";
import { scimTooMany, scimUnauthorized } from "./scimError.ts";

// Reuse the resource API's coarse 120/min subject limiter (checkRequestRate) — a sane cap for an IdP's steady
// provisioning sync while still bounding abuse. Keyed per token id so the budget is per IdP connection.
const scimRateKey = (tokenId: string): string => `scim:${tokenId}`;

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

  // Throttle per resolved token (after the 401 gate, so an unknown/revoked token spends no limiter budget).
  // checkRequestRate throws ONLY RateLimitedError on a trip and fails open on a Redis outage; translate the trip
  // into a SCIM 429 so the IdP gets a well-formed SCIM error envelope (not a Problem-Details body it can't read).
  try {
    await checkRequestRate(scimRateKey(auth.id));
  } catch (e) {
    if (e instanceof RateLimitedError) throw scimTooMany();
    throw e; // any non-rate-limit error is unexpected — let the SCIM onError handler render a generic 500.
  }

  // Best-effort last-use bump (monitoring, 09). Never let a bump failure reject an otherwise-valid call; the
  // bump runs before next() so a successful request reflects the use, but its error is swallowed.
  try {
    await scimTokenRepository.touchLastUsed(auth.tenantId, auth.id);
  } catch {
    // swallow — last_used_at is observability, not authorization.
  }

  await next();
}

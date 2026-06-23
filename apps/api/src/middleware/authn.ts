// authn.ts — verify the access JWT (minted by the auth.* IdP) via JWKS and attach its claims. Stateless:
// the api never issues tokens (ADR-0016). Missing/invalid token → 401 invalid_token, with no detail leak.

import { isRevoked, verifyAccessToken } from "@leadwolf/auth";
import { appOrigins } from "@leadwolf/config";
import { type AccessTokenClaims, InvalidTokenError } from "@leadwolf/types";
import type { Context, Next } from "hono";

export type ApiVariables = { claims: AccessTokenClaims };

export async function authn(c: Context<{ Variables: ApiVariables }>, next: Next): Promise<void> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new InvalidTokenError();
  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(token, [...appOrigins()]);
  } catch {
    throw new InvalidTokenError();
  }
  // Revocation deny-list (17 §5, ADR-0016): a cryptographically valid token is STILL rejected if its session
  // was logged out / rotated / force-revoked within the access-token lifetime. isRevoked fails OPEN, so a Redis
  // blip narrows the window back to the token's natural ≤15-min expiry — it never 401s an otherwise-valid caller.
  if (await isRevoked(claims.sid)) throw new InvalidTokenError();
  c.set("claims", claims);
  await next();
}

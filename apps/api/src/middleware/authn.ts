// authn.ts — verify the access JWT (minted by the auth.* IdP) via JWKS and attach its claims. Stateless:
// the api never issues tokens (ADR-0016). Missing/invalid token → 401 invalid_token, with no detail leak.

import type { Context, Next } from "hono";
import { verifyAccessToken } from "@leadwolf/auth";
import { appOrigins } from "@leadwolf/config";
import { InvalidTokenError, type AccessTokenClaims } from "@leadwolf/types";

export type ApiVariables = { claims: AccessTokenClaims };

export async function authn(c: Context<{ Variables: ApiVariables }>, next: Next): Promise<void> {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new InvalidTokenError();
  try {
    const claims = await verifyAccessToken(token, [...appOrigins()]);
    c.set("claims", claims);
  } catch {
    throw new InvalidTokenError();
  }
  await next();
}

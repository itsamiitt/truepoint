// token.ts — short-lived access-JWT mint/verify + JWKS publication (ADR-0016). EdDSA, 15-min TTL, audience
// = the app origin. apps/api verifies statelessly against the JWKS; the access token lives in memory only.

import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { env } from "@leadwolf/config";
import { accessTokenClaimsSchema, type AccessTokenClaims } from "@leadwolf/types";

const ALG = "EdDSA";

const privateKey = () => importPKCS8(env.JWT_PRIVATE_KEY_PEM, ALG);
const publicKey = () => importSPKI(env.JWT_PUBLIC_KEY_PEM, ALG);

export interface MintAccessTokenInput {
  userId: string;
  tenantId: string;
  sessionId: string;
  audience: string; // the requesting app origin
  workspaceId?: string;
  scope?: string[];
}

export async function mintAccessToken(
  input: MintAccessTokenInput,
): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = env.ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    tid: input.tenantId,
    ...(input.workspaceId ? { wid: input.workspaceId } : {}),
    sid: input.sessionId,
    scope: input.scope ?? [],
  })
    .setProtectedHeader({ alg: ALG, kid: env.JWT_SIGNING_KID, typ: "JWT" })
    .setSubject(input.userId)
    .setIssuer(env.AUTH_ORIGIN)
    .setAudience(input.audience)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(await privateKey());
  return { token, expiresIn };
}

export async function verifyAccessToken(
  token: string,
  audience: string | string[],
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, await publicKey(), {
    issuer: env.AUTH_ORIGIN,
    audience,
    algorithms: [ALG],
  });
  return accessTokenClaimsSchema.parse(payload);
}

/** Public signing keys served at auth.truepoint.in/.well-known/jwks.json (current key; add next on rotation). */
export async function getJwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
  const jwk = await exportJWK(await publicKey());
  return { keys: [{ ...jwk, use: "sig", alg: ALG, kid: env.JWT_SIGNING_KID }] };
}

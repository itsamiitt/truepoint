// token.ts — short-lived access-JWT mint/verify + JWKS publication (ADR-0016). EdDSA, 15-min TTL, audience
// = the app origin. apps/api verifies statelessly against the JWKS (served at /auth/.well-known/jwks.json,
// under the auth app's "/auth" basePath); the access token lives in memory only.

import { env } from "@leadwolf/config";
import { type AccessTokenClaims, accessTokenClaimsSchema } from "@leadwolf/types";
import { SignJWT, createRemoteJWKSet, exportJWK, importPKCS8, importSPKI, jwtVerify } from "jose";
import { recordAuthMetric } from "./authMetrics.ts";

const ALG = "EdDSA";

const privateKey = () => importPKCS8(env.JWT_PRIVATE_KEY_PEM, ALG);
const publicKey = () => importSPKI(env.JWT_PUBLIC_KEY_PEM, ALG);

// verifyAccessToken (the apps/api path) verifies against the auth origin's PUBLISHED JWKS, selecting the key
// by `kid` — so the api needs no local public PEM and key rotation works (publish the next key in JWKS, the
// api picks it up; jose caches the set ~5 min). Lazy so importing this module opens no socket.
// The auth app runs at basePath "/auth" (apps/auth/next.config.mjs), so ALL its routes — including the JWKS
// endpoint — live under /auth/*. The URL MUST carry that prefix: in the multi-domain deployment Caddy proxies
// auth.* → the auth container passing the path through unchanged, so a bare /.well-known/jwks.json 404s and
// every token fails verification (401 invalid_token). This matches authClient.ts, which prefixes /auth too.
//
// FETCH LOCATION ONLY: when INTERNAL_AUTH_ORIGIN is set (e.g. http://auth:3000 on the docker network) the api
// reads the key set over the internal network instead of hairpinning out through the public edge (public DNS →
// TLS → Caddy → back to the auth container it already shares a network with). This moves WHERE the keys are
// fetched, nothing else — verifyAccessToken below still pins the token's issuer/audience to the PUBLIC
// AUTH_ORIGIN, so the internal http origin is never trusted as the claim authority. Unset → fall back to
// AUTH_ORIGIN (dev/local/test unchanged). The "/auth" basePath prefix is required for the internal host too.
const jwksUrl = new URL("/auth/.well-known/jwks.json", env.INTERNAL_AUTH_ORIGIN ?? env.AUTH_ORIGIN);
let _jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
// biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
const remoteJwks = () => (_jwks ??= createRemoteJWKSet(jwksUrl));

export interface MintAccessTokenInput {
  userId: string;
  tenantId: string;
  sessionId: string;
  audience: string; // the requesting app origin
  workspaceId?: string;
  scope?: string[];
  isPlatformAdmin?: boolean;
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
    ...(input.isPlatformAdmin ? { pa: true } : {}),
  })
    .setProtectedHeader({ alg: ALG, kid: env.JWT_SIGNING_KID, typ: "JWT" })
    .setSubject(input.userId)
    .setIssuer(env.AUTH_ORIGIN)
    .setAudience(input.audience)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(await privateKey());
  recordAuthMetric("auth_token_mint_total", { result: "success" });
  return { token, expiresIn };
}

export async function verifyAccessToken(
  token: string,
  audience: string | string[],
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, remoteJwks(), {
    issuer: env.AUTH_ORIGIN,
    audience,
    algorithms: [ALG],
    // Tolerate ≤30s of clock skew between the minter (apps/auth) and this verifier (apps/api) so a slightly
    // fast/slow node doesn't spuriously reject a just-minted or about-to-expire token (AUTH-076). Bounds exp/
    // nbf/iat checks; 30s is well under the 15-min access TTL, so it never materially extends a token's life.
    clockTolerance: 30,
  });
  return accessTokenClaimsSchema.parse(payload);
}

/** Public signing keys served at auth.<domain>/auth/.well-known/jwks.json (current key; add next on rotation). */
export async function getJwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
  const jwk = await exportJWK(await publicKey());
  return { keys: [{ ...jwk, use: "sig", alg: ALG, kid: env.JWT_SIGNING_KID }] };
}

/**
 * Boot self-test (ADR-0016 addendum): mint a throwaway token to prove the signing key actually loads and
 * signs — the exact path that returns 503 `token_mint_failed` when JWT_PRIVATE_KEY_PEM/_B64 is missing or
 * mangled. No DB/Redis. Throws a clear, secret-free error (never the PEM) so the deploy smoke test and the
 * app boot hook fail loudly and specifically instead of every login silently 503-ing.
 */
export async function assertSigningKey(): Promise<void> {
  try {
    await mintAccessToken({
      userId: "boot-selftest",
      tenantId: "boot",
      sessionId: "boot",
      audience: env.AUTH_ORIGIN,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    const message = err instanceof Error ? err.message : "unknown";
    throw new Error(
      `JWT signing self-test failed (${name}: ${message}) — JWT_PRIVATE_KEY_PEM/_B64 is missing or malformed`,
    );
  }
}

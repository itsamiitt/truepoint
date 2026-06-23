// token.test.ts — locks the security contract of the access-token verify path (ADR-0016) after moving the
// JWKS *fetch* location to the internal network (perf root-cause #8). Invariant under test: ONLY where the key
// set is fetched may move; verifyAccessToken still validates the token's issuer and audience against the
// PUBLIC AUTH_ORIGIN. These tests import and call the REAL verifyAccessToken from ./token (NOT a re-implemented
// copy), so a regression that weakened the issuer/audience pinning would actually fail here. The remote JWKS
// HTTP GET is the only thing stubbed: we replace globalThis.fetch to serve our public key set hermetically
// (createRemoteJWKSet in jose 5.x fetches via globalThis.fetch), and we ASSERT the URL it fetches — proving
// the key set is read from the configured jwksUrl (env.INTERNAL_AUTH_ORIGIN ?? env.AUTH_ORIGIN) with the
// required "/auth" basePath. In this unit run INTERNAL_AUTH_ORIGIN is unset, so jwksUrl falls back to
// AUTH_ORIGIN (the preload's https://auth.test) — the dev/local/test path the change must leave unchanged.
//
// Note: token.ts memoizes a single createRemoteJWKSet per process (module-level `_jwks`), and jose caches the
// fetched key set by kid. So we generate ONE keypair for the whole file and keep the stub answering the same
// URL — otherwise a per-test keypair would leave the cached JWKS bound to a stale key and falsely fail valid
// tokens. The "stranger key" case below intentionally reuses the same kid so jose selects the cached (correct)
// key and the signature check — not a kid miss — is what rejects it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { env } from "@leadwolf/config";
import { type KeyLike, SignJWT, errors, exportJWK, generateKeyPair } from "jose";
import { verifyAccessToken } from "./token.ts";

const ALG = "EdDSA";
const KID = "test-kid-token";
const PUBLIC_AUDIENCE = "https://app.test"; // == APP_ORIGINS in the test preload
// accessTokenClaimsSchema requires sub/tid to be UUIDs (packages/types/src/auth.ts).
const SUB = "11111111-1111-4111-8111-111111111111";
const TID = "22222222-2222-4222-8222-222222222222";

// jwksUrl in token.ts: new URL("/auth/.well-known/jwks.json", env.INTERNAL_AUTH_ORIGIN ?? env.AUTH_ORIGIN).
const expectedJwksUrl = new URL(
  "/auth/.well-known/jwks.json",
  env.INTERNAL_AUTH_ORIGIN ?? env.AUTH_ORIGIN,
).toString();

let signingKey: KeyLike;
const realFetch = globalThis.fetch;
const fetchedUrls: string[] = [];

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair(ALG);
  signingKey = privateKey;
  const publicJwks = {
    keys: [{ ...(await exportJWK(publicKey)), use: "sig", alg: ALG, kid: KID }],
  };
  // Stub the JWKS HTTP GET only. jose's createRemoteJWKSet GETs the jwks_uri via globalThis.fetch; we record
  // the URL it asks for and answer with our public key set. Everything else (signature, iss/aud) is real.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchedUrls.push(url);
    return new Response(JSON.stringify(publicJwks), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function sign(
  claims: { iss: string; aud: string },
  key: KeyLike = signingKey,
): Promise<string> {
  return new SignJWT({ tid: TID, sid: "s1", scope: [] })
    .setProtectedHeader({ alg: ALG, kid: KID, typ: "JWT" })
    .setSubject(SUB)
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key);
}

describe("verifyAccessToken — real code path; claim authority stays the PUBLIC AUTH_ORIGIN", () => {
  it("verifies a token issued by the PUBLIC AUTH_ORIGIN and returns its claims", async () => {
    const token = await sign({ iss: env.AUTH_ORIGIN, aud: PUBLIC_AUDIENCE });
    const claims = await verifyAccessToken(token, PUBLIC_AUDIENCE);
    expect(claims.sub).toBe(SUB);
    expect(claims.tid).toBe(TID);
  });

  it("fetches the JWKS from the configured jwksUrl, with the required /auth basePath", async () => {
    const token = await sign({ iss: env.AUTH_ORIGIN, aud: PUBLIC_AUDIENCE });
    await verifyAccessToken(token, PUBLIC_AUDIENCE);
    expect(fetchedUrls).toContain(expectedJwksUrl);
    expect(expectedJwksUrl).toContain("/auth/.well-known/jwks.json");
  });

  it("REJECTS a token whose issuer is the INTERNAL JWKS host (fetch host is never the claim authority)", async () => {
    // The exact regression the change must not introduce: if verifyAccessToken ever pinned issuer to the
    // internal origin, this token (signed by our key, fetchable via the stub) would wrongly verify. We assert
    // the rejection is specifically an ISSUER claim failure — not an incidental signature/schema error — so a
    // refactor that broke issuer pinning cannot pass this test by failing for some other reason.
    const token = await sign({ iss: "http://auth:3000", aud: PUBLIC_AUDIENCE });
    const err = await verifyAccessToken(token, PUBLIC_AUDIENCE).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(errors.JWTClaimValidationFailed);
    expect((err as InstanceType<typeof errors.JWTClaimValidationFailed>).claim).toBe("iss");
  });

  it("REJECTS a token whose audience is not an allow-listed app origin (specifically an aud failure)", async () => {
    const token = await sign({ iss: env.AUTH_ORIGIN, aud: "https://evil.example" });
    const err = await verifyAccessToken(token, PUBLIC_AUDIENCE).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(errors.JWTClaimValidationFailed);
    expect((err as InstanceType<typeof errors.JWTClaimValidationFailed>).claim).toBe("aud");
  });

  it("REJECTS a token with valid iss/aud but a signature from an unknown key (same kid) — signature failure", async () => {
    const { privateKey: stranger } = await generateKeyPair(ALG);
    const token = await sign({ iss: env.AUTH_ORIGIN, aud: PUBLIC_AUDIENCE }, stranger);
    const err = await verifyAccessToken(token, PUBLIC_AUDIENCE).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(errors.JWSSignatureVerificationFailed);
  });
});

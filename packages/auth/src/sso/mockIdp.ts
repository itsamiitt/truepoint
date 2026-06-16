// mockIdp.ts — a dev/test Identity Provider behind the SsoProvider seam, so the full SSO flow (handoff →
// IdP → callback → JIT) runs end-to-end WITHOUT an external IdP or the heavy OIDC/SAML libraries. initiate()
// sends the browser to the in-app /sso/mock screen; that screen mints a signed assertion which validate()
// verifies. The assertion is HMAC-signed (dev key derived from config) + short-lived + relay-state-bound —
// not a real security boundary, just enough to make the callback path honest. Never selected in production.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@leadwolf/config";
import { InvalidCredentialsError } from "@leadwolf/types";
import type { SsoAssertion, SsoInitiation, SsoProvider } from "./types.ts";

interface MockClaims {
  email: string;
  fullName?: string;
  relayState: string;
  exp: number;
}

const mac = (payload: string): string =>
  createHmac("sha256", env.BLIND_INDEX_KEY).update(payload).digest("base64url");

/** Mint a signed mock assertion — called by the /sso/mock screen to stand in for an IdP's response. */
export function signMockAssertion(input: {
  email: string;
  fullName?: string;
  relayState: string;
}): string {
  const claims: MockClaims = { ...input, exp: Date.now() + 5 * 60 * 1000 };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

function verifyMockAssertion(token: string): MockClaims | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = mac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MockClaims;
    return typeof claims.exp === "number" && claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

export const mockProvider: SsoProvider = {
  protocol: "oidc", // the mock serves both protocols; the field is unused for selection
  async initiate(): Promise<SsoInitiation> {
    return {
      redirectUrl: `${env.AUTH_ORIGIN}/sso/mock`,
      relayState: randomBytes(16).toString("base64url"),
    };
  },
  async validate({ params, relayState }): Promise<SsoAssertion> {
    const token = params.code ?? params.assertion ?? params.SAMLResponse ?? "";
    const claims = verifyMockAssertion(token);
    if (!claims || claims.relayState !== relayState) throw new InvalidCredentialsError();
    return { email: claims.email, fullName: claims.fullName, attributes: {} };
  },
};

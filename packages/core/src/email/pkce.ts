// pkce.ts — RFC 7636 PKCE + CSRF state for the mailbox OAuth redirect (M12 P1). Pure (node:crypto),
// unit-testable. The verifier is a 43-char base64url secret kept SERVER-SIDE (stored encrypted in
// oauth_connect_state until the callback exchanges it); the challenge = base64url(SHA256(verifier)) is what
// rides on the public authorize URL, so a redirect interceptor learns nothing usable. The state is a
// high-entropy CSRF token the provider echoes back and we match (single-use) at the callback.

import { createHash, randomBytes } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Mint a fresh PKCE pair (verifier kept secret server-side, challenge sent on the authorize URL). */
export function generatePkce(): Pkce {
  const verifier = b64url(randomBytes(32)); // 43 url-safe chars — within RFC 7636's 43..128
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** The S256 challenge for a verifier — lets the callback/tests confirm a (verifier, challenge) pair. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

/** A high-entropy CSRF state token for the OAuth `state` param (matched single-use at the callback). */
export function randomState(): string {
  return b64url(randomBytes(24));
}

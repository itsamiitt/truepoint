// webauthnRegistration.ts — passkey REGISTRATION ceremony (AUTH-024), server side. Wraps the vetted
// @simplewebauthn/server (NOT hand-rolled crypto) around the challenge store (anti-replay) and the credential
// repository (persistence). ⚠ SECURITY-CRITICAL, NEEDS SPECIALIST REVIEW BEFORE ENABLE — verify in review:
//   • rpID = the registrable domain (env.WEBAUTHN_RP_ID), so credentials work across the subdomain estate;
//   • expectedOrigin = the APP_ORIGINS allow-list (never a client value);
//   • the challenge is single-use (consumeWebauthnChallenge GETDELs it) and bound to the response;
//   • attestationType "none" (privacy; no attestation-CA trust store to maintain) — tighten if a device-model
//     allow-list is later required.
// The ROUTES that call this are gated on WEBAUTHN_ENABLED (off by default) and are a separate app-layer slice,
// so this module is inert until then.

import { appOrigins, env } from "@leadwolf/config";
import { webauthnCredentialRepository } from "@leadwolf/db";
import {
  type RegistrationResponseJSON,
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { consumeWebauthnChallenge, storeWebauthnChallenge } from "./webauthnChallenge.ts";

/** Step 1 — options the browser passes to `navigator.credentials.create`. Excludes the user's existing
 *  credentials (no double-registration) and stashes the challenge (single-use, 5-min TTL) for step 2. */
export async function generatePasskeyRegistration(user: { id: string; email: string }) {
  const existing = await webauthnCredentialRepository.listForUser(user.id);
  const options = await generateRegistrationOptions({
    rpName: "TruePoint",
    rpID: env.WEBAUTHN_RP_ID,
    userName: user.email,
    // new Uint8Array(...) so the type is Uint8Array<ArrayBuffer> (TextEncoder yields Uint8Array<ArrayBufferLike>).
    userID: new Uint8Array(new TextEncoder().encode(user.id)),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await storeWebauthnChallenge("register", user.id, options.challenge);
  return options;
}

/** Step 2 — verify the attestation against the stored challenge + expected origin/RP, and persist the credential
 *  on success. Returns whether it verified; fails closed on a missing/expired challenge or any verify error. */
export async function verifyPasskeyRegistration(
  user: { id: string },
  response: RegistrationResponseJSON,
  label?: string,
): Promise<boolean> {
  const expectedChallenge = await consumeWebauthnChallenge("register", user.id);
  if (!expectedChallenge) return false;
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: [...appOrigins()],
      expectedRPID: env.WEBAUTHN_RP_ID,
    });
  } catch {
    return false;
  }
  if (!verification.verified || !verification.registrationInfo) return false;
  const { credential, aaguid, credentialBackedUp } = verification.registrationInfo;
  await webauthnCredentialRepository.create({
    userId: user.id,
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports,
    aaguid,
    backedUp: credentialBackedUp,
    label,
  });
  return true;
}

// Re-export the response type so apps/auth routes can type the request body without a direct lib import.
export type { RegistrationResponseJSON } from "@simplewebauthn/server";

// AuthenticatorTransportFuture is the lib's transport union; aliased locally for the excludeCredentials cast.
type AuthenticatorTransportFuture =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

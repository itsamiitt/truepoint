// webauthnAuthentication.ts — passkey AUTHENTICATION (assertion) ceremony (AUTH-024), server side. Mirrors
// webauthnRegistration: wraps the vetted @simplewebauthn/server around the single-use challenge store and the
// credential repository. User-scoped (the user is already identified — e.g. passkey as an MFA factor, or a
// username-first sign-in); the usernameless/discoverable-credential variant is a follow-up.
// ⚠ SECURITY-CRITICAL, NEEDS SPECIALIST REVIEW BEFORE ENABLE — verify in review:
//   • the presented credential MUST belong to the acting user (findByCredentialId + userId check — no
//     cross-user credential use);
//   • expectedOrigin = the APP_ORIGINS allow-list, expectedRPID = the registrable domain;
//   • the challenge is single-use; the library enforces the monotonic signature counter (clone detection) and
//     we persist the advanced counter on success.
// Inert until the WEBAUTHN_ENABLED-gated routes call it.

import { appOrigins, env } from "@leadwolf/config";
import { webauthnCredentialRepository } from "@leadwolf/db";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { recordAuthMetric } from "./authMetrics.ts";
import { consumeWebauthnChallenge, storeWebauthnChallenge } from "./webauthnChallenge.ts";

type AuthenticatorTransportFuture =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

/** Step 1 — options the browser passes to `navigator.credentials.get`, restricted to this user's credentials.
 *  Stashes the single-use challenge (5-min TTL) for step 2. */
export async function generatePasskeyAuthentication(userId: string) {
  const creds = await webauthnCredentialRepository.listForUser(userId);
  const options = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: "preferred",
  });
  await storeWebauthnChallenge("authenticate", userId, options.challenge);
  return options;
}

/** Step 2 — verify the assertion against the stored challenge + expected origin/RP, confirm the credential
 *  belongs to `userId`, and advance the signature counter on success. Fails closed on any mismatch/error. */
export async function verifyPasskeyAuthentication(
  userId: string,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const record = (result: "success" | "failure") =>
    recordAuthMetric("webauthn_ceremony_total", { ceremony: "authenticate", result });
  const expectedChallenge = await consumeWebauthnChallenge("authenticate", userId);
  if (!expectedChallenge) {
    record("failure");
    return false;
  }
  const cred = await webauthnCredentialRepository.findByCredentialId(response.id);
  if (!cred || cred.userId !== userId) {
    record("failure"); // unknown credential, or one that belongs to another user — never accepted
    return false;
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: [...appOrigins()],
      expectedRPID: env.WEBAUTHN_RP_ID,
      credential: {
        id: cred.credentialId,
        // Re-wrap so the type is Uint8Array<ArrayBuffer> (the bytea column is Uint8Array<ArrayBufferLike>).
        publicKey: new Uint8Array(cred.publicKey),
        counter: cred.counter,
        transports: (cred.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
    });
  } catch {
    record("failure");
    return false;
  }
  if (!verification.verified) {
    record("failure");
    return false;
  }
  await webauthnCredentialRepository.updateCounter(
    cred.credentialId,
    verification.authenticationInfo.newCounter,
  );
  record("success");
  return true;
}

export type { AuthenticationResponseJSON } from "@simplewebauthn/server";

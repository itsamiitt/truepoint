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

import { randomUUID } from "node:crypto";
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

// ── Usernameless (discoverable-credential) variant (AUTH-024) ────────────────────────────────────────────────
// "Sign in with a passkey" with NO email first: the authenticator offers its resident credentials, and the USER
// IS RESOLVED FROM the returned credential (findByCredentialId), not supplied. This is decision-independent
// crypto/logic — it only proves possession of a registered credential and returns whose it is. Whether that
// resolved login then SKIPS the separate MFA step (a passkey with user-verification as multi-factor) is a POLICY
// decision made by the caller/login-flow wiring, NOT here (⚠ flagged: passkey-as-MFA vs mfa_enforcement).
// Because there is no userId at options time, the challenge is keyed by a random single-use HANDLE the caller
// carries in a cookie between options and verify.

/** Step 1 (usernameless) — options with NO allowCredentials (the authenticator picks a resident credential) +
 *  userVerification "required" (so the passkey is genuinely two-factor). Returns the opaque `handle` the caller
 *  stores in a cookie; the single-use challenge is stashed under it. */
export async function generatePasskeyAuthenticationUsernameless(): Promise<{
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
  handle: string;
}> {
  const options = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    userVerification: "required",
    // no allowCredentials — discoverable credentials only
  });
  const handle = `ul_${randomUUID()}`; // distinct keyspace from real user ids
  await storeWebauthnChallenge("authenticate", handle, options.challenge);
  return { options, handle };
}

/** Step 2 (usernameless) — verify the assertion against the handle's stashed challenge, resolve the user FROM the
 *  presented credential, advance the counter, and return whose credential it was. Fails closed (no userId) on any
 *  mismatch. The caller decides what to do with `userId` (and whether it satisfies MFA). */
export async function verifyPasskeyAuthenticationUsernameless(
  handle: string,
  response: AuthenticationResponseJSON,
): Promise<{ verified: boolean; userId?: string }> {
  const record = (result: "success" | "failure") =>
    recordAuthMetric("webauthn_ceremony_total", { ceremony: "authenticate", result });
  const expectedChallenge = await consumeWebauthnChallenge("authenticate", handle);
  if (!expectedChallenge) {
    record("failure");
    return { verified: false };
  }
  const cred = await webauthnCredentialRepository.findByCredentialId(response.id);
  if (!cred) {
    record("failure");
    return { verified: false };
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
        publicKey: new Uint8Array(cred.publicKey),
        counter: cred.counter,
        transports: (cred.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
    });
  } catch {
    record("failure");
    return { verified: false };
  }
  if (!verification.verified) {
    record("failure");
    return { verified: false };
  }
  await webauthnCredentialRepository.updateCounter(
    cred.credentialId,
    verification.authenticationInfo.newCounter,
  );
  record("success");
  return { verified: true, userId: cred.userId };
}

export type { AuthenticationResponseJSON } from "@simplewebauthn/server";

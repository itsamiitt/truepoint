// actions.ts — the server actions for the MID-LOGIN forced MFA-enrollment surface (P1-01 sub-gate A). Unlike
// the /account/security enroll actions (which run on a durable session via requireUser), EVERY action here
// resolves the user from the LOGIN TRANSACTION (the lw_login_txn cookie → getLoginTransaction → txn.userId):
//   • the user proved their PRIMARY factor THIS flow (that is what created the transaction) — so the
//     transaction itself is the proof of primary auth the 09 MFA-integrity AC requires; we never trust a
//     request-supplied user id and there is no body-settable userId on any path here;
//   • the new TOTP secret binds to txn.userId, NEVER a request value (09 MFA-integrity AC);
//   • the first code is verified BEFORE the method is persisted; recovery codes are shown once + stored hashed;
//   • enrollment + the first-code check are rate-limited (reuse the credential limiter, keyed mfa-enroll:<uid>);
//   • on success the transaction is marked mfaVerified and the login is finalized (finishLogin) — exactly the
//     completion the /mfa challenge action performs after a code passes.
//
// LOCKOUT-CAPABLE: a user only ever REACHES this surface when AUTH_POLICY_ENFORCEMENT_ENABLED === "true" (the
// only thing that routes resolveNextStep → "mfa_enroll"). With the flag off no edge redirects here, so this
// surface is inert by default. CSP: these are server actions ("use server") and the page ships no inline
// scripts (the OtpInput is a bundled 'self' script), so the strict nonce-CSP at middleware.ts is preserved.
"use server";

import { clientIpFromHeaders } from "@/lib/clientIp";
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";
import { env } from "@leadwolf/config";
import {
  assertCredentialNotLocked,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getLoginTransaction,
  hashRecoveryCode,
  patchLoginTransaction,
  recordAuthEvent,
  recordCredentialFailure,
  recordCredentialSuccess,
  verifyTotp,
} from "@leadwolf/auth";
import { userRepository } from "@leadwolf/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { MFA_ENROLL_COOKIE, MFA_ENROLL_MAX_AGE, readMfaEnrollResult } from "./enrollCookie";

// Resolve the pending login transaction or bounce to /login. The userId used for every write below comes ONLY
// from this transaction (server-side state keyed by the HttpOnly login-txn cookie) — never a form field.
async function requireLoginTxn(): Promise<{
  txnId: string;
  userId: string;
  tenantId?: string;
  workspaceId?: string;
}> {
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
  const txn = await getLoginTransaction(txnId);
  if (!txn) redirect("/login");
  return { txnId, userId: txn.userId, tenantId: txn.tenantId, workspaceId: txn.workspaceId };
}

// ── Start: generate the secret (shown once on the enroll screen) ─────────────────────────────────────────
// The freshly-generated secret is NOT persisted yet — it rides ONLY in the short-lived, HttpOnly,
// SameSite=Strict result cookie until the user proves the first code (verifyMfaEnroll), which is when it is
// encrypted (secrets.ts) and inserted, bound to txn.userId. Not persisting until verify means an abandoned
// setup leaves no orphan row.
export async function startMfaEnroll(): Promise<void> {
  await requireLoginTxn(); // gate to the pending transaction; no secret generated for a guest
  const secret = generateTotpSecret();
  (await cookies()).set(MFA_ENROLL_COOKIE, JSON.stringify({ kind: "totp", secret }), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: MFA_ENROLL_MAX_AGE,
  });
  redirect("/mfa/enroll");
}

// ── Verify the first code → persist the VERIFIED method + issue recovery codes ───────────────────────────
// Rate-limited (mfa-enroll:<uid>) so the first-code check cannot be brute-forced. On a correct code: insert the
// method already-verified (secret encrypted at insert, bound to txn.userId from the transaction), generate
// one-time recovery codes (shown once), and store ONLY their hashes. A wrong code persists nothing.
export async function verifyMfaEnroll(formData: FormData): Promise<void> {
  const { userId, tenantId, workspaceId } = await requireLoginTxn();
  const code = String(formData.get("code") ?? "").trim();
  const ip = clientIpFromHeaders(await headers());
  const limiterKey = `mfa-enroll:${userId}`;

  const pending = await readMfaEnrollResult();
  if (!pending || pending.kind !== "totp") redirect("/mfa/enroll?error=expired");

  // Brute-force lockout on the enroll first-code (W7), keyed separately (mfa-enroll: namespace). A lockout maps
  // to the same neutral "that code didn't match" so it leaks nothing about why the attempt failed.
  try {
    await assertCredentialNotLocked({ ip, identifier: limiterKey });
  } catch {
    redirect("/mfa/enroll?error=1");
  }

  if (!verifyTotp(pending.secret, code)) {
    await recordCredentialFailure({ ip, identifier: limiterKey });
    redirect("/mfa/enroll?error=1");
  }
  await recordCredentialSuccess(limiterKey);

  await userRepository.createMfaMethod({
    userId, // bind to THIS user from the login transaction (09 MFA-integrity AC) — never a request value
    type: "totp",
    secretEnc: encryptSecret(pending.secret),
    label: "Authenticator app",
    verified: true,
  });

  // Issue one-time recovery codes alongside the first verified factor; store hashes only.
  const codes = generateRecoveryCodes();
  await userRepository.replaceRecoveryCodes(
    userId,
    codes.map((c) => hashRecoveryCode(c)),
  );

  // Replace the pending cookie with the one-time recovery codes for the "show once" result render.
  (await cookies()).set(MFA_ENROLL_COOKIE, JSON.stringify({ kind: "recovery", codes }), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: MFA_ENROLL_MAX_AGE,
  });

  // Audit the enrollment (09 MFA-integrity AC). The tenant is RESOLVED before resolveNextStep routes here
  // (flow.ts), so this is a tenant-known event → audit_log via recordAuthEvent (best-effort, swallow-on-
  // failure — an audit miss must never block enrollment). Bound to txn.userId, never a request value; no
  // secret/code in metadata. Skipped only in the defensive case where the txn somehow carries no tenant.
  if (tenantId) {
    await recordAuthEvent({
      tenantId,
      workspaceId: workspaceId ?? null,
      actorUserId: userId,
      action: "mfa.enroll",
      entityType: "user",
      entityId: userId,
      metadata: { method: "totp", context: "forced_in_login" },
      ipAddress: ip,
      userAgent: (await headers()).get("user-agent"),
      originDomain: new URL(env.AUTH_ORIGIN).host,
    });
  }

  redirect("/mfa/enroll?done=1");
}

// ── Finish: clear the one-time cookie and CONTINUE the login transaction to completion ───────────────────
// The factor is now persisted + verified for this user, so the transaction's MFA requirement is satisfied:
// mark mfaVerified and finalize exactly as the /mfa challenge does after a passing code. finishLogin opens the
// durable session + cross-domain code and redirects to the app. Clearing the cookie makes the recovery-code
// display strictly one-time.
export async function finishMfaEnroll(): Promise<void> {
  // Fetch the full transaction here (not via requireLoginTxn) because finishLogin needs the whole object to
  // continue the flow; the userId still comes only from this server-side, cookie-keyed transaction.
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
  const txn = await getLoginTransaction(txnId);
  if (!txn) redirect("/login");

  (await cookies()).delete(MFA_ENROLL_COOKIE);

  // Defense in depth: only continue once a verified factor actually exists for this user (the verify step
  // persisted it). If somehow none does, send the user back to start enrollment rather than finalizing.
  const methods = await userRepository.listMfaMethods(txn.userId);
  if (!methods.some((m) => m.verifiedAt)) redirect("/mfa/enroll");

  await patchLoginTransaction(txnId, { mfaVerified: true });
  await finishLogin(txnId, { ...txn, mfaVerified: true });
}

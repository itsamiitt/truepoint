// actions.ts — Step 3 server action: verify the MFA code against the pending login transaction, mark it
// verified, then advance (workspace selection or completion). "Trust this device" enrollment wires in with
// the trusted-device registry (next increment). Uniform failure ("that code didn't match"). (17 §7.)
"use server";

import { clientIpFromHeaders } from "@/lib/clientIp";
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { loginCodeEmail } from "@/lib/emails";
import { finishLogin } from "@/lib/finishLogin";
import { sendAuthEmail } from "@/lib/mailer";
import {
  type AuthenticationResponseJSON,
  assertCredentialNotLocked,
  checkEmailOtpSendRate,
  getLoginTransaction,
  patchLoginTransaction,
  recordAuthMetric,
  recordCredentialFailure,
  recordCredentialSuccess,
  requestEmailOtp,
  resolveNextStep,
  verifyMfaCode,
  verifyPasskeyAuthentication,
} from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Passkey as a second factor (AUTH-024). Verify the assertion for the pending login's user, then advance exactly
 * like submitMfa (same mfa: lockout namespace, same mark-verified + resolveNextStep + finishLogin). Additive and
 * gated on WEBAUTHN_ENABLED — the TOTP/email-OTP paths are unchanged. Called from the /mfa passkey button with
 * the assertion @simplewebauthn/browser produced; a wrong/absent assertion is the same uniform "didn't match".
 */
export async function submitMfaPasskey(assertion: AuthenticationResponseJSON): Promise<void> {
  if (env.WEBAUTHN_ENABLED !== "true") redirect("/mfa?error=1");
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
  const txn = await getLoginTransaction(txnId);
  if (!txn) redirect("/login");

  const ip = clientIpFromHeaders(await headers());
  const mfaKey = `mfa:${txn.userId}`;
  try {
    await assertCredentialNotLocked({ ip, identifier: mfaKey });
  } catch {
    redirect("/mfa?error=1");
  }

  if (!(await verifyPasskeyAuthentication(txn.userId, assertion))) {
    // Count the passkey second factor in the SAME MFA SLI the TOTP/email-OTP path records (mfaVerify.ts), so
    // the metric isn't blind to passkey attempts.
    recordAuthMetric("auth_mfa_challenge_total", { result: "failed" });
    await recordCredentialFailure({ ip, identifier: mfaKey });
    redirect("/mfa?error=1");
  }
  recordAuthMetric("auth_mfa_challenge_total", { result: "passed" });
  await recordCredentialSuccess(mfaKey);

  await patchLoginTransaction(txnId, { mfaVerified: true });
  const verified = { ...txn, mfaVerified: true };
  const step = await resolveNextStep(txnId, verified);
  if (step === "org") redirect("/org");
  if (step === "workspace") redirect("/workspace");
  await finishLogin(txnId, verified);
}

/** Send an email-OTP challenge code for the pending login (AUTH-025). Rate-limited (anti-mailbomb); the code is
 *  stored regardless of delivery (best-effort send). Always returns the user to the email-OTP form so the flow
 *  never reveals whether an address exists or a send failed. */
export async function sendEmailOtp(): Promise<void> {
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
  const txn = await getLoginTransaction(txnId);
  if (!txn) redirect("/login");

  let limited = false;
  try {
    await checkEmailOtpSendRate(txn.userId);
  } catch {
    limited = true; // RateLimitedError — too many sends; fall through to the form with a soft notice
  }
  if (!limited) {
    const otp = await requestEmailOtp(txn.userId);
    if (otp) {
      try {
        await sendAuthEmail({ to: otp.email, ...loginCodeEmail({ code: otp.code }) });
      } catch {
        // best-effort: the code is stored; the mailer alerts on delivery failure (Phase 0). Never block login.
      }
    }
  }
  redirect(`/mfa?method=email_otp&sent=${limited ? "rate" : "1"}`);
}

export async function submitMfa(formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  // The challenge method (AUTH-025): TOTP by default (backward-compatible — the current form sends no method),
  // or "email_otp" once the challenge UI offers "email me a code". Anything else is rejected uniformly. Both are
  // then verified by verifyMfaCode, which itself fails closed on an unsupported method.
  const method = String(formData.get("method") ?? "totp");
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
  if (method !== "totp" && method !== "email_otp") redirect("/mfa?error=1");
  const txn = await getLoginTransaction(txnId);
  if (!txn) redirect("/login");

  // Brute-force lockout on the MFA code (W7), keyed separately from the password counter (mfa: namespace). A
  // lockout shows the same uniform "that code didn't match" so it leaks nothing about why the attempt failed.
  const ip = clientIpFromHeaders(await headers());
  const mfaKey = `mfa:${txn.userId}`;
  try {
    await assertCredentialNotLocked({ ip, identifier: mfaKey });
  } catch {
    redirect("/mfa?error=1");
  }

  if (!(await verifyMfaCode({ userId: txn.userId, method, code }))) {
    await recordCredentialFailure({ ip, identifier: mfaKey });
    redirect("/mfa?error=1");
  }
  await recordCredentialSuccess(mfaKey);

  await patchLoginTransaction(txnId, { mfaVerified: true });
  const verified = { ...txn, mfaVerified: true };
  const step = await resolveNextStep(txnId, verified);
  if (step === "org") redirect("/org");
  if (step === "workspace") redirect("/workspace");
  await finishLogin(txnId, verified);
}

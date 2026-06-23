// actions.ts — Step 3 server action: verify the MFA code against the pending login transaction, mark it
// verified, then advance (workspace selection or completion). "Trust this device" enrollment wires in with
// the trusted-device registry (next increment). Uniform failure ("that code didn't match"). (17 §7.)
"use server";

import { clientIpFromHeaders } from "@/lib/clientIp";
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";
import {
  assertCredentialNotLocked,
  getLoginTransaction,
  patchLoginTransaction,
  recordCredentialFailure,
  recordCredentialSuccess,
  resolveNextStep,
  verifyMfaCode,
} from "@leadwolf/auth";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

export async function submitMfa(formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
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

  if (!(await verifyMfaCode({ userId: txn.userId, method: "totp", code }))) {
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

// actions.ts — Step 3 server action: verify the MFA code against the pending login transaction, mark it
// verified, then advance (workspace selection or completion). "Trust this device" enrollment wires in with
// the trusted-device registry (next increment). Uniform failure ("that code didn't match"). (17 §7.)
"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getLoginTransaction,
  patchLoginTransaction,
  resolveNextStep,
  verifyMfaCode,
} from "@leadwolf/auth";
import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";

export async function submitMfa(formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
  const txn = await getLoginTransaction(txnId);
  if (!txn) redirect("/login");

  if (!(await verifyMfaCode({ userId: txn.userId, method: "totp", code }))) redirect("/mfa?error=1");

  await patchLoginTransaction(txnId, { mfaVerified: true });
  const verified = { ...txn, mfaVerified: true };
  const step = await resolveNextStep(txnId, verified);
  if (step === "org") redirect("/org");
  if (step === "workspace") redirect("/workspace");
  await finishLogin(txnId, verified);
}

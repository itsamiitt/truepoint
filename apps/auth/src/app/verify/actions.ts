// actions.ts — registration step 2 server actions (ADR-0020): submitVerification consumes the emailed code
// and marks the signup transaction email-proven (advancing to the profile step); resendCode mints + mails a
// fresh code for the same transaction. Both require a pending signup transaction.
"use server";

import { SIGNUP_TXN_COOKIE } from "@/lib/cookies";
import { sendAuthEmail } from "@/lib/mailer";
import {
  createEmailVerification,
  getSignupTransaction,
  patchSignupTransaction,
  verifyEmailCode,
} from "@leadwolf/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

async function requireSignup(): Promise<{ id: string; email: string }> {
  const id = (await cookies()).get(SIGNUP_TXN_COOKIE)?.value;
  const txn = id ? await getSignupTransaction(id) : null;
  if (!id || !txn) redirect("/signup");
  return { id, email: txn.email };
}

export async function submitVerification(formData: FormData): Promise<void> {
  const { id, email } = await requireSignup();
  const code = String(formData.get("code") ?? "").trim();

  if (!(await verifyEmailCode({ email, code }))) redirect("/verify?error=code");
  await patchSignupTransaction(id, { emailVerified: true });
  redirect("/signup/profile");
}

export async function resendCode(): Promise<void> {
  const { email } = await requireSignup();
  const { code } = await createEmailVerification({ email });
  await sendAuthEmail({
    to: email,
    subject: "Your TruePoint verification code",
    text: `Your verification code is ${code}. It expires in 15 minutes.`,
  });
  redirect("/verify?sent=1");
}

// actions.ts — "forgot password" request action (17 §9). Per-IP/per-identifier rate-limited, then calls the
// enumeration-safe requestPasswordReset: a reset `code` comes back ONLY when the account exists, and is used
// solely to mail a one-click /reset link — never logged, never branched on for the user-facing message. The
// redirect to /forgot?sent=1 and its confirmation are identical whether or not the account exists.
"use server";

import { clientIpFromHeaders } from "@/lib/clientIp";
import { passwordResetEmail } from "@/lib/emails";
import { sendAuthEmail } from "@/lib/mailer";
import { checkIdentifierRate, requestPasswordReset } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function requestReset(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const carry = new URLSearchParams({
    email,
    app_origin: String(formData.get("app_origin") ?? ""),
    code_challenge: String(formData.get("code_challenge") ?? ""),
    state: String(formData.get("state") ?? ""),
  });
  const back = (err: string): never => redirect(`/forgot?${carry.toString()}&error=${err}`);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) back("email");

  const ip = clientIpFromHeaders(await headers());
  try {
    await checkIdentifierRate({ ip, identifier: email });
  } catch {
    back("rate");
  }

  // Enumeration-safe: `code` is present ONLY when the account exists. We email a one-click reset link in that
  // case; otherwise we silently do nothing. The user-facing outcome below is identical either way.
  const { code } = await requestPasswordReset({ email, ipAddress: ip });
  if (code) {
    const link = `${env.AUTH_ORIGIN}/reset?${new URLSearchParams({ email, code })}`;
    await sendAuthEmail({ to: email, ...passwordResetEmail({ link }) });
  }

  redirect(`/forgot?${carry.toString()}&sent=1`);
}

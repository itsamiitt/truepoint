// actions.ts — completes a password reset (17 §9). Validates the two new-password fields match server-side
// (no-JS friendly), then consumes the single-use, short-lived reset code via completePasswordReset. On
// success the user is sent to /login?reset=1 with the app's context preserved; a bad/expired/replayed code
// re-renders /reset with a neutral error. The reset code never appears in logs or the error text.
"use server";

import { clientIpFromHeaders } from "@/lib/clientIp";
import {
  assertCredentialNotLocked,
  completePasswordReset,
  recordCredentialFailure,
  recordCredentialSuccess,
} from "@leadwolf/auth";
import { isAllowedOrigin } from "@leadwolf/config";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function completeReset(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const code = String(formData.get("code") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const carry = new URLSearchParams({
    email,
    code,
    app_origin: String(formData.get("app_origin") ?? ""),
    code_challenge: String(formData.get("code_challenge") ?? ""),
    state: String(formData.get("state") ?? ""),
  });
  const back = (err: string): never => redirect(`/reset?${carry.toString()}&error=${err}`);

  if (password.length < 8) back("weak");
  if (password !== confirm) back("mismatch");

  // Brute-force lockout on the reset code (W7), keyed separately (reset: namespace). The reset code is a
  // short-lived secret an attacker could otherwise guess at speed; cap failed guesses per email + per IP.
  const ip = clientIpFromHeaders(await headers());
  const resetKey = `reset:${email}`;
  try {
    await assertCredentialNotLocked({ ip, identifier: resetKey });
  } catch {
    back("1"); // same neutral "invalid or expired" message — never reveal the lockout distinctly
  }

  const result = await completePasswordReset({ email, code, newPassword: password });
  if (!result.ok) {
    await recordCredentialFailure({ ip, identifier: resetKey });
    back("1"); // invalid_token → "This reset link is invalid or expired."
  }
  await recordCredentialSuccess(resetKey);

  // Only forward an allowlisted return origin to /login — an un-validated app_origin must never propagate
  // into the subsequent sign-in's cross-domain handoff. reset=1 drives the "password updated" notice.
  const appOrigin = String(formData.get("app_origin") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const next = new URLSearchParams({ reset: "1" });
  if (isAllowedOrigin(appOrigin) && codeChallenge) {
    next.set("app_origin", appOrigin);
    next.set("code_challenge", codeChallenge);
    next.set("state", String(formData.get("state") ?? ""));
  }
  redirect(`/login?${next.toString()}`);
}

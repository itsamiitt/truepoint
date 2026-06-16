// actions.ts — issues a magic sign-in link (17 §2/§9). Per-IP/per-identifier rate-limited (also throttles the
// resend), then mints a single-use email code (purpose magic_link) and mails a one-click /magic/confirm link.
// The app's PKCE/return context is stashed in the hardened MAGIC_TXN_COOKIE (there's no server-side magic
// transaction store) for the confirm route to recover. The code never appears in logs or error text.
"use server";

import { clientIpFromHeaders } from "@/lib/clientIp";
import { setMagicTxnCookie } from "@/lib/cookies";
import { magicLinkEmail } from "@/lib/emails";
import { encodeMagicCarry } from "@/lib/magicCarry";
import { sendAuthEmail } from "@/lib/mailer";
import { checkIdentifierRate, createEmailVerification } from "@leadwolf/auth";
import { env, isAllowedOrigin } from "@leadwolf/config";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function sendMagic(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const appOrigin = String(formData.get("app_origin") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const state = String(formData.get("state") ?? "");
  const carry = new URLSearchParams({
    email,
    app_origin: appOrigin,
    code_challenge: codeChallenge,
    state,
  });
  const back = (err: string): never => redirect(`/magic?${carry.toString()}&error=${err}`);

  if (!email) back("1");
  // Validate the return origin (allowlist) + PKCE challenge BEFORE issuing anything — mirrors the
  // password/sso flows. Without this an attacker-supplied app_origin would ride the cookie and later
  // become an open redirect that leaks the cross-domain code (see completeMagic for the same guard).
  if (!isAllowedOrigin(appOrigin) || !codeChallenge) back("1");

  const ip = clientIpFromHeaders(await headers());
  try {
    await checkIdentifierRate({ ip, identifier: email });
  } catch {
    back("rate");
  }

  const { code } = await createEmailVerification({ email, purpose: "magic_link", ipAddress: ip });

  // No magic transaction store exists; the cookie itself carries the app's PKCE/return context for the
  // confirm route. clientIp is re-derived from headers there, so it is not stashed here.
  await setMagicTxnCookie(encodeMagicCarry({ appOrigin, codeChallenge, state }));

  const link = `${env.AUTH_ORIGIN}/magic/confirm?${new URLSearchParams({ email, code })}`;
  await sendAuthEmail({ to: email, ...magicLinkEmail({ link }) });

  redirect(`/magic?${carry.toString()}&sent=1`);
}

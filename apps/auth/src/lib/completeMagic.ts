// completeMagic.ts — shared completion for the magic-link callback (17 §2/§9). The link's email has already
// been proven (verifyEmailCode, purpose magic_link) by the caller; here we resolve the global identity and
// hand off to the SAME login finalize path SSO uses (createLoginTransaction → resolveNextStep → finishLogin).
// Unlike SSO, a magic-link identity is NOT pinned to one org, so org/workspace are left for resolveNextStep
// to select (auto-select on a single membership, or branch to /org · /workspace). The verified email and the
// carry-context (app_origin/code_challenge/state) ride the short-lived MAGIC_TXN_COOKIE; a missing user or
// txn returns the browser to /login with the app's context preserved — never a blank error.
import { LOGIN_TXN_COOKIE, LOGIN_TXN_MAX_AGE, clearMagicTxnCookie } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";
import { createLoginTransaction, resolveNextStep } from "@leadwolf/auth";
import { isAllowedOrigin } from "@leadwolf/config";
import { userRepository } from "@leadwolf/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export interface MagicCarryContext {
  appOrigin: string;
  codeChallenge: string;
  state: string;
  clientIp: string;
}

export async function completeMagic(email: string, carry: MagicCarryContext): Promise<never> {
  // Preserve the app's PKCE/return context so a failure can bounce cleanly back to /login.
  const loginCarry = new URLSearchParams({
    app_origin: carry.appOrigin,
    code_challenge: carry.codeChallenge,
    state: carry.state,
  });
  const fail = (): never => redirect(`/login?${loginCarry.toString()}&error=magic`);

  // Defense in depth: never finalize against an un-allowlisted return origin or an empty PKCE challenge,
  // even though sendMagic validates up front (the cookie value could be stale or forged).
  if (!isAllowedOrigin(carry.appOrigin) || !carry.codeChallenge) return fail();

  const user = await userRepository.findByEmail(email.trim().toLowerCase());
  if (!user || user.status !== "active") return fail();

  const { id: loginTxnId, txn: loginTxn } = await createLoginTransaction({
    userId: user.id,
    appOrigin: carry.appOrigin,
    codeChallenge: carry.codeChallenge,
    state: carry.state,
    clientIp: carry.clientIp,
  });
  // No tenant/workspace pin (magic-link identities aren't org-bound); resolveNextStep selects them — so,
  // unlike completeSso, there is no patchLoginTransaction step here before the next-step resolution.

  const jar = await cookies();
  jar.set(LOGIN_TXN_COOKIE, loginTxnId, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: LOGIN_TXN_MAX_AGE,
  });
  await clearMagicTxnCookie();

  const step = await resolveNextStep(loginTxnId, loginTxn);
  if (step === "mfa") redirect("/mfa");
  if (step === "org") redirect("/org");
  if (step === "workspace") redirect("/workspace");
  return finishLogin(loginTxnId, loginTxn);
}

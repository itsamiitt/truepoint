// actions.ts — Step 2A server action: verify the password, open a login transaction (pending-auth), and
// route to the next required step (MFA / workspace) or complete. Credential logic is in packages/auth; the
// durable session + cross-domain code are only issued at completion (finishLogin). Uniform failure. (17 §2.)
"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { authenticatePassword, createLoginTransaction, resolveNextStep } from "@leadwolf/auth";
import { isAllowedOrigin } from "@leadwolf/config";
import { clientIpFromHeaders } from "@/lib/clientIp";
import { LOGIN_TXN_COOKIE, LOGIN_TXN_MAX_AGE } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";

export async function submitPassword(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const appOrigin = String(formData.get("app_origin") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const state = String(formData.get("state") ?? "");
  const ctx = new URLSearchParams({ email, app_origin: appOrigin, code_challenge: codeChallenge, state });

  if (!isAllowedOrigin(appOrigin) || !codeChallenge) redirect(`/password?${ctx.toString()}&error=1`);

  const clientIp = clientIpFromHeaders(await headers());

  let user: Awaited<ReturnType<typeof authenticatePassword>>;
  try {
    user = await authenticatePassword({ email, password });
  } catch {
    redirect(`/password?${ctx.toString()}&error=1`);
  }

  const { id: txnId, txn } = await createLoginTransaction({
    userId: user.userId,
    appOrigin,
    codeChallenge,
    state,
    clientIp,
  });

  (await cookies()).set(LOGIN_TXN_COOKIE, txnId, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: LOGIN_TXN_MAX_AGE,
  });

  const step = await resolveNextStep(txnId, txn);
  if (step === "mfa") redirect("/mfa");
  if (step === "org") redirect("/org");
  if (step === "workspace") redirect("/workspace");
  await finishLogin(txnId, txn);
}

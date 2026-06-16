// actions.ts — Step 2A server action: verify the password, open a login transaction (pending-auth), and
// route to the next required step (MFA / workspace) or complete. Credential logic is in packages/auth; the
// durable session + cross-domain code are only issued at completion (finishLogin). Failure is uniform for
// credentials (bad/unknown/locked all show the same message), but a genuine infra outage (DB/Redis layer)
// — whether verifying the password or running the post-verify I/O — surfaces a distinct "temporarily
// unavailable" instead of a misleading "check your credentials" or an unhandled 500. (17 §2.)
"use server";

import { authFailureKind } from "@/lib/authFailure";
import { clientIpFromHeaders } from "@/lib/clientIp";
import { LOGIN_TXN_COOKIE, LOGIN_TXN_MAX_AGE } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";
import { authenticatePassword, createLoginTransaction, resolveNextStep } from "@leadwolf/auth";
import { isAllowedOrigin } from "@leadwolf/config";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

export async function submitPassword(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const appOrigin = String(formData.get("app_origin") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const state = String(formData.get("state") ?? "");
  const ctx = new URLSearchParams({
    email,
    app_origin: appOrigin,
    code_challenge: codeChallenge,
    state,
  });

  if (!isAllowedOrigin(appOrigin) || !codeChallenge)
    redirect(`/password?${ctx.toString()}&error=1`);

  const clientIp = clientIpFromHeaders(await headers());

  // Distinguish a credential rejection (uniform "check your credentials") from an infra outage during the
  // user lookup ("temporarily unavailable"). redirect() throws NEXT_REDIRECT, so it MUST stay in the catch.
  let user: Awaited<ReturnType<typeof authenticatePassword>>;
  try {
    user = await authenticatePassword({ email, password });
  } catch (err) {
    redirect(
      `/password?${ctx.toString()}&error=${authFailureKind(err) === "credentials" ? "1" : "unavailable"}`,
    );
  }

  // Post-verify I/O. A DB/Redis outage here must show "temporarily unavailable", not throw a 500. redirect()
  // throws NEXT_REDIRECT — never call it inside this try (the catch would swallow it). The try only assigns
  // the outer vars; every redirect() runs after/outside the try.
  let txnId: string;
  let txn: Awaited<ReturnType<typeof createLoginTransaction>>["txn"];
  let step: Awaited<ReturnType<typeof resolveNextStep>>;
  try {
    const created = await createLoginTransaction({
      userId: user.userId,
      appOrigin,
      codeChallenge,
      state,
      clientIp,
    });
    txnId = created.id;
    txn = created.txn;

    (await cookies()).set(LOGIN_TXN_COOKIE, txnId, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: LOGIN_TXN_MAX_AGE,
    });

    step = await resolveNextStep(txnId, txn);
  } catch {
    redirect(`/password?${ctx.toString()}&error=unavailable`);
  }

  if (step === "mfa") redirect("/mfa");
  if (step === "org") redirect("/org");
  if (step === "workspace") redirect("/workspace");
  await finishLogin(txnId, txn);
}

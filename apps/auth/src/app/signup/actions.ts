// actions.ts — registration server actions (ADR-0020). startSignup opens a signup transaction for an
// unknown email and mails a 6-digit code; completeSignup (run after /verify proves the email) validates the
// profile, provisions the identity + its org placement, then hands off to the normal login finalize. All
// existence checks are deliberate (registration reveals existence); credentials never live in the URL.
"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  createEmailVerification,
  createLoginTransaction,
  createSignupTransaction,
  deleteSignupTransaction,
  getSignupTransaction,
  patchLoginTransaction,
  provisionIdentity,
  resolveNextStep,
} from "@leadwolf/auth";
import { isAllowedOrigin } from "@leadwolf/config";
import { userRepository } from "@leadwolf/db";
import { ConflictError, signupSchema } from "@leadwolf/types";
import { clientIpFromHeaders } from "@/lib/clientIp";
import {
  LOGIN_TXN_COOKIE,
  LOGIN_TXN_MAX_AGE,
  SIGNUP_TXN_COOKIE,
  SIGNUP_TXN_MAX_AGE,
} from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";
import { sendAuthEmail } from "@/lib/mailer";
import { resolveDomain } from "@/lib/domainResolver";

const TXN_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/",
} as const;

// Step 1 → 2: claim an unknown email, mail a code, and start the signup transaction.
export async function startSignup(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const appOrigin = String(formData.get("app_origin") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const state = String(formData.get("state") ?? "");
  const carry = new URLSearchParams({ email, app_origin: appOrigin, code_challenge: codeChallenge, state });
  const back = (err: string): never => redirect(`/signup?${carry.toString()}&error=${err}`);

  if (!isAllowedOrigin(appOrigin) || !codeChallenge) back("1");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) back("email");

  // A known email has no business registering — send them to sign in instead (ADR-0020 reveals this).
  if (await userRepository.findByEmail(email)) redirect(`/password?${carry.toString()}`);

  const clientIp = clientIpFromHeaders(await headers());
  const { id: txnId } = await createSignupTransaction({ email, appOrigin, codeChallenge, state, clientIp });
  (await cookies()).set(SIGNUP_TXN_COOKIE, txnId, { ...TXN_COOKIE, maxAge: SIGNUP_TXN_MAX_AGE });

  const { code } = await createEmailVerification({ email, ipAddress: clientIp });
  await sendAuthEmail({
    to: email,
    subject: "Your TruePoint verification code",
    text: `Your verification code is ${code}. It expires in 15 minutes.`,
  });

  redirect("/verify");
}

// Step 3: the email is proven — validate the profile, provision the identity, and complete the login.
export async function completeSignup(formData: FormData): Promise<void> {
  const txnId = (await cookies()).get(SIGNUP_TXN_COOKIE)?.value;
  const txn = txnId ? await getSignupTransaction(txnId) : null;
  if (!txnId || !txn) redirect("/signup");
  if (!txn.emailVerified) redirect("/verify");

  const parsed = signupSchema.safeParse({
    email: txn.email,
    fullName: String(formData.get("full_name") ?? "").trim(),
    username: String(formData.get("username") ?? "").trim() || undefined,
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) redirect("/signup/profile?error=invalid");

  let provisioned: Awaited<ReturnType<typeof provisionIdentity>>;
  try {
    provisioned = await provisionIdentity({ ...parsed.data, clientIp: txn.clientIp, resolveDomain });
  } catch (err) {
    if (err instanceof ConflictError && err.code === "username_taken") redirect("/signup/profile?error=username");
    if (err instanceof ConflictError && err.code === "email_taken") {
      const carry = new URLSearchParams({
        email: txn.email,
        app_origin: txn.appOrigin,
        code_challenge: txn.codeChallenge,
        state: txn.state,
      });
      redirect(`/password?${carry.toString()}`);
    }
    throw err;
  }

  // Open the durable login flow for the new identity, pre-bound to the org it was just placed in.
  const { id: loginTxnId, txn: loginTxn } = await createLoginTransaction({
    userId: provisioned.userId,
    appOrigin: txn.appOrigin,
    codeChallenge: txn.codeChallenge,
    state: txn.state,
    clientIp: txn.clientIp,
  });
  await patchLoginTransaction(loginTxnId, {
    tenantId: provisioned.tenantId,
    workspaceId: provisioned.workspaceId,
  });
  const advanced = { ...loginTxn, tenantId: provisioned.tenantId, workspaceId: provisioned.workspaceId };

  const jar = await cookies();
  jar.set(LOGIN_TXN_COOKIE, loginTxnId, { ...TXN_COOKIE, maxAge: LOGIN_TXN_MAX_AGE });
  jar.delete(SIGNUP_TXN_COOKIE);
  await deleteSignupTransaction(txnId);

  // A brand-new identity has no MFA and a single org/workspace, so this resolves straight to completion;
  // the branches stay for the invite/auto-join cases that could land in a multi-workspace org.
  const step = await resolveNextStep(loginTxnId, advanced);
  if (step === "mfa") redirect("/mfa");
  if (step === "org") redirect("/org");
  if (step === "workspace") redirect("/workspace");
  await finishLogin(loginTxnId, advanced);
}

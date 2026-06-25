// completeSso.ts — shared completion for both SSO callbacks (17 §7). Loads the pending SSO transaction,
// validates the IdP assertion through the provider seam (relay-state-bound), JIT-provisions the identity +
// membership, then hands off to the normal login finalize (durable session + cross-domain code). Any
// validation/JIT failure returns the browser to /login with the app's context preserved — never a blank error.

import { LOGIN_TXN_COOKIE, LOGIN_TXN_MAX_AGE, SSO_TXN_COOKIE } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";
import { loadSsoConfig } from "@/lib/ssoConfig";
import {
  createLoginTransaction,
  deleteSsoTransaction,
  getSsoProvider,
  getSsoTransaction,
  patchLoginTransaction,
  provisionSsoIdentity,
  recordAuthEvent,
  resolveNextStep,
} from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function completeSso(
  protocol: "oidc" | "saml",
  params: Record<string, string>,
): Promise<never> {
  const jar = await cookies();
  const ssoTxnId = jar.get(SSO_TXN_COOKIE)?.value;
  const txn = ssoTxnId ? await getSsoTransaction(ssoTxnId) : null;
  if (!ssoTxnId || !txn) redirect("/login");

  // Preserve the app's PKCE/return context so a failure can bounce cleanly back to /login.
  const loginCarry = new URLSearchParams({
    app_origin: txn.appOrigin,
    code_challenge: txn.codeChallenge,
    state: txn.state,
  });
  const fail = (): never => redirect(`/login?${loginCarry.toString()}&error=sso`);

  const config = await loadSsoConfig(txn.tenantId);
  if (!config) fail();

  let provisioned: Awaited<ReturnType<typeof provisionSsoIdentity>>;
  try {
    const provider = getSsoProvider(protocol);
    const assertion = await provider.validate({
      config: config!,
      params,
      relayState: txn.relayState,
      providerState: txn.providerState,
    });
    provisioned = await provisionSsoIdentity({ assertion, config: config! });
  } catch {
    fail();
  }

  // sso.callback — IdP assertion validated + identity JIT-provisioned into the SSO org (ADR-0031 §2).
  await recordAuthEvent({
    tenantId: txn.tenantId,
    workspaceId: provisioned!.workspaceId ?? null,
    actorUserId: provisioned!.userId,
    action: "sso.callback",
    entityType: "user",
    entityId: provisioned!.userId,
    metadata: { placement: "sso_callback", protocol },
    ipAddress: txn.clientIp,
    originDomain: new URL(env.AUTH_ORIGIN).host,
  });

  const { id: loginTxnId, txn: loginTxn } = await createLoginTransaction({
    userId: provisioned!.userId,
    appOrigin: txn.appOrigin,
    codeChallenge: txn.codeChallenge,
    state: txn.state,
    clientIp: txn.clientIp,
    method: "sso", // P1-01 Gate B: carry the method for the allowed-methods policy gate at finalize.
  });
  await patchLoginTransaction(loginTxnId, {
    tenantId: txn.tenantId,
    workspaceId: provisioned!.workspaceId,
  });
  const advanced = { ...loginTxn, tenantId: txn.tenantId, workspaceId: provisioned!.workspaceId };

  jar.set(LOGIN_TXN_COOKIE, loginTxnId, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: LOGIN_TXN_MAX_AGE,
  });
  jar.delete(SSO_TXN_COOKIE);
  await deleteSsoTransaction(ssoTxnId);

  // SSO identities carry no local MFA and are pinned to the SSO org, so this resolves straight to completion;
  // the branches remain for an org that requires a workspace choice.
  const step = await resolveNextStep(loginTxnId, advanced);
  if (step === "mfa") redirect("/mfa");
  if (step === "mfa_enroll") redirect("/mfa/enroll"); // P1-01 sub-gate A: forced in-login enrollment.
  if (step === "org") redirect("/org");
  if (step === "workspace") redirect("/workspace");
  return finishLogin(loginTxnId, advanced);
}

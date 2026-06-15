// actions.ts — SSO initiation (17 §7). Loads the tenant's SSO config, asks the provider seam for the IdP
// redirect (+ the relay/provider state to echo at callback), persists an SSO transaction with the app's
// PKCE/return context, and sends the browser to the IdP (the in-app mock in dev). Misconfiguration falls
// back to the handoff with a support message — never a blank error.
"use server";

import { clientIpFromHeaders } from "@/lib/clientIp";
import { SSO_TXN_COOKIE, SSO_TXN_MAX_AGE } from "@/lib/cookies";
import { loadSsoConfig } from "@/lib/ssoConfig";
import { createSsoTransaction, getSsoProvider, recordAuthEvent } from "@leadwolf/auth";
import { env, isAllowedOrigin } from "@leadwolf/config";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

export async function initiateSso(formData: FormData): Promise<void> {
  const tenantId = String(formData.get("tenant") ?? "");
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const appOrigin = String(formData.get("app_origin") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const state = String(formData.get("state") ?? "");
  const carry = new URLSearchParams({
    tenant: tenantId,
    email,
    app_origin: appOrigin,
    code_challenge: codeChallenge,
    state,
  });
  const back = (): never => redirect(`/sso?${carry.toString()}&error=1`);

  if (!tenantId || !isAllowedOrigin(appOrigin) || !codeChallenge) back();

  const config = await loadSsoConfig(tenantId);
  if (!config) back();

  const provider = getSsoProvider(config!.protocol);
  const callbackUrl = `${env.AUTH_ORIGIN}/sso/${config!.protocol}/callback`;

  let initiation: Awaited<ReturnType<typeof provider.initiate>>;
  try {
    initiation = await provider.initiate({ config: config!, callbackUrl, emailHint: email });
  } catch {
    back();
  }

  const clientIp = clientIpFromHeaders(await headers());
  const { id } = await createSsoTransaction({
    tenantId,
    protocol: config!.protocol,
    appOrigin,
    codeChallenge,
    state,
    clientIp,
    relayState: initiation!.relayState,
    providerState: initiation!.providerState,
    emailHint: email || undefined,
  });
  (await cookies()).set(SSO_TXN_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: SSO_TXN_MAX_AGE,
  });

  // sso.initiated — tenant-routed SSO handoff started (ADR-0031 §2); no identity yet (actorUserId null).
  await recordAuthEvent({
    tenantId,
    actorUserId: null,
    action: "sso.initiated",
    entityType: "user",
    metadata: { placement: "sso_handoff", protocol: config!.protocol },
    ipAddress: clientIp,
    userAgent: (await headers()).get("user-agent"),
    originDomain: new URL(env.AUTH_ORIGIN).host,
  });

  redirect(initiation!.redirectUrl);
}

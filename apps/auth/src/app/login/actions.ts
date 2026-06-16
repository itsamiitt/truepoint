// actions.ts — Step 1 server action (ADR-0020): a bot (Turnstile) + per-IP/per-identifier rate-limit gate,
// then resolve whether the identity exists and route — existing → SSO / password / magic; unknown →
// registration. Reveals existence by design, throttled. Carries the app's PKCE/return context forward.
"use server";

import { clientIpFromHeaders } from "@/lib/clientIp";
import { resolveDomain } from "@/lib/domainResolver";
import { checkIdentifierRate, lookupIdentifier, verifyTurnstile } from "@leadwolf/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function submitIdentifier(formData: FormData): Promise<void> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const turnstileToken = String(formData.get("cf-turnstile-response") ?? "") || null;
  const carry = new URLSearchParams({
    app_origin: String(formData.get("app_origin") ?? ""),
    code_challenge: String(formData.get("code_challenge") ?? ""),
    state: String(formData.get("state") ?? ""),
  });
  const back = (err: string): never => redirect(`/login?${carry.toString()}&error=${err}`);

  if (!identifier) back("1");

  const ip = clientIpFromHeaders(await headers());
  if (!(await verifyTurnstile(turnstileToken, ip))) back("bot");
  try {
    await checkIdentifierRate({ ip, identifier });
  } catch {
    back("rate");
  }

  const result = await lookupIdentifier(identifier, resolveDomain);
  const next = new URLSearchParams(carry);
  if (result.email) next.set("email", result.email);

  if (result.route === "register") redirect(`/signup?${next.toString()}`);
  if (result.route === "sso") {
    if (result.tenantId) next.set("tenant", result.tenantId);
    redirect(`/sso?${next.toString()}`);
  }
  if (result.route === "magic") redirect(`/magic?${next.toString()}`);
  redirect(`/password?${next.toString()}`); // password | passkey
}

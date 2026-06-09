// actions.ts — Step 1 server action: resolve the email's domain and route to the right Step-2 (ADR-0017).
// Routing is by verified domain only, so the response never reveals whether the account exists.
"use server";

import { redirect } from "next/navigation";
import { lookupIdentifier } from "@leadwolf/auth";
import { resolveDomain } from "@/lib/domainResolver";

export async function startPasswordStep(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const ctx = new URLSearchParams({
    email,
    app_origin: String(formData.get("app_origin") ?? ""),
    code_challenge: String(formData.get("code_challenge") ?? ""),
    state: String(formData.get("state") ?? ""),
  });
  if (!email) redirect(`/login?${ctx.toString()}&error=1`);

  const result = await lookupIdentifier(email, resolveDomain);
  if (result.method === "sso") redirect(`/sso?${ctx.toString()}`);
  redirect(`/password?${ctx.toString()}`);
}

// actions.ts — the mock IdP's "authenticate" action (DEVELOPMENT ONLY). Mints a signed mock assertion bound
// to the SSO transaction's relay state and posts it to the protocol callback, exactly as a real IdP redirect
// would. Disabled in production. Requires a pending SSO transaction.
"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSsoTransaction, signMockAssertion } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { SSO_TXN_COOKIE } from "@/lib/cookies";

export async function submitMockAssertion(formData: FormData): Promise<void> {
  if (env.NODE_ENV === "production") redirect("/login");
  const txnId = (await cookies()).get(SSO_TXN_COOKIE)?.value;
  const txn = txnId ? await getSsoTransaction(txnId) : null;
  if (!txn) redirect("/login");

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const fullName = String(formData.get("full_name") ?? "").trim() || undefined;
  if (!email) redirect("/sso/mock");

  const token = signMockAssertion({ email, fullName, relayState: txn.relayState });
  const relay = encodeURIComponent(txn.relayState);
  const assertion = encodeURIComponent(token);
  // Echo the protocol's natural callback params so the callback route + provider parse them realistically.
  const query = txn.protocol === "oidc" ? `code=${assertion}&state=${relay}` : `assertion=${assertion}&RelayState=${relay}`;
  redirect(`/sso/${txn.protocol}/callback?${query}`);
}

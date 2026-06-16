// actions.ts — org-selection server action (ADR-0019): record the chosen org on the login transaction, then
// advance (workspace selection or completion). Requires a pending login transaction.
"use server";

import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";
import { getLoginTransaction, patchLoginTransaction, resolveNextStep } from "@leadwolf/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function selectOrg(formData: FormData): Promise<void> {
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
  const txn = await getLoginTransaction(txnId);
  if (!txn) redirect("/login");

  const tenantId = String(formData.get("tenantId") ?? "");
  if (!tenantId) redirect("/org?error=1");

  await patchLoginTransaction(txnId, { tenantId });
  const updated = { ...txn, tenantId };
  if ((await resolveNextStep(txnId, updated)) === "workspace") redirect("/workspace");
  await finishLogin(txnId, updated);
}

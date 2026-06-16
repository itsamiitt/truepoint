// actions.ts — Step 4 server action: record the chosen workspace on the login transaction, then complete
// (finishLogin issues the code bound to that workspace). Requires a pending login transaction. (17 §2.)
"use server";

import { LOGIN_TXN_COOKIE } from "@/lib/cookies";
import { finishLogin } from "@/lib/finishLogin";
import { getLoginTransaction, patchLoginTransaction } from "@leadwolf/auth";
import { workspaceSelectionSchema } from "@leadwolf/types";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function selectWorkspace(formData: FormData): Promise<void> {
  const txnId = (await cookies()).get(LOGIN_TXN_COOKIE)?.value;
  if (!txnId) redirect("/login");
  const txn = await getLoginTransaction(txnId);
  if (!txn) redirect("/login");

  const parsed = workspaceSelectionSchema.safeParse({
    workspaceId: String(formData.get("workspaceId") ?? ""),
  });
  if (!parsed.success) redirect("/workspace?error=1");

  await patchLoginTransaction(txnId, { workspaceId: parsed.data.workspaceId });
  await finishLogin(txnId, { ...txn, workspaceId: parsed.data.workspaceId });
}

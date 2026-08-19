// api.ts — data access for the /companies/:id page (market-intelligence MI-1): the base masked-account
// DTO. Momentum/technology/graph sections fetch through the prospect slice's own hooks; the signal feed
// through the signals slice — this file only owns what no other slice serves.

import { fetchWithAuth } from "@/lib/authClient";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type { MaskedAccount } from "@leadwolf/types";

export async function fetchAccount(accountId: string): Promise<MaskedAccount> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/accounts/${encodeURIComponent(accountId)}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the company"));
  return ((await res.json()) as { account: MaskedAccount }).account;
}

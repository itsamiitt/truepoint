// api.ts — the settings-billing slice's data access: typed, authenticated calls to apps/api for the credit
// pool (07, 12 §4). Reads the in-memory access token via fetchWithAuth (ADR-0016); never touches the DB or
// the auth origin directly. The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { RevealType } from "@leadwolf/types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** A single metered reveal from /credits/usage — the usage-history row shape (09 §3, 12 §4). */
export interface UsageReveal {
  id: string;
  contactId: string;
  revealType: RevealType;
  creditsConsumed: number;
  revealedAt: string;
}

export async function fetchBalance(): Promise<number> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/balance`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load credit balance"));
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

export async function fetchUsage(limit = 100): Promise<UsageReveal[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/usage?limit=${limit}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load usage history"));
  const data = (await res.json()) as { reveals: UsageReveal[] };
  return data.reveals;
}

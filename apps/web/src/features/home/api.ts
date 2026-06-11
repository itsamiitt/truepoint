// api.ts — the home slice's data access: typed, authenticated calls to apps/api via the in-memory access
// token (fetchWithAuth, ADR-0016). No /home/summary endpoint exists yet, so fetchHomeSummary composes the
// cockpit from GET /credits/balance + GET /credits/usage. The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { HomeSummary, UsageReveal } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

async function fetchCreditBalance(): Promise<number> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/balance`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load credit balance"));
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

async function fetchRecentReveals(limit = 10): Promise<UsageReveal[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/usage?limit=${limit}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load recent reveals"));
  const data = (await res.json()) as { reveals: UsageReveal[] };
  return data.reveals;
}

/** Compose the cockpit summary from the two credits endpoints (run in parallel). */
export async function fetchHomeSummary(): Promise<HomeSummary> {
  const [creditBalance, reveals] = await Promise.all([
    fetchCreditBalance(),
    fetchRecentReveals(10),
  ]);
  return { creditBalance, reveals };
}

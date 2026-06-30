// api.ts — the settings-billing slice's data access: typed, authenticated calls to apps/api for the credit
// pool + tenant plan (07, 09 §3, 12 §4). Reads the in-memory access token via fetchWithAuth (ADR-0016); never
// touches the DB or the auth origin directly. The slice's only seam to the backend.
//
// Contract notes:
//   GET  /credits/balance     → current tenant balance (09 §3)               — preserved
//   GET  /credits/usage       → usage history (reveals)   (09 §3)            — preserved
//   GET  /credits/me          → plan + seats + workspaces + balance envelope (TenantPlanEnvelope)
//   POST /credits/checkout    → Stripe checkout for a credit pack (09 §3) — 404/501 ⇒ Stripe not wired
// A 404/501 means "not built yet" — surfaced as null / available:false so the page degrades to disabled/empty
// states instead of erroring. No fabricated balances, no fake checkouts.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { TenantPlanEnvelope } from "@leadwolf/types";
import type { TenantPlan, UsageReveal } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
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

/** Current tenant's plan/seat/limit envelope (GET /credits/me). Maps the server envelope to the view shape.
 *  null when the route isn't built yet (defensive — /credits/me is built). */
export async function fetchTenantPlan(): Promise<TenantPlan | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/me`);
  if (notBuilt(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load plan"));
  const { plan } = (await res.json()) as { plan: TenantPlanEnvelope };
  return {
    tier: plan.plan,
    planName: plan.planName,
    seatsUsed: plan.seatsUsed,
    seatLimit: plan.seatLimit,
    workspacesUsed: plan.workspacesUsed,
    workspaceLimit: plan.workspaceLimit,
    balance: plan.revealCreditBalance,
    features: plan.features,
  };
}

/** Begin a Stripe credit-pack top-up (09 §3). `available:false` ⇒ Stripe isn't wired (404/501) — the page
 *  toasts "coming soon" rather than inventing a checkout. Never fabricates a URL. */
export async function startCheckout(
  pack: string,
): Promise<{ available: boolean; checkoutUrl?: string }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pack }),
  });
  if (notBuilt(res.status)) return { available: false };
  if (!res.ok) throw new Error(await problemMessage(res, "Could not start checkout"));
  const data = (await res.json()) as { checkoutUrl?: string };
  return { available: true, checkoutUrl: data.checkoutUrl };
}

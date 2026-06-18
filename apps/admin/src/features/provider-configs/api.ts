// api.ts — the provider-configs slice's seam to the internal /admin/* API (apps/api). Self-contained
// (credentials: "include"; base from NEXT_PUBLIC_ADMIN_API_BASE). Provider configs are managed by existing
// admin endpoints (13 §3.6); this slice reads the masked config (NEVER plaintext secrets) and posts
// enable/disable + budget changes. The provider-config admin endpoints are part of the broader admin track;
// this slice degrades gracefully (a clear "not yet available" state) until they are mounted.

import type { ProviderConfigView } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_ADMIN_API_BASE ?? "";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}/api/v1/admin${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** List provider configs (masked). Throws a typed message; the page maps a 404 to "endpoint not available". */
export async function fetchProviderConfigs(): Promise<ProviderConfigView[]> {
  const res = await adminFetch("/provider-configs");
  if (res.status === 404) {
    throw new Error("PROVIDER_CONFIG_ENDPOINT_UNAVAILABLE");
  }
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load provider configs"));
  const body = (await res.json()) as { providers: ProviderConfigView[] };
  return body.providers;
}

/** Enable or disable a provider. */
export async function setProviderEnabled(provider: string, enabled: boolean): Promise<void> {
  const res = await adminFetch(`/provider-configs/${encodeURIComponent(provider)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the provider"));
}

/** Update a provider's monthly cost budget (cents). */
export async function setProviderBudget(
  provider: string,
  monthlyBudgetCents: number,
): Promise<void> {
  const res = await adminFetch(`/provider-configs/${encodeURIComponent(provider)}/budget`, {
    method: "POST",
    body: JSON.stringify({ monthly_budget_cents: monthlyBudgetCents }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the budget"));
}

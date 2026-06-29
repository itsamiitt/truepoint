// api.ts — the provider-configs slice's seam to the internal /admin/* API (apps/api). Authenticates via the
// in-memory access token (fetchWithAuth, Bearer — ADR-0016), the SAME client the Tenants/Imports slices + the
// platform-admin gate use. The api authn middleware is Bearer-only (no cookie fallback — authn.ts), so the
// previous cookie credentials carried nothing usable. Reads the masked config (NEVER plaintext secrets) and
// posts enable/disable + budget changes; a 404 still degrades to a clear "not yet available" state.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { ProviderConfigView } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetchWithAuth(`${API_BASE}/api/v1/admin${path}`, {
    ...init,
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

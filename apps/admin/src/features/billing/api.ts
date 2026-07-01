// api.ts — the Billing economics slice's data access: a typed, authenticated read against the apps/api
// `/admin/billing/*` surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER
// touches the database directly — the cross-tenant aggregate read goes through the audited api endpoint.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  EconomicsSummary,
  EconomicsTrendPoint,
  LowBalanceTenant,
  TenantEconomicsRow,
} from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/billing/economics?sinceDays=N — the credit-economics rollup for the trailing window. */
export async function fetchEconomics(sinceDays: number): Promise<EconomicsSummary> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/billing/economics?sinceDays=${encodeURIComponent(sinceDays)}`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load economics"));
  const body = (await res.json()) as { summary: EconomicsSummary };
  return body.summary;
}

/** GET /admin/billing/economics/trend?sinceDays=N — the gap-filled daily revenue/reveals time series. */
export async function fetchEconomicsTrend(sinceDays: number): Promise<EconomicsTrendPoint[]> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/billing/economics/trend?sinceDays=${encodeURIComponent(sinceDays)}`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load economics trend"));
  const body = (await res.json()) as { trend: EconomicsTrendPoint[] };
  return body.trend;
}

/** GET /admin/billing/economics/by-tenant?sinceDays=N — the top tenants by provider spend for the window. */
export async function fetchEconomicsByTenant(sinceDays: number): Promise<TenantEconomicsRow[]> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/billing/economics/by-tenant?sinceDays=${encodeURIComponent(sinceDays)}`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load per-tenant economics"));
  const body = (await res.json()) as { tenants: TenantEconomicsRow[] };
  return body.tenants;
}

/** GET /admin/billing/economics/by-tenant/export — download the per-tenant economics as CSV. Authenticated
 *  (bearer-token blob fetch → client-side download); the export is itself audited server-side. */
export async function exportEconomicsByTenant(sinceDays: number): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/billing/economics/by-tenant/export?sinceDays=${encodeURIComponent(sinceDays)}`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not export economics"));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "billing-economics-by-tenant.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** GET /admin/billing/low-balance — active tenants at/under a credit-balance threshold (default 100). */
export async function fetchLowBalance(threshold = 100): Promise<LowBalanceTenant[]> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/billing/low-balance?threshold=${encodeURIComponent(threshold)}`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load low-balance tenants"));
  const body = (await res.json()) as { tenants: LowBalanceTenant[] };
  return body.tenants;
}

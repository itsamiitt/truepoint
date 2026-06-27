// api.ts — the Tenants slice's data access: typed, authenticated reads against the apps/api `/admin/*` surface
// via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER touches the database directly —
// every cross-tenant read goes through the audited api endpoints (ADR-0011 / ADR-0034). The slice's only seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { TenantDetail, TenantRow } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export interface TenantsPage {
  tenants: TenantRow[];
  nextCursor: string | null;
}

/** GET /admin/tenants — one keyset page of the directory, optionally filtered by a name/slug search (13a F5). */
export async function fetchTenants(search?: string, cursor?: string): Promise<TenantsPage> {
  const p = new URLSearchParams();
  if (search) p.set("search", search);
  if (cursor) p.set("cursor", cursor);
  const qs = p.toString();
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/tenants${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load tenants"));
  return (await res.json()) as TenantsPage;
}

/** GET /admin/tenants/:id — one org plus its workspaces + members. */
export async function fetchTenantDetail(id: string): Promise<TenantDetail> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load tenant"));
  return (await res.json()) as TenantDetail;
}

/** POST /admin/tenants/:id/suspend — suspend an org (super_admin). Reason is audited. */
export async function suspendTenant(id: string, reason: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/suspend`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not suspend the tenant"));
}

/** POST /admin/tenants/:id/reactivate — reactivate a suspended org (super_admin). Reason is audited. */
export async function reactivateTenant(id: string, reason: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/reactivate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not reactivate the tenant"));
}

/** POST /admin/elevations — mint a time-boxed JIT elevation (13a F1) the gated action then consumes. The
 *  console requests this immediately before a suspend / credit action, passing the same reason. */
export async function requestElevation(
  action: "credit.adjust" | "tenant.suspend",
  reason: string,
  targetTenantId: string,
): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/elevations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, reason, targetTenantId }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not obtain elevation"));
}

/** POST /admin/tenants/:id/credits — manual signed credit adjustment (super_admin|billing_ops). Returns the
 *  new authoritative balance. A positive delta grants, a negative one debits; both are audited with a reason. */
export async function adjustTenantCredits(
  id: string,
  delta: number,
  reason: string,
): Promise<{ balanceAfter: number }> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}/credits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delta, reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not adjust credits"));
  const body = (await res.json()) as { balanceAfter: number };
  return { balanceAfter: body.balanceAfter };
}

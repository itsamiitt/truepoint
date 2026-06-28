// api.ts — the Tenants slice's data access: typed, authenticated reads against the apps/api `/admin/*` surface
// via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER touches the database directly —
// every cross-tenant read goes through the audited api endpoints (ADR-0011 / ADR-0034). The slice's only seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { SetAuthEnforcementInput } from "@leadwolf/types";
import type { TenantDetail, TenantRow } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/tenants — the cross-tenant directory (bounded by the api). */
export async function fetchTenants(): Promise<TenantRow[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/tenants`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load tenants"));
  const body = (await res.json()) as { tenants: TenantRow[] };
  return body.tenants;
}

/** GET /admin/tenants/:id — one org plus its workspaces + members. */
export async function fetchTenantDetail(id: string): Promise<TenantDetail> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load tenant"));
  return (await res.json()) as TenantDetail;
}

/**
 * POST /admin/tenants/:id/auth-enforcement — set (or clear, the break-glass direction) a tenant's per-tenant
 * P1-01 enforcement master switch. The EXISTING audited endpoint (admin.set_auth_enforcement); this adds no
 * new route. super_admin-gated server-side (requireStaffRole) — the real boundary; the body is the shared
 * `setAuthEnforcementSchema` contract. Returns the server's resulting state.
 */
export async function setAuthEnforcement(tenantId: string, enabled: boolean): Promise<boolean> {
  const body: SetAuthEnforcementInput = { enabled };
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/auth-enforcement`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update auth enforcement"));
  const data = (await res.json()) as { enforcementEnabled: boolean };
  return data.enforcementEnabled;
}

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

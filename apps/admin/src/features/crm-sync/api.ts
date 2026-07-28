// api.ts — the staff CRM-sync monitor's only seam to the backend. One typed, authenticated read against the
// apps/api `/admin/crm/sync-health` surface (fetchWithAuth, ADR-0016). No direct DB access from the console
// (ADR-0011 / ADR-0034).
//
// Every call writes a platform_audit_log row server-side BEFORE the read runs (ADR-0032): reaching across
// tenants is the auditable event, so opening this page is itself recorded.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { StaffCrmConnection } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/crm/sync-health — fleet-wide CRM connection health. Audited cross-tenant read. */
export async function fetchCrmSyncHealth(): Promise<StaffCrmConnection[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/crm/sync-health`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load CRM sync health"));
  return ((await res.json()) as { connections: StaffCrmConnection[] }).connections;
}

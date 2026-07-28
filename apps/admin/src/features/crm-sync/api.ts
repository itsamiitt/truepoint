// api.ts — the staff CRM-sync monitor's only seam to the backend. One typed, authenticated read against the
// apps/api `/admin/crm/sync-health` surface (fetchWithAuth, ADR-0016). No direct DB access from the console
// (ADR-0011 / ADR-0034).
//
// Every call writes a platform_audit_log row server-side BEFORE the read runs (ADR-0032): reaching across
// tenants is the auditable event, so opening this page is itself recorded.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { StaffCrmConnection, StaffCrmDeadLetter } from "./types";

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

/** GET /admin/crm/dead-letters — fleet-wide open poison jobs. Audited cross-tenant read. */
export async function fetchCrmDeadLetters(): Promise<StaffCrmDeadLetter[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/crm/dead-letters`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the dead-letter queue"));
  return ((await res.json()) as { deadLetters: StaffCrmDeadLetter[] }).deadLetters;
}

/**
 * Triage one dead letter. `retrying` records the operator's INTENT to replay — it does not itself
 * re-enqueue, because re-driving a poison job spends the customer's CRM quota and can re-attempt a write
 * that failed for a reason nobody has diagnosed.
 */
export async function triageCrmDeadLetter(
  id: string,
  status: "retrying" | "resolved" | "ignored",
): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/crm/dead-letters/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update that dead letter"));
}

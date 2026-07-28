// api.ts — the CRM-sync slice's only seam to the backend (crm-sync 00 §9). Typed, authenticated reads of the
// workspace-scoped endpoints, using the same fetchWithAuth + problemMessage pattern as the other slices.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  CrmConflictView,
  CrmConnectionView,
  CrmMappingView,
  CrmSyncRunView,
  CrmSyncStreamView,
} from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export async function fetchCrmConnections(): Promise<CrmConnectionView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/crm/connections`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your CRM connections"));
  return ((await res.json()) as { connections: CrmConnectionView[] }).connections;
}

export async function fetchCrmRuns(connectionId: string): Promise<CrmSyncRunView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/crm/connections/${connectionId}/runs`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load recent sync activity"));
  return ((await res.json()) as { runs: CrmSyncRunView[] }).runs;
}

export async function fetchCrmStreams(connectionId: string): Promise<CrmSyncStreamView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/crm/connections/${connectionId}/streams`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load sync state"));
  return ((await res.json()) as { streams: CrmSyncStreamView[] }).streams;
}

export async function fetchCrmConflicts(): Promise<CrmConflictView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/crm/conflicts`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the review queue"));
  return ((await res.json()) as { conflicts: CrmConflictView[] }).conflicts;
}

/** Close one review-queue row. The server records who decided and refuses a second transition. */
export async function resolveCrmConflict(
  conflictId: string,
  status: "resolved" | "ignored",
): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/crm/conflicts/${conflictId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update that conflict"));
}

export async function fetchCrmMappings(connectionId: string): Promise<CrmMappingView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/crm/connections/${connectionId}/mappings`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your field mappings"));
  return ((await res.json()) as { mappings: CrmMappingView[] }).mappings;
}

/** Edit one mapping's POLICY. tpField/crmField are not editable — see the schema's note on re-pointing. */
export async function updateCrmMapping(
  id: string,
  patch: { direction?: string; authority?: string; enabled?: boolean },
): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/crm/mappings/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update that mapping"));
}

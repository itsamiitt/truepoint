// api.ts — the Compliance slice's data access: a typed, authenticated read against the apps/api
// `/admin/compliance/*` surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER
// touches the database directly — the cross-tenant read goes through the audited, compliance:read-gated endpoint.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DsarRequest, GlobalSuppression, RetentionPolicy, SubProcessor } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/compliance/dsars — the DSAR request queue (newest first), optionally filtered by status. */
export async function fetchDsars(status?: string): Promise<DsarRequest[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/compliance/dsars${qs}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load DSAR requests"));
  const body = (await res.json()) as { dsars: DsarRequest[] };
  return body.dsars;
}

/** POST /admin/compliance/dsars/:id/status — advance a DSAR (verifying|processing|rejected; compliance:manage).
 *  'completed' is intentionally not settable from the console — fulfilment records that, not a manual flag. */
export async function transitionDsar(
  id: string,
  status: "verifying" | "processing" | "rejected",
  reason?: string,
): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/compliance/dsars/${encodeURIComponent(id)}/status`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the DSAR"));
}

/** GET /admin/compliance/suppression — the global blocklist. */
export async function fetchGlobalSuppression(): Promise<GlobalSuppression[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/compliance/suppression`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the blocklist"));
  const body = (await res.json()) as { entries: GlobalSuppression[] };
  return body.entries;
}

/** POST /admin/compliance/suppression — block a domain globally (compliance:manage). */
export async function addGlobalSuppression(domain: string, reason?: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/compliance/suppression`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain, ...(reason ? { reason } : {}) }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not add the block"));
}

/** POST /admin/compliance/suppression/:id/remove — lift a global block (compliance:manage). */
export async function removeGlobalSuppression(id: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/compliance/suppression/${encodeURIComponent(id)}/remove`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not remove the block"));
}

export interface RetentionPolicyInput {
  entity: string;
  field: string | null;
  retentionDays: number;
  reason: string | null;
}

/** GET /admin/compliance/retention — the retention-policy list. */
export async function fetchRetention(): Promise<RetentionPolicy[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/compliance/retention`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load retention policies"));
  const body = (await res.json()) as { policies: RetentionPolicy[] };
  return body.policies;
}

/** POST /admin/compliance/retention — create a retention policy (compliance:manage). */
export async function createRetention(input: RetentionPolicyInput): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/compliance/retention`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the policy"));
}

/** PUT /admin/compliance/retention/:id — update a retention policy (compliance:manage). */
export async function updateRetention(id: string, input: RetentionPolicyInput): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/compliance/retention/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the policy"));
}

/** POST /admin/compliance/retention/:id/active — enable/retire a policy (compliance:manage). */
export async function setRetentionActive(id: string, active: boolean): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/compliance/retention/${encodeURIComponent(id)}/active`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the policy"));
}

export interface SubProcessorInput {
  name: string;
  purpose: string;
  location: string;
  dpaUrl?: string;
  sortOrder: number;
}

/** GET /admin/compliance/sub-processors — the GDPR Art. 28 sub-processor registry. */
export async function fetchSubProcessors(): Promise<SubProcessor[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/compliance/sub-processors`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load sub-processors"));
  const body = (await res.json()) as { subProcessors: SubProcessor[] };
  return body.subProcessors;
}

/** POST /admin/compliance/sub-processors — add a sub-processor (compliance:manage). */
export async function createSubProcessor(input: SubProcessorInput): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/compliance/sub-processors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the sub-processor"));
}

/** PUT /admin/compliance/sub-processors/:id — update a sub-processor (compliance:manage). */
export async function updateSubProcessor(id: string, input: SubProcessorInput): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/compliance/sub-processors/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the sub-processor"));
}

/** POST /admin/compliance/sub-processors/:id/active — remove/restore a sub-processor (compliance:manage). */
export async function setSubProcessorActive(id: string, active: boolean): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/compliance/sub-processors/${encodeURIComponent(id)}/active`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the sub-processor"));
}

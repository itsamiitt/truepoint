// api.ts — the settings-compliance slice's data access (08 §3/§4, 12 §4): adding a suppression entry
// (authenticated) and submitting a DSAR (PUBLIC, session-less). Suppression rides fetchWithAuth and the
// in-memory access token (ADR-0016); the DSAR intake uses a plain credentialed-less fetch because the
// subject is not a signed-in user. The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { SuppressionListItem, SuppressionMatchType, SuppressionScope } from "@leadwolf/types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** The suppression scopes a workspace/tenant admin can add (global rows are platform-managed — 08 §3). */
export type AddableScope = Exclude<SuppressionScope, "global">;
/** The match types exposed at MVP (phone blind-indexing lands with the verifier wiring — 08 §3). */
export type AddableMatchType = Exclude<SuppressionMatchType, "phone">;

export interface SuppressionInput {
  scope: AddableScope;
  match_type: AddableMatchType;
  email?: string;
  domain?: string;
  contact_id?: string;
  reason?: string;
}

export interface DsarInput {
  request_type: "access" | "delete" | "rectify";
  email: string;
}

export interface DsarReceipt {
  id: string;
  status: "received";
}

/** Add a suppression entry; gates BOTH reveals and sends, in-transaction (08 §3). */
export async function addSuppression(input: SuppressionInput): Promise<{ id: string }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/compliance/suppression`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not add suppression entry"));
  return (await res.json()) as { id: string };
}

/** List the workspace's manageable suppression entries (masked — email/phone surface by type only). */
export async function listSuppressions(): Promise<SuppressionListItem[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/compliance/suppression`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the suppression list"));
  const body = (await res.json()) as { entries: SuppressionListItem[] };
  return body.entries;
}

/** Remove a suppression entry by id (RLS limits removal to the caller's own scope). */
export async function removeSuppression(id: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/compliance/suppression/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not remove the entry"));
}

/** Submit a DSAR via the PUBLIC, session-less intake (plain fetch, not fetchWithAuth — 08 §4). */
export async function submitDsar(input: DsarInput): Promise<DsarReceipt> {
  const res = await fetch(`${API_BASE}/api/v1/compliance/dsar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not submit request"));
  return (await res.json()) as DsarReceipt;
}

// enrichApi.ts — the per-record enrichment/refresh triggers (linkedin-source-ingestion §customer UI).
//
// Both calls ride the SHIPPED enrichment contract: POST /api/v1/enrichment/:entity/:id. The contact
// trigger pins providerOrder to linkedin_api (a PREFIX, not an allowlist — the rest of the waterfall still
// cascades if LinkedIn misses), asks for every enrichable field, and is metered exactly like any
// enrichment. The account trigger is 202-only (provider I/O never runs on a request thread) and is dark
// until LINKEDIN_ACCOUNT_REFRESH_ENABLED — a 400/404 from it reads as "not available", which the button
// surfaces honestly.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { toApiError } from "./api";

/** 202 → {queued:true, jobId}; 200 → the inline enrichment result (flag-off path). */
export interface RefreshTriggerResult {
  queued: boolean;
  jobId: string | null;
}

export async function refreshContactFromSource(contactId: string): Promise<RefreshTriggerResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/enrichment/contact/${contactId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fields: ["email", "phone", "jobTitle", "seniorityLevel", "department"],
      providerOrder: ["linkedin_api"],
    }),
  });
  if (!res.ok) throw await toApiError(res, "Could not refresh from LinkedIn");
  if (res.status === 202) {
    const body = (await res.json()) as { queued: boolean; jobId: string };
    return { queued: true, jobId: body.jobId };
  }
  await res.json(); // inline result — the caller re-reads via query invalidation, not from this body
  return { queued: false, jobId: null };
}

export async function refreshAccountFromSource(accountId: string): Promise<RefreshTriggerResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/enrichment/account/${accountId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: ["jobTitle"] }), // body schema requires fields; the account lane ignores them
  });
  if (!res.ok) throw await toApiError(res, "Could not refresh company data");
  const body = (await res.json()) as { queued: boolean; jobId: string };
  return { queued: true, jobId: body.jobId };
}

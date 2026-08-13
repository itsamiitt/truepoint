// api.ts — the Auto-enrich settings backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the
// /settings/auto-enrich routes (G-ENR-1; 09 §3). A 404/501 means "not built yet" — surfaced as null so the
// panel degrades to a disabled state instead of erroring. No fabricated policy, no fake saves.

import { fetchWithAuth } from "@/lib/authClient";
import { isUnavailable } from "@/lib/maybeList";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type {
  EnrichField,
  EnrichTrigger,
  ProviderPriority,
  VerificationPolicy,
} from "@leadwolf/types";
import type { AutoEnrichPolicy } from "./types";

/** Current workspace's auto-enrich policy + month-to-date spend. null when the route isn't built yet. */
export async function fetchAutoEnrichPolicy(): Promise<AutoEnrichPolicy | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/settings/auto-enrich`);
  if (isUnavailable(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the auto-enrich policy"));
  return (await res.json()) as AutoEnrichPolicy;
}

/** The editable subset of the policy (everything except the read-only month-to-date spend). Sparse —
 *  the server PATCH merges; absent fields keep their stored value (arrays replace whole). */
export interface AutoEnrichPolicyPatch {
  enabled?: boolean;
  triggers?: EnrichTrigger[];
  fieldAllowlist?: EnrichField[];
  monthlyBudgetMicros?: number;
  providerPriority?: ProviderPriority;
  verification?: VerificationPolicy;
}

/** Save the policy. Returns the resolved policy, or null when the route isn't built yet (404/501). */
export async function saveAutoEnrichPolicy(
  patch: AutoEnrichPolicyPatch,
): Promise<AutoEnrichPolicy | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/settings/auto-enrich`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (isUnavailable(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the auto-enrich policy"));
  return (await res.json()) as AutoEnrichPolicy;
}

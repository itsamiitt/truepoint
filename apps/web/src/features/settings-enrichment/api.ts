// api.ts — the Auto-enrich settings backend seam: authenticated calls (fetchWithAuth, ADR-0016) to the
// /settings/auto-enrich routes (G-ENR-1; 09 §3). A 404/501 means "not built yet" — surfaced as null so the
// panel degrades to a disabled state instead of erroring. No fabricated policy, no fake saves.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { EnrichField, EnrichTrigger } from "@leadwolf/types";
import type { AutoEnrichPolicy } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

/** Current workspace's auto-enrich policy + month-to-date spend. null when the route isn't built yet. */
export async function fetchAutoEnrichPolicy(): Promise<AutoEnrichPolicy | null> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/settings/auto-enrich`);
  if (notBuilt(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the auto-enrich policy"));
  return (await res.json()) as AutoEnrichPolicy;
}

/** The editable subset of the policy (everything except the read-only month-to-date spend). */
export interface AutoEnrichPolicyPatch {
  enabled: boolean;
  triggers: EnrichTrigger[];
  fieldAllowlist: EnrichField[];
  monthlyBudgetMicros: number;
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
  if (notBuilt(res.status)) return null;
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the auto-enrich policy"));
  return (await res.json()) as AutoEnrichPolicy;
}

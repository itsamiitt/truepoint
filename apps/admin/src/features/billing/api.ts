// api.ts — the Billing economics slice's data access: a typed, authenticated read against the apps/api
// `/admin/billing/*` surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER
// touches the database directly — the cross-tenant aggregate read goes through the audited api endpoint.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { EconomicsSummary } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/billing/economics?sinceDays=N — the credit-economics rollup for the trailing window. */
export async function fetchEconomics(sinceDays: number): Promise<EconomicsSummary> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/billing/economics?sinceDays=${encodeURIComponent(sinceDays)}`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load economics"));
  const body = (await res.json()) as { summary: EconomicsSummary };
  return body.summary;
}

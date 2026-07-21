// api.ts — the Overview slice's data access: a typed, authenticated GET against the forge-api `/bff/overview`
// surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER touches the database —
// every read goes through the forge-api BFF. The slice's only seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { OverviewSummary } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /bff/overview — the operator-console dashboard summary (KPIs + recent captures). */
export async function fetchOverview(): Promise<OverviewSummary> {
  const res = await fetchWithAuth(`${API_BASE}/bff/overview`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the overview"));
  return (await res.json()) as OverviewSummary;
}

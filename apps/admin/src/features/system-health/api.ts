// api.ts — the System health slice's data access: a single typed, authenticated read against the apps/api
// `/admin/system-health` surface via the in-memory access token (fetchWithAuth, ADR-0016). No direct DB
// access from the console (ADR-0011 / ADR-0034). The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { SystemHealth } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/system-health — service status + the bulk-enrichment job queue/DLQ summary. */
export async function fetchSystemHealth(): Promise<SystemHealth> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/system-health`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load system health"));
  return (await res.json()) as SystemHealth;
}

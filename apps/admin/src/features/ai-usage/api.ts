// api.ts — the AI-usage slice's data access: a single typed, authenticated read against the apps/api
// `/admin/ai-usage` surface via the in-memory access token (fetchWithAuth, ADR-0016). No direct DB access from
// the console (ADR-0011 / ADR-0034). The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { AiUsageReport } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/ai-usage?days=N — cross-tenant AI NL-search metering over the window. */
export async function fetchAiUsage(days: number): Promise<AiUsageReport> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/ai-usage?days=${days}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load AI usage"));
  return (await res.json()) as AiUsageReport;
}

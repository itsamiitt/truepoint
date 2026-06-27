// api.ts — the Compliance slice's data access: a typed, authenticated read against the apps/api
// `/admin/compliance/*` surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER
// touches the database directly — the cross-tenant read goes through the audited, compliance:read-gated endpoint.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DsarRequest } from "./types";

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

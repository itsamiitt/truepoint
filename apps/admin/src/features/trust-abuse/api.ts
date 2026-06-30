// api.ts — the Trust & abuse slice's data access: a single typed, authenticated read against the apps/api
// `/admin/trust-abuse` surface via the in-memory access token (fetchWithAuth, ADR-0016). No direct DB access
// from the console (ADR-0011 / ADR-0034). The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { TrustAbuse } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/trust-abuse — cross-tenant signup velocity, active holds and the tenant-status mix. */
export async function fetchTrustAbuse(): Promise<TrustAbuse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/trust-abuse`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load trust signals"));
  return (await res.json()) as TrustAbuse;
}

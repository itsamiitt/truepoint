// api.ts — the Audit log slice's data access: a typed, authenticated read against the apps/api `/admin/*`
// surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER touches the database
// directly — the cross-tenant read goes through the audited api endpoint (ADR-0011 / ADR-0034). The only seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { PlatformAuditEntry } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/audit-log — the most recent platform audit entries (bounded by the api, newest first). */
export async function fetchAuditLog(): Promise<PlatformAuditEntry[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/audit-log`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load audit log"));
  const body = (await res.json()) as { entries: PlatformAuditEntry[] };
  return body.entries;
}

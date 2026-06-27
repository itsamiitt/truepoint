// api.ts — the Audit log slice's data access: typed, authenticated reads against the apps/api `/admin/*`
// surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER touches the database
// directly — the cross-tenant read goes through the audited api endpoint (ADR-0011 / ADR-0034). The only seam.
// Supports keyset pagination (cursor), AND-combined filters, and an authenticated CSV export download (13a F4).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { AuditLogFilters, PlatformAuditEntry } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

const PAGE_SIZE = 50;

/** Build the query string from the filters (+ optional cursor/limit), omitting empty fields. */
function buildQuery(filters: AuditLogFilters, cursor?: string, limit?: number): string {
  const p = new URLSearchParams();
  if (filters.action) p.set("action", filters.action);
  if (filters.tenantId) p.set("tenantId", filters.tenantId);
  if (filters.actorUserId) p.set("actorUserId", filters.actorUserId);
  if (filters.since) p.set("since", filters.since);
  if (filters.until) p.set("until", filters.until);
  if (cursor) p.set("cursor", cursor);
  if (limit != null) p.set("limit", String(limit));
  return p.toString();
}

export interface AuditLogPage {
  entries: PlatformAuditEntry[];
  nextCursor: string | null;
}

/** GET /admin/audit-log — one keyset page of entries (newest first), AND-filtered. */
export async function fetchAuditLog(
  filters: AuditLogFilters,
  cursor?: string,
): Promise<AuditLogPage> {
  const qs = buildQuery(filters, cursor, PAGE_SIZE);
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/audit-log?${qs}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load audit log"));
  return (await res.json()) as AuditLogPage;
}

/** GET /admin/audit-log/export — download the filtered entries as CSV. The export is authenticated (so we
 *  fetch the blob with the bearer token, then trigger a client-side download) and is itself audited server-side. */
export async function exportAuditLog(filters: AuditLogFilters): Promise<void> {
  const qs = buildQuery(filters);
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/audit-log/export?${qs}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not export audit log"));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "platform-audit-log.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

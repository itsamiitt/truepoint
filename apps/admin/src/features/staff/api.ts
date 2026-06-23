// api.ts — the Staff RBAC slice's data access: typed, authenticated calls against the apps/api `/admin/staff`
// surface via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER touches the database
// directly — every grant/revoke goes through the audited, super_admin-gated api endpoints (ADR-0011). The
// slice's only seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { StaffMember, StaffRole } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/staff — the platform-staff directory (active + revoked). */
export async function fetchStaff(): Promise<StaffMember[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/staff`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load staff"));
  const body = (await res.json()) as { staff: StaffMember[] };
  return body.staff;
}

/** POST /admin/staff — grant (or re-grant) a staff role to a user. */
export async function grantStaff(userId: string, staffRole: StaffRole): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/staff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, staffRole }),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not grant the staff role"));
}

/** DELETE /admin/staff/:userId — revoke a user's staff role. */
export async function revokeStaff(userId: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/staff/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not revoke the staff role"));
}

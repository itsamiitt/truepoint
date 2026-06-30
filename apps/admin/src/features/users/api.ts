// api.ts — the Users slice's data access: a typed, authenticated read against the apps/api `/admin/*` surface
// via the in-memory access token (fetchWithAuth, ADR-0016). The console NEVER touches the database directly —
// the cross-tenant read goes through the audited api endpoint (ADR-0011 / ADR-0034). The slice's only seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { PlatformUser } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export interface UsersPage {
  users: PlatformUser[];
  nextCursor: string | null;
}

/** GET /admin/users — one keyset page of the directory, optionally filtered by an email/name search (13a F5). */
export async function fetchUsers(
  opts: { search?: string; status?: string; cursor?: string } = {},
): Promise<UsersPage> {
  const p = new URLSearchParams();
  if (opts.search) p.set("search", opts.search);
  if (opts.status) p.set("status", opts.status);
  if (opts.cursor) p.set("cursor", opts.cursor);
  const qs = p.toString();
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/users${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load users"));
  return (await res.json()) as UsersPage;
}

/** POST /admin/users/:id/deactivate — suspend a user (super_admin|support). Reason is audited. */
export async function deactivateUser(id: string, reason: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/users/${encodeURIComponent(id)}/deactivate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not deactivate the user"));
}

/** POST /admin/users/:id/reactivate — restore a suspended user (super_admin|support). Reason is audited. */
export async function reactivateUser(id: string, reason: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/users/${encodeURIComponent(id)}/reactivate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not reactivate the user"));
}

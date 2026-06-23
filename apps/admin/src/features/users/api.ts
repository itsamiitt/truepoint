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

/** GET /admin/users — the cross-tenant user directory (bounded by the api). */
export async function fetchUsers(): Promise<PlatformUser[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/users`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load users"));
  const body = (await res.json()) as { users: PlatformUser[] };
  return body.users;
}

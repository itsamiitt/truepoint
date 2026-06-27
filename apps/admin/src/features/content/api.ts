// api.ts — the Content (announcements) slice's data access: typed, authenticated calls against the apps/api
// `/admin/announcements` surface via the in-memory access token (fetchWithAuth, ADR-0016). All reads/writes go
// through the audited, content:manage-gated endpoints.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { Announcement } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

export interface AnnouncementInput {
  title: string;
  body: string;
  level: string;
  audience: string;
  tenantTarget: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

/** GET /admin/announcements — the full authoring list (active + retired). */
export async function fetchAnnouncements(): Promise<Announcement[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/announcements`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load announcements"));
  const body = (await res.json()) as { announcements: Announcement[] };
  return body.announcements;
}

/** POST /admin/announcements — publish a new announcement. */
export async function createAnnouncement(input: AnnouncementInput): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/announcements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not publish the announcement"));
}

/** PUT /admin/announcements/:id — update an announcement. */
export async function updateAnnouncement(id: string, input: AnnouncementInput): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/announcements/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the announcement"));
}

/** POST /admin/announcements/:id/active — show or retire an announcement. */
export async function setAnnouncementActive(id: string, active: boolean): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/admin/announcements/${encodeURIComponent(id)}/active`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the announcement"));
}

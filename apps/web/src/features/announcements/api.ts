// api.ts — the customer announcements read (13a Area 10): the active in-app banners for the signed-in tenant,
// from the apps/api `/announcements` surface (authn + tenancy resolve the org server-side). Failure is
// non-fatal — the banner simply doesn't render.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";

export interface ActiveAnnouncement {
  id: string;
  title: string;
  body: string;
  level: string; // info | warning | critical
  type: string; // general | maintenance (maintenance = site-wide, non-dismissible)
}

export async function fetchActiveAnnouncements(): Promise<ActiveAnnouncement[]> {
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/v1/announcements`);
    if (!res.ok) return [];
    const body = (await res.json()) as { announcements?: ActiveAnnouncement[] };
    return body.announcements ?? [];
  } catch {
    return [];
  }
}

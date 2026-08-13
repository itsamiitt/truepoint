// api.ts — data access for the notifications history page (G-NTF-1). Reads the keyset-paginated feed and the
// per-item / bulk mark-read, all via fetchWithAuth. The top-bar bell (shell/useNotifications) is the compact
// latest-20 view; this slice is the full, paginated history. The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { problemMessage } from "@/lib/problemMessage";
import { API_BASE } from "@/lib/publicConfig";
import type { NotificationsPage } from "@leadwolf/types";

/** GET /notifications — one keyset page of the caller's history (+ the live unread count). */
export async function fetchNotificationsPage(cursor?: string): Promise<NotificationsPage> {
  const params = new URLSearchParams({ limit: "30" });
  if (cursor) params.set("cursor", cursor);
  const res = await fetchWithAuth(`${API_BASE}/api/v1/notifications?${params}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load notifications"));
  return (await res.json()) as NotificationsPage;
}

/** POST /notifications/:id/read — mark one read. */
export async function markNotificationRead(id: string): Promise<void> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/notifications/${encodeURIComponent(id)}/read`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update the notification"));
}

/** POST /notifications/read-all — mark all unread read. */
export async function markAllNotificationsRead(): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/notifications/read-all`, { method: "POST" });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not mark all read"));
}

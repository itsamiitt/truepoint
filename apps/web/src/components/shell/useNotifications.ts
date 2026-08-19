// useNotifications.ts — the top-bar bell's data (11 §3 / G-NTF-1). Now backed by the REAL notification feed
// (GET /api/v1/notifications) — the workspace-scoped, per-user store — replacing the earlier client-derived
// stub. Maps each server Notification to the bell's view shape (tone + deep-link href), tracks the server's
// unread count, and `dismiss` marks one read (optimistic remove + badge decrement, persisted via POST
// /:id/read). Polls on an interval so the badge stays truthful without a realtime channel; a credit-spending
// action invalidates the same key, which is what the "credits:changed" window event used to do by hand.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { realtimeStreamState } from "@/lib/eventStream";
import { API_BASE } from "@/lib/publicConfig";
import { sharedKeys } from "@/lib/queryKeys";
import type { Notification, NotificationType } from "@leadwolf/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

export type NotificationTone = "warning" | "success" | "muted";

export interface AppNotification {
  id: string;
  tone: NotificationTone;
  title: string;
  detail: string;
  href: string;
}

/** Badge/feed refresh cadence (ms) while the realtime stream is dark — the poll IS the signal then. */
const POLL_MS = 60_000;
/** Backstop cadence while the SSE stream is LIVE (perf-audit P3.8a): notification.created events invalidate
 *  the feed the moment a row lands (RealtimeBridge), so a permanent per-tab-per-minute floor of requests —
 *  ~24k/h at a 200-seat customer with two tabs each — buys nothing; the slow poll only covers missed frames. */
const BACKSTOP_POLL_MS = 5 * 60_000;

const TONE: Record<NotificationType, NotificationTone> = {
  low_credits: "warning",
  reply_received: "success",
  import_complete: "muted",
  dsar_update: "muted",
  // A saved contact changing jobs is a warning, not information: the next email to them bounces and the next
  // call reaches someone who left. Muting it beside "your import finished" is how it goes unread.
  job_change: "warning",
  // Opt-in market signal on a watched account — news, not danger. The subscriber asked for it.
  account_signal: "muted",
  system: "muted",
};

const TYPE_HREF: Record<NotificationType, string> = {
  low_credits: "/settings/billing",
  reply_received: "/inbox",
  import_complete: "/imports",
  dsar_update: "/settings",
  // Falls back only when the row carries no entity; job_change always does, so hrefFor deep-links to the
  // contact and this is the safety net.
  job_change: "/prospect",
  account_signal: "/signals",
  system: "/home",
};

/** Deep-link: prefer the entity link when the row carries one; else the type's default destination. An import
 *  notification carries entity ('import_job', jobId) — link straight to that durable job page (11 §5, S-U5). */
function hrefFor(n: Notification): string {
  if (n.entityType === "contact" && n.entityId) return `/prospect?contact=${n.entityId}`;
  if (n.entityType === "import_job" && n.entityId) return `/imports/${n.entityId}`;
  return TYPE_HREF[n.type] ?? "/home";
}

function toApp(n: Notification): AppNotification {
  return {
    id: n.id,
    tone: TONE[n.type] ?? "muted",
    title: n.title,
    detail: n.body ?? "",
    href: hrefFor(n),
  };
}

interface NotificationsState {
  items: AppNotification[];
  unreadCount: number;
  dismiss: (id: string) => void;
  markAll: () => void;
  loading: boolean;
}

interface NotificationFeed {
  notifications: Notification[];
  unreadCount: number;
}

const EMPTY: NotificationFeed = { notifications: [], unreadCount: 0 };

async function fetchFeed(signal?: AbortSignal): Promise<NotificationFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/notifications?limit=20`, { signal });
  // Best-effort: the bell stays quiet rather than surfacing a network blip as a notification. Returning the
  // empty feed rather than throwing keeps that behaviour — an error state would light up the top bar.
  if (!res.ok) return EMPTY;
  return (await res.json()) as NotificationFeed;
}

export function useNotifications(): NotificationsState {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: sharedKeys.notifications(),
    queryFn: ({ signal }) => fetchFeed(signal),
    // The hand-rolled setInterval kept polling while the tab was hidden and while the request was already in
    // flight. RQ pauses the interval for a background tab and never overlaps a fetch with itself.
    // Cadence follows the stream (P3.8a): pushed events are the primary signal once the SSE stream is live,
    // so the poll drops to the backstop; while realtime is dark or unknown, the short poll stays the signal.
    refetchInterval: () => (realtimeStreamState() === "active" ? BACKSTOP_POLL_MS : POLL_MS),
  });
  const feed = query.data ?? EMPTY;

  /** Both mark-read calls are optimistic: the cache is patched first, and a failed write is repaired by the
   *  next poll (or by the settled invalidation) rather than by rolling the UI back under the user. */
  const patch = useCallback(
    (fn: (feed: NotificationFeed) => NotificationFeed) => {
      qc.setQueryData<NotificationFeed>(sharedKeys.notifications(), (old) => fn(old ?? EMPTY));
    },
    [qc],
  );

  const markRead = useMutation({
    mutationFn: (id: string) =>
      fetchWithAuth(`${API_BASE}/api/v1/notifications/${encodeURIComponent(id)}/read`, {
        method: "POST",
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: sharedKeys.notifications() }),
  });

  const markAllRead = useMutation({
    mutationFn: () =>
      fetchWithAuth(`${API_BASE}/api/v1/notifications/read-all`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: sharedKeys.notifications() }),
  });

  const dismiss = useCallback(
    (id: string) => {
      patch((old) => {
        const target = old.notifications.find((n) => n.id === id);
        return {
          notifications: old.notifications.filter((n) => n.id !== id),
          // Only decrement when the row was actually unread, or dismissing a read row would drift the badge.
          unreadCount:
            target && target.readAt === null ? Math.max(0, old.unreadCount - 1) : old.unreadCount,
        };
      });
      markRead.mutate(id);
    },
    [patch, markRead],
  );

  const markAll = useCallback(() => {
    // Mark every loaded row read as well as zeroing the badge, so a later dismiss cannot double-decrement.
    patch((old) => ({
      notifications: old.notifications.map((n) =>
        n.readAt ? n : { ...n, readAt: new Date().toISOString() },
      ),
      unreadCount: 0,
    }));
    markAllRead.mutate();
  }, [patch, markAllRead]);

  const items = useMemo(() => feed.notifications.map(toApp), [feed.notifications]);

  return { items, unreadCount: feed.unreadCount, dismiss, markAll, loading: query.isPending };
}

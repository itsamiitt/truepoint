// useNotifications.ts — the top-bar bell's data (11 §3 / G-NTF-1). Now backed by the REAL notification feed
// (GET /api/v1/notifications) — the workspace-scoped, per-user store — replacing the earlier client-derived
// stub. Maps each server Notification to the bell's view shape (tone + deep-link href), tracks the server's
// unread count, and `dismiss` marks one read (optimistic remove + badge decrement, persisted via POST
// /:id/read). Polls on an interval + on the existing "credits:changed" signal so the badge stays truthful.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { Notification, NotificationType } from "@leadwolf/types";
import { useCallback, useEffect, useMemo, useState } from "react";

export type NotificationTone = "warning" | "success" | "muted";

export interface AppNotification {
  id: string;
  tone: NotificationTone;
  title: string;
  detail: string;
  href: string;
}

/** Badge/feed refresh cadence (ms) — keeps the count truthful without a realtime channel. */
const POLL_MS = 60_000;

const TONE: Record<NotificationType, NotificationTone> = {
  low_credits: "warning",
  reply_received: "success",
  import_complete: "muted",
  dsar_update: "muted",
  system: "muted",
};

const TYPE_HREF: Record<NotificationType, string> = {
  low_credits: "/settings/billing",
  reply_received: "/inbox",
  import_complete: "/imports",
  dsar_update: "/settings",
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

export function useNotifications(): NotificationsState {
  const [raw, setRaw] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/v1/notifications?limit=20`);
      if (!res.ok) return;
      const data = (await res.json()) as { notifications: Notification[]; unreadCount: number };
      setRaw(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // Best-effort: the bell stays quiet (empty) rather than surfacing a network blip as a notification.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener("credits:changed", onChange);
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.removeEventListener("credits:changed", onChange);
      window.clearInterval(timer);
    };
  }, [load]);

  const dismiss = useCallback(
    (id: string) => {
      const target = raw.find((n) => n.id === id);
      // Optimistic: drop it from the dropdown; only decrement the badge if it was actually unread.
      setRaw((prev) => prev.filter((n) => n.id !== id));
      if (target && target.readAt === null) setUnreadCount((c) => Math.max(0, c - 1));
      void fetchWithAuth(`${API_BASE}/api/v1/notifications/${encodeURIComponent(id)}/read`, {
        method: "POST",
      }).catch(() => {
        // If the mark-read fails, the next poll re-syncs the true state.
      });
    },
    [raw],
  );

  const markAll = useCallback(() => {
    // Optimistic: zero the badge + mark every loaded row read (so a later dismiss won't double-decrement).
    setRaw((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnreadCount(0);
    void fetchWithAuth(`${API_BASE}/api/v1/notifications/read-all`, { method: "POST" }).catch(
      () => {
        // If it fails, the next poll re-syncs the true unread count.
      },
    );
  }, []);

  const items = useMemo(() => raw.map(toApp), [raw]);

  return { items, unreadCount, dismiss, markAll, loading };
}

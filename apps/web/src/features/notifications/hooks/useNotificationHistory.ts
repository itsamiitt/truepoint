// useNotificationHistory.ts — view state for the notifications history page: the keyset-paginated feed with a
// "Load more" cursor, per-item + bulk mark-read (optimistic, persisted), and the live unread count. Presentation
// state only; the store is server-side (G-NTF-1). Separate from the bell's compact hook (shell/useNotifications).
"use client";

import type { Notification } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchNotificationsPage, markAllNotificationsRead, markNotificationRead } from "../api";

export function useNotificationHistory() {
  const [items, setItems] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchNotificationsPage();
      setItems(page.notifications);
      setCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load notifications");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchNotificationsPage(cursor);
      setItems((prev) => [...prev, ...page.notifications]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor]);

  const markRead = useCallback((id: string) => {
    setItems((prev) => {
      let wasUnread = false;
      const next = prev.map((n) => {
        if (n.id !== id || n.readAt !== null) return n;
        wasUnread = true;
        return { ...n, readAt: new Date().toISOString() };
      });
      if (wasUnread) setUnreadCount((c) => Math.max(0, c - 1));
      return next;
    });
    void markNotificationRead(id).catch(() => {
      // best-effort; a reload re-syncs the true state
    });
  }, []);

  const markAll = useCallback(() => {
    setItems((prev) =>
      prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })),
    );
    setUnreadCount(0);
    void markAllNotificationsRead().catch(() => {
      // best-effort; a reload re-syncs
    });
  }, []);

  return {
    items,
    unreadCount,
    loading,
    loadingMore,
    error,
    hasMore: cursor != null,
    loadMore,
    markRead,
    markAll,
    reload: load,
  };
}

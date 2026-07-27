// useNotificationHistory.ts — the notifications history page: the keyset-paginated feed with a "Load more"
// cursor, per-item + bulk mark-read (optimistic, persisted), and the live unread count. Presentation state
// only; the store is server-side (G-NTF-1). Separate from the bell's compact hook (shell/useNotifications) —
// different endpoint shape, different page.
//
// The unread COUNT comes from the first page, which is where the server reports it. Marking read patches that
// page's count, so the number the page shows and the rows it renders move together.
"use client";

import type { Notification } from "@leadwolf/types";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { fetchNotificationsPage, markAllNotificationsRead, markNotificationRead } from "../api";
import { notificationHistoryKeys } from "../keys";

type HistoryPage = Awaited<ReturnType<typeof fetchNotificationsPage>>;
type HistoryData = { pages: HistoryPage[]; pageParams: unknown[] };

export function useNotificationHistory() {
  const qc = useQueryClient();
  const key = notificationHistoryKeys.feed();

  const query = useInfiniteQuery<HistoryPage>({
    queryKey: key,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => fetchNotificationsPage(pageParam as string | undefined),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = useMemo<Notification[]>(
    () => query.data?.pages.flatMap((page) => page.notifications) ?? [],
    [query.data],
  );

  const patch = useCallback(
    (fn: (rows: Notification[]) => Notification[], unread: (current: number) => number) => {
      qc.setQueryData<HistoryData>(key, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page, i) => ({
                ...page,
                notifications: fn(page.notifications),
                // Only page 0 carries the count; rewriting it on every page would multiply it.
                unreadCount: i === 0 ? unread(page.unreadCount) : page.unreadCount,
              })),
            }
          : old,
      );
    },
    [qc, key],
  );

  // Both writes are best-effort and deliberately do NOT roll back: a failed mark-read is repaired by the next
  // load, and reverting a row the user just dismissed under them reads as a bug.
  const markReadMutation = useMutation({ mutationFn: markNotificationRead });
  const markAllMutation = useMutation({ mutationFn: markAllNotificationsRead });

  const markRead = useCallback(
    (id: string) => {
      const wasUnread = items.some((n) => n.id === id && n.readAt === null);
      patch(
        (rows) =>
          rows.map((n) =>
            n.id === id && n.readAt === null ? { ...n, readAt: new Date().toISOString() } : n,
          ),
        (current) => (wasUnread ? Math.max(0, current - 1) : current),
      );
      markReadMutation.mutate(id);
    },
    [items, patch, markReadMutation],
  );

  const markAll = useCallback(() => {
    patch(
      (rows) => rows.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })),
      () => 0,
    );
    markAllMutation.mutate();
  }, [patch, markAllMutation]);

  return {
    items,
    unreadCount: query.data?.pages[0]?.unreadCount ?? 0,
    loading: query.isPending,
    loadingMore: query.isFetchingNextPage,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load notifications"
      : null,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    markRead,
    markAll,
    reload: () => {
      void query.refetch();
    },
  };
}

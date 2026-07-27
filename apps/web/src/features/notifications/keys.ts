// keys.ts — the notifications-history feature's TanStack Query key factory. The bell's compact feed is a
// different read with a different shape and lives in lib/queryKeys; this is the full paginated history.
export const notificationHistoryKeys = {
  all: ["notification-history"] as const,
  /** The keyset-paginated history — one infinite-query entry holding every loaded page. */
  feed: () => ["notification-history", "feed"] as const,
};

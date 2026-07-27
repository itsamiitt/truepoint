// useNotificationPrefs.ts — the per-channel notification prefs (GET /settings/user/notifications).
// Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchNotificationPrefs } from "../api";
import { settingsUserKeys } from "../keys";
import type { NotificationPrefs } from "../types";

export function useNotificationPrefs() {
  const query = useQuery<NotificationPrefs>({
    queryKey: settingsUserKeys.notificationPrefs(),
    queryFn: fetchNotificationPrefs,
  });

  return {
    data: query.data ?? null,
    loading: query.isPending,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your notification settings"
      : null,
    reload: () => {
      void query.refetch();
    },
  };
}

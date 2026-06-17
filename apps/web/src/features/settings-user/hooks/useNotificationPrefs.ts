// useNotificationPrefs.ts — loads the per-channel notification prefs (GET /settings/user/notifications) with
// loading/error state and a `reload`. Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchNotificationPrefs } from "../api";
import type { NotificationPrefs } from "../types";

export function useNotificationPrefs() {
  const [data, setData] = useState<NotificationPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchNotificationPrefs());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your notification settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}

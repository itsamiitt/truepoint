// useContent.ts — loads the announcements authoring list (GET /admin/announcements) with loading/error state
// and a `reload`. Presentation state only; the typed fetches + mutations live in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAnnouncements } from "../api";
import type { Announcement } from "../types";

export function useContent() {
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Refreshes (post-mutation reloads) report here — re-raising `loading` would blank the populated table
  // back to the StateSwitch skeleton (perf-audit P3.6).
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (opts?: { initial?: boolean }) => {
    if (opts?.initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      setAnnouncements(await fetchAnnouncements());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load announcements");
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

  return { announcements, error, loading, refreshing, reload };
}

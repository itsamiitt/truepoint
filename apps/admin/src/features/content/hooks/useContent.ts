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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAnnouncements(await fetchAnnouncements());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load announcements");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { announcements, error, loading, reload };
}

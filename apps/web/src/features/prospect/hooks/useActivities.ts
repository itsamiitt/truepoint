// useActivities.ts — loads one contact's activity timeline for the record-detail Drawer, with a `reload`.
// The timeline backend is an M8 gate, so api.fetchActivities maps a 404/501 to available:false and this hook
// surfaces that as an empty (not error) state. Presentation state only.
"use client";

import { useCallback, useEffect, useState } from "react";
import { type ActivityFeed, fetchActivities } from "../api";

export function useActivities(contactId: string | null) {
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!contactId) {
      setFeed(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchActivities(contactId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load activity");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { feed, error, loading, reload };
}

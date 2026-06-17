// useInbox.ts — loads the reply threads for the active filter (GET /inbox) with loading/error + reload.
// Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchThreads } from "../api";
import type { InboxFeed, InboxFilter } from "../types";

export function useInbox(filter: InboxFilter) {
  const [feed, setFeed] = useState<InboxFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchThreads(filter));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your inbox");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { feed, error, loading, reload };
}

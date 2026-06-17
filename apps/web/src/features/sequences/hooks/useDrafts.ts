// useDrafts.ts — loads AI/manual outreach drafts for the draft → review → send seam (05 §13/§16). Returns
// the standard { data, loading, error, reload } shape plus `available`: the drafts backend is post-MVP, so
// when it isn't wired the API helper resolves available=false (not an error) and the panel gates on "review
// required" without inventing drafts. There is deliberately NO send action here — sending stays human-
// reviewed and the send seam isn't implemented yet. Presentation state only.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDrafts } from "../api";
import type { DraftSummary } from "../types";

export function useDrafts() {
  const [data, setData] = useState<DraftSummary[]>([]);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items, available: ok } = await fetchDrafts();
      setData(items);
      setAvailable(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, available, error, loading, reload };
}

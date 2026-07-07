// useReview.ts — loads the human-review queue (GET /bff/review-tasks) with loading/error state and a `reload`.
// Presentation state only; the typed fetch lives in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchReviewTasks } from "../api";
import type { ReviewTask } from "../types";

export function useReview() {
  const [tasks, setTasks] = useState<ReviewTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await fetchReviewTasks());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load review tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { tasks, error, loading, reload };
}

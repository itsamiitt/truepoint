// useTasks.ts — loads the task list (GET /tasks) with loading/error + reload, plus done/snooze mutators that
// optimistically refresh. Presentation state only; typed fetches live in api.ts.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchTasks, updateTask } from "../api";
import type { TaskFeed, TaskStatus } from "../types";

export function useTasks() {
  const [feed, setFeed] = useState<TaskFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchTasks());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Set a task's status; returns whether the backend accepted it (false when not built yet). */
  const setStatus = useCallback(
    async (id: string, status: TaskStatus): Promise<boolean> => {
      const { ok } = await updateTask(id, status);
      if (ok) await reload();
      return ok;
    },
    [reload],
  );

  return { feed, error, loading, reload, setStatus };
}

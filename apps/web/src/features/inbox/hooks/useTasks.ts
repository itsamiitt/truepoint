// useTasks.ts — the task list (GET /tasks) plus the done/snooze status action. Presentation state only;
// typed fetches live in api.ts.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchTasks, updateTask } from "../api";
import { inboxKeys } from "../keys";
import type { TaskFeed, TaskStatus } from "../types";

export function useTasks() {
  const qc = useQueryClient();
  const key = inboxKeys.tasks();
  const query = useQuery<TaskFeed>({ queryKey: key, queryFn: fetchTasks });

  const setStatus = useMutation({
    mutationFn: (vars: { id: string; status: TaskStatus }) => updateTask(vars.id, vars.status),
    onSuccess: ({ ok }) => {
      if (ok) void qc.invalidateQueries({ queryKey: key });
    },
  });

  return {
    feed: query.data ?? null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your tasks"
      : null,
    loading: query.isPending,
    reload: () => {
      void query.refetch();
    },
    /** Set a task's status; returns whether the backend accepted it (false when not built yet). */
    setStatus: async (id: string, status: TaskStatus): Promise<boolean> =>
      (await setStatus.mutateAsync({ id, status })).ok,
  };
}

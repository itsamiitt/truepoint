// TasksPanel.tsx — the tasks list (manual + system-generated: reply received, follow-up due, low credits,
// import done, DSAR). Done / snooze per task. Empty-first; honest about the unbuilt M9 backend.
"use client";

import { EmptyState, StateSwitch, StatusBadge, TpButton, useToast } from "@leadwolf/ui";
import { ListChecks } from "lucide-react";
import { formatDue, formatRelative } from "../format";
import { useTasks } from "../hooks/useTasks";
import { TASK_SOURCE_LABEL, type InboxTask } from "../types";
import styles from "../inbox.module.css";

export function TasksPanel() {
  const toast = useToast();
  const { feed, loading, error, reload, setStatus } = useTasks();

  const act = async (task: InboxTask, status: "done" | "snoozed") => {
    const ok = await setStatus(task.id, status);
    if (ok) toast.success(status === "done" ? "Task completed" : "Task snoozed");
    else
      toast.toast({
        title: "Not available yet",
        description: "Tasks ship with the M9 inbox build.",
      });
  };

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={feed != null && feed.tasks.length === 0}
      onRetry={reload}
      emptyState={
        <EmptyState
          icon={<ListChecks size={28} />}
          title={feed?.available ? "You're all caught up" : "No tasks yet"}
          description={
            feed?.available
              ? "Follow-ups and reminders will appear here."
              : "Tasks (replies, follow-ups, low-credit + import alerts) arrive with the M9 inbox build."
          }
        />
      }
    >
      <ul className={styles.taskList}>
        {feed?.tasks.map((task) => (
          <li key={task.id} className={styles.taskItem}>
            <span className={styles.taskMain}>
              <span className={styles.taskTop}>
                <StatusBadge tone="muted">{TASK_SOURCE_LABEL[task.source]}</StatusBadge>
                <span className={styles.taskTitle}>{task.title}</span>
              </span>
              <span className={styles.taskSub}>
                {task.contactName ? `${task.contactName} · ` : ""}
                {formatDue(task.dueAt) || `Added ${formatRelative(task.createdAt)}`}
              </span>
            </span>
            <span className={styles.taskActions}>
              <TpButton variant="secondary" size="sm" onClick={() => act(task, "done")}>
                Done
              </TpButton>
              <TpButton variant="ghost" size="sm" onClick={() => act(task, "snoozed")}>
                Snooze
              </TpButton>
            </span>
          </li>
        ))}
      </ul>
    </StateSwitch>
  );
}

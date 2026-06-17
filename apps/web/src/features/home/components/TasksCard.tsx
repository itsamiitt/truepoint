// TasksCard.tsx — today's tasks (follow-ups, replies to review, reveals due). Empty-state-first: a calm "all
// caught up" until a tasks source lands. Each row carries a task-kind badge + relative due time. Pure
// presentation over HomeSummary.todaysTasks (PII-safe references only — id/kind/contactId/dueAt). All four
// async states render through the shared WidgetCard → StateSwitch. Public slice component.
"use client";

import { StatusBadge, type StatusTone } from "@leadwolf/ui";
import { CheckCircle2, ListChecks } from "lucide-react";
import type { TodaysTask } from "../types";
import { formatRelative } from "./format";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

const TASK_LABELS: Record<TodaysTask["kind"], string> = {
  follow_up: "Follow up",
  review_reply: "Review reply",
  reveal: "Reveal",
  enrich: "Enrich",
  custom: "Task",
};

/** A task that's due in the past nudges to "warning"; everything else stays neutral. */
function dueTone(dueAt: string): StatusTone {
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return "muted";
  return due < Date.now() ? "warning" : "muted";
}

export function TasksCard({
  tasks,
  loading,
  error,
  onRetry,
}: {
  tasks: TodaysTask[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <WidgetCard
      title="Today's tasks"
      icon={ListChecks}
      loading={loading}
      error={error}
      empty={tasks.length === 0}
      onRetry={onRetry}
      emptyIcon={CheckCircle2}
      emptyTitle="You're all caught up"
      emptyDescription="No tasks due today. Follow-ups, replies to review, and reveals due will surface here."
    >
      <div className={styles.list}>
        {tasks.map((task) => (
          <div key={task.id} className={styles.row}>
            <span className={styles.rowStack}>
              <span className={styles.rowLabel}>{TASK_LABELS[task.kind]}</span>
              <span className={styles.rowMeta}>Due {formatRelative(task.dueAt)}</span>
            </span>
            <span className={styles.rowAside}>
              <StatusBadge tone={dueTone(task.dueAt)}>
                {dueTone(task.dueAt) === "warning" ? "Overdue" : "Open"}
              </StatusBadge>
            </span>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}

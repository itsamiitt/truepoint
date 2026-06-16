// TasksCard.tsx — today's tasks (follow-ups, replies to review, reveals due). Empty-state-first: shows a
// calm "all caught up" until a tasks source lands. Pure presentation over HomeSummary.todaysTasks
// (PII-safe references only — id/kind/contactId/dueAt). Public slice component.
"use client";

import { Card, Spinner } from "@leadwolf/ui";
import type { TodaysTask } from "../types";
import styles from "./HomePage.module.css";
import { formatDate } from "./format";

const TASK_LABELS: Record<TodaysTask["kind"], string> = {
  follow_up: "Follow up",
  review_reply: "Review reply",
  reveal: "Reveal",
  enrich: "Enrich",
  custom: "Task",
};

export function TasksCard({
  tasks,
  loading,
  error,
}: {
  tasks: TodaysTask[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Today's tasks</h2>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading tasks…
        </div>
      ) : tasks.length === 0 ? (
        <p className={styles.muted}>You're all caught up — no tasks for today.</p>
      ) : (
        <div className={styles.list}>
          {tasks.map((task) => (
            <div key={task.id} className={styles.row}>
              <span className={styles.rowStack}>
                <span className={styles.rowLabel}>{TASK_LABELS[task.kind]}</span>
                <span className={styles.rowMeta}>Due {formatDate(task.dueAt)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ReviewPage.tsx — the human-review queue: a DataTable of the captures a parser couldn't resolve confidently,
// with reason, priority and assignee. Every async state renders through the shared State Kit. Public slice
// component; reads only, via the forge-api BFF.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { ClipboardCheck } from "lucide-react";
import { useReview } from "../hooks/useReview";
import type { ReviewTask } from "../types";

function priorityTone(priority: string): StatusTone {
  if (priority === "high" || priority === "urgent") return "danger";
  if (priority === "medium") return "warning";
  if (priority === "low") return "muted";
  return "muted";
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16);
}

const columns: Column<ReviewTask>[] = [
  {
    key: "reason",
    header: "Reason",
    sortValue: (t) => t.reason,
    cell: (t) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{t.reason}</span>,
  },
  {
    key: "captureId",
    header: "Capture",
    sortValue: (t) => t.captureId,
    cell: (t) => <span className="tp-cell-mono">{t.captureId}</span>,
  },
  {
    key: "priority",
    header: "Priority",
    sortValue: (t) => t.priority,
    cell: (t) => <StatusBadge tone={priorityTone(t.priority)}>{t.priority}</StatusBadge>,
  },
  {
    key: "assignedTo",
    header: "Assignee",
    sortValue: (t) => t.assignedTo ?? "",
    cell: (t) => t.assignedTo ?? <span className="app-muted">Unassigned</span>,
  },
  {
    key: "createdAt",
    header: "Opened",
    sortValue: (t) => t.createdAt,
    cell: (t) => <span className="tp-cell-mono">{shortTime(t.createdAt)}</span>,
  },
];

export function ReviewPage() {
  const { tasks, loading, error, reload } = useReview();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Review</h2>
          <p className="tp-page-sub">
            Captures a parser couldn't resolve on its own — triaged here for a human decision.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!tasks && tasks.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<ClipboardCheck size={20} />}
            title="Nothing to review"
            description="The review queue is clear — every capture parsed cleanly."
          />
        }
      >
        <DataTable columns={columns} rows={tasks ?? []} rowKey={(t) => t.id} />
      </StateSwitch>
    </div>
  );
}

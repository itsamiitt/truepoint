// OverviewPage.tsx — the operator dashboard: four KPI tiles (captures today, pending review, active parsers,
// sync backlog) over a recent-captures table. Every async state renders through the shared State Kit. Public
// slice component; reads only, all data via the forge-api BFF.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  StatTile,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { Inbox } from "lucide-react";
import { useOverview } from "../hooks/useOverview";
import type { OverviewCapture } from "../types";

function statusTone(status: string): StatusTone {
  if (status === "synced" || status === "parsed") return "success";
  if (status === "failed") return "danger";
  if (status === "pending" || status === "captured") return "warning";
  return "muted";
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16);
}

const columns: Column<OverviewCapture>[] = [
  {
    key: "source",
    header: "Source",
    sortValue: (c) => c.source,
    cell: (c) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{c.source}</span>,
  },
  {
    key: "status",
    header: "Status",
    sortValue: (c) => c.status,
    cell: (c) => <StatusBadge tone={statusTone(c.status)}>{c.status}</StatusBadge>,
  },
  {
    key: "capturedAt",
    header: "Captured",
    sortValue: (c) => c.capturedAt,
    cell: (c) => <span className="tp-cell-mono">{shortTime(c.capturedAt)}</span>,
  },
];

export function OverviewPage() {
  const { data, loading, error, reload } = useOverview();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Overview</h2>
          <p className="tp-page-sub">
            Live health of the capture → parse → review → sync pipeline across every source.
          </p>
        </div>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {data ? (
          <>
            <div className="tp-stat-grid">
              <StatTile label="Captures today" value={data.capturesToday} />
              <StatTile label="Pending review" value={data.pendingReview} />
              <StatTile label="Active parsers" value={data.activeParsers} />
              <StatTile label="Sync backlog" value={data.syncBacklog} />
            </div>

            <h3 className="tp-section-title">Recent captures</h3>
            <DataTable
              columns={columns}
              rows={data.recentCaptures}
              rowKey={(c) => c.id}
              empty={
                <EmptyState
                  icon={<Inbox size={20} />}
                  title="No captures yet"
                  description="Captured items will appear here as sources produce them."
                />
              }
            />
          </>
        ) : null}
      </StateSwitch>
    </div>
  );
}

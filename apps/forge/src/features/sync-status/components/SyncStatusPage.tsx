// SyncStatusPage.tsx — the downstream-sync health board: a DataTable of each destination, its health, pending
// backlog and last successful sync. Every async state renders through the shared State Kit. Public slice
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
import { RefreshCw } from "lucide-react";
import { useSyncStatus } from "../hooks/useSyncStatus";
import type { SyncTarget } from "../types";

function statusTone(status: string): StatusTone {
  if (status === "healthy" || status === "synced") return "success";
  if (status === "stalled" || status === "failed") return "danger";
  if (status === "degraded" || status === "lagging") return "warning";
  return "muted";
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16);
}

const columns: Column<SyncTarget>[] = [
  {
    key: "destination",
    header: "Destination",
    sortValue: (t) => t.destination,
    cell: (t) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{t.destination}</span>,
  },
  {
    key: "status",
    header: "Health",
    sortValue: (t) => t.status,
    cell: (t) => <StatusBadge tone={statusTone(t.status)}>{t.status}</StatusBadge>,
  },
  {
    key: "pending",
    header: "Pending",
    align: "right",
    sortValue: (t) => t.pending,
    cell: (t) => t.pending,
  },
  {
    key: "lastSyncedAt",
    header: "Last synced",
    sortValue: (t) => t.lastSyncedAt ?? "",
    cell: (t) => <span className="tp-cell-mono">{shortTime(t.lastSyncedAt)}</span>,
  },
];

export function SyncStatusPage() {
  const { targets, loading, error, reload } = useSyncStatus();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Sync status</h2>
          <p className="tp-page-sub">
            How parsed records are flowing to each downstream destination — and where they are
            backing up.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!targets && targets.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<RefreshCw size={20} />}
            title="No sync destinations"
            description="No downstream destinations have been configured yet."
          />
        }
      >
        <DataTable columns={columns} rows={targets ?? []} rowKey={(t) => t.id} />
      </StateSwitch>
    </div>
  );
}

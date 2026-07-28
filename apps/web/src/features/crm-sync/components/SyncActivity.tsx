// SyncActivity.tsx — recent sync runs for one connection (GET /crm/connections/:id/runs). Read-only evidence.
//
// The MODE column is the one that needs explaining rather than just rendering: a `shadow` run counts records
// and writes nothing to the CRM, so its Created/Updated figures are "what enforce WOULD have done". Showing
// those numbers without that distinction would read as data having been written. Hence a tone paired with a
// text label (never colour alone) and the footnote.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  Icon,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { RefreshCw } from "lucide-react";
import styles from "../crm-sync.module.css";
import type { CrmSyncRunView } from "../types";

const MODE_TONE: Record<string, StatusTone> = {
  disabled: "muted",
  shadow: "warning",
  enforce: "success",
};

const STATUS_TONE: Record<string, StatusTone> = {
  // No "info" tone exists in the DS; a run still in flight is not a state worth colouring, so muted.
  running: "muted",
  completed: "success",
  partial: "warning",
  failed: "danger",
  // A `cancelled` run is a GATED one — the engine is off for this tenant. Muted, not danger: nothing broke.
  cancelled: "muted",
};

const fmtDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export function SyncActivity({
  runs,
  loading,
  error,
  onRetry,
}: {
  runs: CrmSyncRunView[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const list = runs ?? [];

  const columns: Column<CrmSyncRunView>[] = [
    {
      key: "direction",
      header: "Direction",
      sortValue: (r) => r.direction,
      cell: (r) => (r.direction === "inbound" ? "CRM → TruePoint" : "TruePoint → CRM"),
    },
    { key: "object", header: "Object", sortValue: (r) => r.objectType, cell: (r) => r.objectType },
    { key: "trigger", header: "Trigger", sortValue: (r) => r.trigger, cell: (r) => r.trigger },
    {
      key: "mode",
      header: "Mode",
      sortValue: (r) => r.mode,
      cell: (r) => <StatusBadge tone={MODE_TONE[r.mode] ?? "muted"}>{r.mode}</StatusBadge>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge tone={STATUS_TONE[r.status] ?? "muted"}>{r.status}</StatusBadge>,
    },
    {
      key: "seen",
      header: "Seen",
      align: "right",
      sortValue: (r) => r.recordsSeen,
      cell: (r) => r.recordsSeen.toLocaleString(),
    },
    {
      key: "created",
      header: "Created",
      align: "right",
      sortValue: (r) => r.recordsCreated,
      cell: (r) => r.recordsCreated.toLocaleString(),
    },
    {
      key: "updated",
      header: "Updated",
      align: "right",
      sortValue: (r) => r.recordsUpdated,
      cell: (r) => r.recordsUpdated.toLocaleString(),
    },
    {
      key: "failed",
      header: "Failed",
      align: "right",
      sortValue: (r) => r.recordsFailed,
      cell: (r) => r.recordsFailed.toLocaleString(),
    },
    {
      key: "started",
      header: "Started",
      sortValue: (r) => r.startedAt,
      cell: (r) => fmtDateTime(r.startedAt),
    },
  ];

  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && list.length === 0}
      emptyState={
        <EmptyState
          icon={<Icon icon={RefreshCw} size={28} />}
          title="No sync activity yet"
          description="Runs appear here once a connection starts syncing. Shadow mode records what would change without writing to your CRM."
        />
      }
    >
      <div className={styles.stack}>
        <div className={styles.tableBlock}>
          <h3 className={styles.subheading}>Recent runs</h3>
          <DataTable columns={columns} rows={list} rowKey={(r) => r.id} />
        </div>
        <p className={styles.footnote}>
          Shadow = counted only, nothing was written to your CRM (the Created/Updated figures are
          what enforce would have done). Cancelled = sync is switched off for this workspace, not an
          error.
        </p>
      </div>
    </StateSwitch>
  );
}

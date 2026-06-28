// ReverificationActivity.tsx — the Re-verification activity tab: summary StatTiles (totals across the recent runs)
// + a DataTable of recent freshness re-verification runs (started / finished / scanned / re-verified / errored),
// from GET /home/data-quality/reverification-runs. Four async states via StateSwitch with a first-class EmptyState.
"use client";

import { type Column, DataTable, EmptyState, Icon, StatTile, StateSwitch } from "@leadwolf/ui";
import { History } from "lucide-react";
import type { CSSProperties } from "react";
import styles from "../data-health.module.css";
import type { ReverificationRun } from "../types";

const KPI_CARD: CSSProperties = {
  background: "var(--tp-surface)",
  border: "1px solid var(--tp-hairline-2)",
  borderRadius: "var(--tp-radius-card)",
  boxShadow: "var(--tp-shadow-card)",
};

const fmt = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ReverificationActivity({
  runs,
  loading,
  error,
  onRetry,
}: {
  runs: ReverificationRun[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const list = runs ?? [];
  const totals = list.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      reverified: acc.reverified + r.reverified,
      errored: acc.errored + r.errored,
    }),
    { scanned: 0, reverified: 0, errored: 0 },
  );

  const columns: Column<ReverificationRun>[] = [
    { key: "started", header: "Started", sortValue: (r) => r.startedAt, cell: (r) => fmt(r.startedAt) },
    {
      key: "finished",
      header: "Finished",
      sortValue: (r) => r.finishedAt,
      cell: (r) => fmt(r.finishedAt),
    },
    {
      key: "scanned",
      header: "Scanned",
      align: "right",
      sortValue: (r) => r.scanned,
      cell: (r) => r.scanned.toLocaleString(),
    },
    {
      key: "reverified",
      header: "Re-verified",
      align: "right",
      sortValue: (r) => r.reverified,
      cell: (r) => r.reverified.toLocaleString(),
    },
    {
      key: "errored",
      header: "Errored",
      align: "right",
      sortValue: (r) => r.errored,
      cell: (r) => r.errored.toLocaleString(),
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
          icon={<Icon icon={History} size={28} />}
          title="No re-verification runs yet"
          description="Daily freshness sweeps appear here once they run."
        />
      }
    >
      <div className={styles.stack}>
        <div className={styles.tiles}>
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Runs</span>}
            value={list.length.toLocaleString()}
            sublabel="Recent sweeps"
          />
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Scanned</span>}
            value={totals.scanned.toLocaleString()}
            sublabel="Contacts checked"
          />
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Re-verified</span>}
            value={totals.reverified.toLocaleString()}
            sublabel="Refreshed records"
          />
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Errored</span>}
            value={totals.errored.toLocaleString()}
            sublabel="Failed checks"
          />
        </div>
        <div className={styles.tableBlock}>
          <h3 className={styles.subheading}>Recent runs</h3>
          <DataTable columns={columns} rows={list} rowKey={(r) => r.id} />
        </div>
      </div>
    </StateSwitch>
  );
}

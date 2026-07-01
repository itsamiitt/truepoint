// UsageTable.tsx — the credit usage history (one row per metered reveal) on the foundation DataTable: typed,
// sortable columns with a quiet empty state. Pure presentation — data comes from useBilling via the parent; the
// credit accounting is server-side (07 §3).
"use client";

import { type Column, DataTable, EmptyState, StatusBadge } from "@leadwolf/ui";
import { Receipt } from "lucide-react";
import styles from "../billing.module.css";
import { REVEAL_DATA_SOURCE_LABEL, REVEAL_LABEL, type UsageReveal } from "../types";

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const columns: Column<UsageReveal>[] = [
  {
    key: "reveal",
    header: "Reveal",
    sortValue: (r) => r.id,
    cell: (r) => <span className={styles.mono}>{shortId(r.id)}</span>,
  },
  {
    key: "type",
    header: "Type",
    sortValue: (r) => r.revealType,
    cell: (r) => (
      <StatusBadge tone="muted">{REVEAL_LABEL[r.revealType] ?? r.revealType}</StatusBadge>
    ),
  },
  {
    key: "source",
    header: "Source",
    sortValue: (r) => r.dataSource,
    cell: (r) => (
      <StatusBadge tone="muted">
        {REVEAL_DATA_SOURCE_LABEL[r.dataSource] ?? r.dataSource}
      </StatusBadge>
    ),
  },
  {
    key: "credits",
    header: "Credits",
    align: "right",
    sortValue: (r) => r.creditsConsumed,
    cell: (r) => <span className={styles.credits}>{r.creditsConsumed}</span>,
  },
  {
    key: "date",
    header: "Date",
    sortValue: (r) => r.revealedAt,
    cell: (r) => formatDate(r.revealedAt),
  },
];

export function UsageTable({ reveals }: { reveals: UsageReveal[] }) {
  return (
    <DataTable
      columns={columns}
      rows={reveals}
      rowKey={(r) => r.id}
      empty={
        <EmptyState
          icon={<Receipt size={28} />}
          title="No reveals yet"
          description="When you reveal a contact, each charge shows up here — fully itemized."
        />
      }
    />
  );
}

// HistoryTab.tsx — the billing hub's Credit history tab (M11, ADR-0029): the UNIFIED credit statement from the
// ledger — every movement (top-ups, reveals, adjustments, monthly resets), newest-first, keyset-paginated.
// Owns its own data so it's independent of the Plan/Credits load. Tenant-scoped + RLS-isolated server-side.
// For older accounts, pre-ledger movements are summarised as an opening balance (the note says so).
"use client";

import type { CreditLedgerEntry } from "@leadwolf/types";
import {
  Card,
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpButton,
} from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { fetchCreditLedger } from "../../api";
import styles from "../../billing.module.css";

const TYPE_LABEL: Record<string, string> = {
  grant: "Added",
  spend: "Used",
  credit_back: "Refunded",
  adjustment: "Adjustment",
  expiry: "Expired",
  lease: "Reserved",
  settle: "Settled",
  release: "Released",
};

function typeTone(t: string): StatusTone {
  if (t === "grant" || t === "credit_back" || t === "release") return "success";
  if (t === "adjustment" || t === "expiry") return "warning";
  return "muted";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function HistoryTab() {
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchCreditLedger();
      setEntries(page.entries);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load credit history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchCreditLedger(cursor);
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor]);

  const columns: Column<CreditLedgerEntry>[] = [
    { key: "createdAt", header: "Date", cell: (e) => fmtDate(e.createdAt) },
    {
      key: "entryType",
      header: "Type",
      cell: (e) => (
        <StatusBadge tone={typeTone(e.entryType)}>
          {TYPE_LABEL[e.entryType] ?? e.entryType}
        </StatusBadge>
      ),
    },
    {
      key: "delta",
      header: "Change",
      align: "right",
      cell: (e) => (e.delta > 0 ? `+${e.delta.toLocaleString()}` : e.delta.toLocaleString()),
    },
    {
      key: "balanceAfter",
      header: "Balance",
      align: "right",
      cell: (e) => (e.balanceAfter === null ? "—" : e.balanceAfter.toLocaleString()),
    },
  ];

  return (
    <Card style={{ padding: 24 }}>
      <div className={styles.cardHead}>
        <span className={styles.cardLabel}>Credit history</span>
      </div>
      <p className="app-muted" style={{ fontSize: 13, marginTop: 0 }}>
        Every credit movement — top-ups, reveals, adjustments and monthly plan resets. For older
        accounts, movements from before this statement was introduced are summarised as an opening
        balance once reconciliation has run.
      </p>
      <StateSwitch
        loading={loading}
        error={error}
        onRetry={reload}
        empty={entries.length === 0}
        emptyState={
          <EmptyState
            title="No credit movements yet"
            description="Top-ups, reveals and plan grants will appear here as they happen."
          />
        }
      >
        <DataTable columns={columns} rows={entries} rowKey={(e) => e.id} />
        {cursor && (
          <div className={styles.loadMore}>
            <TpButton
              variant="secondary"
              size="sm"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              Load more
            </TpButton>
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}

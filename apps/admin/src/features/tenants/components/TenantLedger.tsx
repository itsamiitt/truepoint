// TenantLedger.tsx — the credit-ledger panel on a tenant's detail (M11, ADR-0029): the audited, append-only
// credit statement (grants, spends, adjustments, the opening-balance backfill entry) a support/finance operator
// reviews for a dispute. billing:read (the api enforces it too). Keyset "Load more" over the newest-first feed.
// PII-free — amounts + refs only. Renders async state through the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { LedgerEntryView } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpButton,
} from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { fetchTenantLedger } from "../api";
import { shortDate } from "../format";

// Credit-direction tone: additions (grant/credit_back/release) read positive; consumption muted; adjustments
// (manual + the opening-balance reconciler) flagged so they stand out in an audit.
const TYPE_TONE: Record<string, StatusTone> = {
  grant: "success",
  credit_back: "success",
  release: "success",
  spend: "muted",
  lease: "muted",
  settle: "muted",
  adjustment: "warning",
};

export function TenantLedger({ tenantId }: { tenantId: string }) {
  const { canMaybe, loaded } = useStaffMe();
  const canView = canMaybe("billing:read");

  const [entries, setEntries] = useState<LedgerEntryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchTenantLedger(tenantId);
      setEntries(page.entries);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the credit ledger");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (canView) void reload();
  }, [canView, reload]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchTenantLedger(tenantId, cursor);
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [tenantId, cursor]);

  // Hide the whole section once we know the caller can't view billing (the api also enforces it).
  if (loaded && !canView) return null;

  const columns: Column<LedgerEntryView>[] = [
    {
      key: "createdAt",
      header: "Date",
      sortValue: (e) => e.createdAt,
      cell: (e) => <span className="tp-cell-mono">{shortDate(e.createdAt)}</span>,
    },
    {
      key: "entryType",
      header: "Type",
      sortValue: (e) => e.entryType,
      cell: (e) => (
        <StatusBadge tone={TYPE_TONE[e.entryType] ?? "muted"}>{e.entryType}</StatusBadge>
      ),
    },
    {
      key: "delta",
      header: "Delta",
      align: "right",
      sortValue: (e) => e.delta,
      cell: (e) => (
        <span style={e.delta > 0 ? { color: "var(--tp-success, #15803d)" } : undefined}>
          {e.delta > 0 ? `+${e.delta.toLocaleString()}` : e.delta.toLocaleString()}
        </span>
      ),
    },
    {
      key: "balanceAfter",
      header: "Balance after",
      align: "right",
      sortValue: (e) => e.balanceAfter ?? 0,
      cell: (e) => (e.balanceAfter === null ? "—" : e.balanceAfter.toLocaleString()),
    },
    {
      key: "reason",
      header: "Reason",
      cell: (e) => <span className="app-muted">{e.reason ?? "—"}</span>,
    },
  ];

  return (
    <div style={{ marginTop: 28 }}>
      <h3 className="tp-section-title">Credit ledger</h3>
      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && entries.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <p className="app-muted" style={{ padding: 16 }}>
            No ledger entries yet.
          </p>
        }
      >
        <DataTable columns={columns} rows={entries} rowKey={(e) => e.id} />
        {cursor ? (
          <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
            <TpButton
              variant="secondary"
              size="sm"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              Load more
            </TpButton>
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}

// FleetQualityPage.tsx — the cross-tenant FLEET data-quality view (database-management-research 10, gap G18):
// recent per-workspace data-quality snapshots ACROSS all tenants read from the api `/admin/data/quality/snapshots`
// surface. The customer Data Health dashboard is per-workspace (apps/web); this is the staff fleet view that did
// not exist before. READ-ONLY, NON-PII (the metrics are counts + statuses; the UI derives fill/verified/fresh
// rates). Every async state goes through the shared State Kit.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch } from "@leadwolf/ui";
import { Activity } from "lucide-react";
import { formatInt, pct, shortDate } from "../format";
import { useFleetQuality } from "../hooks/useFleetQuality";
import type { FleetQualityRow } from "../types";

export function FleetQualityPage() {
  const { snapshots, loading, error, reload } = useFleetQuality();

  const columns: Column<FleetQualityRow>[] = [
    {
      key: "tenant",
      header: "Tenant · workspace",
      sortValue: (r) => r.tenantName,
      cell: (r) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{r.tenantName}</span>
          <span className="tp-cell-mono">{r.workspaceId}</span>
        </div>
      ),
    },
    {
      key: "total",
      header: "Contacts",
      align: "right",
      sortValue: (r) => r.metrics.total,
      cell: (r) => formatInt(r.metrics.total),
    },
    {
      key: "hasEmail",
      header: "Has email",
      align: "right",
      sortValue: (r) => (r.metrics.total > 0 ? r.metrics.withEmail / r.metrics.total : 0),
      cell: (r) => pct(r.metrics.withEmail, r.metrics.total),
    },
    {
      key: "emailValid",
      header: "Email valid",
      align: "right",
      sortValue: (r) => (r.metrics.total > 0 ? r.metrics.emailValid / r.metrics.total : 0),
      cell: (r) => pct(r.metrics.emailValid, r.metrics.total),
    },
    {
      key: "fresh",
      header: "Fresh",
      align: "right",
      sortValue: (r) => (r.metrics.total > 0 ? r.metrics.fresh / r.metrics.total : 0),
      cell: (r) => pct(r.metrics.fresh, r.metrics.total),
    },
    {
      key: "captured",
      header: "Captured",
      sortValue: (r) => r.createdAt,
      cell: (r) => <span className="tp-cell-mono">{shortDate(r.createdAt)}</span>,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Fleet data quality</h2>
          <p className="tp-page-sub">
            Cross-tenant data-quality snapshots — per-workspace fill, email-verification and freshness rates
            from the daily Data Health sweep. Read-only; counts only.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!snapshots && snapshots.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Activity size={20} />}
            title="No quality snapshots"
            description="The daily Data Health snapshot sweep has not captured any workspace yet."
          />
        }
      >
        <DataTable columns={columns} rows={snapshots ?? []} rowKey={(r) => r.snapshotId} />
      </StateSwitch>
    </div>
  );
}

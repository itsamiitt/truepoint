// ImportsMonitorPage.tsx — the cross-tenant BULK-IMPORT monitor (data-management A4; 15-bulk-import-design):
// recent import jobs ACROSS all tenants read from the api `/admin/import-jobs` surface. The rollout-monitoring
// surface for the COPY-staging pipeline — which tenant, which file, status, AV scan, row tallies, failures.
// READ-ONLY: no actions (staff mutations, if ever, come later via audited endpoints). The page is not
// render-gated to a tier — it relies on the shell's adminGate + the server's requireStaffRole gate, matching
// the sibling read-only directories (Tenants / Users). Renders every async state through the shared State Kit.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { FileUp } from "lucide-react";
import { avScanTone, formatInt, jobStatusTone, shortDate } from "../format";
import { useImportJobs } from "../hooks/useImportJobs";
import type { ImportJobRow } from "../types";

export function ImportsMonitorPage() {
  const { jobs, loading, error, reload } = useImportJobs();

  const columns: Column<ImportJobRow>[] = [
    {
      key: "tenant",
      header: "Tenant",
      sortValue: (j) => j.tenantName,
      cell: (j) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{j.tenantName}</span>
          <span className="tp-cell-mono">{j.tenantId}</span>
        </div>
      ),
    },
    {
      key: "source",
      header: "Source",
      sortValue: (j) => j.sourceName,
      cell: (j) => <span className="tp-cell-mono">{j.sourceName}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (j) => j.status,
      cell: (j) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <StatusBadge tone={jobStatusTone(j.status)}>{j.status}</StatusBadge>
          {j.failedReason ? (
            <span style={{ color: "var(--tp-ink-3)", fontSize: 12 }} title={j.failedReason}>
              {j.failedReason}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "rowsCreated",
      header: "New",
      align: "right",
      sortValue: (j) => j.rowsCreated,
      cell: (j) => formatInt(j.rowsCreated),
    },
    {
      key: "rowsMatched",
      header: "Matched",
      align: "right",
      sortValue: (j) => j.rowsMatched,
      cell: (j) => formatInt(j.rowsMatched),
    },
    {
      key: "rowsRejected",
      header: "Rejected",
      align: "right",
      sortValue: (j) => j.rowsRejected,
      cell: (j) => formatInt(j.rowsRejected),
    },
    {
      key: "avScan",
      header: "AV scan",
      align: "center",
      sortValue: (j) => j.avScanStatus,
      cell: (j) => <StatusBadge tone={avScanTone(j.avScanStatus)}>{j.avScanStatus}</StatusBadge>,
    },
    {
      key: "createdAt",
      header: "Created",
      sortValue: (j) => j.createdAt,
      cell: (j) => <span className="tp-cell-mono">{shortDate(j.createdAt)}</span>,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Bulk imports</h2>
          <p className="tp-page-sub">
            Cross-tenant bulk-import monitor — recent jobs, AV scan, row outcomes and failures
            across all orgs.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!jobs && jobs.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<FileUp size={20} />}
            title="No import jobs"
            description="No bulk imports have been submitted yet."
          />
        }
      >
        <DataTable columns={columns} rows={jobs ?? []} rowKey={(j) => j.jobId} />
      </StateSwitch>
    </div>
  );
}

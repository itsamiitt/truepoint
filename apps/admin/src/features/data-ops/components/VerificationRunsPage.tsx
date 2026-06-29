// VerificationRunsPage.tsx — the cross-tenant freshness RE-VERIFICATION monitor (database-management-research
// 08/10, Phase 2 read slice): recent reverify-sweep runs ACROSS all tenants read from the api
// `/admin/data/verification/runs` surface. Which tenant, scanned/reverified/errored tallies, and the run window.
// READ-ONLY. Not render-gated to a tier: relies on the shell adminGate + the server's data:read gate. COUNTS only
// (the verification_jobs ledger carries no PII). Every async state goes through the shared State Kit.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch } from "@leadwolf/ui";
import { ShieldCheck } from "lucide-react";
import { formatInt, shortDate } from "../format";
import { useVerificationRuns } from "../hooks/useVerificationRuns";
import type { VerificationRunRow } from "../types";

export function VerificationRunsPage() {
  const { runs, loading, error, reload } = useVerificationRuns();

  const columns: Column<VerificationRunRow>[] = [
    {
      key: "tenant",
      header: "Tenant",
      sortValue: (r) => r.tenantName,
      cell: (r) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{r.tenantName}</span>
          <span className="tp-cell-mono">{r.tenantId}</span>
        </div>
      ),
    },
    {
      key: "scanned",
      header: "Scanned",
      align: "right",
      sortValue: (r) => r.scanned,
      cell: (r) => formatInt(r.scanned),
    },
    {
      key: "reverified",
      header: "Reverified",
      align: "right",
      sortValue: (r) => r.reverified,
      cell: (r) => formatInt(r.reverified),
    },
    {
      key: "errored",
      header: "Errored",
      align: "right",
      sortValue: (r) => r.errored,
      cell: (r) => formatInt(r.errored),
    },
    {
      key: "startedAt",
      header: "Started",
      sortValue: (r) => r.startedAt,
      cell: (r) => <span className="tp-cell-mono">{shortDate(r.startedAt)}</span>,
    },
    {
      key: "finishedAt",
      header: "Finished",
      sortValue: (r) => r.finishedAt,
      cell: (r) => <span className="tp-cell-mono">{shortDate(r.finishedAt)}</span>,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Verification runs</h2>
          <p className="tp-page-sub">
            Cross-tenant freshness re-verification monitor — recent reverify sweeps and their scanned /
            reverified / errored tallies across all orgs. Read-only; counts only.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!runs && runs.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="No verification runs"
            description="No re-verification sweeps have completed yet (the loop is flag-gated and config-gated)."
          />
        }
      >
        <DataTable columns={columns} rows={runs ?? []} rowKey={(r) => r.jobId} />
      </StateSwitch>
    </div>
  );
}

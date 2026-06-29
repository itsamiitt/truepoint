// EnrichmentRunsPage.tsx — the cross-tenant bulk-ENRICHMENT monitor (database-management-research 08, Phase 2
// read slice): recent enrichment jobs ACROSS all tenants read from the api `/admin/data/enrichment/runs` surface.
// Which tenant, which file, status, match/enrich outcomes, credit spend, failures. READ-ONLY — the run actions
// (re-run / test-batch / preview-then-commit) land later behind data:manage + the approval flow. Not render-gated
// to a tier: relies on the shell adminGate + the server's data:read gate (sibling read-only directories do the
// same). Statuses render as plain text (no tone mapping); every async state goes through the shared State Kit.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch } from "@leadwolf/ui";
import { Sparkles } from "lucide-react";
import { formatCredits, formatInt, shortDate } from "../format";
import { useEnrichmentRuns } from "../hooks/useEnrichmentRuns";
import type { EnrichmentRunRow } from "../types";

export function EnrichmentRunsPage() {
  const { runs, loading, error, reload } = useEnrichmentRuns();

  const columns: Column<EnrichmentRunRow>[] = [
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
      key: "status",
      header: "Status",
      sortValue: (r) => r.status,
      cell: (r) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="tp-cell-mono">{r.status}</span>
          {r.failedReason ? (
            <span style={{ color: "var(--tp-ink-3)", fontSize: 12 }} title={r.failedReason}>
              {r.failedReason}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "source",
      header: "Source",
      sortValue: (r) => r.sourceName,
      cell: (r) => <span className="tp-cell-mono">{r.sourceName}</span>,
    },
    {
      key: "totalRows",
      header: "Rows",
      align: "right",
      sortValue: (r) => r.totalRows,
      cell: (r) => formatInt(r.totalRows),
    },
    {
      key: "matchedRows",
      header: "Matched",
      align: "right",
      sortValue: (r) => r.matchedRows,
      cell: (r) => formatInt(r.matchedRows),
    },
    {
      key: "enrichedRows",
      header: "Enriched",
      align: "right",
      sortValue: (r) => r.enrichedRows,
      cell: (r) => formatInt(r.enrichedRows),
    },
    {
      key: "chargedRows",
      header: "Charged",
      align: "right",
      sortValue: (r) => r.chargedRows,
      cell: (r) => formatInt(r.chargedRows),
    },
    {
      key: "credits",
      header: "Credits",
      align: "right",
      sortValue: (r) => r.creditSpentMicros,
      cell: (r) => formatCredits(r.creditSpentMicros),
    },
    {
      key: "createdAt",
      header: "Created",
      sortValue: (r) => r.createdAt,
      cell: (r) => <span className="tp-cell-mono">{shortDate(r.createdAt)}</span>,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Enrichment runs</h2>
          <p className="tp-page-sub">
            Cross-tenant bulk-enrichment monitor — recent runs, match/enrich outcomes and credit spend
            across all orgs. Read-only; counts only.
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
            icon={<Sparkles size={20} />}
            title="No enrichment runs"
            description="No bulk enrichment jobs have been submitted yet."
          />
        }
      >
        <DataTable columns={columns} rows={runs ?? []} rowKey={(r) => r.jobId} />
      </StateSwitch>
    </div>
  );
}

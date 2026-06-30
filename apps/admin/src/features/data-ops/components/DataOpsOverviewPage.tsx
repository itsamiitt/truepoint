// DataOpsOverviewPage.tsx — the Data-management control panel's landing surface (database-management-research
// Phase 1 / MVP): a cross-tenant DATA-OPS overview read from the api `/admin/data/overview` surface. Headline KPIs
// for the internal Database Management team — pipeline job pressure, recent bulk-import outcomes, and retention
// shadow-run evidence. READ-ONLY: no actions on this surface yet (the write tiers come later via audited,
// data:manage/-review/-export-gated endpoints). The page is not render-gated to a tier — it relies on the shell's
// adminGate + the server's data:read gate, matching the sibling read-only directories. Renders every async state
// through the shared State Kit.
"use client";

import { StatTile, StateSwitch } from "@leadwolf/ui";
import Link from "next/link";
import { formatInt } from "../format";
import { useDataOpsOverview } from "../hooks/useDataOpsOverview";

export function DataOpsOverviewPage() {
  const { overview, loading, error, reload } = useDataOpsOverview();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Data management</h2>
          <p className="tp-page-sub">
            Cross-tenant data-operations overview — pipeline jobs, bulk-import outcomes and retention
            shadow runs at a glance. Read-only; counts and tallies only.
          </p>
        </div>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {overview ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            <StatTile
              label="Active jobs"
              value={formatInt(overview.jobs.queueDepth)}
              sublabel="queued + running (recent sample)"
            />
            <StatTile
              label="Dead-letter jobs"
              value={formatInt(overview.jobs.deadLetter)}
              sublabel="failed in the recent sample"
            />
            <StatTile
              label="Recent bulk imports"
              value={formatInt(overview.imports.recentCount)}
              sublabel={overview.imports.truncated ? "latest jobs (capped)" : "across all tenants"}
            />
            <StatTile
              label="Rejected rows"
              value={formatInt(overview.imports.rejectedRecent)}
              sublabel="across recent imports"
            />
            <StatTile
              label="Retention runs"
              value={formatInt(overview.retention.recentRuns)}
              sublabel="shadow-mode evidence"
            />
          </div>
        ) : null}
      </StateSwitch>

      <div style={{ marginTop: 24, display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Link href="/imports" style={{ fontWeight: 500 }}>
          Bulk imports monitor →
        </Link>
        <Link href="/data-ops/enrichment" style={{ fontWeight: 500 }}>
          Enrichment runs →
        </Link>
        <Link href="/data-ops/verification" style={{ fontWeight: 500 }}>
          Verification runs →
        </Link>
        <Link href="/data-ops/quality" style={{ fontWeight: 500 }}>
          Fleet data quality →
        </Link>
        <Link href="/data-ops/approvals" style={{ fontWeight: 500 }}>
          Approvals →
        </Link>
      </div>
    </div>
  );
}

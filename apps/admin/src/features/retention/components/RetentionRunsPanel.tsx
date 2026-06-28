// RetentionRunsPanel.tsx — the cross-tenant retention-RUNS review (data-management A5; design
// 16-retention-engine-design.md). A DataTable of recent retention-engine sweeps ACROSS all tenants read from the
// api `/admin/retention-runs` surface: which tenant, data class, mode, candidates ("would delete"), deleted,
// cutoff window, last run. This is the SHADOW evidence operators review BEFORE flipping a class to `enforce`
// (it pairs with the Policies tab). READ-ONLY + COUNTS-only — retention_runs carries no contact PII. The panel
// is not render-gated to a tier; it relies on the shell's adminGate + the server's requireStaffRole gate
// (matching the sibling read-only Imports monitor). Four async states via the shared StateSwitch.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { Archive } from "lucide-react";
import { useRetentionRuns } from "../hooks/useRetentionRuns";
import type { RetentionRunRow } from "../types";

// Tone paired WITH the text label (never colour alone): shadow = a "would delete" heads-up (warning); enforce =
// rows actually purged (danger); disabled = the class is ignored (muted). Unknown modes fall back to muted.
function modeTone(mode: string): StatusTone {
  switch (mode) {
    case "enforce":
      return "danger";
    case "shadow":
      return "warning";
    default:
      return "muted";
  }
}

const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const fmtCutoff = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

export function RetentionRunsPanel() {
  const { runs, error, loading, reload } = useRetentionRuns();

  const columns: Column<RetentionRunRow>[] = [
    {
      key: "tenant",
      header: "Tenant",
      sortValue: (r) => r.tenantName,
      cell: (r) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{r.tenantName}</span>
          <span style={{ fontFamily: "var(--tp-font-mono, monospace)", fontSize: 12, color: "var(--tp-ink-3)" }}>
            {r.tenantId}
          </span>
        </div>
      ),
    },
    {
      key: "dataClass",
      header: "Data class",
      sortValue: (r) => r.dataClass,
      cell: (r) => (
        <span style={{ fontFamily: "var(--tp-font-mono, monospace)", fontWeight: 600 }}>{r.dataClass}</span>
      ),
    },
    {
      key: "mode",
      header: "Mode",
      align: "center",
      width: 120,
      sortValue: (r) => r.mode,
      cell: (r) => <StatusBadge tone={modeTone(r.mode)}>{r.mode}</StatusBadge>,
    },
    {
      key: "candidates",
      header: "Would delete",
      align: "right",
      sortValue: (r) => r.candidateCount,
      cell: (r) => r.candidateCount.toLocaleString(),
    },
    {
      key: "deleted",
      header: "Deleted",
      align: "right",
      sortValue: (r) => r.deletedCount,
      cell: (r) => r.deletedCount.toLocaleString(),
    },
    {
      key: "cutoff",
      header: "Cutoff",
      sortValue: (r) => r.cutoff ?? "",
      cell: (r) => fmtCutoff(r.cutoff),
    },
    {
      key: "lastRun",
      header: "Last run",
      sortValue: (r) => r.runFinishedAt,
      cell: (r) => fmtDateTime(r.runFinishedAt),
    },
  ];

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ color: "var(--tp-ink-3)", fontSize: 13, maxWidth: 720, margin: 0 }}>
        Recent retention-engine sweeps across all tenants — the SHADOW evidence to review BEFORE a class is
        flipped to enforce. "Would delete" is the candidate count shadow mode measured but did not purge;
        "Deleted" is non-zero only once a class enforces for that tenant.
      </p>

      <StateSwitch
        loading={loading && runs.length === 0}
        error={error}
        empty={!loading && runs.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Archive size={20} />}
            title="No retention runs yet"
            description="The daily sweep records what WOULD delete here once the engine is enabled for a tenant. Nothing is deleted in shadow mode."
          />
        }
      >
        <DataTable
          columns={columns}
          rows={runs}
          rowKey={(r) => `${r.tenantId}-${r.dataClass}-${r.runStartedAt}`}
        />
      </StateSwitch>
    </section>
  );
}

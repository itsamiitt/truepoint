// SourceFetchesPage.tsx — the live capture pipeline's telemetry: every URL the extension harvested or a
// rep viewed, whether the origin fleet fetched it, with what outcome, and whether it resolved a golden
// record. URLs + outcomes only (the registry holds no PII). Every async state renders through the shared
// State Kit. Public slice component; reads only, via the forge-api BFF.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  PageContainer,
  PageHeader,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { Link2 } from "lucide-react";
import { useSourceFetches } from "../hooks/useSourceFetches";
import type { SourceFetch } from "../types";

function outcomeTone(outcome: string | null): StatusTone {
  if (outcome === "ok") return "success";
  if (outcome === "rejected") return "danger";
  if (outcome === "unavailable") return "warning";
  return "muted";
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16);
}

const columns: Column<SourceFetch>[] = [
  {
    key: "url",
    header: "Target",
    sortValue: (f) => f.normalizedUrl,
    cell: (f) => (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span className="tp-cell-mono">{f.normalizedUrl}</span>
        <span className="app-muted" style={{ fontSize: 12 }}>
          {f.entityKind}
          {f.externalId ? ` · ${f.externalId}` : ""}
        </span>
      </div>
    ),
  },
  {
    key: "outcome",
    header: "Last outcome",
    sortValue: (f) => f.lastOutcome ?? "",
    cell: (f) => (
      <StatusBadge tone={outcomeTone(f.lastOutcome)}>
        {f.lastOutcome ?? "never fetched"}
      </StatusBadge>
    ),
  },
  {
    key: "resolved",
    header: "Resolved",
    align: "center",
    sortValue: (f) => (f.resolved ? 1 : 0),
    cell: (f) => (
      <StatusBadge tone={f.resolved ? "success" : "muted"}>{f.resolved ? "yes" : "no"}</StatusBadge>
    ),
  },
  {
    key: "fetchCount",
    header: "Fetches",
    align: "center",
    sortValue: (f) => f.fetchCount,
    cell: (f) => <span className="tp-cell-mono">{f.fetchCount}</span>,
  },
  {
    key: "lastFetchedAt",
    header: "Last fetched",
    sortValue: (f) => f.lastFetchedAt ?? "",
    cell: (f) => <span className="tp-cell-mono">{shortTime(f.lastFetchedAt)}</span>,
  },
  {
    key: "firstSeenAt",
    header: "First seen",
    sortValue: (f) => f.firstSeenAt,
    cell: (f) => <span className="tp-cell-mono">{shortTime(f.firstSeenAt)}</span>,
  },
];

export function SourceFetchesPage() {
  const { fetches, loading, error, reload } = useSourceFetches();

  return (
    <PageContainer width="fluid">
      <PageHeader
        title="Source fetches"
        subtitle="The URL fetch registry — what the extension harvested, what the origin fleet fetched, and what resolved."
      />

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!fetches && fetches.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Link2 size={20} />}
            title="No fetch targets yet"
            description="Harvested and viewed LinkedIn URLs will appear here as reps browse."
          />
        }
      >
        <DataTable columns={columns} rows={fetches ?? []} rowKey={(f) => f.id} />
      </StateSwitch>
    </PageContainer>
  );
}

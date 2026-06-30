// DedupReviewPage.tsx — the dedup / ER clerical-review surface (database-management-research 07): entity-resolution
// decisions across all tenants — which records were matched into one golden entity. READ-ONLY for now; the
// non-destructive merge/split actions (which mutate the system-owned master graph) land next behind maker-checker
// approval. The read is data:review-gated server-side (it exposes the matched person name — PII). `pending` rows are
// the human-decision queue (populated once probabilistic matching ships); `auto` rows are deterministic, for oversight.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch } from "@leadwolf/ui";
import { GitMerge } from "lucide-react";
import { shortDate } from "../format";
import { useDedupReview } from "../hooks/useDedupReview";
import type { MatchLinkRow } from "../types";

const STATUS_LABEL: Record<string, string> = {
  auto: "Auto-resolved",
  pending: "Pending review",
  confirmed: "Confirmed",
  rejected: "Rejected",
};

export function DedupReviewPage() {
  const { links, loading, error, reload } = useDedupReview();

  const columns: Column<MatchLinkRow>[] = [
    {
      key: "name",
      header: "Entity",
      sortValue: (r) => r.name ?? "",
      cell: (r) => r.name ?? <span style={{ color: "var(--tp-ink-3)" }}>({r.entityType})</span>,
    },
    {
      key: "type",
      header: "Type",
      sortValue: (r) => r.entityType,
      cell: (r) => <span className="tp-cell-mono">{r.entityType}</span>,
    },
    {
      key: "method",
      header: "Method",
      sortValue: (r) => r.matchMethod,
      cell: (r) => <span className="tp-cell-mono">{r.matchMethod}</span>,
    },
    {
      key: "prob",
      header: "Probability",
      sortValue: (r) => r.matchProbability ?? -1,
      cell: (r) => (r.matchProbability != null ? r.matchProbability.toFixed(3) : "—"),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.reviewStatus,
      cell: (r) => STATUS_LABEL[r.reviewStatus] ?? r.reviewStatus,
    },
    {
      key: "resolved",
      header: "Resolved",
      sortValue: (r) => r.resolvedAt,
      cell: (r) => <span className="tp-cell-mono">{shortDate(r.resolvedAt)}</span>,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Dedup review</h2>
          <p className="tp-page-sub">
            Entity-resolution decisions across all tenants — which records were matched into one. <strong>Pending</strong>{" "}
            rows await a human decision (populated once probabilistic matching is enabled); <strong>auto</strong> rows are
            deterministic resolutions, shown for oversight. Merge / split actions are coming next, behind maker-checker
            approval.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!links && links.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<GitMerge size={20} />}
            title="No match-links"
            description="No entity-resolution activity to review yet."
          />
        }
      >
        <DataTable columns={columns} rows={links ?? []} rowKey={(r) => r.id} />
      </StateSwitch>
    </div>
  );
}

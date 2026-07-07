// DuplicatesSection.tsx — the Duplicates review queue: a DataTable of the workspace's auto-flagged duplicate
// contacts, each paired with the canonical it was merged into. S-U8 upgrades it IN PLACE (11 §5): the dismiss-only
// verb SURVIVES ("Not a duplicate", the override), and each pair gains a "Review" action that opens the
// side-by-side merge panel (survivor-suggested vs duplicate) → an IRREVERSIBLE per-field merge. The merge is
// DUAL-GATED 404-off: while dark, the first preview 404 hides the Merge affordance across the queue and the surface
// stays dismiss-only (the S-U2 not-enabled pattern). Four async states via StateSwitch. NAMES ONLY — no PII here.
"use client";

import type { DuplicatePairView } from "@leadwolf/types";
import { type Column, DataTable, EmptyState, Icon, StateSwitch, TpButton } from "@leadwolf/ui";
import { Copy, GitMerge } from "lucide-react";
import { useState } from "react";
import { MergeReviewDrawer } from "./MergeReviewDrawer";

const fmt = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

export function DuplicatesSection({
  pairs,
  loading,
  error,
  unmarking,
  onRetry,
  onUnmark,
  onMerged,
}: {
  pairs: DuplicatePairView[] | null;
  loading: boolean;
  error: string | null;
  unmarking: string | null;
  onRetry: () => void;
  onUnmark: (contactId: string) => void;
  /** Drop a merged pair from the queue (keyed by the flagged duplicate id) — the server is authoritative on reload. */
  onMerged: (duplicateId: string) => void;
}) {
  const list = pairs ?? [];
  // The pair under review (opens the merge drawer). `mergeDisabled` flips true on the first gate-off 404, hiding
  // the Merge affordance across every row (dismiss-only survives).
  const [reviewing, setReviewing] = useState<DuplicatePairView | null>(null);
  const [mergeDisabled, setMergeDisabled] = useState(false);

  const columns: Column<DuplicatePairView>[] = [
    {
      key: "duplicate",
      header: "Duplicate",
      sortValue: (r) => r.duplicateName,
      cell: (r) => r.duplicateName,
    },
    {
      key: "canonical",
      header: "Kept as",
      sortValue: (r) => r.canonicalName,
      cell: (r) => r.canonicalName,
    },
    {
      key: "added",
      header: "Added",
      sortValue: (r) => r.duplicateCreatedAt,
      cell: (r) => fmt(r.duplicateCreatedAt),
    },
    {
      key: "action",
      header: "",
      align: "right",
      cell: (r) => (
        <div style={{ display: "flex", gap: "var(--tp-space-2)", justifyContent: "flex-end" }}>
          {mergeDisabled ? null : (
            <TpButton
              variant="secondary"
              size="sm"
              leftIcon={<GitMerge size={14} />}
              onClick={() => setReviewing(r)}
            >
              Review
            </TpButton>
          )}
          <TpButton
            variant="ghost"
            size="sm"
            loading={unmarking === r.duplicateId}
            onClick={() => onUnmark(r.duplicateId)}
          >
            Not a duplicate
          </TpButton>
        </div>
      ),
    },
  ];

  return (
    <>
      <StateSwitch
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={!loading && !error && list.length === 0}
        emptyState={
          <EmptyState
            icon={<Icon icon={Copy} size={28} />}
            title="No duplicates flagged"
            description="Contacts the import auto-detected as duplicates appear here for review."
          />
        }
      >
        <DataTable columns={columns} rows={list} rowKey={(r) => r.duplicateId} />
      </StateSwitch>

      <MergeReviewDrawer
        pair={reviewing}
        onClose={() => setReviewing(null)}
        onMerged={(duplicateId) => onMerged(duplicateId)}
        onNotEnabled={() => setMergeDisabled(true)}
      />
    </>
  );
}

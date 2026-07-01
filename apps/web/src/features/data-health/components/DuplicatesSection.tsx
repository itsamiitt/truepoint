// DuplicatesSection.tsx — the Duplicates review tab: a DataTable of the workspace's auto-flagged duplicate contacts,
// each paired with the canonical it was merged into, with a per-row "Not a duplicate" action that un-merges it (the
// override). Four async states via StateSwitch with a first-class EmptyState. NAMES ONLY — no PII crosses here.
"use client";

import type { DuplicatePairView } from "@leadwolf/types";
import { type Column, DataTable, EmptyState, Icon, StateSwitch, TpButton } from "@leadwolf/ui";
import { Copy } from "lucide-react";

const fmt = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

export function DuplicatesSection({
  pairs,
  loading,
  error,
  unmarking,
  onRetry,
  onUnmark,
}: {
  pairs: DuplicatePairView[] | null;
  loading: boolean;
  error: string | null;
  unmarking: string | null;
  onRetry: () => void;
  onUnmark: (contactId: string) => void;
}) {
  const list = pairs ?? [];
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
        <TpButton
          variant="secondary"
          size="sm"
          loading={unmarking === r.duplicateId}
          onClick={() => onUnmark(r.duplicateId)}
        >
          Not a duplicate
        </TpButton>
      ),
    },
  ];

  return (
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
  );
}

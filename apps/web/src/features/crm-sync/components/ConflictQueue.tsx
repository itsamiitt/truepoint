// ConflictQueue.tsx — the field-level conflict review queue (GET/PATCH /crm/conflicts).
//
// A conflict is raised when the CRM wanted to change a field a human had PINNED. The live TruePoint value is
// never touched — it is staged here for a person to arbitrate (§6.1 staging-not-clobber), which is why this
// panel offers only "Keep ours" and "Dismiss" and never "apply the CRM value": applying is a data decision
// the merge engine makes, not a button that silently overwrites a human's correction.
//
// The values shown are ALREADY PII-masked server-side (§4.7) — an email arrives as "•••.com". This component
// renders what it is given and must never attempt to resolve the real value.
"use client";

import { type Column, DataTable, EmptyState, Icon, StateSwitch, TpButton } from "@leadwolf/ui";
import { GitPullRequestArrow } from "lucide-react";
import styles from "../crm-sync.module.css";
import type { CrmConflictView } from "../types";

const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ConflictQueue({
  conflicts,
  loading,
  error,
  resolving,
  onResolve,
  onRetry,
}: {
  conflicts: CrmConflictView[] | null;
  loading: boolean;
  error: string | null;
  resolving: boolean;
  onResolve: (id: string, status: "resolved" | "ignored") => void;
  onRetry: () => void;
}) {
  const list = conflicts ?? [];

  const columns: Column<CrmConflictView>[] = [
    { key: "field", header: "Field", sortValue: (r) => r.field, cell: (r) => r.field },
    {
      key: "object",
      header: "Object",
      sortValue: (r) => r.objectType,
      cell: (r) => r.objectType,
    },
    { key: "tp", header: "TruePoint", cell: (r) => r.tpValue ?? "—" },
    { key: "crm", header: "CRM", cell: (r) => r.crmValue ?? "—" },
    {
      key: "raised",
      header: "Raised",
      sortValue: (r) => r.createdAt,
      cell: (r) => fmtDateTime(r.createdAt),
    },
    {
      key: "actions",
      header: "Decision",
      cell: (r) => (
        <div className={styles.actions}>
          <TpButton
            size="sm"
            variant="secondary"
            disabled={resolving}
            onClick={() => onResolve(r.id, "resolved")}
          >
            Keep ours
          </TpButton>
          <TpButton
            size="sm"
            variant="ghost"
            disabled={resolving}
            onClick={() => onResolve(r.id, "ignored")}
          >
            Dismiss
          </TpButton>
        </div>
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
          icon={<Icon icon={GitPullRequestArrow} size={28} />}
          title="Nothing to review"
          description="Conflicts appear when your CRM tries to change a field someone has edited by hand. Your value is kept until you decide."
        />
      }
    >
      <div className={styles.stack}>
        <DataTable columns={columns} rows={list} rowKey={(r) => r.id} />
        <p className={styles.footnote}>
          Your value was kept — nothing was overwritten. Personal fields show only their last few
          characters, so this queue never becomes a second copy of your contacts' details.
        </p>
      </div>
    </StateSwitch>
  );
}

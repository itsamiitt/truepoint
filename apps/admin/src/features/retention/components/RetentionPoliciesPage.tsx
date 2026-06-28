// RetentionPoliciesPage.tsx — the GLOBAL retention-policy admin screen (data-management A2; design
// 16-retention-engine-design.md). A DataTable of every data class with its TTL + mode, rendered through the
// four-state StateSwitch (loading/error/empty/content). super_admin may edit a row (EditPolicyDialog);
// view-only staff tiers see the table but no edit affordance (the render-gate is UX; the api is the real
// boundary). Shadow-first + OFF by default: a class only deletes when its mode is "enforce" AND the tenant
// has the retention engine enabled. The Policies-tab CONTENT: the RetentionPage host owns the page chrome
// (title + the Policies|Runs Tabs); this renders the table + edit dialog inside that host.
"use client";

import type { RetentionMode, RetentionPolicy } from "@leadwolf/types";
import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
  TpButton,
} from "@leadwolf/ui";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { useIsSuperAdmin } from "../hooks/useIsSuperAdmin";
import { useRetentionPolicies } from "../hooks/useRetentionPolicies";
import { EditPolicyDialog } from "./EditPolicyDialog";

const MODE_TONE: Record<RetentionMode, StatusTone> = {
  disabled: "muted",
  shadow: "warning",
  enforce: "danger",
};

export function RetentionPoliciesPage() {
  const { policies, error, loading, reload } = useRetentionPolicies();
  const { isSuperAdmin } = useIsSuperAdmin();
  const [editing, setEditing] = useState<RetentionPolicy | null>(null);

  const columns: Column<RetentionPolicy>[] = [
    {
      key: "dataClass",
      header: "Data class",
      sortValue: (p) => p.dataClass,
      cell: (p) => (
        <span style={{ fontFamily: "var(--tp-font-mono, monospace)", fontWeight: 600 }}>
          {p.dataClass}
        </span>
      ),
    },
    {
      key: "ttlDays",
      header: "TTL (days)",
      align: "right",
      width: 140,
      sortValue: (p) => p.ttlDays ?? Number.POSITIVE_INFINITY,
      cell: (p) => (p.ttlDays == null ? "Never" : p.ttlDays.toLocaleString()),
    },
    {
      key: "mode",
      header: "Mode",
      align: "center",
      width: 130,
      sortValue: (p) => p.mode,
      cell: (p) => <StatusBadge tone={MODE_TONE[p.mode]}>{p.mode}</StatusBadge>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: 110,
      cell: (p) =>
        isSuperAdmin ? (
          <TpButton variant="ghost" size="sm" leftIcon={<Pencil size={14} />} onClick={() => setEditing(p)}>
            Edit
          </TpButton>
        ) : null,
    },
  ];

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ color: "var(--tp-ink-3)", fontSize: 13, maxWidth: 640, margin: 0 }}>
        One global policy per data class: its time-to-live and its mode. Shadow counts and audits but
        deletes nothing; enforce permanently deletes aged rows for tenants with the retention engine
        enabled. {isSuperAdmin ? "Every change is audited." : "Only a super admin can change a policy."}
      </p>

      <StateSwitch
        loading={loading && policies.length === 0}
        error={error}
        empty={!loading && policies.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            title="No retention policies"
            description="No policy rows have been seeded yet."
          />
        }
      >
        <DataTable columns={columns} rows={policies} rowKey={(p) => p.dataClass} />
      </StateSwitch>

      {editing ? (
        <EditPolicyDialog
          policy={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      ) : null}
    </section>
  );
}

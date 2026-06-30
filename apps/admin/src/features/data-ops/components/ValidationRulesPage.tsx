// ValidationRulesPage.tsx — the data-quality rule builder (database-management-research 06): the global checks every
// import must pass (built-in + custom; reject-on-fail). List is data:read; add/edit/toggle/delete are data:manage,
// audited server-side. Built-in checks are read-only (code constants — no edit/delete). The add/edit form lives in
// RuleFormDialog; toggle is immediate; delete confirms first. Mirrors features/data-ops ApprovalsPage.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { ValidationRule } from "@leadwolf/types";
import { type Column, DataTable, Dialog, EmptyState, StateSwitch, TpButton, useToast } from "@leadwolf/ui";
import { ListChecks } from "lucide-react";
import { useState } from "react";
import { deleteValidationRule, toggleValidationRule } from "../api";
import { useValidationRules } from "../hooks/useValidationRules";
import { RuleFormDialog } from "./RuleFormDialog";

function configSummary(r: ValidationRule): string {
  if (r.checkType === "regex") return r.config.pattern ?? "—";
  if (r.checkType === "max_length") return r.config.maxLength != null ? `≤ ${r.config.maxLength}` : "—";
  if (r.checkType === "one_of") return (r.config.allowed ?? []).join(", ") || "—";
  return "—";
}

export function ValidationRulesPage() {
  const { rules, loading, error, reload } = useValidationRules();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("data:manage");

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ValidationRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ValidationRule | null>(null);
  const [busy, setBusy] = useState(false);

  function openNew() {
    setEditTarget(null);
    setFormOpen(true);
  }
  function openEdit(r: ValidationRule) {
    setEditTarget(r);
    setFormOpen(true);
  }

  async function onToggle(r: ValidationRule) {
    setBusy(true);
    try {
      await toggleValidationRule(r.id, !r.enabled);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the rule");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteValidationRule(deleteTarget.id);
      toast.success("Rule deleted.");
      setDeleteTarget(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the rule");
    } finally {
      setBusy(false);
    }
  }

  const actionsCol: Column<ValidationRule> = {
    key: "actions",
    header: "",
    cell: (r) =>
      r.builtin ? (
        <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>built-in</span>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <TpButton variant="secondary" onClick={() => openEdit(r)}>
            Edit
          </TpButton>
          <TpButton variant="secondary" onClick={() => void onToggle(r)} disabled={busy}>
            {r.enabled ? "Disable" : "Enable"}
          </TpButton>
          <TpButton variant="danger" onClick={() => setDeleteTarget(r)}>
            Delete
          </TpButton>
        </div>
      ),
  };

  const columns: Column<ValidationRule>[] = [
    { key: "name", header: "Rule", sortValue: (r) => r.name, cell: (r) => r.name },
    {
      key: "field",
      header: "Field",
      sortValue: (r) => r.field,
      cell: (r) => <span className="tp-cell-mono">{r.field}</span>,
    },
    {
      key: "check",
      header: "Check",
      sortValue: (r) => r.checkType,
      cell: (r) => <span className="tp-cell-mono">{r.checkType}</span>,
    },
    { key: "config", header: "Config", cell: (r) => <span className="tp-cell-mono">{configSummary(r)}</span> },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => (r.enabled ? "1" : "0"),
      cell: (r) => (r.enabled ? "Enabled" : <span style={{ color: "var(--tp-ink-3)" }}>Disabled</span>),
    },
    ...(canManage ? [actionsCol] : []),
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Validation rules</h2>
          <p className="tp-page-sub">
            The global data-quality checks every import must pass — built-in checks plus your custom rules. A row
            that fails any enabled rule is rejected (reject-on-fail). Changes are audited.
          </p>
        </div>
        {canManage ? (
          <TpButton variant="primary" onClick={openNew}>
            Add rule
          </TpButton>
        ) : null}
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!rules && rules.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<ListChecks size={20} />}
            title="No rules"
            description="No validation rules are defined yet."
          />
        }
      >
        <DataTable columns={columns} rows={rules ?? []} rowKey={(r) => r.id} />
      </StateSwitch>

      {formOpen ? (
        <RuleFormDialog
          rule={editTarget}
          onClose={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            void reload();
          }}
        />
      ) : null}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => (busy ? undefined : setDeleteTarget(null))}
        title="Delete rule"
        description={deleteTarget ? `Delete "${deleteTarget.name}"? This is audited.` : ""}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setDeleteTarget(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={() => void onDelete()} disabled={busy}>
              {busy ? "Working…" : "Delete"}
            </TpButton>
          </div>
        }
      />
    </div>
  );
}

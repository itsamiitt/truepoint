// RetentionPolicies.tsx — the retention-SLA authoring section on the Compliance page (13a Area 8, 13 §3.8):
// how long each entity (optionally a field) is retained. A table with
// create / edit and enable / retire, all going to the audited, compliance:manage-gated api. The create/edit/
// toggle controls hide without the capability (the api still enforces it). Renders via the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  Dialog,
  FieldGroup,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
  TpSelect,
  useToast,
} from "@leadwolf/ui";
import { useCallback, useEffect, useState } from "react";
import { createRetention, fetchRetention, setRetentionActive, updateRetention } from "../api";
import type { RetentionPolicy } from "../types";

const ENTITIES = ["contact", "account", "activity", "audit_log", "import", "reveal"];

interface Draft {
  id: string | null;
  entity: string;
  field: string; // blank = whole entity
  retentionDays: string;
  reason: string;
}

const EMPTY: Draft = { id: null, entity: "contact", field: "", retentionDays: "365", reason: "" };

export function RetentionPolicies() {
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("compliance:manage");

  const [policies, setPolicies] = useState<RetentionPolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [enableTarget, setEnableTarget] = useState<RetentionPolicy | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPolicies(await fetchRetention());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load retention policies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openNew() {
    setDraft({ ...EMPTY });
  }
  function openEdit(p: RetentionPolicy) {
    setDraft({
      id: p.id,
      entity: p.entity,
      field: p.field ?? "",
      retentionDays: String(p.retentionDays),
      reason: p.reason ?? "",
    });
  }

  async function onSave() {
    if (!draft) return;
    const days = Number(draft.retentionDays);
    if (!Number.isInteger(days) || days < 1) {
      toast.error("Retention days must be a whole number ≥ 1.");
      return;
    }
    const input = {
      entity: draft.entity,
      field: draft.field.trim() || null,
      retentionDays: days,
      reason: draft.reason.trim() || null,
    };
    setBusy(true);
    try {
      if (draft.id) await updateRetention(draft.id, input);
      else await createRetention(input);
      toast.success(draft.id ? "Policy updated." : "Policy created.");
      setDraft(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the policy");
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(p: RetentionPolicy) {
    setTogglingId(p.id);
    try {
      await setRetentionActive(p.id, !p.active);
      toast.success(p.active ? "Policy retired." : "Policy enabled.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the policy");
    } finally {
      setTogglingId(null);
    }
  }

  const columns: Column<RetentionPolicy>[] = [
    {
      key: "entity",
      header: "Entity",
      sortValue: (p) => p.entity,
      cell: (p) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{p.entity}</span>
          <span className="app-muted" style={{ fontSize: "var(--tp-text-caption)" }}>
            {p.field ? `field: ${p.field}` : "whole entity"}
          </span>
        </div>
      ),
    },
    {
      key: "days",
      header: "Retention (days)",
      align: "right",
      sortValue: (p) => p.retentionDays,
      cell: (p) => p.retentionDays.toLocaleString(),
    },
    {
      key: "reason",
      header: "Reason",
      cell: (p) => p.reason ?? "—",
    },
    {
      key: "active",
      header: "Status",
      sortValue: (p) => (p.active ? 0 : 1),
      cell: (p) => (
        <StatusBadge tone={p.active ? "success" : "muted"}>
          {p.active ? "Active" : "Retired"}
        </StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (p) =>
        canManage ? (
          <div style={{ display: "flex", gap: "var(--tp-space-2)", justifyContent: "flex-end" }}>
            <TpButton
              variant="ghost"
              size="sm"
              disabled={togglingId === p.id}
              onClick={() => openEdit(p)}
            >
              Edit
            </TpButton>
            <TpButton
              variant="ghost"
              size="sm"
              disabled={togglingId === p.id}
              onClick={() => {
                if (p.active) void onToggle(p);
                else setEnableTarget(p);
              }}
            >
              {p.active ? "Retire" : "Enable"}
            </TpButton>
          </div>
        ) : (
          <span className="app-muted">—</span>
        ),
    },
  ];

  return (
    <div style={{ marginTop: 28 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "var(--tp-space-3)",
        }}
      >
        <h3 className="tp-section-title">Retention policies</h3>
        {canManage ? <TpButton onClick={openNew}>New policy</TpButton> : null}
      </div>

      {/* audit 32 §9C — these rows are a RECORDED COMMITMENT, not an enforcement rule: nothing reads this
          table outside this console. Saying so on screen is the point. A compliance officer who writes
          "contacts.email — 400 days", sees it saved and marked Active, and reasonably concludes personal data
          is being deleted on that schedule is the failure this line exists to prevent — and a code comment
          cannot reach them. Whether to wire it into the sweep is a human decision (§9C options). */}
      <p
        className="app-muted"
        style={{
          fontSize: "var(--tp-text-caption)",
          marginTop: "var(--tp-space-1)",
          maxWidth: "68ch",
        }}
      >
        Recorded commitments, for audit and reference. Saving a policy here does{" "}
        <strong>not</strong> delete anything — the engine that actually deletes reads its own
        per-class schedule on the Retention page.
      </p>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!policies && policies.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <p className="app-muted" style={{ padding: "var(--tp-space-4)" }}>
            No retention policies configured.
          </p>
        }
      >
        <DataTable columns={columns} rows={policies ?? []} rowKey={(p) => p.id} />
      </StateSwitch>

      <Dialog
        open={!!draft}
        onClose={() => (busy ? undefined : setDraft(null))}
        title={draft?.id ? "Edit retention policy" : "New retention policy"}
        footer={
          <div style={{ display: "flex", gap: "var(--tp-space-2)", justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton onClick={() => void onSave()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </TpButton>
          </div>
        }
      >
        {draft ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-3)" }}>
            {/* The DS FieldGroup, not four hand-rolled label+span stacks: it is the same label · control ·
                hint contract the rest of this console already uses 22 times, and it keeps the label tone and
                spacing on tokens instead of re-deciding them per dialog. */}
            <FieldGroup label="Entity" htmlFor="r-entity">
              <TpSelect
                id="r-entity"
                value={draft.entity}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, entity: e.currentTarget.value })}
              >
                {ENTITIES.map((en) => (
                  <option key={en} value={en}>
                    {en}
                  </option>
                ))}
              </TpSelect>
            </FieldGroup>
            <FieldGroup label="Field" htmlFor="r-field" hint="Blank = the whole entity.">
              <TpInput
                id="r-field"
                value={draft.field}
                placeholder="e.g. email"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, field: e.currentTarget.value })}
              />
            </FieldGroup>
            <FieldGroup label="Retention (days)" htmlFor="r-days">
              <TpInput
                id="r-days"
                type="number"
                value={draft.retentionDays}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, retentionDays: e.currentTarget.value })}
              />
            </FieldGroup>
            <FieldGroup label="Reason (optional)" htmlFor="r-reason">
              <TpInput
                id="r-reason"
                value={draft.reason}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, reason: e.currentTarget.value })}
              />
            </FieldGroup>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={!!enableTarget}
        onClose={() => setEnableTarget(null)}
        title="Mark this retention policy active?"
        description={
          enableTarget
            ? `Records a commitment to retain "${enableTarget.entity}${enableTarget.field ? `.${enableTarget.field}` : ""}" for ${enableTarget.retentionDays} days. This does NOT start or arm any deletion — the retention engine reads its own per-class schedule. The change is audited.`
            : undefined
        }
        footer={
          <div style={{ display: "flex", gap: "var(--tp-space-2)", justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setEnableTarget(null)}>
              Cancel
            </TpButton>
            <TpButton
              variant="danger"
              onClick={() => {
                if (enableTarget) void onToggle(enableTarget);
                setEnableTarget(null);
              }}
            >
              Enable policy
            </TpButton>
          </div>
        }
      />
    </div>
  );
}

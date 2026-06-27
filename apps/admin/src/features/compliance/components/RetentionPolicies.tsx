// RetentionPolicies.tsx — the retention-SLA authoring section on the Compliance page (13a Area 8, 13 §3.8):
// how long each entity (optionally a field) is retained — the input to the retention sweep. A table with
// create / edit and enable / retire, all going to the audited, compliance:manage-gated api. The create/edit/
// toggle controls hide without the capability (the api still enforces it). Renders via the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  Dialog,
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
    try {
      await setRetentionActive(p.id, !p.active);
      toast.success(p.active ? "Policy retired." : "Policy enabled.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the policy");
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
          <span className="app-muted" style={{ fontSize: 12 }}>
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
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="ghost" size="sm" onClick={() => openEdit(p)}>
              Edit
            </TpButton>
            <TpButton variant="ghost" size="sm" onClick={() => void onToggle(p)}>
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
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
      >
        <h3 className="tp-section-title">Retention policies</h3>
        {canManage ? <TpButton onClick={openNew}>New policy</TpButton> : null}
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!policies && policies.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <p className="app-muted" style={{ padding: 16 }}>
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
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label htmlFor="r-entity" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Entity</span>
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
            </label>
            <label htmlFor="r-field" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>
                Field (blank = whole entity)
              </span>
              <TpInput
                id="r-field"
                value={draft.field}
                placeholder="e.g. email"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, field: e.currentTarget.value })}
              />
            </label>
            <label htmlFor="r-days" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Retention (days)</span>
              <TpInput
                id="r-days"
                type="number"
                value={draft.retentionDays}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, retentionDays: e.currentTarget.value })}
              />
            </label>
            <label htmlFor="r-reason" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason (optional)</span>
              <TpInput
                id="r-reason"
                value={draft.reason}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, reason: e.currentTarget.value })}
              />
            </label>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

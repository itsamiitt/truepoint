// PlansPage.tsx — the plan/entitlement-template catalog (13a Area 5, 13 §3.5, 07 §5): staff author the plans
// the product offers — seat/workspace caps, optional monthly credit grant, and the entitlement feature flags.
// A table with create / edit (idempotent on key) and offer / retire toggles, all going to the audited,
// pricing:manage-gated api. Renders async state through the State Kit. Applying a template to a tenant (the
// plan-override path) is a separate surface.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
  useToast,
} from "@leadwolf/ui";
import { Layers } from "lucide-react";
import { type ReactNode, useState } from "react";
import { setPlanTemplateActive, upsertPlanTemplate } from "../api";
import { usePlans } from "../hooks/usePlans";
import type { PlanTemplate } from "../types";

interface Draft {
  editingKey: string | null;
  key: string;
  name: string;
  seatLimit: string;
  workspaceLimit: string; // blank = unlimited
  monthlyCreditGrant: string; // blank = none
  features: string; // comma-separated enabled feature keys
  sortOrder: string;
}

const EMPTY: Draft = {
  editingKey: null,
  key: "",
  name: "",
  seatLimit: "1",
  workspaceLimit: "",
  monthlyCreditGrant: "",
  features: "",
  sortOrder: "0",
};

/** Blank → null (unlimited / none); a valid non-negative integer → the number; otherwise undefined (invalid). */
function optInt(s: string): number | null | undefined {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function enabledFeatureKeys(features: Record<string, boolean>): string[] {
  return Object.entries(features)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

export function PlansPage() {
  const { templates, loading, error, reload } = usePlans();
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const canManage = canMaybe("pricing:manage");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  function openNew() {
    setDraft({ ...EMPTY });
  }
  function openEdit(t: PlanTemplate) {
    setDraft({
      editingKey: t.key,
      key: t.key,
      name: t.name,
      seatLimit: String(t.seatLimit),
      workspaceLimit: t.workspaceLimit == null ? "" : String(t.workspaceLimit),
      monthlyCreditGrant: t.monthlyCreditGrant == null ? "" : String(t.monthlyCreditGrant),
      features: enabledFeatureKeys(t.features).join(", "),
      sortOrder: String(t.sortOrder),
    });
  }

  async function onSave() {
    if (!draft) return;
    const key = draft.key.trim();
    const name = draft.name.trim();
    const seatLimit = Number(draft.seatLimit);
    const workspaceLimit = optInt(draft.workspaceLimit);
    const monthlyCreditGrant = optInt(draft.monthlyCreditGrant);
    const sortOrder = Number(draft.sortOrder || "0");
    if (!/^[a-z0-9_]+$/.test(key)) {
      toast.error("Key: lowercase letters, digits and underscore only.");
      return;
    }
    if (!name) {
      toast.error("Enter a name.");
      return;
    }
    if (!Number.isInteger(seatLimit) || seatLimit < 0) {
      toast.error("Seat limit must be a whole number ≥ 0.");
      return;
    }
    if (workspaceLimit === undefined) {
      toast.error("Workspace limit must be blank (unlimited) or a whole number ≥ 0.");
      return;
    }
    if (monthlyCreditGrant === undefined) {
      toast.error("Monthly credit grant must be blank (none) or a whole number ≥ 0.");
      return;
    }
    const features: Record<string, boolean> = {};
    for (const k of draft.features
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      features[k] = true;
    }
    setBusy(true);
    try {
      await upsertPlanTemplate({
        key,
        name,
        seatLimit,
        workspaceLimit,
        monthlyCreditGrant,
        features,
        sortOrder: Number.isInteger(sortOrder) ? sortOrder : 0,
      });
      toast.success(draft.editingKey ? "Plan updated." : "Plan created.");
      setDraft(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the plan");
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(t: PlanTemplate) {
    setTogglingKey(t.key);
    try {
      await setPlanTemplateActive(t.key, !t.active);
      toast.success(t.active ? "Plan retired." : "Plan offered.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the plan");
    } finally {
      setTogglingKey(null);
    }
  }

  const columns: Column<PlanTemplate>[] = [
    {
      key: "name",
      header: "Plan",
      sortValue: (t) => t.sortOrder,
      cell: (t) => (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{t.name}</span>
          <span className="tp-cell-mono">{t.key}</span>
        </div>
      ),
    },
    {
      key: "seats",
      header: "Seats",
      align: "right",
      sortValue: (t) => t.seatLimit,
      cell: (t) => t.seatLimit.toLocaleString(),
    },
    {
      key: "workspaces",
      header: "Workspaces",
      align: "right",
      sortValue: (t) => t.workspaceLimit ?? Number.POSITIVE_INFINITY,
      cell: (t) => (t.workspaceLimit == null ? "∞" : t.workspaceLimit.toLocaleString()),
    },
    {
      key: "grant",
      header: "Monthly credits",
      align: "right",
      sortValue: (t) => t.monthlyCreditGrant ?? 0,
      cell: (t) => (t.monthlyCreditGrant == null ? "—" : t.monthlyCreditGrant.toLocaleString()),
    },
    {
      key: "features",
      header: "Features",
      sortValue: (t) => enabledFeatureKeys(t.features).length,
      cell: (t) => {
        const ks = enabledFeatureKeys(t.features);
        return ks.length === 0 ? "—" : `${ks.length}`;
      },
    },
    {
      key: "active",
      header: "Status",
      sortValue: (t) => (t.active ? 0 : 1),
      cell: (t) => (
        <StatusBadge tone={t.active ? "success" : "muted"}>
          {t.active ? "Offered" : "Retired"}
        </StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (t) =>
        canManage ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton
              variant="ghost"
              size="sm"
              disabled={togglingKey === t.key}
              onClick={() => openEdit(t)}
            >
              Edit
            </TpButton>
            <TpButton
              variant="ghost"
              size="sm"
              disabled={togglingKey === t.key}
              onClick={() => void onToggle(t)}
            >
              {t.active ? "Retire" : "Offer"}
            </TpButton>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Plans</h2>
          <p className="tp-page-sub">
            Plan/entitlement templates — seat &amp; workspace caps, an optional monthly credit
            grant, and feature entitlements.
          </p>
        </div>
        {canManage ? <TpButton onClick={openNew}>New plan</TpButton> : null}
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!templates && templates.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Layers size={20} />}
            title="No plan templates"
            description="Create the first plan the product will offer."
          />
        }
      >
        <DataTable columns={columns} rows={templates ?? []} rowKey={(t) => t.key} />
      </StateSwitch>

      <Dialog
        open={!!draft}
        onClose={() => (busy ? undefined : setDraft(null))}
        title={draft?.editingKey ? "Edit plan template" : "New plan template"}
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
            <Field label="Key (stable id)" htmlFor="plan-key">
              <TpInput
                id="plan-key"
                value={draft.key}
                placeholder="e.g. pro"
                disabled={busy || draft.editingKey != null}
                onChange={(e) => setDraft({ ...draft, key: e.currentTarget.value })}
              />
            </Field>
            <Field label="Name" htmlFor="plan-name">
              <TpInput
                id="plan-name"
                value={draft.name}
                placeholder="e.g. Pro"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              />
            </Field>
            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Seat limit" htmlFor="plan-seats" grow>
                <TpInput
                  id="plan-seats"
                  type="number"
                  value={draft.seatLimit}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, seatLimit: e.currentTarget.value })}
                />
              </Field>
              <Field label="Workspaces (blank = ∞)" htmlFor="plan-ws" grow>
                <TpInput
                  id="plan-ws"
                  type="number"
                  value={draft.workspaceLimit}
                  placeholder="∞"
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, workspaceLimit: e.currentTarget.value })}
                />
              </Field>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <Field label="Monthly credit grant (blank = none)" htmlFor="plan-grant" grow>
                <TpInput
                  id="plan-grant"
                  type="number"
                  value={draft.monthlyCreditGrant}
                  placeholder="none"
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, monthlyCreditGrant: e.currentTarget.value })
                  }
                />
              </Field>
              <Field label="Sort" htmlFor="plan-sort">
                <TpInput
                  id="plan-sort"
                  type="number"
                  value={draft.sortOrder}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, sortOrder: e.currentTarget.value })}
                />
              </Field>
            </div>
            <Field label="Features (comma-separated enabled keys)" htmlFor="plan-features">
              <TpInput
                id="plan-features"
                value={draft.features}
                placeholder="api_access, crm_sync, ai_outreach"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, features: e.currentTarget.value })}
              />
            </Field>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  grow,
  children,
}: {
  label: string;
  htmlFor: string;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      style={{ display: "flex", flexDirection: "column", gap: 4, flex: grow ? "1 1 0" : undefined }}
    >
      <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{label}</span>
      {children}
    </label>
  );
}

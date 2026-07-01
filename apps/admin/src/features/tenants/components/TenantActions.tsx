// TenantActions.tsx — the staff mutation row on a tenant's detail (13a Area 1, 13 §3.1): suspend / reactivate
// and a manual credit grant/adjustment, each behind a dialog that requires a justification. All writes go to
// the audited, role-gated /admin/tenants/:id/* endpoints; a 403/422 from the api is surfaced as a clear toast
// (the api is the authority — the console never assumes the caller may act). On success the parent reloads so
// the status badge + credit balance reflect the change. Mirrors the StaffPage grant/revoke pattern.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import { Dialog, TpButton, TpInput, TpSelect, TpTextarea, useToast } from "@leadwolf/ui";
import { useState } from "react";
import {
  adjustTenantCredits,
  applyTenantPlan,
  fetchActivePlanTemplates,
  reactivateTenant,
  requestElevation,
  suspendTenant,
} from "../api";
import type { PlanTemplateOption, TenantRow } from "../types";

const MIN_REASON = 5;

export function TenantActions({
  tenant,
  onChanged,
}: {
  tenant: TenantRow;
  onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const { canMaybe } = useStaffMe();
  const suspended = tenant.status === "suspended";

  const [statusOpen, setStatusOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState("");
  const [templates, setTemplates] = useState<PlanTemplateOption[] | null>(null);
  const [planKey, setPlanKey] = useState("");
  const [busy, setBusy] = useState(false);

  function openStatus() {
    setReason("");
    setStatusOpen(true);
  }
  function openCredit() {
    setReason("");
    setDelta("");
    setCreditOpen(true);
  }
  async function openPlan() {
    setPlanKey("");
    setTemplates(null);
    setPlanOpen(true);
    try {
      const list = await fetchActivePlanTemplates();
      setTemplates(list);
      if (list[0]) setPlanKey(list[0].key);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load plan templates");
    }
  }

  async function onApplyPlan() {
    if (!planKey) {
      toast.error("Pick a plan template.");
      return;
    }
    setBusy(true);
    try {
      await applyTenantPlan(tenant.id, planKey);
      toast.success(`Plan applied — ${planKey}.`);
      setPlanOpen(false);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not apply the plan");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleStatus() {
    const r = reason.trim();
    if (r.length < MIN_REASON) {
      toast.error(`Enter a reason (min ${MIN_REASON} characters).`);
      return;
    }
    setBusy(true);
    try {
      if (suspended) {
        // Reactivation is restorative — not JIT-gated.
        await reactivateTenant(tenant.id, r);
      } else {
        // Suspend is JIT-gated (13a F1): mint the elevation, then perform the action that consumes it.
        await requestElevation("tenant.suspend", r, tenant.id);
        await suspendTenant(tenant.id, r);
      }
      toast.success(suspended ? "Tenant reactivated." : "Tenant suspended.");
      setStatusOpen(false);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function onAdjustCredits() {
    const n = Number(delta);
    if (!Number.isInteger(n) || n === 0) {
      toast.error("Enter a non-zero whole number (+ to grant, − to debit).");
      return;
    }
    const r = reason.trim();
    if (r.length < MIN_REASON) {
      toast.error(`Enter a reason (min ${MIN_REASON} characters).`);
      return;
    }
    setBusy(true);
    try {
      // Money moves require peer approval (Part B / decision #4): FILE a request — a DIFFERENT billing operator
      // approves + executes it. No balance change happens here.
      await adjustTenantCredits(tenant.id, n, r);
      toast.success(
        `Credit ${n > 0 ? "grant" : "debit"} requested — a different operator must approve it before it applies.`,
      );
      setCreditOpen(false);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Adjustment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Buttons are hidden when the caller's role lacks the capability (the api still enforces it). */}
      <div style={{ display: "flex", gap: 8 }}>
        {canMaybe("tenants:credits") ? (
          <TpButton variant="secondary" onClick={openCredit}>
            Adjust credits
          </TpButton>
        ) : null}
        {canMaybe("tenants:plan") ? (
          <TpButton variant="secondary" onClick={() => void openPlan()}>
            Apply plan
          </TpButton>
        ) : null}
        {canMaybe("tenants:suspend") ? (
          <TpButton variant={suspended ? "primary" : "danger"} onClick={openStatus}>
            {suspended ? "Reactivate" : "Suspend"}
          </TpButton>
        ) : null}
      </div>

      {/* Suspend / reactivate — reason is recorded in the immutable platform audit log. */}
      <Dialog
        open={statusOpen}
        onClose={() => (busy ? undefined : setStatusOpen(false))}
        title={suspended ? "Reactivate tenant" : "Suspend tenant"}
        description={
          suspended
            ? `Restore access for ${tenant.name}. This is audited.`
            : `Suspend ${tenant.name}. Members lose access until reactivated. This is audited.`
        }
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setStatusOpen(false)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton
              variant={suspended ? "primary" : "danger"}
              onClick={() => void onToggleStatus()}
              disabled={busy}
            >
              {busy ? "Working…" : suspended ? "Reactivate" : "Suspend"}
            </TpButton>
          </div>
        }
      >
        <label
          htmlFor="tenant-status-reason"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason (audited)</span>
          <TpTextarea
            id="tenant-status-reason"
            value={reason}
            rows={3}
            placeholder="Why is this org being suspended / reactivated?"
            disabled={busy}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      </Dialog>

      {/* Manual credit grant / adjustment — signed delta + reason. */}
      <Dialog
        open={creditOpen}
        onClose={() => (busy ? undefined : setCreditOpen(false))}
        title="Adjust credits"
        description={`Apply a signed credit adjustment to ${tenant.name}. Current balance ${tenant.revealCreditBalance}. Positive grants, negative debits. This is audited.`}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setCreditOpen(false)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton onClick={() => void onAdjustCredits()} disabled={busy}>
              {busy ? "Applying…" : "Apply"}
            </TpButton>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label
            htmlFor="tenant-credit-delta"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>
              Amount (+ grant / − debit)
            </span>
            <TpInput
              id="tenant-credit-delta"
              type="number"
              value={delta}
              placeholder="e.g. 500 or -100"
              disabled={busy}
              onChange={(e) => setDelta(e.currentTarget.value)}
            />
          </label>
          <label
            htmlFor="tenant-credit-reason"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Reason (audited)</span>
            <TpTextarea
              id="tenant-credit-reason"
              value={reason}
              rows={3}
              placeholder="e.g. goodwill credit for incident #123 / chargeback reversal"
              disabled={busy}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
          </label>
        </div>
      </Dialog>

      {/* Plan override — apply a plan template's entitlements (plan / limits / features). Audited. */}
      <Dialog
        open={planOpen}
        onClose={() => (busy ? undefined : setPlanOpen(false))}
        title="Apply plan"
        description={`Apply a plan template to ${tenant.name} — sets the plan, seat & workspace limits, and feature entitlements. Current plan ${tenant.plan}. This is audited.`}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <TpButton variant="secondary" onClick={() => setPlanOpen(false)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton onClick={() => void onApplyPlan()} disabled={busy || !planKey}>
              {busy ? "Applying…" : "Apply plan"}
            </TpButton>
          </div>
        }
      >
        <label
          htmlFor="tenant-plan-key"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>Plan template</span>
          {templates === null ? (
            <span className="app-muted">Loading templates…</span>
          ) : templates.length === 0 ? (
            <span className="app-muted">No active plan templates — create one under Plans.</span>
          ) : (
            <TpSelect
              id="tenant-plan-key"
              value={planKey}
              disabled={busy}
              onChange={(e) => setPlanKey(e.currentTarget.value)}
            >
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name} ({t.key}) — {t.seatLimit} seats
                </option>
              ))}
            </TpSelect>
          )}
        </label>
      </Dialog>
    </>
  );
}

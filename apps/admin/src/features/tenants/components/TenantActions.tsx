// TenantActions.tsx — the staff mutation row on a tenant's detail (13a Area 1, 13 §3.1): suspend / reactivate
// and a manual credit grant/adjustment, each behind a dialog that requires a justification. All writes go to
// the audited, role-gated /admin/tenants/:id/* endpoints; a 403/422 from the api is surfaced as a clear toast
// (the api is the authority — the console never assumes the caller may act). On success the parent reloads so
// the status badge + credit balance reflect the change. Mirrors the StaffPage grant/revoke pattern.
"use client";

import { Dialog, TpButton, TpInput, TpTextarea, useToast } from "@leadwolf/ui";
import { useState } from "react";
import { adjustTenantCredits, reactivateTenant, suspendTenant } from "../api";
import type { TenantRow } from "../types";

const MIN_REASON = 5;

export function TenantActions({
  tenant,
  onChanged,
}: {
  tenant: TenantRow;
  onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const suspended = tenant.status === "suspended";

  const [statusOpen, setStatusOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState("");
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

  async function onToggleStatus() {
    const r = reason.trim();
    if (r.length < MIN_REASON) {
      toast.error(`Enter a reason (min ${MIN_REASON} characters).`);
      return;
    }
    setBusy(true);
    try {
      if (suspended) await reactivateTenant(tenant.id, r);
      else await suspendTenant(tenant.id, r);
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
      const { balanceAfter } = await adjustTenantCredits(tenant.id, n, r);
      toast.success(`Credits ${n > 0 ? "granted" : "debited"} — new balance ${balanceAfter}.`);
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
      <div style={{ display: "flex", gap: 8 }}>
        <TpButton variant="secondary" onClick={openCredit}>
          Adjust credits
        </TpButton>
        <TpButton variant={suspended ? "primary" : "danger"} onClick={openStatus}>
          {suspended ? "Reactivate" : "Suspend"}
        </TpButton>
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
    </>
  );
}

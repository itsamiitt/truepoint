// EditPolicyDialog.tsx — edit ONE global retention policy: its TTL (days, blank = never) and its mode
// (disabled | shadow | enforce). CRITICAL: flipping a class to `enforce` from any other mode ARMS REAL,
// permanent deletion of aged rows — so that transition is gated behind an explicit in-dialog CONFIRM step
// with a clear warning, never a silent save. super_admin-gated by the caller (render-gate) + the api
// (requireStaffRole — the real boundary); every write is audited server-side. Rendered by the page.
"use client";

import type { RetentionMode, RetentionPolicy } from "@leadwolf/types";
import { Dialog, FieldGroup, TpButton, TpInput, TpSelect, useToast } from "@leadwolf/ui";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { updateRetentionPolicy } from "../api";

export function EditPolicyDialog({
  policy,
  onClose,
  onSaved,
}: {
  policy: RetentionPolicy;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [ttl, setTtl] = useState(policy.ttlDays == null ? "" : String(policy.ttlDays));
  const [mode, setMode] = useState<RetentionMode>(policy.mode);
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [busy, setBusy] = useState(false);

  // Parse the TTL field → null (never) or a positive int; a non-empty, non-positive-int value is invalid.
  const trimmed = ttl.trim();
  const ttlDays = trimmed === "" ? null : Number.parseInt(trimmed, 10);
  const ttlInvalid = trimmed !== "" && (!Number.isInteger(ttlDays) || (ttlDays as number) < 1);

  // Flipping to `enforce` from any other mode ARMS deletion — the gated, confirmed transition.
  const armsDeletion = mode === "enforce" && policy.mode !== "enforce";

  async function save() {
    setBusy(true);
    try {
      await updateRetentionPolicy(policy.dataClass, { ttlDays, mode });
      toast.success(`Policy for ${policy.dataClass} saved`);
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the policy");
      setStep("edit"); // back to the form so the operator can retry or cancel
    } finally {
      setBusy(false);
    }
  }

  function onPrimary() {
    if (ttlInvalid) {
      toast.error("TTL must be a positive whole number of days, or blank for never");
      return;
    }
    if (armsDeletion) {
      setStep("confirm");
      return;
    }
    void save();
  }

  const ageClause =
    ttlDays == null ? "once a TTL is set" : `older than ${ttlDays} day${ttlDays === 1 ? "" : "s"}`;

  if (step === "confirm") {
    return (
      <Dialog
        open
        onClose={() => !busy && setStep("edit")}
        title="Enable permanent deletion?"
        description={`Switching ${policy.dataClass} to “enforce” turns on REAL deletion for this class.`}
        maxWidth={520}
        footer={
          <>
            <TpButton variant="secondary" disabled={busy} onClick={() => setStep("edit")}>
              Back
            </TpButton>
            <TpButton variant="danger" loading={busy} onClick={() => void save()}>
              Enable permanent deletion
            </TpButton>
          </>
        }
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            padding: 12,
            borderRadius: 8,
            background: "var(--tp-surface-3)",
            border: "1px solid var(--danger)",
            color: "var(--tp-ink)",
          }}
        >
          <AlertTriangle size={18} aria-hidden style={{ color: "var(--danger)", flexShrink: 0 }} />
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            This enables permanent deletion of <strong>{policy.dataClass}</strong> rows {ageClause} for
            tenants with the retention engine enabled. Deleted rows cannot be recovered.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title="Edit retention policy"
      description={`Global policy for ${policy.dataClass}. A class only deletes when its mode is “enforce” and the tenant has the retention engine enabled.`}
      maxWidth={520}
      footer={
        <>
          <TpButton variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </TpButton>
          <TpButton variant={armsDeletion ? "danger" : "primary"} disabled={busy} onClick={onPrimary}>
            {armsDeletion ? "Review change" : "Save changes"}
          </TpButton>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FieldGroup label="TTL (days)" htmlFor="rp-ttl">
          <TpInput
            id="rp-ttl"
            type="number"
            min={1}
            value={ttl}
            placeholder="Never (no TTL)"
            onChange={(e) => setTtl(e.currentTarget.value)}
          />
        </FieldGroup>
        <FieldGroup label="Mode" htmlFor="rp-mode">
          <TpSelect
            id="rp-mode"
            value={mode}
            onChange={(e) => setMode(e.currentTarget.value as RetentionMode)}
          >
            <option value="disabled">Disabled — engine ignores this class</option>
            <option value="shadow">Shadow — count + audit, delete nothing</option>
            <option value="enforce">Enforce — permanently delete aged rows</option>
          </TpSelect>
        </FieldGroup>
      </div>
    </Dialog>
  );
}

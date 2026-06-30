// RuleFormDialog.tsx — create / edit a CUSTOM data-quality validation rule (database-management-research 06). The
// rule-builder form (name · field · check · per-check config · enabled), posting to the audited, data:manage-gated
// /admin/data/validation/rules endpoints. Built-in checks are read-only (not edited here). config inputs are shown
// only for the checks that use them (pattern / max length / allowed values). Remounted per open, so state resets.
"use client";

import type { UpsertValidationRuleInput, ValidationCheckType, ValidationRule } from "@leadwolf/types";
import { Dialog, TpButton, TpInput, TpSelect, TpSwitch, useToast } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { useState } from "react";
import { createValidationRule, updateValidationRule } from "../api";

const CHECK_TYPES: { value: ValidationCheckType; label: string }[] = [
  { value: "required", label: "Required (must be present)" },
  { value: "email_format", label: "Valid email format" },
  { value: "regex", label: "Matches a pattern (regex)" },
  { value: "max_length", label: "Maximum length" },
  { value: "one_of", label: "One of a list of values" },
];

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{label}</span>
      {children}
    </label>
  );
}

export function RuleFormDialog({
  rule,
  onClose,
  onSaved,
}: {
  rule: ValidationRule | null; // null = create a new rule
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const editing = rule !== null;
  const [name, setName] = useState(rule?.name ?? "");
  const [field, setField] = useState(rule?.field ?? "");
  const [checkType, setCheckType] = useState<ValidationCheckType>(rule?.checkType ?? "required");
  const [pattern, setPattern] = useState(rule?.config.pattern ?? "");
  const [maxLength, setMaxLength] = useState(rule?.config.maxLength != null ? String(rule.config.maxLength) : "");
  const [allowed, setAllowed] = useState((rule?.config.allowed ?? []).join(", "));
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    const n = name.trim();
    const f = field.trim();
    if (!n || !f) {
      toast.error("Name and field are both required.");
      return;
    }
    const config: UpsertValidationRuleInput["config"] = {};
    if (checkType === "regex" && pattern.trim()) config.pattern = pattern.trim();
    if (checkType === "max_length") {
      const m = Number.parseInt(maxLength, 10);
      if (!Number.isFinite(m) || m <= 0) {
        toast.error("Enter a positive maximum length.");
        return;
      }
      config.maxLength = m;
    }
    if (checkType === "one_of") {
      const list = allowed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) {
        toast.error("Enter at least one allowed value (comma-separated).");
        return;
      }
      config.allowed = list;
    }
    const input: UpsertValidationRuleInput = { name: n, field: f, checkType, config, enabled };
    setBusy(true);
    try {
      if (editing && rule) await updateValidationRule(rule.id, input);
      else await createValidationRule(input);
      toast.success(editing ? "Rule updated." : "Rule created.");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the rule");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => (busy ? undefined : onClose())}
      title={editing ? "Edit rule" : "New validation rule"}
      description="Imported rows that fail an enabled rule are rejected (reject-on-fail). Changes are audited."
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <TpButton variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </TpButton>
          <TpButton variant="primary" onClick={() => void onSubmit()} disabled={busy}>
            {busy ? "Saving…" : editing ? "Save" : "Create"}
          </TpButton>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Labeled label="Name">
          <TpInput
            value={name}
            disabled={busy}
            placeholder="e.g. Company required"
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Labeled>
        <Labeled label="Field (canonical key)">
          <TpInput
            value={field}
            disabled={busy}
            placeholder="e.g. email, firstName, company"
            onChange={(e) => setField(e.currentTarget.value)}
          />
        </Labeled>
        <Labeled label="Check">
          <TpSelect
            value={checkType}
            disabled={busy}
            onChange={(e) => setCheckType(e.currentTarget.value as ValidationCheckType)}
          >
            {CHECK_TYPES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </TpSelect>
        </Labeled>
        {checkType === "regex" ? (
          <Labeled label="Pattern (regex)">
            <TpInput
              value={pattern}
              disabled={busy}
              placeholder="^[A-Za-z]{2}$"
              onChange={(e) => setPattern(e.currentTarget.value)}
            />
          </Labeled>
        ) : null}
        {checkType === "max_length" ? (
          <Labeled label="Maximum length">
            <TpInput
              type="number"
              value={maxLength}
              disabled={busy}
              placeholder="120"
              onChange={(e) => setMaxLength(e.currentTarget.value)}
            />
          </Labeled>
        ) : null}
        {checkType === "one_of" ? (
          <Labeled label="Allowed values (comma-separated)">
            <TpInput
              value={allowed}
              disabled={busy}
              placeholder="active, inactive, pending"
              onChange={(e) => setAllowed(e.currentTarget.value)}
            />
          </Labeled>
        ) : null}
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <TpSwitch checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          <span style={{ fontSize: 13 }}>Enabled</span>
        </label>
      </div>
    </Dialog>
  );
}

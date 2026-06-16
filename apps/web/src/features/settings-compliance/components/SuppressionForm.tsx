// SuppressionForm.tsx — add a suppression / DNC entry (08 §3): pick a scope (workspace/tenant) and a match
// type (email/domain/contact_id), enter the matching value + an optional reason, POST it. The value field
// adapts to the chosen match type. Presentation + local view state only — the entry is created server-side
// via api.addSuppression and gates BOTH reveals and sends, in-transaction.
"use client";

import { type FormEvent, useState } from "react";
import { type AddableMatchType, type AddableScope, addSuppression } from "../api";
import styles from "../compliance.module.css";

const SCOPES: { value: AddableScope; label: string }[] = [
  { value: "workspace", label: "Workspace — this workspace only" },
  { value: "tenant", label: "Tenant — the whole organization" },
];

const MATCH_TYPES: { value: AddableMatchType; label: string }[] = [
  { value: "email", label: "Email address" },
  { value: "domain", label: "Domain" },
  { value: "contact_id", label: "Contact id" },
];

const VALUE_META: Record<AddableMatchType, { label: string; placeholder: string; type: string }> = {
  email: { label: "Email address", placeholder: "person@example.com", type: "email" },
  domain: { label: "Domain", placeholder: "example.com", type: "text" },
  contact_id: {
    label: "Contact id",
    placeholder: "00000000-0000-0000-0000-000000000000",
    type: "text",
  },
};

export function SuppressionForm() {
  const [scope, setScope] = useState<AddableScope>("workspace");
  const [matchType, setMatchType] = useState<AddableMatchType>("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);

  const meta = VALUE_META[matchType];
  const canSubmit = value.trim().length > 0 && !busy;

  function onMatchTypeChange(next: AddableMatchType): void {
    setMatchType(next);
    setValue("");
    setAddedId(null);
    setError(null);
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setAddedId(null);
    try {
      const trimmed = value.trim();
      const input = {
        scope,
        match_type: matchType,
        ...(matchType === "email" ? { email: trimmed } : {}),
        ...(matchType === "domain" ? { domain: trimmed } : {}),
        ...(matchType === "contact_id" ? { contact_id: trimmed } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      };
      const { id } = await addSuppression(input);
      setAddedId(id);
      setValue("");
      setReason("");
      // Nudge the sibling SuppressionList to reload so the new entry appears immediately.
      window.dispatchEvent(new CustomEvent("suppression:changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add suppression entry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Suppression / Do-Not-Contact</h2>
        <p className={styles.cardHint}>
          Add an email, domain, or contact id you never want revealed or messaged.
        </p>
      </div>

      <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Scope</span>
            <select
              className={styles.select}
              value={scope}
              onChange={(e) => setScope(e.target.value as AddableScope)}
            >
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Match type</span>
            <select
              className={styles.select}
              value={matchType}
              onChange={(e) => onMatchTypeChange(e.target.value as AddableMatchType)}
            >
              {MATCH_TYPES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>{meta.label}</span>
            <input
              className={styles.input}
              type={meta.type}
              value={value}
              placeholder={meta.placeholder}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Reason (optional)</span>
            <input
              className={styles.input}
              type="text"
              value={reason}
              placeholder="e.g. existing customer, opted out"
              maxLength={255}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </div>

        <div className={styles.actions}>
          <button className={styles.button} type="submit" disabled={!canSubmit}>
            {busy ? "Adding…" : "Add to suppression list"}
          </button>
          {addedId && (
            <p className={styles.success}>
              <span className={styles.successDot} aria-hidden="true" />
              <span>Added. This entry now blocks reveals and sends across the chosen scope.</span>
            </p>
          )}
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </form>

      <p className={styles.explainer}>
        <span className={styles.explainerDot} aria-hidden="true" />
        <span>
          Suppression is checked inside both the reveal and the send transaction — a suppressed
          contact is never revealed, exported, or messaged, regardless of credit balance.
        </span>
      </p>
    </section>
  );
}

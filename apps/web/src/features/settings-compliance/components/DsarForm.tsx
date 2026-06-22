// DsarForm.tsx — Data Subject Access Request intake (08 §4): pick a request type (access/delete/rectify),
// enter the subject's email, and POST to the PUBLIC, session-less endpoint. On success we surface the
// returned request id + "received" status and note that identity verification follows before anything is
// acted on. Presentation + local view state only — the request is recorded server-side via api.submitDsar.
"use client";

import { TpButton, TpInput, TpSelect } from "@leadwolf/ui";
import { type FormEvent, useState } from "react";
import { type DsarInput, type DsarReceipt, submitDsar } from "../api";
import styles from "../compliance.module.css";

const REQUEST_TYPES: { value: DsarInput["request_type"]; label: string }[] = [
  { value: "access", label: "Access — a copy of the data we hold" },
  { value: "delete", label: "Delete — erase the data everywhere" },
  { value: "rectify", label: "Rectify — correct inaccurate data" },
];

export function DsarForm() {
  const [requestType, setRequestType] = useState<DsarInput["request_type"]>("access");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<DsarReceipt | null>(null);

  const canSubmit = email.trim().length > 0 && !busy;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await submitDsar({ request_type: requestType, email: email.trim() });
      setReceipt(result);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Data subject request (DSAR)</h2>
        <p className={styles.cardHint}>
          Anyone can ask to access, delete, or correct the data we hold about them.
        </p>
      </div>

      <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.row}>
          <label className={styles.field} htmlFor="dsar-request-type">
            <span className={styles.label}>Request type</span>
            <TpSelect
              id="dsar-request-type"
              value={requestType}
              onChange={(e) => setRequestType(e.target.value as DsarInput["request_type"])}
            >
              {REQUEST_TYPES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </TpSelect>
          </label>

          <label className={styles.field} htmlFor="dsar-email">
            <span className={styles.label}>Email address</span>
            <TpInput
              id="dsar-email"
              type="email"
              value={email}
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
        </div>

        <div className={styles.actions}>
          <TpButton type="submit" disabled={!canSubmit}>
            {busy ? "Submitting…" : "Submit request"}
          </TpButton>
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </form>

      {receipt && (
        <div className={styles.receipt}>
          <div className={styles.receiptRow}>
            <span className={styles.receiptLabel}>Request id</span>
            <span className={styles.mono}>{receipt.id}</span>
          </div>
          <div className={styles.receiptRow}>
            <span className={styles.receiptLabel}>Status</span>
            <span className={styles.statusPill}>{receipt.status}</span>
          </div>
          <p className={styles.receiptNote}>
            We&apos;ll verify the requester&apos;s identity before acting on this request. Keep this
            id for reference.
          </p>
        </div>
      )}
    </section>
  );
}

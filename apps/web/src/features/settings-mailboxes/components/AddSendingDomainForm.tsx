// AddSendingDomainForm.tsx — register a per-tenant sending domain (M12, email-planning/13 P0, 03, D2). The
// domain is unusable for any send until SPF/DKIM/DMARC verify (the Verify action in the list). Presentation
// + local view state only.
"use client";

import { TpButton, TpInput } from "@leadwolf/ui";
import { type FormEvent, useState } from "react";
import { addSendingDomain } from "../api";
import styles from "../mailboxes.module.css";

export function AddSendingDomainForm({ onAdded }: { onAdded: () => void }) {
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const canSubmit = domain.trim().length >= 3 && !busy;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setAdded(false);
    try {
      await addSendingDomain({ domain: domain.trim() });
      setAdded(true);
      setDomain("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the sending domain");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Add a sending domain</h2>
        <p className={styles.cardHint}>
          Authenticate a domain you own. It can't send until SPF, DKIM, and DMARC all verify.
        </p>
      </div>

      <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.row}>
          <label className={styles.field} htmlFor="domain-name">
            <span className={styles.label}>Domain</span>
            <TpInput
              id="domain-name"
              type="text"
              value={domain}
              placeholder="mail.yourdomain.com"
              onChange={(e) => setDomain(e.target.value)}
              required
            />
          </label>
        </div>

        <div className={styles.actions}>
          <TpButton type="submit" disabled={!canSubmit}>
            {busy ? "Adding…" : "Add domain"}
          </TpButton>
          {added && (
            <p className={styles.success}>
              <span className={styles.successDot} aria-hidden="true" />
              <span>Domain added. Run Verify once your DNS records are in place.</span>
            </p>
          )}
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </form>
    </section>
  );
}

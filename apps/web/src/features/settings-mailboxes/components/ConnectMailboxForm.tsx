// ConnectMailboxForm.tsx — connect a sending mailbox (M12, email-planning/13 P0, 02, D7). Pick a provider,
// enter the address, supply the credential (SMTP password, or an OAuth token bundle for Google/Microsoft),
// optionally bind a sending domain. The credential is sent ONCE and stored KMS-envelope-encrypted
// server-side — it is never read back. The full Google/Microsoft OAuth redirect flow lands at P1; at P0 the
// form accepts the resulting token bundle (or SMTP password). Presentation + local view state only.
"use client";

import { TpButton, TpInput, TpSelect } from "@leadwolf/ui";
import { type FormEvent, useState } from "react";
import { connectMailbox } from "../api";
import styles from "../mailboxes.module.css";
import type { MailboxProvider, SendingDomainView } from "../types";

const PROVIDERS: { value: MailboxProvider; label: string }[] = [
  { value: "google", label: "Google (OAuth)" },
  { value: "microsoft", label: "Microsoft (OAuth)" },
  { value: "smtp", label: "SMTP" },
  { value: "ses", label: "Amazon SES (platform)" },
];

export function ConnectMailboxForm({
  domains,
  onConnected,
}: {
  domains: SendingDomainView[];
  onConnected: () => void;
}) {
  const [provider, setProvider] = useState<MailboxProvider>("google");
  const [address, setAddress] = useState("");
  const [sendingDomainId, setSendingDomainId] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const needsCredential = provider !== "ses";
  const isOauth = provider === "google" || provider === "microsoft";
  const canSubmit =
    address.trim().length > 0 && (!needsCredential || credential.trim().length > 0) && !busy;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setConnected(false);
    try {
      await connectMailbox({
        provider,
        address: address.trim(),
        ...(sendingDomainId ? { sending_domain_id: sendingDomainId } : {}),
        ...(provider === "smtp" ? { smtp_password: credential } : {}),
        ...(isOauth ? { oauth_token: credential } : {}),
      });
      setConnected(true);
      setAddress("");
      setCredential("");
      setSendingDomainId("");
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the mailbox");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Connect a mailbox</h2>
        <p className={styles.cardHint}>
          Connect the identity you send from. Credentials are encrypted at rest and never shown
          again.
        </p>
      </div>

      <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.row}>
          <label className={styles.field} htmlFor="mailbox-provider">
            <span className={styles.label}>Provider</span>
            <TpSelect
              id="mailbox-provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as MailboxProvider);
                setCredential("");
                setConnected(false);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </TpSelect>
          </label>

          <label className={styles.field} htmlFor="mailbox-address">
            <span className={styles.label}>Address</span>
            <TpInput
              id="mailbox-address"
              type="email"
              value={address}
              placeholder="sdr@yourdomain.com"
              onChange={(e) => setAddress(e.target.value)}
              required
            />
          </label>
        </div>

        <div className={styles.row}>
          {needsCredential && (
            <label className={styles.field} htmlFor="mailbox-credential">
              <span className={styles.label}>{isOauth ? "OAuth token" : "SMTP password"}</span>
              <TpInput
                id="mailbox-credential"
                type="password"
                value={credential}
                placeholder={isOauth ? "Paste the OAuth token bundle" : "SMTP password"}
                onChange={(e) => setCredential(e.target.value)}
                required
              />
            </label>
          )}

          <label className={styles.field} htmlFor="mailbox-domain">
            <span className={styles.label}>Sending domain (optional)</span>
            <TpSelect
              id="mailbox-domain"
              value={sendingDomainId}
              onChange={(e) => setSendingDomainId(e.target.value)}
            >
              <option value="">— none —</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.domain}
                  {d.status === "verified" ? " (verified)" : ""}
                </option>
              ))}
            </TpSelect>
          </label>
        </div>

        <div className={styles.actions}>
          <TpButton type="submit" disabled={!canSubmit}>
            {busy ? "Connecting…" : "Connect mailbox"}
          </TpButton>
          {connected && (
            <p className={styles.success}>
              <span className={styles.successDot} aria-hidden="true" />
              <span>Mailbox connected. The credential is encrypted server-side.</span>
            </p>
          )}
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </form>
    </section>
  );
}

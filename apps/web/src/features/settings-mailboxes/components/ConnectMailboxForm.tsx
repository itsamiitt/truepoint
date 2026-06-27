// ConnectMailboxForm.tsx — connect a sending mailbox (M12, email-planning/13 P0/P1, 02, D7). Google/Microsoft
// connect via the OAuth REDIRECT flow: the form posts to /connect/start and sends the browser to the provider's
// consent screen — no password or token is ever entered or stored client-side. SMTP supplies a password and SES
// uses the platform identity; both post directly. On return from the OAuth callback the page carries a
// `?connect=…` status which this form surfaces as a banner. Presentation + local view state only.
"use client";

import { TpButton, TpInput, TpSelect } from "@leadwolf/ui";
import { type FormEvent, useEffect, useState } from "react";
import { connectMailbox, startMailboxConnect } from "../api";
import styles from "../mailboxes.module.css";
import type { MailboxProvider, SendingDomainView } from "../types";

const PROVIDERS: { value: MailboxProvider; label: string }[] = [
  { value: "google", label: "Google (OAuth)" },
  { value: "microsoft", label: "Microsoft (OAuth)" },
  { value: "smtp", label: "SMTP" },
  { value: "ses", label: "Amazon SES (platform)" },
];

const PROVIDER_LABEL: Record<MailboxProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
  smtp: "SMTP",
  ses: "Amazon SES",
};

/** Map the callback `?connect=…&reason=…` query into a human banner, then strip it from the URL. */
function useConnectResult(): { kind: "ok" | "error"; message: string } | null {
  const [result, setResult] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const connect = params.get("connect");
    if (!connect) return;
    if (connect === "connected" || connect === "reconnected") {
      const address = params.get("address");
      setResult({
        kind: "ok",
        message: address
          ? `${address} ${connect === "reconnected" ? "reconnected" : "connected"}.`
          : "Mailbox connected.",
      });
    } else if (connect === "error") {
      const reason = params.get("reason") ?? "unknown";
      setResult({ kind: "error", message: `Could not connect the mailbox (${reason}).` });
    }
    // Strip the status params so a refresh doesn't replay the banner.
    params.delete("connect");
    params.delete("reason");
    params.delete("address");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);
  return result;
}

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
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const callbackResult = useConnectResult();

  const isOauth = provider === "google" || provider === "microsoft";
  const needsAddress = !isOauth; // OAuth derives the address from the consented account
  const needsPassword = provider === "smtp";
  const canSubmit = isOauth
    ? !busy
    : address.trim().length > 0 && (!needsPassword || password.trim().length > 0) && !busy;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setConnected(false);
    try {
      if (isOauth) {
        // Hand off to the provider consent screen; the address pre-fills the account picker if supplied.
        const { authorize_url } = await startMailboxConnect({
          provider,
          ...(address.trim() ? { login_hint: address.trim() } : {}),
          redirect_after: window.location.pathname,
        });
        window.location.href = authorize_url;
        return; // navigating away — keep the button busy
      }
      await connectMailbox({
        provider,
        address: address.trim(),
        ...(sendingDomainId ? { sending_domain_id: sendingDomainId } : {}),
        ...(provider === "smtp" ? { smtp_password: password } : {}),
      });
      setConnected(true);
      setAddress("");
      setPassword("");
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
          Connect the identity you send from. Google and Microsoft use a secure sign-in — we never
          see your password. SMTP credentials are encrypted at rest and never shown again.
        </p>
      </div>

      {callbackResult && (
        <p className={callbackResult.kind === "ok" ? styles.success : styles.error}>
          {callbackResult.kind === "ok" && (
            <span className={styles.successDot} aria-hidden="true" />
          )}
          <span>{callbackResult.message}</span>
        </p>
      )}

      <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.row}>
          <label className={styles.field} htmlFor="mailbox-provider">
            <span className={styles.label}>Provider</span>
            <TpSelect
              id="mailbox-provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as MailboxProvider);
                setPassword("");
                setConnected(false);
                setError(null);
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
            <span className={styles.label}>{isOauth ? "Account email (optional)" : "Address"}</span>
            <TpInput
              id="mailbox-address"
              type="email"
              value={address}
              placeholder={isOauth ? "name@yourdomain.com" : "sdr@yourdomain.com"}
              onChange={(e) => setAddress(e.target.value)}
              required={needsAddress}
            />
          </label>
        </div>

        <div className={styles.row}>
          {needsPassword && (
            <label className={styles.field} htmlFor="mailbox-password">
              <span className={styles.label}>SMTP password</span>
              <TpInput
                id="mailbox-password"
                type="password"
                value={password}
                placeholder="SMTP password"
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          )}

          {!isOauth && (
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
          )}
        </div>

        <div className={styles.actions}>
          <TpButton type="submit" disabled={!canSubmit}>
            {busy
              ? isOauth
                ? `Redirecting to ${PROVIDER_LABEL[provider]}…`
                : "Connecting…"
              : isOauth
                ? `Continue with ${PROVIDER_LABEL[provider]}`
                : "Connect mailbox"}
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

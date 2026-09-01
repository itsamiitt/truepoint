// MailboxList.tsx — the connected mailboxes, masked (NEVER a credential — D7). Four states via StateSwitch;
// the not-yet-wired case (available:false) renders a calm EmptyState. A broken OAuth mailbox (error /
// disconnected) carries a RECONNECT action — the common failure is an expired grant, and showing the error
// with no way out was a dead end. SMTP re-credentialing goes through the connect form above (same address
// overwrites); full mailbox removal ships with a later email milestone. Data comes from useMailboxes
// (lifted into MailboxesPage).
"use client";

import { EmptyState, Icon, StateSwitch, StatusBadge, TpButton } from "@leadwolf/ui";
import { Mail } from "lucide-react";
import { useState } from "react";
import { startMailboxConnect } from "../api";
import styles from "../mailboxes.module.css";
import type { MailboxStatus, MailboxView } from "../types";

const STATUS_TONE: Record<MailboxStatus, "success" | "warning" | "danger" | "muted"> = {
  connected: "success",
  pending: "warning",
  error: "danger",
  disconnected: "muted",
};

export function MailboxList({
  mailboxes,
  available,
  loading,
  error,
  reload,
}: {
  mailboxes: MailboxView[];
  available: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  async function reconnect(m: MailboxView): Promise<void> {
    setReconnectingId(m.id);
    setReconnectError(null);
    try {
      // Same consent handoff as the connect form — a fresh grant for the SAME address overwrites the
      // broken one server-side.
      const { authorize_url } = await startMailboxConnect({
        provider: m.provider as "google" | "microsoft",
        login_hint: m.address,
        redirect_after: window.location.pathname,
      });
      window.location.href = authorize_url;
    } catch (err) {
      setReconnectError(err instanceof Error ? err.message : "Could not start the reconnect");
      setReconnectingId(null);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Mailboxes</h2>
        <p className={styles.cardHint}>The identities this workspace can send from.</p>
      </div>

      {reconnectError && <p className={styles.error}>{reconnectError}</p>}

      <StateSwitch
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!available || mailboxes.length === 0}
        emptyState={
          <EmptyState
            icon={<Icon icon={Mail} size={28} />}
            title={available ? "No mailboxes yet" : "Mailboxes aren't enabled yet"}
            description={
              available
                ? "Connect a mailbox above to start sending from your own identity."
                : "Email sending ships behind a feature flag. It will appear here once enabled for your workspace."
            }
          />
        }
      >
        <ul className={styles.list}>
          {mailboxes.map((m) => (
            <li className={styles.listRow} key={m.id}>
              <div className={styles.listMain}>
                <span className={styles.listType}>{m.provider}</span>
                <span className={styles.listKey}>{m.address}</span>
                {m.lastError && <span className={styles.listReason}>{m.lastError}</span>}
              </div>
              <div className={styles.listMeta}>
                <StatusBadge tone={STATUS_TONE[m.status]}>{m.status}</StatusBadge>
                {(m.status === "error" || m.status === "disconnected") &&
                (m.provider === "google" || m.provider === "microsoft") ? (
                  <TpButton
                    variant="secondary"
                    size="sm"
                    loading={reconnectingId === m.id}
                    onClick={() => void reconnect(m)}
                  >
                    Reconnect
                  </TpButton>
                ) : null}
                {(m.status === "error" || m.status === "disconnected") && m.provider === "smtp" ? (
                  <span className={styles.listReason}>
                    Re-connect above with the same address to update credentials
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </StateSwitch>
    </section>
  );
}

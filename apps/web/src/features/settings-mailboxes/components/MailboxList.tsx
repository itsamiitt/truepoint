// MailboxList.tsx — the connected mailboxes, masked (NEVER a credential — D7). Four states via StateSwitch;
// the not-yet-wired case (available:false) renders a calm EmptyState. Presentation only — data comes from
// useMailboxes (lifted into MailboxesPage).
"use client";

import { EmptyState, Icon, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { Mail } from "lucide-react";
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
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Mailboxes</h2>
        <p className={styles.cardHint}>The identities this workspace can send from.</p>
      </div>

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
              </div>
            </li>
          ))}
        </ul>
      </StateSwitch>
    </section>
  );
}

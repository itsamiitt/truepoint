// SendingDomainList.tsx — the per-tenant sending domains with their SPF/DKIM/DMARC state + the Verify action
// (M12, email-planning/13 P0, 03 §1, D2). A domain is usable for sending only when status='verified'. Four
// states via StateSwitch. Presentation only — data + the verify action come from useSendingDomains.
"use client";

import { EmptyState, Icon, StateSwitch, StatusBadge, TpButton } from "@leadwolf/ui";
import { Globe } from "lucide-react";
import styles from "../mailboxes.module.css";
import type { DnsAuthState, SendingDomainStatus, SendingDomainView } from "../types";

const STATUS_TONE: Record<SendingDomainStatus, "success" | "warning" | "danger" | "muted"> = {
  verified: "success",
  pending: "muted",
  verifying: "warning",
  failed: "danger",
};

const AUTH_TONE: Record<DnsAuthState, "success" | "warning" | "danger" | "muted"> = {
  pass: "success",
  unverified: "muted",
  fail: "danger",
};

function AuthChip({ label, state }: { label: string; state: DnsAuthState }) {
  return (
    <StatusBadge tone={AUTH_TONE[state]}>
      {label}: {state}
    </StatusBadge>
  );
}

export function SendingDomainList({
  domains,
  available,
  loading,
  error,
  reload,
  verify,
  verifyingId,
  actionError,
}: {
  domains: SendingDomainView[];
  available: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
  verify: (id: string) => Promise<boolean>;
  verifyingId: string | null;
  actionError: string | null;
}) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Sending domains</h2>
        <p className={styles.cardHint}>
          A domain must pass SPF, DKIM, and DMARC before it can send.
        </p>
      </div>

      {actionError && <p className={styles.error}>{actionError}</p>}

      <StateSwitch
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!available || domains.length === 0}
        emptyState={
          <EmptyState
            icon={<Icon icon={Globe} size={28} />}
            title={available ? "No sending domains yet" : "Sending domains aren't enabled yet"}
            description={
              available
                ? "Add a domain above, set its DNS records, then Verify."
                : "Email sending ships behind a feature flag. Domains will appear here once enabled."
            }
          />
        }
      >
        <ul className={styles.list}>
          {domains.map((d) => (
            <li className={styles.listRow} key={d.id}>
              <div className={styles.listMain}>
                <span className={styles.listKey}>{d.domain}</span>
                <AuthChip label="SPF" state={d.spfState} />
                <AuthChip label="DKIM" state={d.dkimState} />
                <AuthChip label="DMARC" state={d.dmarcState} />
              </div>
              <div className={styles.listMeta}>
                <StatusBadge tone={STATUS_TONE[d.status]}>{d.status}</StatusBadge>
                <TpButton
                  variant="secondary"
                  disabled={verifyingId === d.id}
                  onClick={() => void verify(d.id)}
                >
                  {verifyingId === d.id ? "Verifying…" : "Verify"}
                </TpButton>
              </div>
            </li>
          ))}
        </ul>
      </StateSwitch>
    </section>
  );
}

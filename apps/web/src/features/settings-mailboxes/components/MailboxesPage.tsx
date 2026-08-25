// MailboxesPage.tsx — the Email & mailboxes settings surface (M12, email-planning/13 P0): connect a mailbox,
// authenticate a sending domain, and see the per-tenant send quota. Workspace-scope settings page, rendered
// by the thin (shell)/settings/mailboxes route. Lifts the two hooks and threads reload into the forms so a
// connect/add/verify refreshes the sibling list. Composition only.
"use client";

import { PageHeader } from "@leadwolf/ui";
import { useEffect, useState } from "react";
import { fetchSendQuota } from "../api";
import { useMailboxes } from "../hooks/useMailboxes";
import { useSendingDomains } from "../hooks/useSendingDomains";
import styles from "../mailboxes.module.css";
import type { SendQuotaView } from "../types";
import { AddSendingDomainForm } from "./AddSendingDomainForm";
import { ConnectMailboxForm } from "./ConnectMailboxForm";
import { MailboxList } from "./MailboxList";
import { SendingDomainList } from "./SendingDomainList";

export function MailboxesPage() {
  const mailboxes = useMailboxes();
  const domains = useSendingDomains();
  const [quota, setQuota] = useState<SendQuotaView | null>(null);

  useEffect(() => {
    void fetchSendQuota()
      .then(setQuota)
      .catch(() => setQuota(null));
  }, []);

  return (
    <div className={styles.page}>
      {/* The DS PageHeader owns the title + description; the quota is a LIVE METRIC, not page copy, so it
          stays its own line. `.header` is kept purely as the grouping box (column, 6px gap) that holds the
          metric tight under the header instead of letting the page's 24px rhythm orphan it. */}
      <div className={styles.header}>
        <PageHeader
          title="Email & mailboxes"
          subtitle="Connect a sending identity and authenticate a domain. Credentials are encrypted server-side and never shown again."
        />
        {quota && (
          <p className={styles.quota}>
            Send quota this period:{" "}
            <strong>
              {quota.used.toLocaleString()}
              {quota.quota === null ? " (unlimited)" : ` / ${quota.quota.toLocaleString()}`}
            </strong>
          </p>
        )}
      </div>

      <ConnectMailboxForm domains={domains.domains} onConnected={mailboxes.reload} />
      <MailboxList
        mailboxes={mailboxes.mailboxes}
        available={mailboxes.available}
        loading={mailboxes.loading}
        error={mailboxes.error}
        reload={mailboxes.reload}
      />

      <AddSendingDomainForm onAdded={domains.reload} />
      <SendingDomainList
        domains={domains.domains}
        available={domains.available}
        loading={domains.loading}
        error={domains.error}
        reload={domains.reload}
        verify={domains.verify}
        verifyingId={domains.verifyingId}
        actionError={domains.actionError}
      />
    </div>
  );
}

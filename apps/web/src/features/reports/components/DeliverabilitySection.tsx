// DeliverabilitySection.tsx — the Sending & deliverability dashboard. The send/outreach analytics pipeline
// (open/reply/bounce rates from the ClickHouse /reports/* endpoints — ADR-0010) does not exist yet, so this
// renders a first-class "connect sending" empty state plus a placeholder rate scaffold so the layout reads as a
// real dashboard. No invented numbers, no fake sends. Presentation only.
"use client";

import { EmptyState, Icon, Progress, StatTile, TpButton } from "@leadwolf/ui";
import { Send } from "lucide-react";
import styles from "../reports.module.css";

const PLACEHOLDER_RATES = [
  { label: "Delivered", tone: "success" as const },
  { label: "Open rate", tone: "ink" as const },
  { label: "Reply rate", tone: "ink" as const },
  { label: "Bounce rate", tone: "warning" as const },
];

export function DeliverabilitySection({ onConnect }: { onConnect: () => void }) {
  return (
    <div>
      <div className={styles.tiles}>
        <StatTile label="Emails sent" value="—" sublabel="Connect a mailbox to start sending" />
        <StatTile label="Delivered" value="—" sublabel="Inbox-placement rate" />
        <StatTile label="Replies" value="—" sublabel="Positive + neutral replies" />
      </div>

      <h3 className={styles.subheading}>Deliverability rates</h3>
      <ul className={styles.barList} aria-hidden>
        {PLACEHOLDER_RATES.map((r) => (
          <li key={r.label} className={styles.barRow}>
            <span className={styles.barLabel}>{r.label}</span>
            <span className={styles.healthTrack}>
              <Progress value={0} max={100} tone={r.tone} label={r.label} />
            </span>
            <span className={styles.barValue}>—</span>
          </li>
        ))}
      </ul>

      <div className={styles.connect}>
        <EmptyState
          icon={<Icon icon={Send} size={28} />}
          title="Connect sending to see deliverability"
          description="Sequence sends, opens, replies, and bounces will populate these rates once a mailbox is connected and the analytics pipeline is live. Deeper send analytics ship post-MVP."
          action={
            <TpButton variant="secondary" leftIcon={<Icon icon={Send} size={16} />} onClick={onConnect}>
              Connect sending
            </TpButton>
          }
        />
      </div>
    </div>
  );
}

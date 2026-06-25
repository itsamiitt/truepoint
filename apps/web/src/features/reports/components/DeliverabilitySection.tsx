// DeliverabilitySection.tsx — the Sending & deliverability dashboard (M12 P5). Reads the workspace
// deliverability report from GET /api/v1/email/analytics; until any send exists (or the endpoint is dark) it
// keeps the first-class "connect sending" empty state — no invented numbers. Reply rate is the headline (D6);
// open rate is shown but labelled informational (MPP-inflated). Presentation only.
"use client";

import { EmptyState, Icon, Progress, StatTile, TpButton } from "@leadwolf/ui";
import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import { type DeliverabilityReport, fetchEmailDeliverability } from "../api";
import styles from "../reports.module.css";

const RATE_ROWS: {
  label: string;
  tone: "success" | "ink" | "warning";
  key: keyof DeliverabilityReport;
}[] = [
  { label: "Delivered", tone: "success", key: "deliveryRate" },
  { label: "Reply rate", tone: "ink", key: "replyRate" },
  { label: "Open rate (informational)", tone: "ink", key: "openRate" },
  { label: "Bounce rate", tone: "warning", key: "bounceRate" },
];

export function DeliverabilitySection({ onConnect }: { onConnect: () => void }) {
  const [report, setReport] = useState<DeliverabilityReport | null>(null);

  useEffect(() => {
    void fetchEmailDeliverability(30)
      .then(setReport)
      .catch(() => setReport(null));
  }, []);

  const hasSends = report != null && report.sent > 0;

  if (!hasSends) {
    return (
      <div>
        <div className={styles.tiles}>
          <StatTile label="Emails sent" value="—" sublabel="Connect a mailbox to start sending" />
          <StatTile label="Delivered" value="—" sublabel="Inbox-placement rate" />
          <StatTile label="Replies" value="—" sublabel="Positive + neutral replies" />
        </div>
        <div className={styles.connect}>
          <EmptyState
            icon={<Icon icon={Send} size={28} />}
            title="Connect sending to see deliverability"
            description="Sequence sends, opens, replies, and bounces will populate these rates once a mailbox is connected and you start sending."
            action={
              <TpButton
                variant="secondary"
                leftIcon={<Icon icon={Send} size={16} />}
                onClick={onConnect}
              >
                Connect sending
              </TpButton>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className={styles.tiles}>
        <StatTile
          label="Emails sent"
          value={report.sent.toLocaleString()}
          sublabel={`Last ${report.rangeDays} days`}
        />
        <StatTile
          label="Delivered"
          value={`${report.deliveryRate}%`}
          sublabel={`${report.delivered.toLocaleString()} delivered`}
        />
        <StatTile label="Reply rate" value={`${report.replyRate}%`} sublabel="The headline KPI" />
      </div>

      <h3 className={styles.subheading}>Deliverability rates</h3>
      <ul className={styles.barList}>
        {RATE_ROWS.map((r) => (
          <li key={r.label} className={styles.barRow}>
            <span className={styles.barLabel}>{r.label}</span>
            <span className={styles.healthTrack}>
              <Progress value={Number(report[r.key])} max={100} tone={r.tone} label={r.label} />
            </span>
            <span className={styles.barValue}>{report[r.key]}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

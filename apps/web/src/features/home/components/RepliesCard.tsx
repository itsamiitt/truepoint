// RepliesCard.tsx — recent inbound replies to outreach. PII-safe: references only (id/contactId/
// sequenceId/channel/repliedAt) — no message body, no email address. Empty-state-first: a calm "no recent
// replies" until a replies source lands. Pure presentation over HomeSummary.recentReplies. Public slice component.
"use client";

import { Card, Spinner } from "@leadwolf/ui";
import type { RecentReply } from "../types";
import styles from "./HomePage.module.css";
import { formatDate } from "./format";

export function RepliesCard({
  replies,
  loading,
  error,
}: {
  replies: RecentReply[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Recent replies</h2>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading replies…
        </div>
      ) : replies.length === 0 ? (
        <p className={styles.muted}>
          No recent replies. Replies to your sequences will appear here.
        </p>
      ) : (
        <div className={styles.list}>
          {replies.map((reply) => (
            <div key={reply.id} className={styles.row}>
              <span className={styles.rowStack}>
                <span className={styles.rowLabel}>Reply via {reply.channel}</span>
                <span className={styles.rowMeta}>{formatDate(reply.repliedAt)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

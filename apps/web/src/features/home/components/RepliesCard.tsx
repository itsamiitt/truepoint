// RepliesCard.tsx — recent inbound replies to outreach. PII-safe: references only (id/contactId/sequenceId/
// channel/repliedAt) — no message body, no email address. Empty-state-first: a calm "no recent replies"
// until a replies source lands. Pure presentation over HomeSummary.recentReplies; all four async states
// render through the shared WidgetCard → StateSwitch. Public slice component.
"use client";

import { StatusBadge } from "@leadwolf/ui";
import { MessageSquare } from "lucide-react";
import type { RecentReply } from "../types";
import { formatRelative } from "./format";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

export function RepliesCard({
  replies,
  loading,
  error,
  onRetry,
}: {
  replies: RecentReply[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <WidgetCard
      title="Recent replies"
      icon={MessageSquare}
      loading={loading}
      error={error}
      empty={replies.length === 0}
      onRetry={onRetry}
      emptyIcon={MessageSquare}
      emptyTitle="No replies yet"
      emptyDescription="Replies to your sequences land here so you can pick up the conversation."
    >
      <div className={styles.list}>
        {replies.map((reply) => (
          <div key={reply.id} className={styles.row}>
            <span className={styles.rowStack}>
              <span className={styles.rowLabel}>New reply</span>
              <span className={styles.rowMeta}>{formatRelative(reply.repliedAt)}</span>
            </span>
            <span className={styles.rowAside}>
              <StatusBadge tone="success">{reply.channel}</StatusBadge>
            </span>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}

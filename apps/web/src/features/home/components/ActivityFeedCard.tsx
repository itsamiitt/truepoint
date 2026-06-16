// ActivityFeedCard.tsx — the workspace audit feed: minimized columns only (action · entity · when — no PII;
// see home.ts). Actions come from the closed auditAction enum and are lightly humanized for display.
"use client";

import { Card, Spinner } from "@leadwolf/ui";
import type { ActivityFeedItem } from "../types";
import styles from "./HomePage.module.css";
import { formatRelative } from "./format";

/** Humanize a closed-enum audit action ("contact.create" → "Contact create") for display. */
function humanizeAction(action: string): string {
  const text = action.replace(/[._]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ActivityFeedCard({
  items,
  loading,
  error,
}: {
  items: ActivityFeedItem[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Activity feed</h2>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading activity…
        </div>
      ) : items.length === 0 ? (
        <p className={styles.muted}>No recorded activity yet in this workspace.</p>
      ) : (
        <div className={styles.list}>
          {items.map((item) => (
            <div key={item.id} className={styles.row}>
              <span className={styles.rowStack}>
                <span className={styles.rowLabel}>{humanizeAction(item.action)}</span>
                <span className={styles.rowMeta}>{item.entityType}</span>
              </span>
              <span className={styles.mono}>{formatRelative(item.occurredAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ActivityFeedCard.tsx — the workspace audit feed: minimized columns only (action · entity · when — no PII;
// see home.ts). Actions come from the closed auditAction enum and are lightly humanized for display. All
// four async states render through the shared WidgetCard → StateSwitch. Public slice component.
"use client";

import { History } from "lucide-react";
import type { ActivityFeedItem } from "../types";
import { formatRelative } from "./format";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

/** Humanize a closed-enum audit action ("contact.create" → "Contact create") for display. */
function humanizeAction(action: string): string {
  const text = action.replace(/[._]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ActivityFeedCard({
  items,
  loading,
  error,
  onRetry,
}: {
  items: ActivityFeedItem[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <WidgetCard
      title="Activity feed"
      icon={History}
      loading={loading}
      error={error}
      empty={items.length === 0}
      onRetry={onRetry}
      emptyIcon={History}
      emptyTitle="No recorded activity yet"
      emptyDescription="Reveals, imports, sequence sends, and edits in this workspace are logged here."
      skeletonRows={5}
    >
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
    </WidgetCard>
  );
}

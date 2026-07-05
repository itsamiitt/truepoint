// NotificationsPage.tsx — the full notification history (G-NTF-1): a keyset-paginated list with per-item +
// bulk mark-read and "Load more". Each row deep-links (entity link when present, else the type's destination)
// and marks itself read on open. The compact latest-20 view is the top-bar bell; this is the "See all" page.
// Presentation + view state only (useNotificationHistory → api); four-state via StateSwitch.
"use client";

import type { Notification, NotificationType } from "@leadwolf/types";
import { EmptyState, StateSwitch, StatusBadge, TpButton } from "@leadwolf/ui";
import Link from "next/link";
import { useNotificationHistory } from "../hooks/useNotificationHistory";
import styles from "../notifications.module.css";

const TYPE_LABEL: Record<NotificationType, string> = {
  low_credits: "Credits",
  reply_received: "Reply",
  import_complete: "Import",
  dsar_update: "Compliance",
  system: "System",
};

type Tone = "success" | "warning" | "muted";
const TYPE_TONE: Record<NotificationType, Tone> = {
  low_credits: "warning",
  reply_received: "success",
  import_complete: "muted",
  dsar_update: "muted",
  system: "muted",
};

const TYPE_HREF: Record<NotificationType, string> = {
  low_credits: "/settings/billing",
  reply_received: "/inbox",
  import_complete: "/imports",
  dsar_update: "/settings",
  system: "/home",
};

function hrefFor(n: Notification): string {
  if (n.entityType === "contact" && n.entityId) return `/prospect?contact=${n.entityId}`;
  // An import notification carries entity ('import_job', jobId) — link to that durable job page (S-U5).
  if (n.entityType === "import_job" && n.entityId) return `/imports/${n.entityId}`;
  return TYPE_HREF[n.type] ?? "/home";
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const m = Math.floor((Date.now() - then) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationsPage() {
  const {
    items,
    unreadCount,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    markRead,
    markAll,
    reload,
  } = useNotificationHistory();

  return (
    <section>
      <div className={styles.head}>
        <h1 className="tp-settings-title" style={{ margin: 0 }}>
          Notifications{unreadCount > 0 ? ` · ${unreadCount} unread` : ""}
        </h1>
        {unreadCount > 0 ? (
          <TpButton variant="secondary" size="sm" onClick={markAll}>
            Mark all read
          </TpButton>
        ) : null}
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        onRetry={reload}
        empty={items.length === 0}
        emptyState={
          <EmptyState
            title="You're all caught up"
            description="Notifications about your credits, imports and activity will appear here."
          />
        }
      >
        <ul className={styles.list}>
          {items.map((n) => (
            <li key={n.id} className={n.readAt ? styles.item : `${styles.item} ${styles.unread}`}>
              <Link
                className={styles.itemLink}
                href={hrefFor(n)}
                onClick={() => {
                  if (!n.readAt) markRead(n.id);
                }}
              >
                <span className={styles.body}>
                  <span className={styles.itemHead}>
                    <StatusBadge tone={TYPE_TONE[n.type] ?? "muted"}>
                      {TYPE_LABEL[n.type] ?? n.type}
                    </StatusBadge>
                    <span className={styles.title}>{n.title}</span>
                  </span>
                  {n.body ? <span className={styles.detail}>{n.body}</span> : null}
                </span>
                <span className={styles.time}>{relTime(n.createdAt)}</span>
              </Link>
              {n.readAt ? null : (
                <button
                  type="button"
                  className={styles.markBtn}
                  onClick={() => markRead(n.id)}
                  aria-label={`Mark read: ${n.title}`}
                >
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
        {hasMore ? (
          <div className={styles.more}>
            <TpButton
              variant="secondary"
              size="sm"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              Load more
            </TpButton>
          </div>
        ) : null}
      </StateSwitch>
    </section>
  );
}

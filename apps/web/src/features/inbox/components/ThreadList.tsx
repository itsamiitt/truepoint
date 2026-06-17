// ThreadList.tsx — the reply threads list with a Mine / Unassigned / By-sequence filter (11 §4.4). Each row
// opens the thread in a Drawer. Empty-first: with no mailbox synced (M9) it shows a calm connect state, never
// fabricated threads.
"use client";

import { Avatar, EmptyState, SegmentedControl, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { Inbox as InboxIcon } from "lucide-react";
import { useState } from "react";
import { formatRelative } from "../format";
import { useInbox } from "../hooks/useInbox";
import type { InboxFilter } from "../types";
import styles from "../inbox.module.css";
import { ThreadView } from "./ThreadView";

const FILTERS = [
  { value: "mine", label: "Mine" },
  { value: "unassigned", label: "Unassigned" },
  { value: "sequence", label: "By sequence" },
];

export function ThreadList() {
  const [filter, setFilter] = useState<InboxFilter>("mine");
  const { feed, loading, error, reload } = useInbox(filter);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className={styles.replies}>
      <div className={styles.filterRow}>
        <SegmentedControl
          items={FILTERS}
          value={filter}
          onChange={(v) => setFilter(v as InboxFilter)}
          aria-label="Filter replies"
        />
      </div>
      <StateSwitch
        loading={loading}
        error={error}
        empty={feed != null && feed.threads.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            icon={<InboxIcon size={28} />}
            title={feed?.available ? "You're all caught up" : "No replies yet"}
            description={
              feed?.available
                ? "New replies to your sequences will show up here."
                : "Connect a mailbox to start ingesting replies. Until then, follow send status in Sequences."
            }
          />
        }
      >
        <ul className={styles.threadList}>
          {feed?.threads.map((t) => (
            <li key={t.id}>
              <button type="button" className={styles.threadItem} onClick={() => setOpenId(t.id)}>
                <Avatar name={t.contactName} size={34} />
                <span className={styles.threadMeta}>
                  <span className={styles.threadTop}>
                    <span className={styles.threadName}>{t.contactName}</span>
                    <span className={styles.threadTime}>{formatRelative(t.lastMessageAt)}</span>
                  </span>
                  <span className={styles.threadSnippet}>{t.snippet}</span>
                  <span className={styles.threadTags}>
                    {t.sequenceName ? <StatusBadge tone="muted">{t.sequenceName}</StatusBadge> : null}
                    {t.unread ? <StatusBadge tone="success">New</StatusBadge> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </StateSwitch>
      <ThreadView threadId={openId} onClose={() => setOpenId(null)} onChanged={reload} />
    </div>
  );
}

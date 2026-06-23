// NotificationsBell.tsx — the top-bar bell (11 §3). An accessible button + dropdown over the client-DERIVED
// list from useNotifications (no notifications backend, no fake data). Quiet + monochrome: the unread count
// is a small muted badge, item tone shows only as a StatusBadge-style dot, and an empty inbox reads as a
// calm "You're all caught up." Dismiss on outside click + Escape so the panel never traps focus.
"use client";

import { TpIconButton } from "@leadwolf/ui";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styles from "./NotificationsBell.module.css";
import { useNotifications } from "./useNotifications";

export function NotificationsBell() {
  const { items, unreadCount, dismiss, loading } = useNotifications();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label =
    unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications, none unread";

  return (
    <div className={styles.root} ref={rootRef}>
      <TpIconButton
        label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">◔</span>
        {unreadCount > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </TpIconButton>

      {open && (
        <section className={styles.menu} aria-label="Notifications">
          <div className={styles.head}>Notifications</div>
          {items.length === 0 ? (
            <p className={styles.empty}>{loading ? "Checking…" : "You're all caught up."}</p>
          ) : (
            <ul className={styles.list}>
              {items.map((n) => (
                <li className={styles.item} key={n.id}>
                  <Link className={styles.itemLink} href={n.href} onClick={() => setOpen(false)}>
                    <span className={`${styles.dot} ${styles[n.tone]}`} aria-hidden="true" />
                    <span className={styles.itemBody}>
                      <span className={styles.itemTitle}>{n.title}</span>
                      <span className={styles.itemDetail}>{n.detail}</span>
                    </span>
                  </Link>
                  <TpIconButton
                    className={styles.dismiss}
                    label={`Dismiss: ${n.title}`}
                    onClick={() => dismiss(n.id)}
                  >
                    ×
                  </TpIconButton>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

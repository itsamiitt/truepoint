// AccordionGroup.tsx — one collapsible filter group: a header button (title, active-count badge, optional
// tier tag) and its body. Presentation only; the parent owns open/closed (persisted by useOpenGroups) and
// renders the facets. Shared by the People and Accounts rails so the two never drift.
"use client";

import type { ReactNode } from "react";
import styles from "../prospect.module.css";

export function AccordionGroup({
  id,
  title,
  open,
  onToggle,
  badge,
  tag,
  children,
}: {
  /** DOM id of the body — the header's aria-controls target. */
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Number of active selections inside — shown on the header so a collapsed group is still legible. */
  badge?: number;
  /** A short qualifier after the title (e.g. "Saved contacts only"). */
  tag?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.group}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className={styles.groupHead}
      >
        <span className={styles.groupTitle}>
          {title}
          {badge ? <span className={styles.groupBadge}>{badge}</span> : null}
          {tag ? <span className={styles.tierTag}>{tag}</span> : null}
        </span>
        <span aria-hidden className={styles.groupChevron}>
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? (
        <div id={id} className={styles.groupBody}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

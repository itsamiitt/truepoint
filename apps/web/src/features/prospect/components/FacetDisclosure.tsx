// FacetDisclosure.tsx — ONE filter as a closed-by-default disclosure row (2026-08-31 rail simplification):
// the label row is the toggle, an active-count badge keeps a closed row legible, and the control itself
// renders only once opened. Local state on purpose — "closed until the user opens it" is the contract, so
// the open state is neither persisted nor URL state. Shared by every People and Accounts facet control so
// the rails cannot drift.
"use client";

import { type ReactNode, useId, useState } from "react";
import styles from "../prospect.module.css";

export function FacetDisclosure({
  label,
  badge,
  scopeNote,
  headExtra,
  children,
}: {
  label: ReactNode;
  /** Number of active selections inside — shown on the closed row so nothing applied is ever invisible. */
  badge?: number;
  /** Optional mark beside the label — the scope badge. */
  scopeNote?: ReactNode;
  /** A head-row control rendered OUTSIDE the toggle button, only while open (e.g. the Exclude toggle). */
  headExtra?: ReactNode;
  children: ReactNode;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.facet}>
      <div className={styles.facetHead}>
        <button
          type="button"
          className={styles.facetToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={styles.facetLabel}>{label}</span>
          {badge ? <span className={styles.groupBadge}>{badge}</span> : null}
          {scopeNote}
          <span aria-hidden className={styles.facetChevron}>
            {open ? "−" : "+"}
          </span>
        </button>
        {open ? headExtra : null}
      </div>
      {open ? (
        <div id={bodyId} className={styles.facetBody}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

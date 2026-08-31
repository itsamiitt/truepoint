// FacetDisclosure.tsx — ONE filter as a closed-by-default disclosure row (Search v4): the label row is the
// toggle, the row's right edge carries a SELECTED-VALUE SUMMARY ("VP, Director" in cobalt; a muted "Any"
// when nothing is set) so a closed rail still reads as the whole filter state, and the chevron rotates open.
// The control itself renders only once opened. Local state on purpose — "closed until the user opens it" is
// the contract, so the open state is neither persisted nor URL state. Shared by every People and Accounts
// facet control so the rails cannot drift.
"use client";

import { type ReactNode, useId, useState } from "react";
import styles from "../prospect.module.css";
import { RailChevron } from "./RailChevron";

export function FacetDisclosure({
  label,
  summary,
  scopeNote,
  headExtra,
  children,
}: {
  label: ReactNode;
  /** What is selected, as words ("VP, Director" · "Yes" · "≥ 50 · ≤ 500"). Absent ⇒ a muted "Any". */
  summary?: string;
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
          {scopeNote}
          {/* title = the untruncated summary — the row clips long selections at the CSS max-width. */}
          <span className={styles.facetVal} data-set={summary ? "true" : undefined} title={summary}>
            {summary ?? "Any"}
          </span>
          <RailChevron />
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

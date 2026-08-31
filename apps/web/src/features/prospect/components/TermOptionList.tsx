// TermOptionList.tsx — the value picker for a term facet with a FIXED option list (seniority, status,
// owner, …), Search v4 shape: the options render INLINE under the opened facet as a checkbox list with live
// counts — the top handful first, the rest behind "Show N more" — replacing the dropdown popover (which was
// a second click inside an already-opened accordion). Multi-select within a facet stays OR (the query model
// is unchanged). One picker serves both directions of the progressive-exclude pattern — inside the exclude
// block it edits that clause. Every option is always offered: checking a value already applied in the OTHER
// direction moves it (addTermCondition keeps a value single-typed), so the list never shrinks underneath
// the user.
"use client";

import { TpCheckbox } from "@leadwolf/ui";
import { useState } from "react";
import type { FacetOption, TermOp } from "../filterGroups";
import styles from "../prospect.module.css";

/** How many options show before "Show N more" (v4: the scannable handful; seniority fits entirely). */
const VISIBLE = 6;

export function TermOptionList({
  field,
  label,
  options,
  op,
  counts,
  selected,
  onToggle,
}: {
  /** Facet field — keys into the live per-option counts (`${field}:${value}`). */
  field: string;
  label: string;
  /** The full option list — never pre-filtered; checked state carries what is applied. */
  options: FacetOption[];
  op: TermOp;
  counts?: Map<string, number>;
  /** Values currently applied in THIS direction. */
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (options.length === 0) {
    return <span className={styles.facetEmpty}>No options</span>;
  }
  const chosen = new Set(selected);
  const shown = expanded ? options : options.slice(0, VISIBLE);
  const hidden = options.length - shown.length;
  return (
    <fieldset className={styles.optList} aria-label={op === "exclude" ? `Exclude ${label}` : label}>
      {shown.map((o) => {
        const count = counts?.get(`${field}:${o.value}`);
        return (
          <span key={o.value} className={styles.optRow}>
            <TpCheckbox
              checked={chosen.has(o.value)}
              onChange={() => onToggle(o.value)}
              label={o.label}
            />
            {count !== undefined ? (
              <span className={styles.optCount}>{count.toLocaleString()}</span>
            ) : null}
          </span>
        );
      })}
      {hidden > 0 ? (
        <button type="button" className={styles.optMore} onClick={() => setExpanded(true)}>
          Show {hidden} more
        </button>
      ) : expanded && options.length > VISIBLE ? (
        <button type="button" className={styles.optMore} onClick={() => setExpanded(false)}>
          Show less
        </button>
      ) : null}
    </fieldset>
  );
}

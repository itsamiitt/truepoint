// TermOptionChips.tsx — the value picker for a term facet with a FIXED option list (seniority, status, …):
// every unused option as an "+ Label (count)" chip. One picker serves both directions of the progressive-
// exclude pattern — inside the exclude block it renders in the negative treatment and adds to that clause.
// Options already used in EITHER direction are filtered out by the caller, so a value is never both.
"use client";

import type { TermOp } from "../filterGroups";
import styles from "../prospect.module.css";

export interface TermOption {
  value: string;
  label: string;
}

export function TermOptionChips({
  field,
  options,
  op,
  counts,
  anyApplied,
  onAdd,
}: {
  /** Facet field — keys into the live per-option counts (`${field}:${value}`). */
  field: string;
  /** The options still available (the caller removes everything already applied, either direction). */
  options: TermOption[];
  op: TermOp;
  counts?: Map<string, number>;
  /** Whether the facet has any applied value — distinguishes "all picked" from "nothing to pick". */
  anyApplied: boolean;
  onAdd: (value: string) => void;
}) {
  if (options.length === 0) {
    return (
      <span className={styles.facetEmpty}>
        {anyApplied ? "All options selected" : "No options"}
      </span>
    );
  }
  return (
    <div className={styles.chipWrap}>
      {options.map((o) => {
        const count = counts?.get(`${field}:${o.value}`);
        return (
          <button
            key={o.value}
            type="button"
            className={styles.addChip}
            data-op={op}
            onClick={() => onAdd(o.value)}
          >
            + {o.label}
            {count !== undefined ? ` (${count.toLocaleString()})` : ""}
          </button>
        );
      })}
    </div>
  );
}

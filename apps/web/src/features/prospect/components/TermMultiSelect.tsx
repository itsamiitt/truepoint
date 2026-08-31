// TermMultiSelect.tsx — the value picker for a term facet with a FIXED option list (seniority, status,
// owner, …): a dropdown of checkboxes rather than a wall of add-chips, so a long option list costs one
// closed control until the user opens it. Multi-select within a facet stays OR (the query model is
// unchanged). One picker serves both directions of the progressive-exclude pattern — inside the exclude
// block it renders in the negative treatment and edits that clause. Every option is always offered:
// checking a value already applied in the OTHER direction moves it (addTermCondition keeps a value
// single-typed), so the list never shrinks underneath the user.
"use client";

import { Popover, TpCheckbox } from "@leadwolf/ui";
import type { FacetOption, TermOp } from "../filterGroups";
import styles from "../prospect.module.css";

export function TermMultiSelect({
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
  if (options.length === 0) {
    return <span className={styles.facetEmpty}>No options</span>;
  }
  const chosen = new Set(selected);
  const summary =
    selected.length > 0
      ? `${selected.length} selected`
      : op === "exclude"
        ? `Select ${label.toLowerCase()} to exclude…`
        : `Select ${label.toLowerCase()}…`;
  return (
    <div className={styles.msWrap}>
      <Popover
        className={styles.msPanel}
        trigger={({ toggle, open, props }) => (
          <button
            type="button"
            className={styles.msTrigger}
            data-op={op}
            onClick={toggle}
            {...props}
          >
            <span className={styles.msSummary}>{summary}</span>
            <span aria-hidden className={styles.msCaret}>
              {open ? "▴" : "▾"}
            </span>
          </button>
        )}
      >
        {/* A real <fieldset> (not role="group") — the options are a labelled group of form controls. */}
        <fieldset
          className={styles.msList}
          aria-label={op === "exclude" ? `Exclude ${label}` : label}
        >
          {options.map((o) => {
            const count = counts?.get(`${field}:${o.value}`);
            return (
              <TpCheckbox
                key={o.value}
                checked={chosen.has(o.value)}
                onChange={() => onToggle(o.value)}
                label={
                  <>
                    {o.label}
                    {count !== undefined ? (
                      <span className={styles.msCount}> {count.toLocaleString()}</span>
                    ) : null}
                  </>
                }
              />
            );
          })}
        </fieldset>
      </Popover>
    </div>
  );
}

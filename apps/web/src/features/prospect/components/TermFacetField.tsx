// TermFacetField.tsx — the PROGRESSIVE EXCLUDE term facet (design system: "Progressive exclude", the
// replacement for the old is / is-not toggle). Include is the default and owns the full width of the rail;
// exclusion is one quiet click on the facet's label row and, once opened, becomes its own labelled + tinted
// region, so a reopened saved search reads its own negations back at you. Presentation only — the panel owns
// the query and supplies the picker for each direction; the underlying model is unchanged (a term field
// carries an include AND an exclude clause at once, so both directions coexist).
"use client";

import { type ReactNode, useId, useState } from "react";
import type { TermOp } from "../filterGroups";
import styles from "../prospect.module.css";

/** One applied value on a term facet, in one direction. Structurally shared with both filter-group modules. */
export interface TermFacetCondition {
  op: TermOp;
  value: string;
  label: string;
}

export function TermFacetField({
  label,
  conditions,
  onRemove,
  renderPicker,
  excludeNoun,
}: {
  label: string;
  /** Every applied condition on this facet, both directions (from `termConditions`). */
  conditions: TermFacetCondition[];
  onRemove: (op: TermOp, value: string) => void;
  /** The value picker for one direction. `autoFocus` is true only when the user just opened the block. */
  renderPicker: (op: TermOp, autoFocus: boolean) => ReactNode;
  /** What gets dropped by an exclusion, for the block's explanatory note — "Contacts" or "Accounts". */
  excludeNoun: string;
}) {
  const blockId = useId();
  const included = conditions.filter((c) => c.op === "include");
  const excluded = conditions.filter((c) => c.op === "exclude");
  const hasExcluded = excluded.length > 0;

  const [open, setOpen] = useState(hasExcluded);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  // Auto-open when a query that carries an exclusion arrives (applying a saved search), so the negation is
  // visible without a click. Derived-during-render rather than an effect: no extra paint, no stale frame.
  const [hadExcluded, setHadExcluded] = useState(hasExcluded);
  if (hasExcluded !== hadExcluded) {
    setHadExcluded(hasExcluded);
    if (hasExcluded) {
      setOpen(true);
      setFocusOnOpen(false);
    }
  }

  return (
    <div className={styles.facet}>
      <div className={styles.facetHead}>
        <span className={styles.facetLabel}>{label}</span>
        <button
          type="button"
          className={styles.excToggle}
          aria-expanded={open}
          aria-controls={blockId}
          onClick={() => {
            setFocusOnOpen(!open);
            setOpen((o) => !o);
          }}
        >
          <span aria-hidden className={styles.excSign}>
            {open ? "−" : "+"}
          </span>
          Exclude
        </button>
      </div>

      {renderPicker("include", false)}
      <ChipRow conditions={included} facetLabel={label} onRemove={onRemove} />

      {open ? (
        // A real <fieldset> (not role="group") — the exclusion is a labelled group of form controls.
        <fieldset id={blockId} className={styles.excBlock} aria-label={`Exclude ${label}`}>
          <div className={styles.excHead}>
            <span className={styles.excTitle}>
              <span aria-hidden className={styles.dashMark} />
              Exclude
            </span>
            <button
              type="button"
              className={styles.excClose}
              aria-label={`Close exclude ${label}`}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          {renderPicker("exclude", focusOnOpen)}
          <ChipRow conditions={excluded} facetLabel={label} onRemove={onRemove} />
          {hasExcluded ? null : (
            <p className={styles.excNote}>
              {excludeNoun} matching these are dropped, even when they match above.
            </p>
          )}
        </fieldset>
      ) : hasExcluded ? (
        // Closed with values still set — they stay in the query, so say so rather than hiding them.
        <p className={styles.excSummary}>
          <span aria-hidden className={styles.dashMark} />
          Excluding <b>{excluded.length}</b> {excluded.length === 1 ? "value" : "values"}
        </p>
      ) : null}
    </div>
  );
}

function ChipRow({
  conditions,
  facetLabel,
  onRemove,
}: {
  conditions: TermFacetCondition[];
  facetLabel: string;
  onRemove: (op: TermOp, value: string) => void;
}) {
  if (conditions.length === 0) return null;
  return (
    <div className={styles.termChips}>
      {conditions.map((c) => (
        <span key={`${c.op}:${c.value}`} className={styles.termChip} data-op={c.op}>
          {c.op === "exclude" ? <span aria-hidden className={styles.dashMark} /> : null}
          <span className={styles.termChipLabel}>{c.label}</span>
          <button
            type="button"
            className={styles.termChipRemove}
            aria-label={`Remove ${c.label} from ${c.op === "exclude" ? "excluded" : "included"} ${facetLabel}`}
            onClick={() => onRemove(c.op, c.value)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

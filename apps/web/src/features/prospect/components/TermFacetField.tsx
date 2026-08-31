// TermFacetField.tsx — the PROGRESSIVE EXCLUDE term facet (design system: "Progressive exclude", the
// replacement for the old is / is-not toggle), hosted in a closed-by-default FacetDisclosure (2026-08-31
// rail simplification): the label row is the accordion toggle and the picker renders only once opened, with
// an active-count badge keeping the closed row legible. Include is the default and owns the full width of
// the open body; exclusion is one quiet click on the head row and, once opened, becomes its own labelled +
// tinted region, so a reopened saved search reads its own negations back at you. Presentation only — the
// panel owns the query and supplies the picker for each direction; the underlying model is unchanged (a
// term field carries an include AND an exclude clause at once, so both directions coexist).
"use client";

import { TpIconButton } from "@leadwolf/ui";
import { type ReactNode, useId, useState } from "react";
import type { TermOp } from "../filterGroups";
import styles from "../prospect.module.css";
import { FacetDisclosure } from "./FacetDisclosure";

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
  scopeNote,
}: {
  label: string;
  /** Every applied condition on this facet, both directions (from `termConditions`). */
  conditions: TermFacetCondition[];
  onRemove: (op: TermOp, value: string) => void;
  /** The value picker for one direction. `autoFocus` is true only when the user just opened the block. */
  renderPicker: (op: TermOp, autoFocus: boolean) => ReactNode;
  /** What gets dropped by an exclusion, for the block's explanatory note — "Contacts" or "Accounts". */
  excludeNoun: string;
  /** Optional mark beside the label — the scope badge. */
  scopeNote?: ReactNode;
}) {
  const blockId = useId();
  const included = conditions.filter((c) => c.op === "include");
  const excluded = conditions.filter((c) => c.op === "exclude");
  const hasExcluded = excluded.length > 0;

  const [open, setOpen] = useState(hasExcluded);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  // Pre-open the exclude block when a query that carries an exclusion arrives (applying a saved search), so
  // the negation reads back the moment the user opens the facet — the FacetDisclosure itself stays closed by
  // contract, with the head-row badge counting both directions. Derived-during-render rather than an effect:
  // no extra paint, no stale frame.
  const [hadExcluded, setHadExcluded] = useState(hasExcluded);
  if (hasExcluded !== hadExcluded) {
    setHadExcluded(hasExcluded);
    if (hasExcluded) {
      setOpen(true);
      setFocusOnOpen(false);
    }
  }

  return (
    <FacetDisclosure
      label={label}
      badge={conditions.length || undefined}
      scopeNote={scopeNote}
      headExtra={
        /* Stays a raw <button>: this is a DISCLOSURE, not an action button. Its expanded state is a
           danger-tinted treatment driven by `[aria-expanded="true"]` that no TpButton variant produces,
           and `tp-ui-btn`'s own height/padding/font-size would fight the module class. */
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
      }
    >
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
            {/* The DS icon button, not a hand-rolled ×: it also lifts the hit target from ~18px to the
                32px square WCAG 2.2 SC 2.5.8 asks for, which the bespoke version missed. */}
            <TpIconButton label={`Close exclude ${label}`} onClick={() => setOpen(false)}>
              ×
            </TpIconButton>
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
    </FacetDisclosure>
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
  // Deliberately NOT TpChip: the include/exclude treatment (cobalt vs rose, plus the minus rule so negation
  // is never carried by colour alone) rides on `data-op`, and TpChip takes no data-* passthrough. Its own
  // surface-3 pill would erase the distinction. The remove × is a legal <button> here because the chip
  // wrapper is a <span>, not a button — unlike TagChip, which has to use role="button".
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

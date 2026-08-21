// AppliedFilterChips.tsx — the applied-filter row above the results (search-consolidation 01 §Filters).
//
// Generic over the query type on purpose: the People and Accounts panes each have their own `activeChips`
// helper (filterGroups.ts / accountFilterGroups.ts) that already knows how to describe a clause and how to
// remove it. This component only renders what they produce, so there is ONE chip presentation rather than
// two that drift.
//
// It renders NOTHING when no filter is active — never a "no filters applied" line. That is a design hard
// rule, and it is the right one: a permanently-present empty row is chrome the eye learns to skip, which is
// exactly the wrong training for the row that tells you why your result set is small.
//
// The rail still shows applied values inline inside each facet section. Both are wanted: the inline copy is
// what makes a COLLAPSED accordion legible, this row is what makes the whole filter set legible at a glance
// without opening anything.
"use client";

import { TpButton, TpChip } from "@leadwolf/ui";
import styles from "./search.module.css";

/** The shape both panes' `activeChips` helpers already return. */
export interface AppliedChip<Q> {
  id: string;
  label: string;
  remove: (query: Q) => Q;
}

export function AppliedFilterChips<Q>({
  chips,
  query,
  onChange,
  onClearAll,
}: {
  chips: AppliedChip<Q>[];
  query: Q;
  onChange: (next: Q) => void;
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;

  return (
    <div className={styles.chipRow}>
      {chips.map((chip) => (
        <TpChip
          key={chip.id}
          active
          onRemove={() => onChange(chip.remove(query))}
          // Each chip's remove target is named, because "×" alone tells a screen-reader user nothing about
          // WHICH filter is about to disappear.
          removeLabel={`Remove filter ${chip.label}`}
        >
          {chip.label}
        </TpChip>
      ))}
      <TpButton variant="ghost" size="sm" onClick={onClearAll}>
        Clear all
      </TpButton>
    </div>
  );
}

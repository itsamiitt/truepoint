// SelectionControls.tsx — the row + select-all checkboxes as SUBSCRIBING leaf components (perf-audit P3.1).
// Each subscribes to the bulk-selection store itself, so a toggle re-renders exactly the checkboxes whose
// state changed — never the page, never the other ~700 cells (see useBulkSelection.ts for the full story).
// memo() on top: the grid's own re-renders (new rows, density) skip these when their props are unchanged —
// the store prop is identity-stable for the page's lifetime, so only id/label changes break the memo.
//
// A NOT-SAVED row (a database person) renders the checkbox DISABLED WITH ITS REASON rather than hidden
// (search-consolidation 01 §Results grid): bulk actions address contacts by id, and the row has none until its
// reveal saves it (decisions.md 2026-08-25).
"use client";

import { Tooltip, TpCheckbox } from "@leadwolf/ui";
import { memo } from "react";
import {
  type BulkSelectionStore,
  useBulkSelectionState,
  useRowSelected,
} from "../hooks/useBulkSelection";

export const RowSelectCheckbox = memo(function RowSelectCheckbox({
  store,
  id,
  label,
  className,
  disabledReason,
}: {
  store: BulkSelectionStore;
  id: string;
  label: string;
  className?: string;
  /** Set ⇒ the row cannot join a selection; the reason is the tooltip AND part of the accessible name. */
  disabledReason?: string;
}) {
  const checked = useRowSelected(store, id);
  if (disabledReason) {
    return (
      <Tooltip label={disabledReason}>
        {/* A disabled input swallows pointer events in some engines, so the tooltip anchors on a wrapper. */}
        <span style={{ display: "inline-flex" }}>
          <TpCheckbox
            className={className}
            checked={false}
            disabled
            aria-disabled="true"
            onClick={(e) => e.stopPropagation()}
            onChange={() => undefined}
            aria-label={`${label} — ${disabledReason}`}
          />
        </span>
      </Tooltip>
    );
  }
  return (
    <TpCheckbox
      className={className}
      checked={checked}
      onClick={(e) => e.stopPropagation()}
      onChange={() => store.toggle(id)}
      aria-label={label}
    />
  );
});

export const SelectAllCheckbox = memo(function SelectAllCheckbox({
  store,
  shownIds,
  className,
}: {
  store: BulkSelectionStore;
  shownIds: string[];
  className?: string;
}) {
  const state = useBulkSelectionState(store);
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => state.selectedIds.has(id));
  return (
    <TpCheckbox
      className={className}
      aria-label="Select all shown"
      checked={allShownSelected}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => store.setMany(shownIds, e.target.checked)}
    />
  );
});

// useBulkSelection.ts — view state for multi-row selection on the prospect grid (the bulk-action bar's
// model). Holds the set of explicitly-selected contact ids plus toggle/clear/setMany helpers, AND the
// "select all N matching" mode (24): when the user escalates from "all on this page" to "all results
// matching the current search", the selection switches from an explicit id set to a server-resolved
// `criteria` ContactQuery (capped server-side at BULK_SELECTION_CAP). Pure presentation state, no business
// logic; selection is keyed by contact id so it survives client-side re-filtering of the grid.
"use client";

import type { BulkSelection, ContactQuery } from "@leadwolf/types";
import { useCallback, useMemo, useState } from "react";

export interface ProspectBulkSelection {
  selectedIds: ReadonlySet<string>;
  count: number;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  clear: () => void;
  /** Add or remove many ids at once (drives the header "select all visible" toggle). */
  setMany: (ids: string[], selected: boolean) => void;
  /** True when the user has escalated to "all N matching" (the bulk ops then target `criteria`, not ids). */
  allMatching: boolean;
  /** The total match count when in `allMatching` mode (from searchCount); null = explicit-id mode. */
  matchTotal: number | null;
  /** Escalate to "select all N matching": the bulk ops will send { criteria } resolved/capped server-side. */
  selectAllMatching: (total: number) => void;
  /**
   * Build the server BulkSelection for a mutation: { criteria } when in allMatching mode (with the page's
   * current query), else { contactIds } from the explicit set. Returns null when nothing is selected.
   */
  toBulkSelection: (criteria: ContactQuery) => BulkSelection | null;
}

export function useBulkSelection(): ProspectBulkSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // When set, the selection means "all N matching the current search" rather than the explicit id set.
  const [matchTotal, setMatchTotal] = useState<number | null>(null);

  const toggle = useCallback((id: string) => {
    setMatchTotal(null); // any explicit edit drops out of select-all-matching mode
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setMatchTotal(null);
    setSelectedIds(new Set());
  }, []);

  const setMany = useCallback((ids: string[], selected: boolean) => {
    setMatchTotal(null);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const selectAllMatching = useCallback((total: number) => setMatchTotal(total), []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const toBulkSelection = useCallback(
    (criteria: ContactQuery): BulkSelection | null => {
      if (matchTotal !== null) return { criteria };
      if (selectedIds.size === 0) return null;
      return { contactIds: [...selectedIds] };
    },
    [matchTotal, selectedIds],
  );

  const allMatching = matchTotal !== null;
  // The bar's headline count: the resolved match total in select-all mode, else the explicit set size.
  const count = allMatching ? (matchTotal ?? 0) : selectedIds.size;

  return useMemo(
    () => ({
      selectedIds,
      count,
      isSelected,
      toggle,
      clear,
      setMany,
      allMatching,
      matchTotal,
      selectAllMatching,
      toBulkSelection,
    }),
    [
      selectedIds,
      count,
      isSelected,
      toggle,
      clear,
      setMany,
      allMatching,
      matchTotal,
      selectAllMatching,
      toBulkSelection,
    ],
  );
}

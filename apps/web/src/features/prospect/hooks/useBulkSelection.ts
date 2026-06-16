// useBulkSelection.ts — view state for multi-row selection on the prospect grid (the bulk-action bar's
// model). Holds the set of selected contact ids plus toggle/clear/setMany helpers; pure presentation state,
// no business logic. Selection is keyed by contact id so it survives client-side re-filtering of the grid.
"use client";

import { useCallback, useMemo, useState } from "react";

export interface BulkSelection {
  selectedIds: ReadonlySet<string>;
  count: number;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  clear: () => void;
  /** Add or remove many ids at once (drives the header "select all visible" toggle). */
  setMany: (ids: string[], selected: boolean) => void;
}

export function useBulkSelection(): BulkSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const setMany = useCallback((ids: string[], selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  return useMemo(
    () => ({ selectedIds, count: selectedIds.size, isSelected, toggle, clear, setMany }),
    [selectedIds, isSelected, toggle, clear, setMany],
  );
}

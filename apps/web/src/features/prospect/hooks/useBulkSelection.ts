// useBulkSelection.ts — multi-row selection for the bulk-action bar, held in an EXTERNAL store rather than
// page useState (perf-audit P3.1). The old shape made every checkbox click a page-wide render: the toggle
// replaced the page's selection state → the page re-rendered → the columns memo (whose deps included the
// selection object) rebuilt → DataTable re-ran every cell of every row (~700 renders at the 100-row page,
// zero React.memo anywhere) — the measured "grid feels sluggish" INP. With the store, selection changes
// notify SUBSCRIBERS only: the row checkboxes (whose useSyncExternalStore snapshot is a primitive boolean,
// so only rows whose checked-state actually CHANGED re-render), the select-all header, and the bulk bar —
// the page itself does not re-render on toggle at all (ProspectPage holds only the stable store).
//
// The consumer-facing `ProspectBulkSelection` shape is unchanged — BulkActionBar (930 lines) is untouched;
// it now receives the object from a small subscribing host instead of from page state. Selection semantics
// are unchanged too: keyed by contact id (survives client-side re-filtering), and any explicit edit drops
// out of "select all N matching" mode.
"use client";

import type { BulkSelection, ContactQuery } from "@leadwolf/types";
import { useMemo, useRef, useSyncExternalStore } from "react";

export interface SelectionState {
  selectedIds: ReadonlySet<string>;
  /** Non-null when the user escalated to "all N matching" (bulk ops then target `criteria`, not ids). */
  matchTotal: number | null;
}

/** Shared empty state — never mutated (every write path builds a fresh Set), so it is a safe stable
 *  snapshot for first render and for the server pass (useSyncExternalStore's getServerSnapshot). */
const EMPTY_STATE: SelectionState = { selectedIds: new Set<string>(), matchTotal: null };

/** The store: stable action methods + a snapshot/subscribe pair. Every method identity is fixed for the
 *  store's lifetime, so memos and callbacks can depend on the STORE without invalidating per selection. */
export interface BulkSelectionStore {
  getState(): SelectionState;
  subscribe(listener: () => void): () => void;
  toggle(id: string): void;
  clear(): void;
  /** Add or remove many ids at once (drives the header "select all visible" toggle). */
  setMany(ids: string[], selected: boolean): void;
  /** Escalate to "select all N matching": bulk ops will send { criteria } resolved/capped server-side. */
  selectAllMatching(total: number): void;
}

function createBulkSelectionStore(): BulkSelectionStore {
  let state = EMPTY_STATE;
  const listeners = new Set<() => void>();
  const publish = (next: SelectionState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle(id) {
      const next = new Set(state.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Any explicit edit drops out of select-all-matching mode (unchanged semantics).
      publish({ selectedIds: next, matchTotal: null });
    },
    clear() {
      publish(EMPTY_STATE);
    },
    setMany(ids, selected) {
      const next = new Set(state.selectedIds);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      publish({ selectedIds: next, matchTotal: null });
    },
    selectAllMatching(total) {
      publish({ selectedIds: state.selectedIds, matchTotal: total });
    },
  };
}

/** One store per mounted grid page (Prospect, List detail): created once, identity stable for the page's
 *  lifetime. Holding THIS costs the page nothing — it is the subscribing hooks below that re-render. */
export function useBulkSelectionStore(): BulkSelectionStore {
  const ref = useRef<BulkSelectionStore | null>(null);
  if (ref.current === null) ref.current = createBulkSelectionStore();
  return ref.current;
}

/** Subscribe to the RAW selection state (the select-all header + anything needing the whole set). */
export function useBulkSelectionState(store: BulkSelectionStore): SelectionState {
  return useSyncExternalStore(store.subscribe, store.getState, () => EMPTY_STATE);
}

/** Subscribe to ONE row's checked-state. The snapshot is a primitive, so useSyncExternalStore re-renders
 *  this subscriber only when the boolean actually flips — a toggle re-renders 1-2 checkboxes, not the grid. */
export function useRowSelected(store: BulkSelectionStore, id: string): boolean {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().selectedIds.has(id),
    () => false,
  );
}

// ── The consumer-facing selection view (BulkActionBar's contract — shape unchanged) ─────────────────────
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

/** The SUBSCRIBING view over a store — re-renders its caller on every selection change, so mount it in the
 *  narrowest component that needs the whole selection (the bulk-bar host, a dialog owner), not the page. */
export function useBulkSelection(store: BulkSelectionStore): ProspectBulkSelection {
  const state = useBulkSelectionState(store);
  return useMemo(() => {
    const allMatching = state.matchTotal !== null;
    return {
      selectedIds: state.selectedIds,
      count: allMatching ? (state.matchTotal ?? 0) : state.selectedIds.size,
      isSelected: (id: string) => state.selectedIds.has(id),
      toggle: store.toggle,
      clear: store.clear,
      setMany: store.setMany,
      allMatching,
      matchTotal: state.matchTotal,
      selectAllMatching: store.selectAllMatching,
      toBulkSelection: (criteria: ContactQuery): BulkSelection | null => {
        if (state.matchTotal !== null) return { criteria };
        if (state.selectedIds.size === 0) return null;
        return { contactIds: [...state.selectedIds] };
      },
    };
  }, [state, store]);
}

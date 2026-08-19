// useRevealStore.tsx — the single client source of truth for reveal state across the Prospect grid (Phase 2).
// It caches already-owned reveal PII (hydrated in bulk on page load + merged optimistically after each reveal),
// tracks in-flight reveals (per-row spinner + a synchronous re-entry guard so a double-click can't double-charge),
// and holds the per-type credit costs so the grid can show "Reveal email · N cr" before spending. One store, so
// the list and the detail derive reveal state the same way (fixes the cross-surface inconsistency). The charge
// itself still runs server-side; this only mirrors the outcome.
//
// EXTERNAL STORE, not React context state (perf-audit P3.1b — the useBulkSelection medicine, second dose). The
// old provider held byId/revealing/costs in useState and memoized the context value over all of them, so ONE
// bulk hydrate or ONE reveal replaced the context value and re-rendered EVERY consumer — two RevealCells per
// row across the grid, plus the page itself. The context now carries an identity-STABLE handle; components
// subscribe to exactly the slice they render (one row's revealed data, one (row, type) in-flight flag, the
// costs), so a reveal re-renders the cells of that row and nothing else — and the page, which only calls
// hydrate/refresh, never re-renders for reveal data at all.
"use client";

import { invalidateCreditSignals } from "@/lib/credits";
import type { RevealCosts, RevealResponse, RevealType, RevealedContact } from "@leadwolf/types";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { ApiError, batchRevealedContacts, getRevealCosts, revealContact } from "../api";

export interface RevealAttempt {
  ok: boolean;
  result?: RevealResponse;
  /** Structured failure (mirrors useReveal): code discriminates insufficient_credits (402) / suppressed (403). */
  error?: string;
  code?: string;
}

interface RevealState {
  byId: ReadonlyMap<string, RevealedContact>;
  revealing: ReadonlySet<string>;
  costs: RevealCosts | null;
}

const EMPTY_STATE: RevealState = { byId: new Map(), revealing: new Set(), costs: null };

/** The stable store handle: actions + current-value accessors. Holding this costs a component nothing —
 *  rendering FROM it goes through the subscribing hooks below (useRevealedContact / useIsRevealing /
 *  useRevealCosts), which re-render exactly the component that consumes the changed slice. */
export interface RevealStore {
  /** The owned reveal data for a contact RIGHT NOW (non-reactive — render via useRevealedContact). */
  getRevealed: (contactId: string) => RevealedContact | undefined;
  /** True while a reveal of this (contact, type) is in flight (non-reactive — render via useIsRevealing). */
  isRevealing: (contactId: string, revealType: RevealType) => boolean;
  /** Bulk-load owned reveal data for the visible page (idempotent per id; safe to call on every hits change). */
  hydrate: (contactIds: string[]) => void;
  /** Force a single id to re-hydrate from the backend (e.g. after a reveal done in the detail drawer) so the
   *  grid stays in sync with the drawer. */
  refresh: (contactId: string) => void;
  /** Run a single reveal through the money path, merge the result optimistically, toast-free (caller toasts). */
  reveal: (contactId: string, revealType: RevealType) => Promise<RevealAttempt>;
  /** Subscription primitives for the slice hooks below. */
  getState: () => RevealState;
  subscribe: (listener: () => void) => () => void;
}

const RevealStoreContext = createContext<RevealStore | null>(null);

function ownsEmail(types: RevealType[]): boolean {
  return types.includes("email") || types.includes("full_profile");
}
function ownsPhone(types: RevealType[]): boolean {
  return types.includes("phone") || types.includes("full_profile");
}

/** Merge a single reveal's response into the cached RevealedContact (instant, partial — the drawer refetches the
 *  full record for line-type/history). full_profile implies both fields owned. */
function mergeReveal(
  prev: ReadonlyMap<string, RevealedContact>,
  contactId: string,
  revealType: RevealType,
  res: RevealResponse,
): Map<string, RevealedContact> {
  const existing = prev.get(contactId);
  const owned = new Set<RevealType>(existing?.ownedTypes ?? []);
  owned.add(revealType);
  const ownedTypes = Array.from(owned);
  const email = res.email ?? existing?.email ?? null;
  const phone = res.phone ?? existing?.phone ?? null;
  const revealedFields: string[] = [];
  if (email) revealedFields.push("email");
  if (phone) revealedFields.push("phone");
  const merged: RevealedContact = {
    contactId,
    email,
    phone,
    linkedinUrl: existing?.linkedinUrl ?? null,
    emailStatus: res.emailStatus ?? existing?.emailStatus ?? null,
    phoneStatus: existing?.phoneStatus ?? null,
    phoneLineType: existing?.phoneLineType ?? null,
    ownedTypes,
    revealedFields,
    history: existing?.history ?? [],
  };
  const next = new Map(prev);
  next.set(contactId, merged);
  return next;
}

function createRevealStore(onCreditsMoved: () => void): RevealStore {
  let state = EMPTY_STATE;
  const listeners = new Set<() => void>();
  const publish = (next: RevealState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  // Synchronous re-entry guard (a double-click within one tick must not double-spend).
  const pending = new Set<string>();
  // Ids already hydrated, so re-rendering the same page doesn't refetch.
  const hydrated = new Set<string>();

  const setRows = (rows: RevealedContact[]) => {
    if (rows.length === 0) return;
    // Untouched ids keep their entry OBJECT identity in the new Map, so their per-id snapshots are unchanged
    // and useSyncExternalStore skips their subscribers — only the rows that actually changed re-render.
    const byId = new Map(state.byId);
    for (const r of rows) byId.set(r.contactId, r);
    publish({ ...state, byId });
  };

  const store: RevealStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRevealed: (contactId) => state.byId.get(contactId),
    isRevealing: (contactId, revealType) => state.revealing.has(`${contactId}:${revealType}`),
    hydrate(contactIds) {
      const fresh = contactIds.filter((id) => !hydrated.has(id));
      if (fresh.length === 0) return;
      for (const id of fresh) hydrated.add(id);
      void batchRevealedContacts(fresh)
        .then(setRows)
        .catch(() => {
          // Leave un-hydrated: the per-row badge still renders from the row's revealedTypes; only the inline
          // value is missing. Drop the ids from the hydrated set so a later attempt can retry.
          for (const id of fresh) hydrated.delete(id);
        });
    },
    refresh(contactId) {
      hydrated.delete(contactId);
      void batchRevealedContacts([contactId])
        .then((rows) => {
          hydrated.add(contactId);
          setRows(rows);
        })
        .catch(() => {
          /* keep whatever's cached; a later hydrate can retry */
        });
    },
    async reveal(contactId, revealType) {
      const key = `${contactId}:${revealType}`;
      if (pending.has(key)) return { ok: false, error: "A reveal is already in progress." };
      pending.add(key);
      publish({ ...state, revealing: new Set(state.revealing).add(key) });
      try {
        const result = await revealContact(contactId, revealType);
        publish({ ...state, byId: mergeReveal(state.byId, contactId, revealType, result) });
        hydrated.add(contactId);
        // Credits moved — invalidate so the top-bar pill and the bulk bar both re-read.
        onCreditsMoved();
        return { ok: true, result };
      } catch (e) {
        if (e instanceof ApiError) return { ok: false, error: e.message, code: e.code };
        return { ok: false, error: e instanceof Error ? e.message : "Reveal failed" };
      } finally {
        pending.delete(key);
        const revealing = new Set(state.revealing);
        revealing.delete(key);
        publish({ ...state, revealing });
      }
    },
  };
  // Internal seam for the provider's one-time costs fetch.
  (store as RevealStore & { __setCosts: (c: RevealCosts) => void }).__setCosts = (c) =>
    publish({ ...state, costs: c });
  return store;
}

export function RevealStoreProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const storeRef = useRef<RevealStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createRevealStore(() => invalidateCreditSignals(qc));
  }
  const store = storeRef.current;

  useEffect(() => {
    let live = true;
    getRevealCosts()
      .then((c) => {
        if (live) (store as RevealStore & { __setCosts: (v: RevealCosts) => void }).__setCosts(c);
      })
      .catch(() => {
        /* costs are a nicety; the reveal still works without the up-front number */
      });
    return () => {
      live = false;
    };
  }, [store]);

  // Realtime (Phase 4): a reveal committed elsewhere (a teammate / another tab) arrives as a `reveal:changed`
  // window event from the SSE bridge → refresh that row so this tab's grid converges without a manual reload.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const detail = (e as CustomEvent<{ contactId?: string }>).detail;
      if (detail?.contactId) store.refresh(detail.contactId);
    };
    window.addEventListener("reveal:changed", onReveal);
    return () => window.removeEventListener("reveal:changed", onReveal);
  }, [store]);

  return <RevealStoreContext.Provider value={store}>{children}</RevealStoreContext.Provider>;
}

/** The stable store handle (actions + non-reactive accessors). Rendering reveal DATA goes through the slice
 *  hooks below — holding the handle alone never re-renders the holder. */
export function useRevealStore(): RevealStore {
  const ctx = useContext(RevealStoreContext);
  if (!ctx) throw new Error("useRevealStore must be used within a RevealStoreProvider");
  return ctx;
}

/** Subscribe to ONE contact's owned reveal data — re-renders only when that row's entry changes. */
export function useRevealedContact(contactId: string): RevealedContact | undefined {
  const store = useRevealStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().byId.get(contactId),
    () => undefined,
  );
}

/** Subscribe to ONE (contact, type) in-flight flag — drives the per-row spinner + disabled state. */
export function useIsRevealing(contactId: string, revealType: RevealType): boolean {
  const store = useRevealStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().revealing.has(`${contactId}:${revealType}`),
    () => false,
  );
}

/** Subscribe to the per-type credit costs (loaded once per page; null until then). */
export function useRevealCosts(): RevealCosts | null {
  const store = useRevealStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().costs,
    () => null,
  );
}

/** Which reveal_types a row is owned for, merging the search projection (backend truth at query time) with the
 *  store (reveals done this session). The store's inline value is what actually renders; this drives affordance. */
export function ownedRevealTypes(
  rowRevealedTypes: RevealType[] | undefined,
  storeRevealed: RevealedContact | undefined,
): { email: boolean; phone: boolean } {
  const types = new Set<RevealType>([
    ...(rowRevealedTypes ?? []),
    ...(storeRevealed?.ownedTypes ?? []),
  ]);
  const list = Array.from(types);
  return { email: ownsEmail(list), phone: ownsPhone(list) };
}

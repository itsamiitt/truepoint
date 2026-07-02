// useRevealStore.tsx — the single client source of truth for reveal state across the Prospect grid (Phase 2).
// It caches already-owned reveal PII (hydrated in bulk on page load + merged optimistically after each reveal),
// tracks in-flight reveals (per-row spinner + a synchronous re-entry guard so a double-click can't double-charge),
// and holds the per-type credit costs so the grid can show "Reveal email · N cr" before spending. One store, so
// the list and the detail derive reveal state the same way (fixes the cross-surface inconsistency). The charge
// itself still runs server-side; this only mirrors the outcome.
"use client";

import type { RevealCosts, RevealResponse, RevealType, RevealedContact } from "@leadwolf/types";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, batchRevealedContacts, getRevealCosts, revealContact } from "../api";

export interface RevealAttempt {
  ok: boolean;
  result?: RevealResponse;
  /** Structured failure (mirrors useReveal): code discriminates insufficient_credits (402) / suppressed (403). */
  error?: string;
  code?: string;
}

export interface RevealStore {
  costs: RevealCosts | null;
  /** The owned reveal data for a contact (null until hydrated / revealed this session). */
  getRevealed: (contactId: string) => RevealedContact | undefined;
  /** True while a reveal of this (contact, type) is in flight — drives the per-row spinner + disabled state. */
  isRevealing: (contactId: string, revealType: RevealType) => boolean;
  /** Bulk-load owned reveal data for the visible page (idempotent per id; safe to call on every hits change). */
  hydrate: (contactIds: string[]) => void;
  /** Force a single id to re-hydrate from the backend (e.g. after a reveal done in the detail drawer) so the
   *  grid stays in sync with the drawer. */
  refresh: (contactId: string) => void;
  /** Run a single reveal through the money path, merge the result optimistically, toast-free (caller toasts). */
  reveal: (contactId: string, revealType: RevealType) => Promise<RevealAttempt>;
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
  prev: Map<string, RevealedContact>,
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

export function RevealStoreProvider({ children }: { children: ReactNode }) {
  const [byId, setById] = useState<Map<string, RevealedContact>>(() => new Map());
  const [revealing, setRevealing] = useState<Set<string>>(() => new Set());
  const [costs, setCosts] = useState<RevealCosts | null>(null);
  // Synchronous re-entry guard (state updates are async — a double-click within one tick must not double-spend).
  const pendingRef = useRef<Set<string>>(new Set());
  // Ids already hydrated, so re-rendering the same page doesn't refetch.
  const hydratedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    getRevealCosts()
      .then((c) => live && setCosts(c))
      .catch(() => {
        /* costs are a nicety; the reveal still works without the up-front number */
      });
    return () => {
      live = false;
    };
  }, []);

  const getRevealed = useCallback((contactId: string) => byId.get(contactId), [byId]);

  const isRevealing = useCallback(
    (contactId: string, revealType: RevealType) => revealing.has(`${contactId}:${revealType}`),
    [revealing],
  );

  const hydrate = useCallback((contactIds: string[]) => {
    const fresh = contactIds.filter((id) => !hydratedRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) hydratedRef.current.add(id);
    void batchRevealedContacts(fresh)
      .then((rows) => {
        if (rows.length === 0) return;
        setById((prev) => {
          const next = new Map(prev);
          for (const r of rows) next.set(r.contactId, r);
          return next;
        });
      })
      .catch(() => {
        // Leave un-hydrated: the per-row badge still renders from the row's revealedTypes; only the inline
        // value is missing. Drop the ids from the hydrated set so a later attempt can retry.
        for (const id of fresh) hydratedRef.current.delete(id);
      });
  }, []);

  const refresh = useCallback((contactId: string) => {
    hydratedRef.current.delete(contactId);
    void batchRevealedContacts([contactId])
      .then((rows) => {
        hydratedRef.current.add(contactId);
        if (rows.length === 0) return;
        setById((prev) => {
          const next = new Map(prev);
          for (const r of rows) next.set(r.contactId, r);
          return next;
        });
      })
      .catch(() => {
        /* keep whatever's cached; a later hydrate can retry */
      });
  }, []);

  // Realtime (Phase 4): a reveal committed elsewhere (a teammate / another tab) arrives as a `reveal:changed`
  // window event from the SSE bridge → refresh that row so this tab's grid converges without a manual reload.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const detail = (e as CustomEvent<{ contactId?: string }>).detail;
      if (detail?.contactId) refresh(detail.contactId);
    };
    window.addEventListener("reveal:changed", onReveal);
    return () => window.removeEventListener("reveal:changed", onReveal);
  }, [refresh]);

  const reveal = useCallback(
    async (contactId: string, revealType: RevealType): Promise<RevealAttempt> => {
      const key = `${contactId}:${revealType}`;
      if (pendingRef.current.has(key))
        return { ok: false, error: "A reveal is already in progress." };
      pendingRef.current.add(key);
      setRevealing((s) => new Set(s).add(key));
      try {
        const result = await revealContact(contactId, revealType);
        setById((prev) => mergeReveal(prev, contactId, revealType, result));
        hydratedRef.current.add(contactId);
        // The top-bar CreditPill re-reads the balance off this event (the one place credits change here).
        window.dispatchEvent(new Event("credits:changed"));
        return { ok: true, result };
      } catch (e) {
        if (e instanceof ApiError) return { ok: false, error: e.message, code: e.code };
        return { ok: false, error: e instanceof Error ? e.message : "Reveal failed" };
      } finally {
        pendingRef.current.delete(key);
        setRevealing((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
    },
    [],
  );

  const store: RevealStore = useMemo(
    () => ({ costs, getRevealed, isRevealing, hydrate, refresh, reveal }),
    [costs, getRevealed, isRevealing, hydrate, refresh, reveal],
  );
  return <RevealStoreContext.Provider value={store}>{children}</RevealStoreContext.Provider>;
}

export function useRevealStore(): RevealStore {
  const ctx = useContext(RevealStoreContext);
  if (!ctx) throw new Error("useRevealStore must be used within a RevealStoreProvider");
  return ctx;
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

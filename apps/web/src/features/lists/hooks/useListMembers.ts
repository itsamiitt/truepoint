// useListMembers.ts — the engine for the list-detail members grid: loads the first MASKED, keyset-paged page
// on mount (and whenever the list id changes), exposes the four-state signals + keyset "load more", and a
// reload the remove-from-list action calls after a mutation. Mirrors useProspectSearch's keyset pattern
// (accumulate pages, advance by cursor) but over a fixed list id rather than a URL-derived query. The members
// are masked (email domain only, phone locked) — reveal is the only de-masking path, never this read.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchListMembers } from "../api";

const PAGE_SIZE = 100;

export interface ListMembersState {
  members: MaskedContact[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  /** Optimistically flip a row to revealed after a successful reveal (no refetch). */
  markRevealed: (id: string) => void;
}

export function useListMembers(listId: string): ListMembersState {
  const [members, setMembers] = useState<MaskedContact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fromCursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await fetchListMembers(listId, {
          limit: PAGE_SIZE,
          cursor: fromCursor ?? undefined,
        });
        setMembers((prev) => (fromCursor ? [...prev, ...page.members] : page.members));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load list members");
      } finally {
        setLoading(false);
      }
    },
    [listId],
  );

  // (Re)load from the first page whenever the list id changes.
  useEffect(() => {
    void run(null);
  }, [run]);

  const loadMore = useCallback(() => {
    if (cursor) void run(cursor);
  }, [cursor, run]);

  const reload = useCallback(() => {
    void run(null);
  }, [run]);

  const markRevealed = useCallback((id: string) => {
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, isRevealed: true } : m)));
  }, []);

  return {
    members,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore,
    reload,
    markRevealed,
  };
}

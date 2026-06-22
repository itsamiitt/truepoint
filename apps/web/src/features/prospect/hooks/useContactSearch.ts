// useContactSearch.ts — drives the prospect grid from the server search API (24 §5/§6). Holds the active
// filters + free text, re-runs the query when they change, and exposes keyset "load more". Replaces the
// client-side row filtering in useContacts for filtered/large result sets.
"use client";

import type { ContactHit, ContactQuery, FilterClause } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { searchContacts } from "../searchApi";

const PAGE_SIZE = 50;

export function useContactSearch() {
  const [filters, setFilters] = useState<FilterClause[]>([]);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fromCursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const query: ContactQuery = {
          filters,
          text: text.trim() || undefined,
          sort: "relevance",
          limit: PAGE_SIZE,
          cursor: fromCursor ?? undefined,
        };
        const page = await searchContacts(query);
        setHits((prev) => (fromCursor ? [...prev, ...page.hits] : page.hits));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
      } finally {
        setLoading(false);
      }
    },
    [filters, text],
  );

  // Re-run from the first page whenever filters or text change.
  useEffect(() => {
    void run(null);
  }, [run]);

  const loadMore = useCallback(() => {
    if (cursor) void run(cursor);
  }, [cursor, run]);

  return {
    filters,
    setFilters,
    text,
    setText,
    hits,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore,
  };
}

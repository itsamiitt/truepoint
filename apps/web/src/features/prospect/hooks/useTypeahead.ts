// useTypeahead.ts — debounced, server-driven typeahead for a filter facet (24 §3.4). Fires only after a
// 300ms pause and ≥3 chars.
//
// The per-term memo this kept in a `useRef(new Map())` is now the query cache keyed by (field, term), which
// makes it shared across every mount of the same facet and bounded by RQ's garbage collection — the ref map
// grew for the lifetime of the component and was thrown away on unmount, so the same three keystrokes cost a
// request again every time the panel reopened. RQ also owns the abort, so a stale request is cancelled rather
// than resolved and discarded.
"use client";

import type { FacetKey, Suggestion } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { prospectKeys } from "../keys";
import { suggestDatabaseField, suggestField } from "../searchApi";

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

/**
 * Which endpoint supplies the values. `workspace` aggregates the caller's own contacts; `database`
 * aggregates the Layer-0 satellites, which the overlay does not store and cannot read. A facet declared
 * `database-only` must use the latter or its picker silently returns nothing.
 */
export type TypeaheadSource = "workspace" | "database";

export function useTypeahead(field: FacetKey, source: TypeaheadSource = "workspace") {
  const [query, setQuery] = useState("");
  // The debounce still belongs here: it decides WHEN a term becomes a request, which is a property of typing,
  // not of fetching. RQ then dedupes and caches whatever terms come out of it.
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const term = debounced.length >= MIN_CHARS ? debounced : "";
  const result = useQuery<Suggestion[]>({
    // `source` is part of the KEY: the two endpoints answer the same (field, term) differently, so sharing
    // one cache entry would serve workspace values to a database facet and vice versa.
    queryKey: [...prospectKeys.typeahead(field, term), source],
    enabled: term !== "",
    queryFn: ({ signal }) =>
      source === "database"
        ? suggestDatabaseField(field, term, 10, signal)
        : suggestField(field, term, 10, signal),
    // A suggestion list is disposable; retrying it while the user keeps typing only queues work for a term
    // they have already moved past.
    retry: false,
  });

  return {
    query,
    setQuery,
    suggestions: term ? (result.data ?? []) : [],
    // Typing past the threshold should read as "loading" from the keystroke, not from the request that starts
    // 300ms later — otherwise the panel shows an empty list in the gap.
    loading: query.trim().length >= MIN_CHARS && (query.trim() !== debounced || result.isFetching),
  };
}

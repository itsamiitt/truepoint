// useTypeahead.ts — debounced, server-driven typeahead for a filter facet (24 §3.4). Fires only after a
// 300ms pause and once the term is long enough for its facet.
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
import { suggestField } from "../searchApi";

const MIN_CHARS_DEFAULT = 3;
/** Title is the one facet where two letters are a real query — "VP", "HR", "IT". A recorded deviation from
 *  ADR-0035's client rule of 3 (decisions.md 2026-08-25); bounded by the same debounce + cache. */
const MIN_CHARS: Partial<Record<FacetKey, number>> = { title: 2 };
const DEBOUNCE_MS = 300;

export function useTypeahead(field: FacetKey) {
  const minChars = MIN_CHARS[field] ?? MIN_CHARS_DEFAULT;
  const [query, setQuery] = useState("");
  // The debounce still belongs here: it decides WHEN a term becomes a request, which is a property of typing,
  // not of fetching. RQ then dedupes and caches whatever terms come out of it.
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const term = debounced.length >= minChars ? debounced : "";
  const result = useQuery<Suggestion[]>({
    queryKey: prospectKeys.typeahead(field, term),
    enabled: term !== "",
    queryFn: ({ signal }) => suggestField(field, term, 10, signal),
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
    loading: query.trim().length >= minChars && (query.trim() !== debounced || result.isFetching),
    /** How many characters this facet needs before it asks the server — the picker says so instead of nothing. */
    minChars,
  };
}

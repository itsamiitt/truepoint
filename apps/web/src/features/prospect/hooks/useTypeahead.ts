// useTypeahead.ts — debounced, server-driven typeahead for a filter facet (24 §3.4). Fires only after a
// 300ms pause and ≥3 chars, caches results per query in-memory, and aborts stale requests (latest wins).
"use client";

import type { FacetKey, Suggestion } from "@leadwolf/types";
import { useEffect, useRef, useState } from "react";
import { suggestField } from "../searchApi";

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

export function useTypeahead(field: FacetKey) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, Suggestion[]>());

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    const cached = cache.current.get(q);
    if (cached) {
      setSuggestions(cached);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await suggestField(field, q, 10, controller.signal);
        cache.current.set(q, result);
        setSuggestions(result);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, field]);

  return { query, setQuery, suggestions, loading };
}

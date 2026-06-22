// useRecentSearches.ts — the "recent searches" quick-shortcuts row (24, Done-When #4). Unlike saved searches
// (named, server-persisted, shareable), recents are an ephemeral, per-browser convenience: the last few
// non-empty queries the user ran, kept in localStorage, deduped and capped. The list-merge + label + key
// logic is pure and unit-tested; the hook is the thin localStorage + React wrapper.
"use client";

import type { ContactQuery } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { activeChips } from "../filterGroups";

const STORAGE_KEY = "tp.prospect.recentSearches";
const MAX_RECENTS = 8;

export interface RecentSearch {
  /** Stable identity = the canonical query (so re-running an identical search de-dupes, not duplicates). */
  id: string;
  query: ContactQuery;
  label: string;
  at: number;
}

/** Canonical identity for a query — text + filters + sort (limit/cursor are ephemeral, excluded). */
export function recentKey(query: ContactQuery): string {
  return JSON.stringify({ text: query.text ?? "", filters: query.filters, sort: query.sort });
}

/** A short human label: the free text and/or the active-filter count. "All prospects" when truly empty. */
export function recentLabel(query: ContactQuery): string {
  const parts: string[] = [];
  if (query.text?.trim()) parts.push(`"${query.text.trim()}"`);
  const n = activeChips(query).length;
  if (n > 0) parts.push(`${n} filter${n === 1 ? "" : "s"}`);
  return parts.join(" · ") || "All prospects";
}

/** True when a query is worth recording (has text or at least one filter). */
export function isRecordable(query: ContactQuery): boolean {
  return Boolean(query.text?.trim()) || query.filters.length > 0;
}

/** Pure list merge: newest first, de-duped by id, capped. (Exported for tests.) */
export function mergeRecent(
  prev: RecentSearch[],
  entry: RecentSearch,
  max = MAX_RECENTS,
): RecentSearch[] {
  return [entry, ...prev.filter((r) => r.id !== entry.id)].slice(0, max);
}

function load(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RecentSearch[]) : [];
  } catch {
    return [];
  }
}

function persist(list: RecentSearch[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // best-effort; private mode / quota → recents simply don't persist.
  }
}

export function useRecentSearches() {
  const [recents, setRecents] = useState<RecentSearch[]>([]);

  useEffect(() => setRecents(load()), []);

  const add = useCallback((query: ContactQuery) => {
    if (!isRecordable(query)) return;
    setRecents((prev) => {
      const next = mergeRecent(prev, {
        id: recentKey(query),
        query,
        label: recentLabel(query),
        at: Date.now(),
      });
      persist(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    persist([]);
    setRecents([]);
  }, []);

  return { recents, add, clear };
}

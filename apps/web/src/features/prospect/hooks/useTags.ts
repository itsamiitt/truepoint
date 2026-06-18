// useTags.ts — loads the workspace's tags for the prospect filter rail (ADR-0028, G-REV-6) and resolves the
// set of record ids matching the currently-selected tag ids (filter-by-tag is list-only: the page filters
// the loaded rows against this union). A tag failing to load isn't fatal — the rail just omits the facet.
// Presentation state only.
"use client";

import type { Tag } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchRecordsByTag, fetchTags } from "../api";

export function useTags() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTags(await fetchTags());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load tags");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { tags, error, loading, reload };
}

/**
 * Resolve the union of record ids carrying ANY of `tagIds` (OR semantics), fetched lazily as the selection
 * changes. Returns null when nothing is selected (no tag filter). Contact entity only at MVP (accounts later).
 */
export function useTaggedIds(tagIds: string[]): Set<string> | null {
  const [ids, setIds] = useState<Set<string> | null>(null);
  // A stable signature of the selection: re-fetch only when the SET of tag ids actually changes (a new
  // array identity each render must not re-trigger). Parse back inside the effect so the dep stays a string.
  const key = [...tagIds].sort().join(",");

  useEffect(() => {
    const selected = key ? key.split(",") : [];
    if (selected.length === 0) {
      setIds(null);
      return;
    }
    let live = true;
    // allSettled (not all): one flaky tag fetch must not blank the whole list — union the tags that DID
    // resolve (OR semantics), so a transient failure on one facet degrades gracefully instead of failing
    // the entire selection closed (matches this hook's "a tag failing to load isn't fatal" intent).
    Promise.allSettled(selected.map((id) => fetchRecordsByTag(id, "contact"))).then((results) => {
      if (!live) return;
      const union = new Set<string>();
      for (const r of results) {
        if (r.status === "fulfilled") for (const id of r.value) union.add(id);
      }
      setIds(union);
    });
    return () => {
      live = false;
    };
  }, [key]);

  return ids;
}

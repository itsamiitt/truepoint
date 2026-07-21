// useDuplicatePairs.ts — loads the workspace's auto-flagged duplicate contact pairs (GET /contacts/duplicates) with
// loading/error + reload, plus an `unmark` action ("this is not a duplicate") that clears the flag then drops the
// row locally. Mirrors useReverificationRuns (useState + useEffect + useCallback; no TanStack Query in apps/web).
"use client";

import type { DuplicatePairView } from "@leadwolf/types";
import { useCallback, useEffect, useState } from "react";
import { fetchDuplicatePairs, unmarkDuplicate } from "../api";

export function useDuplicatePairs() {
  const [pairs, setPairs] = useState<DuplicatePairView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unmarking, setUnmarking] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPairs(await fetchDuplicatePairs());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your duplicate contacts");
    } finally {
      setLoading(false);
    }
  }, []);

  const unmark = useCallback(async (contactId: string) => {
    setUnmarking(contactId);
    try {
      await unmarkDuplicate(contactId);
      // The row is no longer a duplicate — drop it locally (the server is now authoritative on a reload).
      setPairs((cur) => (cur ? cur.filter((p) => p.duplicateId !== contactId) : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update this contact");
    } finally {
      setUnmarking(null);
    }
  }, []);

  // Drop a pair the merge verb resolved (the loser is tombstoned server-side) — the row leaves the visible queue;
  // the server stays authoritative on the next reload. No network here: the merge mutation already committed.
  const remove = useCallback((duplicateId: string) => {
    setPairs((cur) => (cur ? cur.filter((p) => p.duplicateId !== duplicateId) : cur));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { pairs, error, loading, unmarking, reload, unmark, remove };
}

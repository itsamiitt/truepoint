// useScores.ts — loads a contact's newest-first lead-score history for the record-detail Drawer (ADR-0008),
// with a `reload`. The score breakdown (composite + icp/intent/engagement) is opaque to the UI; this hook
// only fetches + exposes view state. Presentation state only.
"use client";

import { useCallback, useEffect, useState } from "react";
import { type ScoreHistoryRow, fetchScores } from "../api";

export function useScores(contactId: string | null) {
  const [scores, setScores] = useState<ScoreHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!contactId) {
      setScores(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setScores(await fetchScores(contactId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load scores");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { scores, error, loading, reload };
}

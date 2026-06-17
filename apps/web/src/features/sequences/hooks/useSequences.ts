// useSequences.ts — loads the workspace's sequences for the list view with loading/error state and a
// `reload`. `loading` is true only for the first fetch; reloads after create/step/enroll are quiet so the
// list never flickers. Also owns the pause/resume action (PATCH status) with per-row in-flight tracking so
// the list can disable just the row that's flipping. Presentation state only; the outreach engine lives
// server-side (ADR-0009).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSequences, setSequenceStatus } from "../api";
import type { SequenceStatus, SequenceSummary } from "../types";

export function useSequences() {
  const [sequences, setSequences] = useState<SequenceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setSequences(await fetchSequences());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sequences");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Flip a sequence between active and paused; one PATCH in flight at a time, then a quiet reload. */
  const setStatus = useCallback(
    async (id: string, status: SequenceStatus): Promise<boolean> => {
      setPendingId(id);
      setActionError(null);
      try {
        await setSequenceStatus(id, status);
        await reload();
        return true;
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Could not update the sequence");
        return false;
      } finally {
        setPendingId(null);
      }
    },
    [reload],
  );

  return { sequences, error, loading, reload, setStatus, pendingId, actionError };
}

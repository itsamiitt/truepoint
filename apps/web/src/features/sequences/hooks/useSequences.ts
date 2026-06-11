// useSequences.ts — loads the workspace's sequences for the list view with loading/error state and a
// `reload`. `loading` is true only for the first fetch; reloads after create/step/enroll are quiet so the
// list never flickers. Presentation state only; the outreach engine lives server-side (ADR-0009).
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSequences } from "../api";
import type { SequenceSummary } from "../types";

export function useSequences() {
  const [sequences, setSequences] = useState<SequenceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  return { sequences, error, loading, reload };
}

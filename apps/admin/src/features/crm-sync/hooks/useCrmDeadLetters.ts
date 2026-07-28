// useCrmDeadLetters.ts — the fleet-wide poison-job queue + the triage mutation.
//
// NOT polled, for the same reason the health hook is not: every request writes a cross-tenant audit row, and
// a background refresh would generate a stream of audit entries nobody initiated.
//
// The mutation is NOT optimistic. The server refuses to transition an already-closed row, so removing it
// from the list before the response would show one operator a decision another had already made.
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchCrmDeadLetters, triageCrmDeadLetter } from "../api";
import type { StaffCrmDeadLetter } from "../types";

export function useCrmDeadLetters() {
  const [rows, setRows] = useState<StaffCrmDeadLetter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchCrmDeadLetters());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the dead-letter queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const triage = useCallback(
    async (id: string, status: "retrying" | "resolved" | "ignored") => {
      setBusy(true);
      setError(null);
      try {
        await triageCrmDeadLetter(id, status);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not update that dead letter");
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  return { rows, error, loading, busy, reload, triage };
}

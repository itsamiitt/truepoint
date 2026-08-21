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
  // The TOTAL open count behind the capped page (PA-12) — what makes a 200-row view honest during a spike.
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Refreshes (the post-triage reload) report here — re-raising `loading` would blank the populated queue
  // back to the StateSwitch skeleton (perf-audit P3.6).
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (opts?: { initial?: boolean }) => {
    if (opts?.initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const page = await fetchCrmDeadLetters();
      setRows(page.deadLetters);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the dead-letter queue");
    } finally {
      if (opts?.initial) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  const reload = useCallback(() => load(), [load]);

  useEffect(() => {
    void load({ initial: true });
  }, [load]);

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

  return { rows, total, error, loading, refreshing, busy, reload, triage };
}

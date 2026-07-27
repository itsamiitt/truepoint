// useBulkReveal.ts — view state for the bulk money loop (07 §3): wraps the pure runBulkReveal policy (sum
// server charges, stop on 402, skip 403 — unit-tested in bulkReveal.ts) with busy/progress/summary state and
// invalidates the shared credit key ONCE at the end so the pill + bar re-read once, not N times. Holds no
// business logic beyond wiring revealContact; each reveal carries its own Idempotency-Key (api.revealContact).
"use client";

import { invalidateCreditSignals } from "@/lib/credits";
import type { RevealType } from "@leadwolf/types";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { revealContact } from "../api";
import { type BulkRevealProgress, type BulkRevealSummary, runBulkReveal } from "../bulkReveal";

export type { BulkRevealProgress, BulkRevealSummary } from "../bulkReveal";

export function useBulkReveal() {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<BulkRevealProgress | null>(null);
  const [summary, setSummary] = useState<BulkRevealSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = useCallback(() => {
    setProgress(null);
    setSummary(null);
    setBusy(false);
  }, []);

  const run = useCallback(
    async (ids: string[], revealType: RevealType = "email"): Promise<BulkRevealSummary> => {
      setBusy(true);
      setSummary(null);
      const result = await runBulkReveal(ids, revealContact, revealType, setProgress);
      // One invalidation at the end so the pill + bar re-read the balance once, not N times.
      invalidateCreditSignals(qc);
      setSummary(result);
      setBusy(false);
      return result;
    },
    [qc],
  );

  return { progress, summary, busy, run, reset };
}

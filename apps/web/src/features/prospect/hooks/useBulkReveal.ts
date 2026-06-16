// useBulkReveal.ts — view state for the bulk money loop (07 §3): wraps the pure runBulkReveal policy (sum
// server charges, stop on 402, skip 403 — unit-tested in bulkReveal.ts) with busy/progress/summary state and
// dispatches ONE "credits:changed" at the end so the pill + bar re-read once. Holds no business logic beyond
// wiring revealContact + the window event; each reveal carries its own Idempotency-Key (in api.revealContact).
"use client";

import type { RevealType } from "@leadwolf/types";
import { useCallback, useState } from "react";
import { revealContact } from "../api";
import { type BulkRevealProgress, type BulkRevealSummary, runBulkReveal } from "../bulkReveal";

export type { BulkRevealProgress, BulkRevealSummary } from "../bulkReveal";

export function useBulkReveal() {
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
      // One signal at the end so the pill + bar re-read the balance once, not N times.
      window.dispatchEvent(new Event("credits:changed"));
      setSummary(result);
      setBusy(false);
      return result;
    },
    [],
  );

  return { progress, summary, busy, run, reset };
}

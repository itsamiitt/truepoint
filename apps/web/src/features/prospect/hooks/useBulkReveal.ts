// useBulkReveal.ts — orchestrates the bulk money loop (07 §3): runs api.revealContact for each selected
// revealable contact in turn, summing the SERVER-reported creditsCharged (never a client-computed cost) and
// tracking the latest server balance. Stops early on insufficient_credits (402) and skips suppressed (403)
// so a bulk run has no dead ends. Emits one "credits:changed" at the end so the pill + bar re-read once.
// Each reveal carries its own Idempotency-Key (in api.revealContact), so a retried call never double-charges.
"use client";

import type { RevealType } from "@leadwolf/types";
import { useCallback, useState } from "react";
import { ApiError, revealContact } from "../api";

export interface BulkRevealProgress {
  done: number;
  total: number;
}

export interface BulkRevealSummary {
  revealedIds: string[];
  /** Sum of the server-reported creditsCharged across the run (never computed client-side). */
  totalCharged: number;
  balanceAfter: number | null;
  suppressedCount: number;
  failedCount: number;
  /** True if the run stopped early because the tenant ran out of credits (402). */
  stoppedForCredits: boolean;
}

export function useBulkReveal() {
  const [progress, setProgress] = useState<BulkRevealProgress | null>(null);
  const [summary, setSummary] = useState<BulkRevealSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = useCallback(() => {
    setProgress(null);
    setSummary(null);
    setBusy(false);
  }, []);

  /** Reveal each id in turn. `revealType` defaults to email (the list's primary masked facet). */
  const run = useCallback(
    async (ids: string[], revealType: RevealType = "email"): Promise<BulkRevealSummary> => {
      setBusy(true);
      setSummary(null);
      const revealedIds: string[] = [];
      let totalCharged = 0;
      let balanceAfter: number | null = null;
      let suppressedCount = 0;
      let failedCount = 0;
      let stoppedForCredits = false;

      for (let i = 0; i < ids.length; i++) {
        setProgress({ done: i, total: ids.length });
        const id = ids[i]!;
        try {
          const res = await revealContact(id, revealType);
          revealedIds.push(id);
          totalCharged += res.creditsCharged;
          balanceAfter = res.balanceAfter;
        } catch (e) {
          if (e instanceof ApiError && e.code === "insufficient_credits") {
            // Out of credits — stop hammering the API; surface the stop so the dialog can offer a top-up.
            stoppedForCredits = true;
            if (typeof e.extensions.balance === "number") balanceAfter = e.extensions.balance;
            break;
          }
          if (e instanceof ApiError && e.code === "suppressed") {
            suppressedCount++; // do-not-contact — skip and continue (no charge)
            continue;
          }
          failedCount++; // transient/other — count and continue so one bad row never aborts the rest
        }
      }

      setProgress({ done: ids.length, total: ids.length });
      // One signal at the end so the pill + bar re-read the balance once, not N times.
      window.dispatchEvent(new Event("credits:changed"));
      const result: BulkRevealSummary = {
        revealedIds,
        totalCharged,
        balanceAfter,
        suppressedCount,
        failedCount,
        stoppedForCredits,
      };
      setSummary(result);
      setBusy(false);
      return result;
    },
    [],
  );

  return { progress, summary, busy, run, reset };
}

// bulkReveal.ts — the PURE bulk money-loop policy (07 §3, §13). Given an injected reveal fn, it reveals each
// id in turn, summing the SERVER-reported creditsCharged (never a client-computed cost), stopping on
// insufficient_credits (402) and skipping suppressed (403) so a run has no dead ends. Pure + injectable so
// the stop/skip/sum policy is unit-tested without React or the network; useBulkReveal wraps it for view state.

import type { RevealResponse, RevealType } from "@leadwolf/types";
import { ApiError } from "./api";

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

export type RevealFn = (id: string, revealType: RevealType) => Promise<RevealResponse>;

/**
 * Reveal each id in turn via `reveal`. On insufficient_credits (402) it stops (no point hammering the API)
 * and surfaces the server balance; on suppressed (403) it skips and continues; any other error is counted
 * and the run continues so one bad row never aborts the rest. Returns the aggregate summary.
 */
export async function runBulkReveal(
  ids: string[],
  reveal: RevealFn,
  revealType: RevealType = "email",
  onProgress?: (p: BulkRevealProgress) => void,
): Promise<BulkRevealSummary> {
  const revealedIds: string[] = [];
  let totalCharged = 0;
  let balanceAfter: number | null = null;
  let suppressedCount = 0;
  let failedCount = 0;
  let stoppedForCredits = false;

  for (let i = 0; i < ids.length; i++) {
    onProgress?.({ done: i, total: ids.length });
    const id = ids[i]!;
    try {
      const res = await reveal(id, revealType);
      revealedIds.push(id);
      totalCharged += res.creditsCharged;
      balanceAfter = res.balanceAfter;
    } catch (e) {
      if (e instanceof ApiError && e.code === "insufficient_credits") {
        stoppedForCredits = true;
        if (typeof e.extensions.balance === "number") balanceAfter = e.extensions.balance;
        break;
      }
      if (e instanceof ApiError && e.code === "suppressed") {
        suppressedCount++;
        continue;
      }
      failedCount++;
    }
  }

  onProgress?.({ done: ids.length, total: ids.length });
  return { revealedIds, totalCharged, balanceAfter, suppressedCount, failedCount, stoppedForCredits };
}

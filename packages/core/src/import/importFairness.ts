// importFairness.ts — the S-Q2 tenant-fairness pair for the unified import queue (import-redesign 09 §2):
// (a) the per-workspace job cap — at most env.IMPORT_WORKSPACE_JOB_CAP jobs of a workspace EXECUTING
// (validating|staged|running); the commit verb parks overflow in the `deferred` state (visible
// backpressure, HubSpot's pattern — never a raw 503 before the product limit), and (b) the promotion pass
// the leader-locked scheduler sweep runs per workspace, oldest-first, within the computed headroom. The
// chunk-window half of S-Q2 (bounded rolling fan-out, K = env.IMPORT_CHUNK_WINDOW) lives with the copy
// drive in runBulkImport.ts; this module is mode-agnostic control-plane logic only.
//
// The census is deliberately a SOFT cap (±1 under a concurrent-submit race; no serializing lock): the
// atomic fair-share dispatcher is the worker-platform Phase-5 mechanism (weighted RR with aging, F7) and
// is NOT pre-built here (09 §2.1's explicit rejection). Everything reverts by env: cap 0 = disabled
// (nothing ever defers) — the §R-P1 knob posture.

import { env } from "@leadwolf/config";
import { importJobRepository, withTenantTx, type Tx } from "@leadwolf/db";

/** The states that occupy a workspace's execution slots (09 §2.2 — `queued` waits, it does not execute;
 *  `deferred`/`draft`/`paused` wait on a scheduler/human and never count toward the cap). */
export const ACTIVE_IMPORT_STATUSES = ["validating", "staged", "running"] as const;

/** The commit-time admission verdict (08 §2.1): below the cap ⇒ `queued`; at/over ⇒ `deferred`. */
export type FastAdmission = "queued" | "deferred";

/**
 * Decide a new import's admission state inside the SAME tx that creates its row (routes.ts commit path).
 * Cap 0/unset ⇒ always `queued` (legacy behavior, zero extra queries beyond the one census count).
 */
export async function decideFastAdmission(tx: Tx, workspaceId: string): Promise<FastAdmission> {
  const cap = env.IMPORT_WORKSPACE_JOB_CAP;
  if (cap <= 0) return "queued";
  const active = await importJobRepository.countJobsByStatuses(tx, workspaceId, [
    ...ACTIVE_IMPORT_STATUSES,
  ]);
  return active >= cap ? "deferred" : "queued";
}

/** A job the promotion pass flipped `deferred → queued` (the sweep re-publishes copy-drive transport). */
export interface PromotedImportJob {
  id: string;
  processingMode: string | null;
}

/**
 * One workspace's promotion pass (09 §2.2's sweep body — the caller holds the leader lock): promote the
 * OLDEST `deferred` jobs into the headroom `cap − (executing + already-queued)`. Counting `queued` in the
 * headroom (stricter than the cap itself) keeps a single tick from flushing a whole backlog into the
 * waiting set — promotions are metered at the same rate slots actually free. Idempotent and re-runnable:
 * the UPDATE pins `status='deferred'`, so racing a claim-time promotion double-flips nothing.
 */
export async function promoteDeferredForWorkspace(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<PromotedImportJob[]> {
  const cap = env.IMPORT_WORKSPACE_JOB_CAP;
  if (cap <= 0) {
    // Cap disabled mid-flight: promote everything parked so no job is stranded in `deferred`.
    return withTenantTx(scope, (tx) =>
      importJobRepository.promoteDeferredJobs(tx, scope.workspaceId, 100),
    );
  }
  return withTenantTx(scope, async (tx) => {
    const occupied = await importJobRepository.countJobsByStatuses(tx, scope.workspaceId, [
      ...ACTIVE_IMPORT_STATUSES,
      "queued",
    ]);
    const headroom = cap - occupied;
    if (headroom <= 0) return [];
    return importJobRepository.promoteDeferredJobs(tx, scope.workspaceId, headroom);
  });
}

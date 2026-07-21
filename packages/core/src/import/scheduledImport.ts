// scheduledImport.ts — the PURE decision core for scheduled imports (import-and-data-model-redesign 08 §9,
// P5). No I/O, no DB, no BullMQ — just the cadence math + the idempotency-key derivation + the fire-time
// grant verdict, so the sweep's orchestration is thin and every rule is unit-testable in isolation (T-P5).
//
// The IMPURE orchestration (read the schedule, re-eval the grant against live role+policy, submit through
// submitCopyImport, advance/disable/notify) lives in the worker sweep (scheduledImportSweep.ts) and composes
// these functions — mirroring how decideReaperAction (pure) sits under makeProcessImportReaperSweep (impure).

import {
  CADENCE_INTERVAL_MINUTES,
  type ScheduleCadence,
  type WhoCanImport,
  type WorkspaceRole,
} from "@leadwolf/types";
import {
  evaluateImportCreateGrant,
  type ImportCreateGrantVerdict,
} from "./importCreateGrant.ts";

/**
 * The next due instant after firing for `firedWindow`, given the cadence and the current time. Advances by
 * whole cadence intervals PAST `now` (missed windows are SKIPPED, never backfilled — a worker outage must not
 * unleash a catch-up storm of imports; 08 §9's uniformity is "same trio, same machine", not "replay history").
 * Deterministic + pure (unit-tested). Always returns an instant strictly greater than both `firedWindow` and
 * `now`, aligned to the cadence grid anchored on `firedWindow`.
 */
export function computeNextRunAt(firedWindow: Date, cadence: ScheduleCadence, now: Date): Date {
  const intervalMs = CADENCE_INTERVAL_MINUTES[cadence] * 60_000;
  let next = firedWindow.getTime() + intervalMs;
  const nowMs = now.getTime();
  if (next <= nowMs) {
    // Jump forward by whole intervals to the first grid instant strictly after `now` (skip missed windows).
    const missed = Math.ceil((nowMs - next + 1) / intervalMs);
    next += missed * intervalMs;
  }
  return new Date(next);
}

/**
 * The Idempotency-Key for a fire, derived from the schedule id + the WINDOW it is firing (the due instant that
 * triggered it, floored to whole seconds so a millisecond jitter between the census read and the fire can never
 * split one window into two keys). A double-fire within the same window (two sweep instances, a retried tick)
 * derives the SAME key → importJobRepository.createJob collapses onto ONE job via the shipped
 * (workspace_id, idempotency_key) partial unique. The scheduleId prefix makes cross-schedule collisions
 * impossible; the window suffix makes a NEW run each cadence tick. Stable + pure.
 */
export function deriveScheduleIdempotencyKey(scheduleId: string, windowStart: Date): string {
  const windowSeconds = Math.floor(windowStart.getTime() / 1000);
  return `sched:${scheduleId}:${windowSeconds}`;
}

/**
 * The fire-time grant re-evaluation (08 §9 / 10 §2 posture): a scheduled run executes AS its creator's grant,
 * re-checked at EVERY fire — a schedule can never keep importing after its creator lost the right to (role
 * demoted to viewer, policy tightened to admin-only, or the creator deleted → null role). Returns the grant
 * verdict; `null` role (deleted/absent membership) is treated as a hard loss. Pure wrapper over the shipped
 * evaluateImportCreateGrant matrix (the ONE grant authority — the sweep and the api create-gate never diverge).
 */
export function evaluateScheduleFireGrant(
  role: WorkspaceRole | null,
  whoCanImport: WhoCanImport,
): ImportCreateGrantVerdict {
  if (role === null) return "insufficient_role"; // deleted/departed creator — never fire as a ghost
  return evaluateImportCreateGrant(role, whoCanImport);
}

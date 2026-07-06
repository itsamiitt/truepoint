// importReaperSweep.ts — the S-Q5 import reaper (import-and-data-model-redesign 09 §7 row 2 / §8): the
// DB-backed recovery + observe spine for the unified import queue. It COMPOSES the shipped sweep idiom
// (leader-locked repeatable, owner-connection census, per-workspace fan-out — masterBackfillSweep /
// importPromotionSweep) rather than forking a second reaper; the chunk-lease columns db-mgmt-research/05
// designs are owned THERE and not yet shipped, so this reaper recovers from what DOES exist — the durable
// `import_jobs` control rows + BullMQ job liveness. Three gate-independent jobs, none of which touch the
// happy path (observe/recover only):
//
//   1. REDIS-LOSS / ORPHAN RECOVERY (09 §7 row 2). A non-terminal job older than the orphan grace with NO
//      live BullMQ job is orphaned — a Redis flush, or the "503-shed leaves a visible `queued` row" edge
//      (doc 16 drift, S-I3). Recovery is mode-split:
//        • COPY (`processing_mode='copy'`): re-publish the drive with its STABLE id `import-drive:<jobId>`.
//          The drive resumes from the byte-offset watermark and re-fans only pending bands (idempotent —
//          §7 row 6 "double-drive is benign"); staging/object-store is truth, so the job is reconstructable.
//        • FAST (else): the rows travel in the BullMQ PAYLOAD in Phase A (doc 16 S-I3 drift), so a lost job
//          CANNOT be re-driven — the reaper writes the honest `failed` terminal (markFastImportFailed,
//          reason PII-free) instead of leaving an eternal `queued`/`running` row. This is the Phase-A
//          limitation; at Phase B (rows in the object store) fast becomes re-drivable like copy.
//      Liveness is checked against a per-tick snapshot of ALL live job ids on the queue (waiting + delayed +
//      active + prioritized + paused), so a PROMOTED-deferred fast job carrying a `:r<n>` transport id is
//      correctly seen as live (prefix match) and never falsely terminalized.
//
//   2. STALL DETECTOR (09 §8). A `running` job whose 7-bucket counter sum has not advanced for longer than
//      the stall window is FLAGGED — a metric (`import.jobs.stalled` gauge) + a structured log, NEVER an
//      auto-kill. There is no `updated_at` column, so counter-movement across ticks IS the progress signal
//      (the design's own mechanism: "compare counter snapshots per running job"). Snapshots live in-process.
//
//   3. ARTIFACT RE-SWEEP (09 §7 row 4). Terminal jobs with rejected>0 but no artifact key are FLAGGED
//      (`import.jobs.artifact_pending` gauge) — a store crash mid-finalize left the repair CSV unwritten.
//      The reaper flags rather than re-runs the writer: re-running needs RejectedRow[] reconstructed from
//      the ledger (a heavier surface); the flag gives operators the signal today (09 §7 row 4 "re-run OR
//      flagged"). Recorded as deferred in doc 16.
//
//   4. DRAFT REAP (S-I8; 08 §2.1 draft exit "reaped (sweep; row deleted, audited)" / §Edge cases 48 h).
//      A `draft` older than IMPORT_DRAFT_TTL_HOURS is hard-deleted — ROW FIRST through a draft-pinned
//      tenant tx (a draft that committed/cancelled after the census is untouched: the pinned DELETE
//      matches 0 rows and the object is left alone), THEN its stored source object. Row-before-object is
//      deliberate (the opposite order could destroy a just-committed job's source under the race); the
//      crash window between the two leaves a bounded orphaned object, logged + countered, cleaned by the
//      bucket's job-purge horizon. ⚠ AUDIT GAP (DDL TODO — rides S-I9's P2 audit-CHECK train, ruling M1):
//      `import.draft_reaped` is NOT in the 0054 audit-action CHECK, so a writer today would fail the DB
//      CHECK at runtime — the durable record is the log line + `draft_reaped_total` counter until the P2
//      CHECK extension lands (the exact S-S2 `import.av_infected` precedent, doc 16).
//
// Plus two integrity gauges the same owner-connection pass computes cheaply: accounting-identity violations
// (S1) and the artifact-pending count. Leader-locked (mirrors the promotion sweep) so exactly one instance
// reaps per tick; constructed under the SAME gate as the unified queue (it needs the queue handle to
// re-enqueue, and only the gate's producers create the rows it heals — drafts included).

import { type FileStore, markFastImportFailed } from "@leadwolf/core";
import { importJobRepository, withTenantTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";
import { incrementImportCounter, setImportGauge } from "../metrics.ts";

export const IMPORT_REAPER_SWEEP_QUEUE = "import-reaper-sweep";
const LEADER_KEY = "leader:import_reaper_sweep";
const LEADER_TTL_MS = 2 * 60_000;
// Bound the census per tick so one reaper pass can never do unbounded work; a candidate still non-terminal
// next tick is picked up again (the enumeration only returns non-terminal rows).
const MAX_CANDIDATES_PER_SWEEP = 500;

export type ImportReaperSweepJobData = Record<string, never>;

/** A non-terminal import job as the reaper sees it (control-row fields only — no PII). */
export interface ReaperCandidate {
  id: string;
  tenantId: string;
  workspaceId: string;
  status: string;
  processingMode: string | null;
  createdAt: Date;
  rowsTotal: number;
  processed: number;
}

/** The recovery verdict for one candidate (the stall FLAG is tracked separately, since a copy job can be
 *  both stalled AND recoverable — recovery supersedes the flag but both are metered). */
export type ReaperAction = "none" | "copy_redrive" | "fast_orphan_fail";

/** True when SOME live job id belongs to this fast job — its base id `import-fast:<jobId>` or any deferred
 *  re-check variant `import-fast:<jobId>:r<n>` (prefix match) — so a promoted-deferred fast job in flight is
 *  never mistaken for an orphan. */
export function hasLiveFastJob(liveIds: ReadonlySet<string>, jobId: string): boolean {
  const base = `import-fast:${jobId}`;
  const prefix = `${base}:`;
  for (const id of liveIds) {
    if (id === base || id.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Pure recovery decision for one candidate — no I/O, no mutation (the stall flag is computed by the caller,
 * which owns the cross-tick snapshot, and passed in). Testable in isolation (T-Q5).
 *   • `deferred` jobs are never touched (the promotion sweep + the fast re-check loop own them).
 *   • COPY with no live drive → re-drive when queued/staged past grace, or when a `running` job is stalled
 *     (lost continuation). A healthy running copy job (counters moving ⇒ not stalled) is left alone.
 *   • FAST with no live job past grace, still non-terminal (queued/validating/running) → honest `failed`.
 */
export function decideReaperAction(
  job: Pick<ReaperCandidate, "id" | "status" | "processingMode" | "createdAt">,
  opts: { liveIds: ReadonlySet<string>; now: number; orphanGraceMs: number; stalled: boolean },
): ReaperAction {
  if (job.status === "deferred") return "none";
  const ageMs = opts.now - job.createdAt.getTime();
  const oldEnough = ageMs > opts.orphanGraceMs;

  if (job.processingMode === "copy") {
    const driveLive = opts.liveIds.has(`import-drive:${job.id}`);
    if (!driveLive) {
      if ((job.status === "queued" || job.status === "staged") && oldEnough) return "copy_redrive";
      if (job.status === "running" && opts.stalled) return "copy_redrive";
    }
    return "none";
  }

  // Fast (or a null-mode row on the unified queue): rows-in-payload are unrecoverable in Phase A.
  if (
    oldEnough &&
    (job.status === "queued" || job.status === "validating" || job.status === "running") &&
    !hasLiveFastJob(opts.liveIds, job.id)
  ) {
    return "fast_orphan_fail";
  }
  return "none";
}

/** The draft-reap TTL cutoff: drafts created before this instant lapse (08 §Edge cases — 48 h default,
 *  `IMPORT_DRAFT_TTL_HOURS`). Pure (unit-tested). */
export function draftReapCutoff(now: number, ttlMs: number): Date {
  return new Date(now - ttlMs);
}

/** True when a job's `source_file` is a real object-store key the reaper must delete — drafts always
 *  store one (`imports/<uuid>/source.<ext>`); the fast/retry sentinels (`inline:…`/`retry:…`) name no
 *  object (deleting them would be a traversal-guard error on the disk adapter, a no-op on S3). Pure. */
export function isDraftSourceObjectKey(key: string): boolean {
  return key.includes("/") && !key.includes(":");
}

export interface ImportReaperDeps {
  /** All live job ids on the unified queue this tick (waiting+delayed+active+prioritized+paused) — the
   *  liveness oracle for orphan detection. Injected so the reaper never constructs a queue handle itself. */
  snapshotLiveJobIds: () => Promise<ReadonlySet<string>>;
  /** Re-publish a promoted/orphaned COPY job's drive (stable id `import-drive:<jobId>`). */
  reenqueueCopyDrive: (
    jobId: string,
    scope: { tenantId: string; workspaceId: string },
  ) => Promise<void>;
  orphanGraceMs: number;
  stallWindowMs: number;
  /**
   * S-S2 (G08, 13 §2.3): true when a REAL malware scanner is configured (MALWARE_SCANNER ≠ stub). Arms the
   * NO-NEW-'skipped' MONITOR: the sweep counts fresh `av_scan_status='skipped'` uploads (last 24 h,
   * `retry:%` children excluded — they inherit, they don't scan) and stale `pending` rows, publishing
   * `leadwolf_import_av_skipped_recent` / `_av_pending_stale`. Either > 0 while armed = the gate failing
   * OPEN — an S2 security alert (§K catalog), never normal. Unarmed (stub) the gauges are not published
   * (honest absence — 'skipped' is the truthful record while no scanner exists).
   */
  scannerConfigured: boolean;
  /** S-I8 draft reap: the SAME env-selected store the draft upload wrote through (register.ts composes one
   *  per boot — api and workers select identically, so the reaper always deletes from the right backend). */
  fileStore: FileStore;
  /** IMPORT_DRAFT_TTL_HOURS at the root, in ms (default 48 h — 08 §2.1/§Edge cases). */
  draftTtlMs: number;
}

/** The monitor's look-back / staleness windows (13 §2.3's "new skipped / pending older than SLA"). */
const AV_SKIPPED_LOOKBACK_MS = 24 * 60 * 60_000;
const AV_PENDING_STALE_MS = 60 * 60_000;

/**
 * Build the reaper processor. Leader-locked; enumerates non-terminal jobs on the owner connection, applies
 * the three jobs above, and publishes the reaper gauges/counters. Best-effort per candidate — one job's
 * recovery failure never aborts the sweep (a still-broken row is re-examined next tick).
 */
export function makeProcessImportReaperSweep(redis: IORedis, deps: ImportReaperDeps) {
  // Cross-tick counter-movement snapshot for the stall detector (module-scoped to the closure so it survives
  // between ticks; pruned each tick to the currently-running set so it never grows unbounded).
  const snapshots = new Map<string, { processed: number; since: number }>();

  return async function processImportReaperSweep(
    _job: Job<ImportReaperSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const candidates = await importJobRepository.listNonTerminalImportJobs(
        MAX_CANDIDATES_PER_SWEEP,
      );
      const liveIds = await deps.snapshotLiveJobIds();
      const now = Date.now();
      const seen = new Set<string>();
      let stalledCount = 0;
      let copyRedrive = 0;
      let fastOrphanFailed = 0;

      for (const job of candidates) {
        seen.add(job.id);

        // Stall bookkeeping (running jobs only): counter-movement across ticks is the progress signal.
        let stalled = false;
        if (job.status === "running") {
          const snap = snapshots.get(job.id);
          if (!snap || snap.processed !== job.processed) {
            snapshots.set(job.id, { processed: job.processed, since: now });
          } else if (now - snap.since > deps.stallWindowMs) {
            stalled = true;
          }
        } else {
          snapshots.delete(job.id);
        }
        if (stalled) {
          stalledCount += 1;
          log.warn("import reaper: job stalled (no counter movement)", {
            jobId: job.id,
            workspaceId: job.workspaceId,
            processed: job.processed,
            rowsTotal: job.rowsTotal,
          });
        }

        const action = decideReaperAction(job, {
          liveIds,
          now,
          orphanGraceMs: deps.orphanGraceMs,
          stalled,
        });
        const scope = { tenantId: job.tenantId, workspaceId: job.workspaceId };
        try {
          if (action === "copy_redrive") {
            await deps.reenqueueCopyDrive(job.id, scope);
            copyRedrive += 1;
            log.info("import reaper: re-drove orphaned copy job", {
              jobId: job.id,
              workspaceId: job.workspaceId,
              status: job.status,
            });
          } else if (action === "fast_orphan_fail") {
            // Rows-in-payload are unrecoverable (Phase A) — the honest terminal, not an eternal running row.
            // markFastImportFailed is idempotent + guards a terminal row; the reason is a PII-free constant.
            await markFastImportFailed({
              scope,
              jobId: job.id,
              failedReason: "Import could not be recovered — no worker ran it (queue loss).",
              totalRows: job.rowsTotal,
            });
            fastOrphanFailed += 1;
            log.warn("import reaper: terminalized orphaned fast job", {
              jobId: job.id,
              workspaceId: job.workspaceId,
              status: job.status,
            });
          }
        } catch (e) {
          log.error("import reaper: recovery action failed", {
            jobId: job.id,
            action,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Prune snapshots for jobs no longer running/non-terminal so the map never grows unbounded.
      for (const id of snapshots.keys()) {
        if (!seen.has(id)) snapshots.delete(id);
      }

      // Integrity gauges (cheap owner-connection aggregates) + the reaper's own counters/gauge.
      const [artifactPending, accountingViolations] = await Promise.all([
        importJobRepository.countArtifactPendingJobs().catch(() => 0),
        importJobRepository.countAccountingViolations().catch(() => 0),
      ]);
      setImportGauge("jobs_stalled", stalledCount);
      setImportGauge("jobs_artifact_pending", artifactPending);
      setImportGauge("jobs_accounting_violations", accountingViolations);
      if (copyRedrive > 0) incrementImportCounter("reaper_copy_redrive_total", copyRedrive);
      if (fastOrphanFailed > 0)
        incrementImportCounter("reaper_fast_orphan_failed_total", fastOrphanFailed);

      if (artifactPending > 0) {
        log.warn("import reaper: terminal jobs missing their rejected-rows artifact", {
          count: artifactPending,
        });
      }
      if (accountingViolations > 0) {
        log.error("import reaper: accounting-identity violations on terminal jobs", {
          count: accountingViolations,
        });
      }

      // S-S2 no-new-'skipped' monitor (13 §2.3) — armed only with a real scanner configured; any hit is
      // the G08 gate failing open (S2 security). Published every tick so the alert clears itself once the
      // wiring regression is fixed and the look-back window rolls past.
      if (deps.scannerConfigured) {
        const [skippedRecent, pendingStale] = await Promise.all([
          importJobRepository.countRecentSkippedAvScans(AV_SKIPPED_LOOKBACK_MS).catch(() => 0),
          importJobRepository.countStalePendingAvScans(AV_PENDING_STALE_MS).catch(() => 0),
        ]);
        setImportGauge("av_skipped_recent", skippedRecent);
        setImportGauge("av_pending_stale", pendingStale);
        if (skippedRecent > 0) {
          log.error(
            "import reaper: NEW av_scan_status='skipped' uploads while a real scanner is configured — the G08 gate is failing open",
            { count: skippedRecent },
          );
        }
        if (pendingStale > 0) {
          log.warn("import reaper: av_scan_status='pending' rows older than the scan SLA", {
            count: pendingStale,
          });
        }
      }

      // ── 4. DRAFT REAP (S-I8; 08 §2.1 "reaped") — expired drafts: row first (draft-pinned tenant tx;
      // a raced commit/cancel wins and nothing is touched), then the stored source object. Best-effort
      // per candidate; a failed candidate is re-examined next tick (the census only shrinks). ⚠ DDL TODO
      // (S-I9 P2 audit-CHECK train): write `import.draft_reaped` in the SAME tx as the row delete once the
      // action enters the audit CHECK — until then the log + counter below are the operational record.
      const draftCutoff = draftReapCutoff(Date.now(), deps.draftTtlMs);
      const reapable = await importJobRepository
        .listReapableDrafts(draftCutoff, MAX_CANDIDATES_PER_SWEEP)
        .catch(() => []);
      setImportGauge("draft_reap_candidates", reapable.length);
      let reaped = 0;
      for (const draft of reapable) {
        try {
          const deleted = await withTenantTx(
            { tenantId: draft.tenantId, workspaceId: draft.workspaceId },
            (tx) => importJobRepository.deleteDraftJob(tx, draft.id),
          );
          if (!deleted) continue; // committed/cancelled since the census — not ours to touch
          if (isDraftSourceObjectKey(draft.sourceFile)) {
            // Idempotent delete; a failure here leaves a bounded orphaned object (logged) — never a
            // live job's data (the row is already gone, so nothing points at the key).
            await deps.fileStore.deleteObject(draft.sourceFile).catch((e: unknown) => {
              log.warn("import reaper: reaped draft's source object delete failed (orphaned)", {
                jobId: draft.id,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          }
          reaped += 1;
          log.info("import reaper: reaped expired draft", {
            jobId: draft.id,
            workspaceId: draft.workspaceId,
          });
        } catch (e) {
          log.error("import reaper: draft reap failed", {
            jobId: draft.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (reaped > 0) incrementImportCounter("draft_reaped_total", reaped);
    });
  };
}

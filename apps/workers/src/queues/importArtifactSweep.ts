// importArtifactSweep.ts — the S-S7 ARTIFACT LIFECYCLE sweep (import-redesign 13 §4.4; 15 §M-SEQ seq 37):
// the leader-locked, scheduled deleter that bounds how long the PII-bearing error-artifact pair lives.
// Composes the house sweep idiom (leaderLock + owner-connection census + per-row RLS-scoped write — the
// importReaperSweep / dataRetentionSweep shape). Two jobs, per 13 §4.4:
//
//   (a) TTL EXPIRY — terminal jobs older than IMPORT_ARTIFACT_TTL_DAYS (default 90) with an artifact key:
//       delete the objects (repair CSV, error report, and the deterministic legacy rejected-rows.csv —
//       deleteObject is idempotent, absent keys are no-ops) THEN null the keys on the row in a tenant tx
//       (key-nulling: the artifact route already 404s a null key, so the UI shows the honest "expired"
//       state instead of a dead link). Objects first, keys second — a crash between the two leaves keys
//       pointing at nothing (honest 404 at download, re-nulled next tick), never orphaned objects.
//       The SOURCE object is deliberately NOT touched here — it follows the JOB's purge horizon
//       (13 §4.4: "the source upload object follows the job"), via core's purgeImportJobObjects seam.
//
//   (b) JOB HARD-PURGE prefix deletion — owned by the purger that deletes job ROWS (the retention engine's
//       future import-jobs deleter / S-S8's DSAR fan-out), which composes core's purgeImportJobObjects
//       (`imports/<jobId>/` prefix) BEFORE the row delete. No row-purger exists yet; the seam ships in core
//       so it cannot be forgotten (doc-16 drift row records the split).
//
// Retention-class registration: `import_artifacts` (object-store class, 90 d, lifecycle-enforced) is in the
// @leadwolf/types vocabulary; its retention_class_policies seed row rides the next migration train (this
// slice adds no DDL). THIS sweep is the enforcement either way — env-driven, not policy-row-driven.
// Gauges/counters feed the §K runbook rows (artifact_ttl_* family).

import { type FileStore, legacyRejectedRowsKey } from "@leadwolf/core";
import { importJobRepository, withTenantTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";
import { incrementImportCounter, setImportGauge } from "../metrics.ts";

export const IMPORT_ARTIFACT_SWEEP_QUEUE = "import-artifact-sweep";
const LEADER_KEY = "leader:import_artifact_sweep";
const LEADER_TTL_MS = 10 * 60_000;
// Bound the census per tick; the remainder is picked up next tick (candidates only shrink).
const MAX_CANDIDATES_PER_SWEEP = 200;

export type ImportArtifactSweepJobData = Record<string, never>;

/** One expiry candidate as the sweep sees it (control-row fields only — keys are opaque non-PII paths). */
export interface ArtifactExpiryCandidate {
  id: string;
  tenantId: string;
  workspaceId: string;
  rejectedArtifactKey: string | null;
  errorReportKey: string | null;
}

/** The TTL cutoff: completed before this instant ⇒ the artifacts lapse. Pure (unit-tested). */
export function artifactExpiryCutoff(now: number, ttlDays: number): Date {
  return new Date(now - ttlDays * 24 * 60 * 60_000);
}

/**
 * Pure decider: every object key to delete for one lapsed job — the tracked pair plus the deterministic
 * legacy rejected-rows key (untracked in the DB; deleting an absent object is a no-op by the port's
 * contract, so it rides every candidate). No I/O, no mutation (unit-tested in isolation).
 */
export function artifactKeysToExpire(candidate: ArtifactExpiryCandidate): string[] {
  const keys: string[] = [];
  if (candidate.rejectedArtifactKey) keys.push(candidate.rejectedArtifactKey);
  if (candidate.errorReportKey) keys.push(candidate.errorReportKey);
  keys.push(legacyRejectedRowsKey(candidate.id));
  return keys;
}

export interface ImportArtifactSweepDeps {
  /** The SAME env-selected store the pipeline writes through (register.ts composes one per boot). */
  fileStore: FileStore;
  /** IMPORT_ARTIFACT_TTL_DAYS at the root (default 90 — 13 §4.4). */
  ttlDays: number;
}

/**
 * Build the sweep processor. Leader-locked; enumerates lapsed terminal jobs on the owner connection,
 * deletes their artifact objects, then nulls the keys in a per-row tenant tx. Best-effort per candidate —
 * one job's failure never aborts the sweep (a still-keyed row is re-examined next tick).
 */
export function makeProcessImportArtifactSweep(redis: IORedis, deps: ImportArtifactSweepDeps) {
  return async function processImportArtifactSweep(
    _job: Job<ImportArtifactSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const cutoff = artifactExpiryCutoff(Date.now(), deps.ttlDays);
      const candidates = await importJobRepository.listArtifactExpiryCandidates(
        cutoff,
        MAX_CANDIDATES_PER_SWEEP,
      );
      setImportGauge("artifact_ttl_candidates", candidates.length);
      let expired = 0;
      let objectsDeleted = 0;
      for (const c of candidates) {
        try {
          // Objects FIRST (idempotent deletes), keys SECOND — never an orphaned object (13 §4.4/§11).
          for (const key of artifactKeysToExpire(c)) {
            await deps.fileStore.deleteObject(key);
            objectsDeleted += 1;
          }
          await withTenantTx({ tenantId: c.tenantId, workspaceId: c.workspaceId }, (tx) =>
            importJobRepository.clearArtifactKeys(tx, c.id),
          );
          expired += 1;
        } catch (e) {
          log.error("import artifact sweep: expiry failed for job", {
            jobId: c.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (expired > 0) {
        incrementImportCounter("artifact_ttl_expired_total", expired);
        incrementImportCounter("artifact_ttl_objects_deleted_total", objectsDeleted);
        log.info("import artifact sweep: lapsed artifacts expired", {
          jobs: expired,
          objects: objectsDeleted,
          ttlDays: deps.ttlDays,
        });
      }
    });
  };
}

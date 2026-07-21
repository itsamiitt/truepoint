// artifactLifecycle.ts — the S-S7 object-lifecycle seam (import-redesign 13 §4.4): ONE definition of a
// job's object prefix + the hard-purge deleter every purge path composes, so object-store leftovers after a
// DB purge can never happen by omission (data-protection's deletion rule — orphaned objects ARE the failure
// mode). Callers today/planned:
//   • the S-S7 artifact TTL sweep (apps/workers importArtifactSweep) deletes the ARTIFACT objects only
//     (repair/errors CSVs + the legacy rejected-rows.csv) at 90 d — the SOURCE object deliberately survives
//     to the job's own purge horizon (13 §4.4: "the source upload object follows the job");
//   • the import-job hard-purge (the retention engine's future import-jobs deleter and S-S8's DSAR
//     affected-job deletion) calls purgeImportJobObjects BEFORE the row delete — the whole `imports/<id>/`
//     prefix (source + artifacts) goes with the job. No such purger exists yet; this is its ready seam.

import type { FileStore } from "../storage/fileStore.ts";

/** The one true object prefix for everything a job stored: `imports/<jobId>/` (source + artifact pair +
 *  the legacy rejected-rows artifact all live under it — bulkRoutes/artifactWriter/runBulkImport agree). */
export function importJobObjectPrefix(jobId: string): string {
  return `imports/${jobId}/`;
}

/** The legacy single-artifact key runBulkImport writes (no DB column tracks it — key is deterministic). */
export function legacyRejectedRowsKey(jobId: string): string {
  return `imports/${jobId}/rejected-rows.csv`;
}

/**
 * HARD-PURGE a job's entire object footprint (13 §4.4: "deletes the job's FileStore prefix (source +
 * artifacts) BEFORE the row delete"). Idempotent — an already-empty prefix is a no-op. The caller owns the
 * ordering guarantee (objects first, then the DB row, so a crash between the two leaves a row pointing at
 * nothing — honest and re-purgeable — rather than orphaned PII pointing at nothing in the DB).
 */
export async function purgeImportJobObjects(fileStore: FileStore, jobId: string): Promise<void> {
  await fileStore.deletePrefix(importJobObjectPrefix(jobId));
}

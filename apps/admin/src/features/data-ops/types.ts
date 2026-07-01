// types.ts — the shapes the Data-Ops Overview renders, mirroring the api GET /admin/data/overview payload
// (apps/api/src/features/admin/dataRoutes, backed by @leadwolf/db platformAdminRepository). Presentation-side
// types only; the api owns the canonical shape. COUNTS + tallies only — never an imported row's contents.

import type { WorkspaceDataQuality } from "@leadwolf/types";

export interface DataOpsOverview {
  /** Overall pipeline-job status tally (the queue-depth / dead-letter proxy) — EXACT counts (COUNT(*) GROUP BY). */
  jobs: {
    total: number;
    byStatus: Record<string, number>;
    queueDepth: number;
    deadLetter: number;
  };
  /** Recent cross-tenant bulk-import outcomes — status mix + total rejected rows (no row contents). */
  imports: {
    recentCount: number;
    truncated: boolean;
    byStatus: Record<string, number>;
    rejectedRecent: number;
  };
  /** Recent retention-engine RUNS — the shadow-mode evidence operators review before any `enforce` flip. */
  retention: { recentRuns: number; truncated: boolean };
}

/** One row of the per-status chunk tally on the import drill-down. */
export interface ImportChunkTally {
  status: string;
  count: number;
}

/** One bulk-import job's drill-down, mirroring GET /admin/data/imports/:jobId. METADATA + counts only — no raw
 * CSV row contents and no reject-reason text (those stay server-side). Dates arrive as ISO strings. */
export interface DataImportDetail {
  jobId: string;
  tenantId: string;
  tenantName: string;
  status: string;
  sourceName: string;
  avScanStatus: string;
  conflictPolicy: string;
  fileSize: number | null;
  totalChunks: number;
  completedChunks: number;
  rowsTotal: number;
  rowsCreated: number;
  rowsMatched: number;
  rowsDuplicate: number;
  rowsSkipped: number;
  rowsRejected: number;
  rowsDeduped: number;
  rowsUnprocessed: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedReason: string | null;
  chunkTally: ImportChunkTally[];
}

/** One row of the cross-tenant enrichment-run monitor, mirroring GET /admin/data/enrichment/runs. METADATA +
 * credit spend only — no enriched contact PII. creditSpentMicros is micro-credits (1e6 = 1). Dates are ISO strings. */
export interface EnrichmentRunRow {
  jobId: string;
  tenantId: string;
  tenantName: string;
  status: string;
  sourceName: string;
  totalRows: number;
  matchedRows: number;
  enrichedRows: number;
  chargedRows: number;
  creditSpentMicros: number;
  createdAt: string;
  completedAt: string | null;
  failedReason: string | null;
}

/** One row of the cross-tenant freshness re-verification monitor, mirroring GET /admin/data/verification/runs.
 * COUNTS only (scanned/reverified/errored + the run window) — no contact PII. Dates arrive as ISO strings. */
export interface VerificationRunRow {
  jobId: string;
  tenantId: string;
  tenantName: string;
  scanned: number;
  reverified: number;
  errored: number;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
}

/** One row of the fleet data-quality view, mirroring GET /admin/data/quality/snapshots. `metrics` is the non-PII
 * WorkspaceDataQuality count rollup; the UI derives fill/verified/fresh RATES. createdAt is an ISO string. */
export interface FleetQualityRow {
  snapshotId: string;
  tenantId: string;
  tenantName: string;
  workspaceId: string;
  metrics: WorkspaceDataQuality;
  createdAt: string;
}

/** One ER match-link on the dedup clerical-review surface, mirroring GET /admin/data/dedup/links. Shows the
 * matched person `name` (PII — the read is data:review-gated). matchProbability is 0–1 (null for deterministic
 * resolutions). Read-only for now; non-destructive merge/split actions land next. resolvedAt is an ISO string. */
export interface MatchLinkRow {
  id: string;
  entityType: string;
  clusterId: string;
  matchMethod: string;
  matchProbability: number | null;
  reviewStatus: string;
  isDuplicateOf: string | null;
  resolvedAt: string;
  name: string | null;
}

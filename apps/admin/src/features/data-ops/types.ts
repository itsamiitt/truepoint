// types.ts — the shapes the Data-Ops Overview renders, mirroring the api GET /admin/data/overview payload
// (apps/api/src/features/admin/dataRoutes, backed by @leadwolf/db platformAdminRepository). Presentation-side
// types only; the api owns the canonical shape. COUNTS + tallies only — never an imported row's contents.

export interface DataOpsOverview {
  /** Overall pipeline-job status tally (the historical queue-depth / dead-letter proxy), over a bounded sample. */
  jobs: {
    sampleSize: number;
    truncated: boolean;
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

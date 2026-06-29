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

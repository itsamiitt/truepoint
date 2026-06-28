// types.ts — the shapes the Imports monitor renders. These mirror the api `/admin/import-jobs` read payload
// (apps/api/src/features/admin, backed by @leadwolf/db platformAdminReads.recentImportJobs). Presentation-side
// types only; the api owns the canonical shape. Dates arrive as ISO strings (c.json serializes the repo's
// Date columns). METADATA + outcome tallies only — never an imported row's contents.

export interface ImportJobRow {
  jobId: string;
  tenantId: string;
  tenantName: string;
  status: string;
  sourceName: string;
  avScanStatus: string;
  rowsTotal: number;
  rowsCreated: number;
  rowsMatched: number;
  rowsRejected: number;
  createdAt: string;
  completedAt: string | null;
  failedReason: string | null;
}

// types.ts — the shape the Data-quality cockpit renders. Mirrors GET /admin/data-quality
// (apps/api/src/features/admin/routes.ts, backed by @leadwolf/db platformDataQualityReads). Counts only —
// non-PII; the api owns the canonical shape.

export interface DataQualityRollup {
  workspaces: number;
  latestAt: string | null;
  total: number;
  withEmail: number;
  withPhone: number;
  emailValid: number;
  fresh: number;
  stale: number;
  neverVerified: number;
}

export interface VerificationTotals {
  runs: number;
  scanned: number;
  reverified: number;
  errored: number;
}

export interface VerificationRun {
  tenantId: string;
  tenantName: string;
  finishedAt: string;
  scanned: number;
  reverified: number;
  errored: number;
}

export interface DataQuality {
  windowDays: number;
  rollup: DataQualityRollup;
  verification: {
    totals: VerificationTotals;
    recentRuns: VerificationRun[];
  };
}

// dataQualitySnapshot.ts — capture one per-workspace Data Health snapshot (10 §5 / 22): compute the live
// WorkspaceDataQuality rollup (contactRepository.dataQualitySummary) + persist it as a trend point
// (dataQualitySnapshots). Driven by the daily leader-locked sweep (apps/workers); the dashboard reads the series.
// Workspace-scoped throughout (RLS). Kept in core so the worker depends on @leadwolf/core, not the db repo wiring.

import { contactRepository, dataQualitySnapshotRepository, withTenantTx } from "@leadwolf/db";
import type { DataQualityTrendPoint, WorkspaceDataQuality } from "@leadwolf/types";

export async function captureDataQualitySnapshot(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<void> {
  const metrics = await contactRepository.dataQualitySummary(scope);
  // Multi-source COVERAGE + TRUE conflict count (data-management #8) — the heavy per-contact field_provenance jsonb
  // scans run HERE, in the daily sweep ONLY (never on the live per-request read), then ride the persisted snapshot
  // + trend series. Coverage = fields from ≥2 sources; conflicts = a field where sources actually DISAGREED.
  metrics.multiSourceContacts = await contactRepository.multiSourceContactCount(scope);
  metrics.conflictContacts = await contactRepository.conflictContactCount(scope);
  await withTenantTx(scope, (tx) =>
    dataQualitySnapshotRepository.record(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      metrics,
    }),
  );
}

/** The recent Data Health trend series for a workspace, newest first (the dashboard history read). */
export async function recentDataQualityTrend(
  scope: { tenantId: string; workspaceId: string },
  limit = 90,
): Promise<DataQualityTrendPoint[]> {
  const rows = await withTenantTx(scope, (tx) =>
    dataQualitySnapshotRepository.listRecent(tx, limit),
  );
  return rows.map((r) => ({
    capturedAt: r.createdAt.toISOString(),
    metrics: r.metrics as WorkspaceDataQuality,
  }));
}

// dataQualitySnapshot.ts — capture one per-workspace Data Health snapshot (10 §5 / 22): compute the live
// WorkspaceDataQuality rollup (contactRepository.dataQualitySummary) + persist it as a trend point
// (dataQualitySnapshots). Driven by the daily leader-locked sweep (apps/workers); the dashboard reads the series.
// Workspace-scoped throughout (RLS). Kept in core so the worker depends on @leadwolf/core, not the db repo wiring.

import { contactRepository, dataQualitySnapshotRepository, withTenantTx } from "@leadwolf/db";

export async function captureDataQualitySnapshot(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<void> {
  const metrics = await contactRepository.dataQualitySummary(scope);
  await withTenantTx(scope, (tx) =>
    dataQualitySnapshotRepository.record(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      metrics,
    }),
  );
}

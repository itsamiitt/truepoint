// dataQualitySnapshotRepository.ts — the per-workspace Data Health TREND store (data_quality_snapshots, 10 §5).
// The daily sweep records one rollup row per workspace; reads expose the recent series for the dashboard trend.
// Workspace-scoped via RLS — record/listRecent compose inside a withTenantTx, so isolation rides the GUC.

import type { WorkspaceDataQuality } from "@leadwolf/types";
import { desc } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { dataQualitySnapshots } from "../schema/dataQualitySnapshots.ts";

/** A persisted trend point (the rollup JSONB + capture time). */
export type DataQualitySnapshotRow = typeof dataQualitySnapshots.$inferSelect;

export const dataQualitySnapshotRepository = {
  /** Insert one captured rollup (tx-aware — composed inside the sweep's workspace tx). */
  async record(
    tx: Tx,
    snapshot: { tenantId: string; workspaceId: string; metrics: WorkspaceDataQuality },
  ): Promise<void> {
    await tx.insert(dataQualitySnapshots).values(snapshot);
  },

  /** The recent trend series for the caller's workspace, newest first (the dashboard trend read). */
  async listRecent(tx: Tx, limit = 90): Promise<DataQualitySnapshotRow[]> {
    return tx
      .select()
      .from(dataQualitySnapshots)
      .orderBy(desc(dataQualitySnapshots.createdAt))
      .limit(limit);
  },
};

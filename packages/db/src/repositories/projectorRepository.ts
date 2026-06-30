// projectorRepository.ts — data access for the knowledge-DB survivorship projector (prospect-database-platform I1 /
// Phase 05; audit P03). It drains projection_outbox, summarizes a cluster's evidence (source_records), and writes
// the SHADOW survivorship seams — data_quality_score + prov_hwm — on the golden master_* row. It MUST NOT write the
// authoritative scalar columns (firstName/email/name/…): the projector becoming authoritative over those is a
// SEPARATE, CI-parity-gated flip. System-owned Layer-0; runs under withErTx / owner (it writes master_* + reads
// source_records). field_provenance is left for the per-field survivorship follow-up.
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { masterCompanies, masterPersons, sourceRecords } from "../schema/masterGraph.ts";
import { projectionOutbox } from "../schema/projectionOutbox.ts";

export interface PendingProjection {
  id: string;
  entityType: string; // person | company
  clusterId: string;
}

export interface ClusterEvidenceSummary {
  evidenceCount: number;
  latestIngestedAt: Date | null;
}

export const projectorRepository = {
  /**
   * Claim the oldest PENDING outbox row for THIS worker and mark it `processing` — FOR UPDATE SKIP LOCKED so many
   * workers drain in parallel without contending. Returns null when the queue is empty. Run inside the worker's tx.
   */
  async claimNextPending(tx: Tx): Promise<PendingProjection | null> {
    const [picked] = await tx
      .select({
        id: projectionOutbox.id,
        entityType: projectionOutbox.entityType,
        clusterId: projectionOutbox.clusterId,
      })
      .from(projectionOutbox)
      .where(eq(projectionOutbox.status, "pending"))
      .orderBy(projectionOutbox.enqueuedAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!picked) return null;
    await tx
      .update(projectionOutbox)
      .set({ status: "processing" })
      .where(eq(projectionOutbox.id, picked.id));
    return picked;
  },

  /** Count the source_records resolved to a cluster + the latest ingest time — the projector's evidence summary. */
  async summarizeClusterEvidence(
    tx: Tx,
    clusterId: string,
    entityType: string,
  ): Promise<ClusterEvidenceSummary> {
    const col =
      entityType === "company" ? sourceRecords.resolvedCompanyId : sourceRecords.resolvedPersonId;
    const [row] = await tx
      .select({
        evidenceCount: sql<number>`count(*)::int`,
        latestIngestedAt: sql<Date | null>`max(${sourceRecords.ingestedAt})`,
      })
      .from(sourceRecords)
      .where(eq(col, clusterId));
    return row ?? { evidenceCount: 0, latestIngestedAt: null };
  },

  /**
   * Write the SHADOW survivorship seams — data_quality_score + prov_hwm ONLY — on the golden row. NEVER the
   * authoritative scalar columns (that flip is CI-parity-gated); field_provenance is left for the per-field
   * survivorship follow-up.
   */
  async writeShadowProjection(
    tx: Tx,
    entityType: string,
    clusterId: string,
    seams: { dataQualityScore: number; provHwm: Date | null },
  ): Promise<void> {
    if (entityType === "company") {
      await tx
        .update(masterCompanies)
        .set({ dataQualityScore: seams.dataQualityScore, provHwm: seams.provHwm })
        .where(eq(masterCompanies.id, clusterId));
    } else {
      await tx
        .update(masterPersons)
        .set({ dataQualityScore: seams.dataQualityScore, provHwm: seams.provHwm })
        .where(eq(masterPersons.id, clusterId));
    }
  },

  /** Mark an outbox row terminal. */
  async markDone(tx: Tx, id: string): Promise<void> {
    await tx
      .update(projectionOutbox)
      .set({ status: "done", processedAt: new Date() })
      .where(eq(projectionOutbox.id, id));
  },
  async markFailed(tx: Tx, id: string): Promise<void> {
    await tx
      .update(projectionOutbox)
      .set({ status: "failed", processedAt: new Date() })
      .where(eq(projectionOutbox.id, id));
  },
};

// evidenceRepository.ts — writers for the IMMUTABLE evidence substrate of the knowledge database
// (prospect-database-platform Phases 03-05; audit P01). `source_records` is the append-only log of every observed
// payload (idempotent on content_hash); `match_links` records which source_records form a golden cluster. The
// golden master_* record becomes a survivorship PROJECTION over this log (Phase 05), which is what makes lineage,
// version-history-as-replay, and non-destructive merge/unmerge possible.
//
// These writers are ADDITIVE and currently call-less: the dual-write into the ER resolve path lands as a separate
// slice BEHIND `INGESTION_EVIDENCE_ENABLED` (default-off), and the flip to authoritative is CI-parity-gated. They
// run under the master-graph write path (`withErTx` / owner), which has the grant on these system-owned tables;
// `leadwolf_app` does not.

import { eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { matchLinks, sourceRecords } from "../schema/masterGraph.ts";

/** One observed payload to append as evidence. `contentHash` is sha256(canonical payload) — the UNIQUE idempotency
 *  key, so re-ingesting an identical payload is a no-op. `rawData` is kept verbatim; `matchKeys` are the extracted
 *  normalized dedup keys (email blind-index, domain, linkedin id, phone). resolved ids are the ER result (nullable
 *  in-flight). */
export interface SourceRecordInput {
  sourceName: string;
  contentHash: Uint8Array;
  rawData: unknown;
  matchKeys?: Record<string, unknown>;
  resolvedPersonId?: string | null;
  resolvedCompanyId?: string | null;
  region?: string | null;
}

/** A cluster-membership link: which `source_record` belongs to which golden entity, and how it was matched. */
export interface MatchLinkInput {
  entityType: "person" | "company";
  clusterId: string; // the golden master_persons / master_companies id
  sourceRecordId: string;
  matchMethod?: "deterministic" | "splink" | "manual";
  matchProbability?: number | null; // 0..1, null for deterministic
  reviewStatus?: "auto" | "pending" | "confirmed" | "rejected";
}

export const evidenceRepository = {
  /**
   * Append a `source_records` evidence row, IDEMPOTENT on content_hash. Returns the row id + whether THIS call
   * created it (`created:false` = an identical payload was already ingested → the caller should not re-link).
   * Returns null only on the impossible race where the conflict row vanished before the follow-up read.
   */
  async appendSourceRecord(tx: Tx, input: SourceRecordInput): Promise<{ id: string; created: boolean } | null> {
    const inserted = await tx
      .insert(sourceRecords)
      .values({
        sourceName: input.sourceName,
        contentHash: input.contentHash,
        rawData: input.rawData as Record<string, unknown>,
        matchKeys: (input.matchKeys ?? {}) as Record<string, unknown>,
        resolvedPersonId: input.resolvedPersonId ?? null,
        resolvedCompanyId: input.resolvedCompanyId ?? null,
        region: input.region ?? null,
      })
      .onConflictDoNothing({ target: sourceRecords.contentHash })
      .returning({ id: sourceRecords.id });
    if (inserted[0]) return { id: inserted[0].id, created: true };

    const [existing] = await tx
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(eq(sourceRecords.contentHash, input.contentHash))
      .limit(1);
    return existing ? { id: existing.id, created: false } : null;
  },

  /** Insert a `match_links` cluster-membership row (defaults: deterministic / auto). The probabilistic tier
   *  (Phase 04, scale-track) sets `match_method='splink'` + a probability + `review_status='pending'`. */
  async linkToCluster(tx: Tx, input: MatchLinkInput): Promise<void> {
    await tx.insert(matchLinks).values({
      entityType: input.entityType,
      clusterId: input.clusterId,
      sourceRecordId: input.sourceRecordId,
      matchMethod: input.matchMethod ?? "deterministic",
      matchProbability: input.matchProbability != null ? String(input.matchProbability) : null,
      reviewStatus: input.reviewStatus ?? "auto",
    });
  },
};

// evidenceRepository.ts — writers for the IMMUTABLE evidence substrate of the knowledge database
// (prospect-database-platform Phases 03-05; audit P01). `source_records` is the append-only log of every observed
// payload (idempotent on content_hash); `match_links` records which source_records form a golden cluster. The
// golden master_* record becomes a survivorship PROJECTION over this log (Phase 05), which is what makes lineage,
// version-history-as-replay, and non-destructive merge/unmerge possible.
//
// `provenance_event` (Phase 1 S-02/S-04) is the FIELD-grain layer above the same substrate: source_records says
// "this payload was observed", provenance_event says "and it asserted THESE fields, from this source, under this
// lawful basis". One source_record fans out to many events. Both are appended here, in one transaction, so the
// evidence and the assertions it justifies can never diverge.
//
// These writers are ADDITIVE and currently call-less: the dual-write into the ER resolve path lands as a separate
// slice BEHIND `INGESTION_EVIDENCE_ENABLED` (default-off), and the flip to authoritative is CI-parity-gated. They
// run under the master-graph write path (`withErTx` / owner), which has the grant on these system-owned tables;
// `leadwolf_app` does not.

import type { ProvenanceEventDraft } from "@leadwolf/types";
import { eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { matchLinks, sourceRecords } from "../schema/masterGraph.ts";
import { projectionOutbox } from "../schema/projectionOutbox.ts";
import { provenanceEvent } from "../schema/provenanceEvent.ts";
import { sliceForBindLimit } from "./bindLimit.ts";

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
  async appendSourceRecord(
    tx: Tx,
    input: SourceRecordInput,
  ): Promise<{ id: string; created: boolean } | null> {
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

  /**
   * Append field-grain assertions to `provenance_event` (08-architecture invariant 1). Batched because one
   * observed payload asserts many fields at once, and they must land in the SAME transaction as the graph
   * write they justify — an event written in a separate transaction can be lost while the graph write
   * survives, which is the one failure mode that turns the log from evidence into decoration.
   *
   * IDEMPOTENCY IS THE CALLER'S JOB, and it is the same rule `linkToCluster` already follows: call this ONLY
   * when `appendSourceRecord` returned `created: true`. There is no unique index to fall back on here —
   * `provenance_event` is partitioned by `recorded_at`, and a partitioned table's unique indexes must include
   * the partition key, which would degrade "one event per assertion" into "one event per replay timestamp"
   * (the trap migration 0085 records for provider_calls). So a re-ingested payload that skips the source_record
   * insert but still appends events would silently double every corroboration count, and corroboration count
   * IS the confidence signal and the badge (S-10). Empty input is a no-op so callers need no guard.
   */
  async appendProvenanceEvents(tx: Tx, drafts: readonly ProvenanceEventDraft[]): Promise<number> {
    if (drafts.length === 0) return 0;
    // Sliced for the bind-parameter ceiling: provenance is per FIELD, so one import chunk fans out to tens of
    // thousands of drafts at ~14 parameters each — far past PostgreSQL's 65,534. See bindLimit.ts.
    const rows = drafts.map((d) => ({
      entityType: d.entityType,
      entityId: d.entityId,
      field: d.field,
      action: d.action,
      sourceType: d.sourceType,
      sourceName: d.sourceName ?? null,
      method: d.method ?? null,
      contributorRef: d.contributorRef ?? null,
      lawfulBasis: d.lawfulBasis,
      payload: d.payload as Record<string, unknown>,
      // numeric(4,3) round-trips as a string in postgres.js — mirrors matchProbability in linkToCluster.
      confidence: d.confidence != null ? String(d.confidence) : null,
      acceptanceState: d.acceptanceState,
      sourceRecordId: d.sourceRecordId ?? null,
      scopeRef: d.scopeRef ?? null,
      observedAt: d.observedAt ?? null,
    }));
    for (const slice of sliceForBindLimit(rows)) {
      await tx.insert(provenanceEvent).values(slice);
    }
    return drafts.length;
  },

  /** Enqueue a survivorship re-projection for a golden cluster (prospect-database-platform I1 / Phase 05). The
   *  projector worker drains `projection_outbox` and rebuilds the golden master_* record from the evidence log.
   *  `reason` = evidence_added | merge | unmerge | refresh. */
  async enqueueProjection(
    tx: Tx,
    input: { entityType: "person" | "company"; clusterId: string; reason: string },
  ): Promise<void> {
    await tx.insert(projectionOutbox).values({
      entityType: input.entityType,
      clusterId: input.clusterId,
      reason: input.reason,
    });
  },
};

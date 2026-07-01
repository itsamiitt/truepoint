// erRepository.ts — system-owned reads for I5 probabilistic entity resolution (Layer-0 master graph). Every method
// takes the transaction handed by withErTx (the leadwolf_er role — master_* tables only, non-BYPASSRLS), so ER
// reads never touch the tenant overlay and never expose cross-tenant PII to a user: this is a background SYSTEM
// process, not a user-facing surface. Reads generate candidates; the one WRITE (proposePendingMatch) only ever
// inserts a PENDING/splink review proposal — provably inert in the authoritative graph, never a merge/re-point.
//
// Candidate generation uses BLOCKING to avoid the O(n²) full cross product: v1 blocks on the shared
// current-company pointer (idx_master_persons_company — the one populated + indexed, selective key: colleagues are
// the natural dedup neighbourhood). block_key is RESERVED/unpopulated and the name trgm indexes are deferred, so
// name/email blocking is a later refinement; a seed with no company yields no candidates here. Email/phone blind
// indexes are NOT projected yet (set-valued channels don't fit the pairwise comparison layer) — they compare as
// not_compared for now, so v1 scores conservatively on linkedin + name + company + title (fewer, higher-precision
// proposals — the right bias for a SHADOW proposer). Every read is bounded (no unbounded master-graph scan).

import { type SQL, and, asc, eq, gt, ne } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { masterPersons, matchLinks, sourceRecords } from "../schema/masterGraph.ts";

/** The cap on rows any ER read returns per call — a hard bound on every master-graph scan. */
export const ER_CANDIDATE_LIMIT = 100;

/**
 * A person projected to the fields the core comparison layer scores on. `currentCompanyId` maps to the comparison
 * layer's `companyId`. No PII: email/phone blind indexes are a later refinement (they compare as not_compared).
 */
export interface ErCandidatePerson {
  id: string;
  linkedinPublicId: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  currentCompanyId: string | null;
  jobTitle: string | null;
  seniorityLevel: string | null;
}

const CANDIDATE_COLUMNS = {
  id: masterPersons.id,
  linkedinPublicId: masterPersons.linkedinPublicId,
  fullName: masterPersons.fullName,
  firstName: masterPersons.firstName,
  lastName: masterPersons.lastName,
  currentCompanyId: masterPersons.currentCompanyId,
  jobTitle: masterPersons.jobTitle,
  seniorityLevel: masterPersons.seniorityLevel,
};

const cap = (n: number): number => Math.max(1, Math.min(ER_CANDIDATE_LIMIT, Math.trunc(n)));

export const erRepository = {
  /**
   * A cursor-paginated batch of persons to seed ER over (ordered by id; pass the last id seen as `afterId`, or null
   * to start). The sweep walks these and blocks each with findBlockingCandidates. Bounded; system-scoped; read-only.
   */
  async listPersonsForEr(
    tx: Tx,
    afterId: string | null,
    limit = ER_CANDIDATE_LIMIT,
  ): Promise<ErCandidatePerson[]> {
    const predicate = afterId ? gt(masterPersons.id, afterId) : undefined;
    return tx
      .select(CANDIDATE_COLUMNS)
      .from(masterPersons)
      .where(predicate)
      .orderBy(asc(masterPersons.id))
      .limit(cap(limit));
  },

  /**
   * Candidate records for a seed person via BLOCKING on the shared current-company pointer (index-backed). Returns
   * OTHER master_persons at the same company (the seed itself excluded), bounded by `limit`. A seed with no company
   * yields [] (name/email blocking is a later refinement). System-scoped via withErTx; NO writes; NO cross-tenant
   * user exposure. Scoring happens in core (the sweep), not here.
   */
  async findBlockingCandidates(
    tx: Tx,
    seed: { id: string; currentCompanyId: string | null },
    limit = ER_CANDIDATE_LIMIT,
  ): Promise<ErCandidatePerson[]> {
    if (!seed.currentCompanyId) return [];
    const predicate: SQL | undefined = and(
      eq(masterPersons.currentCompanyId, seed.currentCompanyId),
      ne(masterPersons.id, seed.id),
    );
    return tx.select(CANDIDATE_COLUMNS).from(masterPersons).where(predicate).limit(cap(limit));
  },

  /**
   * The source_record ids currently resolved to a person cluster — the LOSER's evidence the shadow proposer
   * re-proposes for the survivor cluster. Bounded; read-only; system-scoped.
   */
  async listSourceRecordIdsForPerson(
    tx: Tx,
    personId: string,
    limit = ER_CANDIDATE_LIMIT,
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(eq(sourceRecords.resolvedPersonId, personId))
      .limit(cap(limit));
    return rows.map((r) => r.id);
  },

  /**
   * SHADOW-ONLY PROPOSAL (I5): insert a PENDING, splink match_links row proposing that `sourceRecordId` (a loser's
   * evidence) belongs to the survivor `clusterId` — filling ONLY the human-review queue the DB-Ops surface reads.
   * It NEVER sets is_duplicate_of, NEVER writes 'confirmed'/'auto', NEVER re-points a cluster or mutates an existing
   * row. A pending splink row is provably inert in the authoritative paths (the deterministic resolve ignores
   * review_status/is_duplicate_of; the projector counts source_records, not match_links). IDEMPOTENT: if a pending
   * splink link for this (sourceRecordId, clusterId) already exists it is a no-op — the leader-locked ER sweep is a
   * single writer, so the pre-check is race-safe without a unique index. Returns true iff a NEW proposal was
   * inserted. System-owned via withErTx. Acting on the proposal (confirm/merge) is a SEPARATE human + executor step.
   */
  async proposePendingMatch(
    tx: Tx,
    input: { sourceRecordId: string; clusterId: string; matchProbability: number },
  ): Promise<boolean> {
    const existing = await tx
      .select({ id: matchLinks.id })
      .from(matchLinks)
      .where(
        and(
          eq(matchLinks.sourceRecordId, input.sourceRecordId),
          eq(matchLinks.clusterId, input.clusterId),
          eq(matchLinks.matchMethod, "splink"),
        ),
      )
      .limit(1);
    if (existing[0]) return false; // already proposed — idempotent no-op
    const prob = Math.max(0, Math.min(1, input.matchProbability));
    await tx.insert(matchLinks).values({
      entityType: "person",
      clusterId: input.clusterId,
      sourceRecordId: input.sourceRecordId,
      matchMethod: "splink",
      matchProbability: String(prob),
      reviewStatus: "pending",
      // isDuplicateOf intentionally left NULL — a PROPOSAL for review, never a re-point/merge.
    });
    return true;
  },
};

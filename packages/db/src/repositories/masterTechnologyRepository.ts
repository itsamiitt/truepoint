// masterTechnologyRepository.ts — Layer-0 data access for the technology/product catalog (migration 0100) and
// the company↔technology adoption edge (0101). Always called inside withErTx (the least-privilege
// leadwolf_er role): these tables are system-owned and NOT RLS-scoped, so there are no tenant GUCs, and the
// customer app role holds no grant on them at all.
//
// Mirrors masterGraphRepository.ts's shape: the caller owns the transaction, every write converges under
// concurrency, and nothing here decides policy — it executes it.
//
// ── WHY AN ADVISORY LOCK INSTEAD OF A UNIQUE CONSTRAINT (read before "fixing" this) ──────────────────────
// Everywhere else in this codebase, concurrent-insert convergence is guaranteed by a global UNIQUE plus
// ON CONFLICT DO NOTHING (primary_domain, email_blind_index, content_hash). master_technology_adoptions
// deliberately has NO such unique: its grain is one row per DETECTION EPISODE, and a technology detected →
// removed → re-detected must be three rows, because that sequence IS the displacement signal (0101 header).
//
// That leaves `recordDetection` with a genuine read-then-write race: two workers ingesting the same detection
// concurrently would both find no open episode and both insert one, and the company would appear to have
// adopted the same technology twice. A transaction-scoped advisory lock keyed on
// (company, technology, method) serialises exactly that triple and nothing else. It is released automatically
// at commit or rollback — no cleanup path to forget.
//
// The alternative — letting duplicates land and collapsing them on read — was rejected: the read is not the
// only consumer. The displacement sweep reads this table too, and a spurious second episode is a spurious
// "re-adopted" signal fired at a customer.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";

/** Keys a catalog resolve can match on, strongest first. */
export interface ResolveTechnologyInput {
  /** The natural key. Required for a mint; matched case-insensitively (citext). */
  slug: string;
  /** Display name for a freshly minted row. Falls back to the slug. */
  canonicalName?: string;
  /** Optional external keys — partial-unique, so most catalog rows carry neither (research R10). */
  cpe23?: string;
  wikidataQid?: string;
  /** 'technology' | 'product' | 'service'. Defaults to 'technology' at the column level. */
  kind?: string;
}

/**
 * Resolve a technology to its catalog id — LINK if it exists, else MINT.
 *
 * Match order is strongest key first: slug → cpe23 → wikidata_qid → alias. Alias is last on purpose: an alias
 * may legitimately be ambiguous across technologies ("Atlas" is several products), so it is the weakest
 * evidence of identity and must never outrank an exact external key.
 *
 * Concurrency: the mint is ON CONFLICT DO NOTHING on the slug unique, followed by a re-SELECT — two concurrent
 * ingests of the same technology converge on one row rather than one of them failing.
 */
export async function resolveTechnology(
  tx: Tx,
  input: ResolveTechnologyInput,
): Promise<string | null> {
  const slug = input.slug?.trim();
  if (!slug) return null;

  const bySlug = (await tx.execute(
    sql`SELECT id FROM master_technologies WHERE slug = ${slug} LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  if (bySlug[0]) return bySlug[0].id;

  if (input.cpe23) {
    const byCpe = (await tx.execute(
      sql`SELECT id FROM master_technologies WHERE cpe23 = ${input.cpe23} LIMIT 1`,
    )) as unknown as Array<{ id: string }>;
    if (byCpe[0]) return byCpe[0].id;
  }

  if (input.wikidataQid) {
    const byQid = (await tx.execute(
      sql`SELECT id FROM master_technologies WHERE wikidata_qid = ${input.wikidataQid} LIMIT 1`,
    )) as unknown as Array<{ id: string }>;
    if (byQid[0]) return byQid[0].id;
  }

  // Alias lookup last — weakest evidence, and deliberately NOT trusted when it is ambiguous. An alias shared
  // by two technologies is a review task, not a coin flip: returning either one would silently attach a
  // detection to the wrong product, which is worse than leaving it unresolved for the review queue.
  const byAlias = (await tx.execute(
    sql`SELECT technology_id FROM master_technology_aliases WHERE alias = ${slug} LIMIT 2`,
  )) as unknown as Array<{ technology_id: string }>;
  if (byAlias.length === 1 && byAlias[0]) return byAlias[0].technology_id;
  if (byAlias.length > 1) return null;

  await tx.execute(sql`
    INSERT INTO master_technologies (slug, canonical_name, kind, cpe23, wikidata_qid)
    VALUES (${slug}, ${input.canonicalName ?? slug}, ${input.kind ?? "technology"},
            ${input.cpe23 ?? null}, ${input.wikidataQid ?? null})
    ON CONFLICT DO NOTHING
  `);

  const minted = (await tx.execute(
    sql`SELECT id FROM master_technologies WHERE slug = ${slug} LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  return minted[0]?.id ?? null;
}

export interface RecordDetectionInput {
  masterCompanyId: string;
  technologyId: string;
  /** web_fingerprint | job_posting | dns | self_declared | integration | filing | manual */
  detectionMethod: string;
  /** VALID time of this sighting — when the detection was true, not when we processed it. */
  observedAt: Date;
  confidence?: number | null;
  sourceName?: string | null;
  /** source_records.id — the "show me why" link. */
  evidenceRef?: string | null;
}

export interface RecordDetectionResult {
  id: string;
  /** true when this sighting opened a NEW episode; false when it extended an open one. */
  opened: boolean;
}

/**
 * Record one sighting of a technology at a company.
 *
 * EXTENDS the open episode if there is one — moving `last_seen_at` forward — otherwise OPENS a new episode.
 * That is what makes the episode grain work: repeated sightings of a live technology do not multiply rows,
 * but a sighting after a removal correctly starts a new episode and becomes a re-adoption.
 *
 * `first_seen_at` is never moved backwards by an extension, and `last_seen_at` never moves backwards either
 * — a late-arriving OLD sighting must not make a stale detection look fresh, which is the whole reason valid
 * time and transaction time are separate columns in this schema.
 */
export async function recordDetection(
  tx: Tx,
  input: RecordDetectionInput,
): Promise<RecordDetectionResult | null> {
  // Serialise this (company, technology, method) triple for the rest of the transaction. See the header for
  // why this stands in for the unique constraint the episode grain forbids.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${input.masterCompanyId} || ':' || ${input.technologyId} || ':' ||
                       ${input.detectionMethod}, 0))
  `);

  // DATES GO IN AS ISO STRINGS WITH AN EXPLICIT CAST — never as a raw Date. Drizzle's sql template does not
  // type a Date param, so postgres.js falls through to its string serializer and throws, in JS, before the
  // query reaches the server: `TypeError: The "string" argument must be of type string ... Received an
  // instance of Date`, reported by Drizzle as an EMPTY "Failed query:". Adding ::timestamptz alone does not
  // help, because the failure is client-side. This is the house pattern — contactRepository, dsarRepository,
  // eventOutboxRepository and importJobRepository all write `${x.toISOString()}`.
  const extended = (await tx.execute(sql`
    UPDATE master_technology_adoptions
       SET last_seen_at  = GREATEST(last_seen_at, ${input.observedAt.toISOString()}::timestamptz),
           first_seen_at = LEAST(first_seen_at, ${input.observedAt.toISOString()}::timestamptz),
           source_count  = source_count + 1,
           confidence    = COALESCE(${input.confidence ?? null}, confidence)
     WHERE master_company_id = ${input.masterCompanyId}
       AND technology_id     = ${input.technologyId}
       AND detection_method  = ${input.detectionMethod}
       AND removed_at IS NULL
     RETURNING id
  `)) as unknown as Array<{ id: string }>;

  if (extended[0]) {
    return { id: extended[0].id, opened: false };
  }

  const inserted = (await tx.execute(sql`
    INSERT INTO master_technology_adoptions
      (master_company_id, technology_id, detection_method, first_seen_at, last_seen_at,
       confidence, source_name, evidence_ref, observed_at)
    VALUES
      (${input.masterCompanyId}, ${input.technologyId}, ${input.detectionMethod},
       ${input.observedAt.toISOString()}::timestamptz, ${input.observedAt.toISOString()}::timestamptz, ${input.confidence ?? null},
       ${input.sourceName ?? null}, ${input.evidenceRef ?? null}, ${input.observedAt.toISOString()}::timestamptz)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  return inserted[0] ? { id: inserted[0].id, opened: true } : null;
}

/**
 * Close the open episode for a (company, technology, method) — the displacement signal.
 *
 * Returns the number of episodes closed, NOT a boolean: per the RLS-denial discipline in this codebase, a
 * caller must be able to assert "changed exactly one row" rather than infer success from an absence of
 * errors. Closing an already-closed episode affects zero rows and is not an error — a provider reporting a
 * removal twice is normal.
 */
export async function closeDetection(
  tx: Tx,
  input: {
    masterCompanyId: string;
    technologyId: string;
    detectionMethod: string;
    removedAt: Date;
  },
): Promise<number> {
  const closed = (await tx.execute(sql`
    UPDATE master_technology_adoptions
       SET removed_at = ${input.removedAt.toISOString()}::timestamptz
     WHERE master_company_id = ${input.masterCompanyId}
       AND technology_id     = ${input.technologyId}
       AND detection_method  = ${input.detectionMethod}
       AND removed_at IS NULL
       AND ${input.removedAt.toISOString()}::timestamptz >= last_seen_at
     RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return closed.length;
}

export interface CompanyTechnologyRow {
  technologyId: string;
  slug: string;
  canonicalName: string;
  detectionMethod: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  confidence: string | null;
  sourceCount: number;
}

/**
 * The company-profile read: which technologies is this company currently detected on.
 *
 * Only OPEN episodes (`removed_at IS NULL`). One row per (technology, method) — the profile shows *how* a
 * technology was detected, because a DNS record and a job-posting mention are very different claims and
 * flattening them would hide the difference the confidence policy is built around.
 */
export async function listCompanyTechnologies(
  tx: Tx,
  masterCompanyId: string,
  limit = 200,
): Promise<CompanyTechnologyRow[]> {
  const rows = (await tx.execute(sql`
    SELECT a.technology_id, t.slug, t.canonical_name, a.detection_method,
           a.first_seen_at, a.last_seen_at, a.confidence, a.source_count
      FROM master_technology_adoptions a
      JOIN master_technologies t ON t.id = a.technology_id
     WHERE a.master_company_id = ${masterCompanyId}
       AND a.removed_at IS NULL
     ORDER BY a.last_seen_at DESC
     LIMIT ${limit}
  `)) as unknown as Array<{
    technology_id: string;
    slug: string;
    canonical_name: string;
    detection_method: string;
    first_seen_at: Date;
    last_seen_at: Date;
    confidence: string | null;
    source_count: number;
  }>;

  return rows.map((r) => ({
    technologyId: r.technology_id,
    slug: r.slug,
    canonicalName: r.canonical_name,
    detectionMethod: r.detection_method,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    confidence: r.confidence,
    sourceCount: r.source_count,
  }));
}

/**
 * The query the jsonb blob could never answer: which companies are detected on this technology.
 * Ordered by recency, since a detection from last week is worth more than one from two years ago — the same
 * principle the confidence policy encodes.
 */
export async function listTechnologyAdopters(
  tx: Tx,
  technologyId: string,
  limit = 200,
): Promise<Array<{ masterCompanyId: string; lastSeenAt: Date; detectionMethod: string }>> {
  const rows = (await tx.execute(sql`
    SELECT master_company_id, last_seen_at, detection_method
      FROM master_technology_adoptions
     WHERE technology_id = ${technologyId}
       AND removed_at IS NULL
     ORDER BY last_seen_at DESC
     LIMIT ${limit}
  `)) as unknown as Array<{
    master_company_id: string;
    last_seen_at: Date;
    detection_method: string;
  }>;

  return rows.map((r) => ({
    masterCompanyId: r.master_company_id,
    lastSeenAt: r.last_seen_at,
    detectionMethod: r.detection_method,
  }));
}

/**
 * The DEVELOPS side of the split: what does this company BUILD.
 *
 * `listCompanyTechnologies` above answers "what does it RUN" from master_technology_adoptions. This answers
 * the other question entirely, from master_technology_vendors — and the two must never be served by one
 * function, because "Sage develops Sage Intacct" and "Sage uses WordPress" are different facts and a caller
 * that conflates them ships a wrong answer to a customer.
 *
 * creator ∪ current_owner, open rows only: a technology the company sold off is no longer in its portfolio,
 * but the immutable `creator` row keeps the lineage (that is what former_owner is for).
 */
export async function listCompanyProducts(
  tx: Tx,
  masterCompanyId: string,
  limit = 200,
): Promise<
  Array<{
    technologyId: string;
    slug: string;
    canonicalName: string;
    relationship: string;
    startedOn: string | null;
    confidence: string | null;
  }>
> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ON (v.technology_id)
           v.technology_id, t.slug, t.canonical_name, v.relationship, v.started_on, v.confidence
      FROM master_technology_vendors v
      JOIN master_technologies t ON t.id = v.technology_id
     WHERE v.master_company_id = ${masterCompanyId}
       AND v.relationship IN ('creator','current_owner')
       AND v.ended_on IS NULL
     ORDER BY v.technology_id,
              -- current_owner outranks creator when both exist: it is the live portfolio claim.
              CASE v.relationship WHEN 'current_owner' THEN 0 ELSE 1 END
     LIMIT ${limit}
  `)) as unknown as Array<{
    technology_id: string;
    slug: string;
    canonical_name: string;
    relationship: string;
    started_on: string | null;
    confidence: string | null;
  }>;

  return rows.map((r) => ({
    technologyId: r.technology_id,
    slug: r.slug,
    canonicalName: r.canonical_name,
    relationship: r.relationship,
    startedOn: r.started_on,
    confidence: r.confidence,
  }));
}

/**
 * The ownership ledger for one technology — "who made this, and who owns it now".
 *
 * This is what turns "what does Sage run" into "…and Google built two of those tools". Bitemporal by
 * construction: the creator row is immutable and ownership transfers append, so an as-of read reconstructs
 * who owned a product before an acquisition.
 */
export async function listTechnologyVendors(
  tx: Tx,
  technologyId: string,
): Promise<
  Array<{
    masterCompanyId: string;
    companyName: string;
    relationship: string;
    startedOn: string | null;
    endedOn: string | null;
    confidence: string | null;
  }>
> {
  const rows = (await tx.execute(sql`
    SELECT v.master_company_id, c.name AS company_name, v.relationship,
           v.started_on, v.ended_on, v.confidence
      FROM master_technology_vendors v
      JOIN master_companies c ON c.id = v.master_company_id
     WHERE v.technology_id = ${technologyId}
     ORDER BY v.started_on
  `)) as unknown as Array<{
    master_company_id: string;
    company_name: string;
    relationship: string;
    started_on: string | null;
    ended_on: string | null;
    confidence: string | null;
  }>;

  return rows.map((r) => ({
    masterCompanyId: r.master_company_id,
    companyName: r.company_name,
    relationship: r.relationship,
    startedOn: r.started_on,
    endedOn: r.ended_on,
    confidence: r.confidence,
  }));
}

/** Batch form of listTechnologyVendors, creator-only — the "who built the tools you run" expansion. */
export async function listCreatorsForTechnologies(
  tx: Tx,
  technologyIds: string[],
): Promise<Map<string, { masterCompanyId: string; companyName: string }>> {
  if (technologyIds.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT v.technology_id, v.master_company_id, c.name AS company_name
      FROM master_technology_vendors v
      JOIN master_companies c ON c.id = v.master_company_id
     WHERE v.relationship = 'creator'
       AND v.ended_on IS NULL
       AND v.technology_id = ANY(${technologyIds})
  `)) as unknown as Array<{
    technology_id: string;
    master_company_id: string;
    company_name: string;
  }>;

  return new Map(
    rows.map((r) => [
      r.technology_id,
      { masterCompanyId: r.master_company_id, companyName: r.company_name },
    ]),
  );
}

/**
 * What this company RECENTLY STOPPED running — the displacement signal (plan 33 · Track C).
 *
 * `removed_at` is the whole point of the episode grain: a technology detected, removed, then re-detected is
 * three rows, and the middle one is the sales trigger. This reads the closed episodes rather than inferring
 * displacement from an absence, because an absence is indistinguishable from "we never detected it".
 *
 * ⚠ EMPTY TODAY. Nothing populates master_technology_adoptions yet, so `removed_at` is never set and this
 * returns nothing for every company. It is correct-when-data-arrives, not currently useful.
 */
export async function listRecentlyRemovedTechnologies(
  tx: Tx,
  masterCompanyId: string,
  withinDays = 180,
  limit = 50,
): Promise<
  Array<{
    technologyId: string;
    slug: string;
    canonicalName: string;
    detectionMethod: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
    removedAt: Date;
  }>
> {
  const rows = (await tx.execute(sql`
    SELECT a.technology_id, t.slug, t.canonical_name, a.detection_method,
           a.first_seen_at, a.last_seen_at, a.removed_at
      FROM master_technology_adoptions a
      JOIN master_technologies t ON t.id = a.technology_id
     WHERE a.master_company_id = ${masterCompanyId}
       AND a.removed_at IS NOT NULL
       AND a.removed_at >= now() - make_interval(days => ${withinDays})
     ORDER BY a.removed_at DESC
     LIMIT ${limit}
  `)) as unknown as Array<{
    technology_id: string;
    slug: string;
    canonical_name: string;
    detection_method: string;
    first_seen_at: Date;
    last_seen_at: Date;
    removed_at: Date;
  }>;

  return rows.map((r) => ({
    technologyId: r.technology_id,
    slug: r.slug,
    canonicalName: r.canonical_name,
    detectionMethod: r.detection_method,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    removedAt: r.removed_at,
  }));
}

export const masterTechnologyRepository = {
  resolveTechnology,
  recordDetection,
  closeDetection,
  listCompanyTechnologies,
  listTechnologyAdopters,
  listCompanyProducts,
  listTechnologyVendors,
  listCreatorsForTechnologies,
  listRecentlyRemovedTechnologies,
};
